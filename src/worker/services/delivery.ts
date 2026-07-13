import { and, asc, count, desc, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";

import type { DrizzleDb } from "../db/client";
import { collections, entries, fields, type CollectionRow, type EntryRow } from "../db/schema";
import { hashString } from "../lib/hash";
import { badRequest, notFound } from "../lib/errors";
import { fetchMediaByIds, toDeliveryMedia } from "./media";
import { referenceIds } from "./references";

import { D1_IN_CHUNK } from "@/shared/constants";
import { FIELD_TYPES, parseFieldOptions, type FieldOptions } from "@/shared/field-types";
import type { FieldDefinition } from "@/shared/validation";
import type {
  DeliveryCollectionSchema,
  DeliveryEntry,
  DeliveryListResponse,
  DeliveryReference,
  EntryData,
} from "@/shared/api-types";

// Read-only delivery (the public `/api/v1/*` API). Serves ONLY published content and
// normalizes every entry to the collection's current field set so schema changes never
// corrupt old rows: removed fields drop out, added fields appear as `default ?? null`.

const FILTER_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "contains"] as const;
type FilterOp = (typeof FILTER_OPS)[number];

export interface RawFilter {
  field: string;
  op: string;
  value: string;
}

export interface ContentQuery {
  limit: number;
  offset: number;
  sort?: string;
  filters: RawFilter[];
}

export interface DeliveryCollection {
  collection: CollectionRow;
  defs: FieldDefinition[];
}

function parseJson(text: string): EntryData {
  try {
    return JSON.parse(text) as EntryData;
  } catch {
    return {};
  }
}

async function loadDefs(db: DrizzleDb, collectionId: string): Promise<FieldDefinition[]> {
  const rows = await db
    .select()
    .from(fields)
    .where(eq(fields.collectionId, collectionId))
    .orderBy(asc(fields.sortOrder))
    .all();
  return rows.map((r) => {
    let options: FieldOptions = {};
    try {
      options = parseFieldOptions(r.type, JSON.parse(r.options));
    } catch {
      options = {};
    }
    return { name: r.name, type: r.type, options };
  });
}

export async function loadDeliveryCollection(db: DrizzleDb, slug: string): Promise<DeliveryCollection> {
  const collection = await db.select().from(collections).where(eq(collections.slug, slug)).get();
  if (!collection) throw notFound(`No collection "${slug}"`);
  return { collection, defs: await loadDefs(db, collection.id) };
}

/** Emit exactly the currently-defined fields, with stable defaults for missing values. */
function normalizeForDelivery(defs: FieldDefinition[], data: EntryData): EntryData {
  const out: EntryData = {};
  for (const def of defs) {
    if (def.name in data && data[def.name] !== undefined) {
      out[def.name] = data[def.name];
    } else {
      const fallback = FIELD_TYPES[def.type].resolveDefault(def.options);
      out[def.name] = fallback === undefined ? null : fallback;
    }
  }
  return out;
}

function toDeliveryEntry(row: EntryRow, defs: FieldDefinition[]): DeliveryEntry {
  return {
    id: row.id,
    slug: row.slug,
    sortOrder: row.sortOrder,
    publishedAt: row.publishedAt,
    data: normalizeForDelivery(defs, parseJson(row.publishedData ?? "{}")),
  };
}

// `refSig` (the versions of every referenced target collection) is folded in so that
// renaming an expanded target busts this entry's ETag — otherwise a 304 would serve a
// stale expanded title. Empty for collections with no reference fields (ETag unchanged).
function entryEtag(row: EntryRow, refSig: string): string {
  const tag = row.publishedEtag ?? hashString(row.publishedData ?? "");
  return refSig ? `W/"${tag}-${hashString(refSig)}"` : `W/"${tag}"`;
}

/**
 * Replace every picture/video value (a bare media id) with an expanded media object
 * carrying an absolute URL, or `null` when the asset is gone or not ready. One batched
 * lookup covers all entries in the response (chunked IN under D1's param ceiling).
 */
async function expandMedia(
  db: DrizzleDb,
  origin: string,
  defs: FieldDefinition[],
  list: DeliveryEntry[],
): Promise<void> {
  const mediaFields = defs.filter((d) => d.type === "picture" || d.type === "video");
  if (mediaFields.length === 0) return;

  const ids: string[] = [];
  for (const entry of list) {
    for (const def of mediaFields) {
      const v = entry.data[def.name];
      if (typeof v === "string" && v) ids.push(v);
    }
  }
  if (ids.length === 0) return;

  const byId = await fetchMediaByIds(db, ids);
  for (const entry of list) {
    for (const def of mediaFields) {
      const v = entry.data[def.name];
      if (typeof v === "string" && v) {
        const row = byId.get(v);
        entry.data[def.name] = row && row.status === "ready" ? toDeliveryMedia(origin, row) : null;
      }
    }
  }
}

// --- reference expansion -----------------------------------------------------

/** A published entry's title, drawn from its collection's title field (published data only). */
function deliveryTitle(publishedJson: string | null, titleField: string | null): string {
  if (!titleField || !publishedJson) return "Untitled";
  try {
    const data = JSON.parse(publishedJson) as EntryData;
    const v = data[titleField];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (typeof obj.label === "string" && obj.label.trim()) return obj.label.trim();
      if (typeof obj.url === "string" && obj.url.trim()) return obj.url.trim();
    }
  } catch {
    /* fall through */
  }
  return "Untitled";
}

/** Batch-load published target entries → their expanded {id,slug,title,collection} object. */
async function buildExpandedReferences(
  db: DrizzleDb,
  ids: string[],
): Promise<Map<string, DeliveryReference>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, DeliveryReference>();
  for (let i = 0; i < unique.length; i += D1_IN_CHUNK) {
    const chunk = unique.slice(i, i + D1_IN_CHUNK);
    // Only published targets expand; reading published data (not draft) is what keeps
    // unpublished titles from leaking AND lets the contentVersion ETag fold invalidate them.
    const rows = await db
      .select({
        id: entries.id,
        slug: entries.slug,
        publishedData: entries.publishedData,
        collectionSlug: collections.slug,
        titleField: collections.titleField,
      })
      .from(entries)
      .innerJoin(collections, eq(entries.collectionId, collections.id))
      .where(and(inArray(entries.id, chunk), isNotNull(entries.publishedData)))
      .all();
    for (const r of rows) {
      out.set(r.id, {
        id: r.id,
        slug: r.slug,
        collection: r.collectionSlug,
        title: deliveryTitle(r.publishedData, r.titleField),
      });
    }
  }
  return out;
}

/**
 * Replace every reference value (a bare entry id, or an id[] when `multiple`) with an
 * expanded {id,slug,title,collection} object — or `null` when the target is deleted or
 * unpublished. One batched lookup covers the whole response, mirroring expandMedia. This
 * is the v1 depth-1 shape (no nested target `data`); deeper expansion is a bounded follow-on.
 */
async function expandReferences(
  db: DrizzleDb,
  defs: FieldDefinition[],
  list: DeliveryEntry[],
): Promise<void> {
  const refFields = defs.filter((d) => d.type === "reference");
  if (refFields.length === 0) return;

  const ids: string[] = [];
  for (const entry of list) {
    for (const def of refFields) ids.push(...referenceIds(entry.data[def.name]));
  }
  if (ids.length === 0) return;

  const byId = await buildExpandedReferences(db, ids);
  for (const entry of list) {
    for (const def of refFields) {
      const v = entry.data[def.name];
      if (Array.isArray(v)) {
        entry.data[def.name] = v.map((id) => (typeof id === "string" ? byId.get(id) ?? null : null));
      } else if (typeof v === "string" && v) {
        entry.data[def.name] = byId.get(v) ?? null;
      }
      // Absent single ref is already `null` (normalizeForDelivery); leave it.
    }
  }
}

/**
 * A stable signature of every collection's version, folded into delivery ETags so a
 * rename/re-title of any expanded reference target busts the referrer's cache. `contentVersion`
 * catches entry title-value renames (publish bumps it); `updatedAt` catches a target collection
 * changing *which* field is its title. We fold in ALL collections (not just the fields' current
 * `targetCollections`) because a stored reference id can point at a collection that was later
 * removed from `targetCollections` yet still expands at delivery — so scoping to current targets
 * would serve a stale title. Over-invalidation is acceptable (the collections table is tiny and
 * changes rarely). Empty string when the collection has no reference fields (ETags stay identical).
 */
async function referencedVersionSignature(db: DrizzleDb, defs: FieldDefinition[]): Promise<string> {
  if (!defs.some((d) => d.type === "reference")) return "";
  const rows = await db
    .select({
      slug: collections.slug,
      contentVersion: collections.contentVersion,
      updatedAt: collections.updatedAt,
    })
    .from(collections)
    .orderBy(asc(collections.slug))
    .all();
  return rows.map((r) => `${r.slug}:${r.contentVersion}:${r.updatedAt}`).join(",");
}

// --- public schema -----------------------------------------------------------

export async function getPublicSchema(db: DrizzleDb): Promise<DeliveryCollectionSchema[]> {
  const cols = await db
    .select()
    .from(collections)
    .orderBy(asc(collections.sortOrder), asc(collections.createdAt))
    .all();
  const result: DeliveryCollectionSchema[] = [];
  for (const col of cols) {
    const fieldRows = await db
      .select()
      .from(fields)
      .where(eq(fields.collectionId, col.id))
      .orderBy(asc(fields.sortOrder))
      .all();
    result.push({
      slug: col.slug,
      name: col.name,
      description: col.description,
      type: col.type,
      titleField: col.titleField,
      fields: fieldRows.map((f) => {
        let options: FieldOptions = {};
        try {
          options = parseFieldOptions(f.type, JSON.parse(f.options));
        } catch {
          options = {};
        }
        return { name: f.name, label: f.label, type: f.type, options };
      }),
    });
  }
  return result;
}

// --- filtering + sorting -----------------------------------------------------

function jsonExtract(field: string): SQL {
  return sql`json_extract(${entries.publishedData}, ${"$." + field})`;
}

function compileFilter(def: FieldDefinition, op: FilterOp, rawValue: string): SQL {
  const expr = jsonExtract(def.name);

  // References store a bare target id (or an id[] when `multiple`). Filter by id: for a
  // single ref, eq/ne compare the extracted id; for a multiple ref, test array membership
  // via json_each. Ordering/`contains` ops are meaningless on an opaque id → rejected.
  if (def.type === "reference") {
    if (def.options.multiple === true) {
      const member = sql`EXISTS (SELECT 1 FROM json_each(${entries.publishedData}, ${"$." + def.name}) WHERE value = ${rawValue})`;
      switch (op) {
        case "eq":
        case "contains":
          return member;
        case "ne":
          return sql`NOT ${member}`;
        default:
          throw badRequest(`Operator "${op}" is not supported on the multiple reference "${def.name}"`);
      }
    }
    switch (op) {
      case "eq":
        return sql`${expr} = ${rawValue}`;
      case "ne":
        return sql`${expr} != ${rawValue}`;
      default:
        throw badRequest(`Operator "${op}" is not supported on the reference "${def.name}"`);
    }
  }

  if (op === "contains") return sql`${expr} LIKE ${"%" + rawValue + "%"}`;

  let value: string | number = rawValue;
  if (def.type === "number") {
    const num = Number(rawValue);
    if (!Number.isFinite(num)) throw badRequest(`Filter value for "${def.name}" must be a number`);
    value = num;
  } else if (def.type === "boolean") {
    value = rawValue === "true" || rawValue === "1" ? 1 : 0;
  }

  switch (op) {
    case "eq":
      return sql`${expr} = ${value}`;
    case "ne":
      return sql`${expr} != ${value}`;
    case "lt":
      return sql`${expr} < ${value}`;
    case "lte":
      return sql`${expr} <= ${value}`;
    case "gt":
      return sql`${expr} > ${value}`;
    case "gte":
      return sql`${expr} >= ${value}`;
  }
}

function buildFilters(defs: FieldDefinition[], filters: RawFilter[]): SQL[] {
  const byName = new Map(defs.map((d) => [d.name, d]));
  return filters.map((f) => {
    const def = byName.get(f.field);
    if (!def) throw badRequest(`Unknown filter field "${f.field}"`);
    if (!FILTER_OPS.includes(f.op as FilterOp)) throw badRequest(`Unknown filter operator "${f.op}"`);
    return compileFilter(def, f.op as FilterOp, f.value);
  });
}

function buildSort(defs: FieldDefinition[], sort: string | undefined): SQL {
  if (!sort) return asc(entries.sortOrder);
  const dir = sort.startsWith("-") ? "desc" : "asc";
  const field = sort.replace(/^-/, "");
  let expr: SQL;
  if (field === "sortOrder") expr = sql`${entries.sortOrder}`;
  else if (field === "publishedAt") expr = sql`${entries.publishedAt}`;
  else if (field === "createdAt") expr = sql`${entries.createdAt}`;
  else if (defs.some((d) => d.name === field)) expr = jsonExtract(field);
  else throw badRequest(`Unknown sort field "${field}"`);
  return dir === "desc" ? desc(expr) : asc(expr);
}

// --- queries -----------------------------------------------------------------

export async function queryCollectionContent(
  db: DrizzleDb,
  origin: string,
  { collection, defs }: DeliveryCollection,
  query: ContentQuery,
): Promise<{ response: DeliveryListResponse; etag: string }> {
  const conds = [eq(entries.collectionId, collection.id), isNotNull(entries.publishedData)];
  for (const filter of buildFilters(defs, query.filters)) conds.push(filter);
  const where = and(...conds);

  const totalRow = await db.select({ n: count() }).from(entries).where(where).get();
  const rows = await db
    .select()
    .from(entries)
    .where(where)
    .orderBy(buildSort(defs, query.sort))
    .limit(query.limit)
    .offset(query.offset)
    .all();

  const data = rows.map((r) => toDeliveryEntry(r, defs));
  await expandMedia(db, origin, defs, data);
  await expandReferences(db, defs, data);

  // ETag changes when the collection's content changes (content_version) OR when the
  // query shape changes — so two different filters never share a 304. `refSig` folds in
  // the versions of every expanded target collection, so renaming a referenced entry
  // busts this list too. (If opt-in deeper/`expand` is ever added, its shape must also be
  // folded into `queryKey` here, or expanded and non-expanded responses collide on a 304.)
  const refSig = await referencedVersionSignature(db, defs);
  const baseKey = `${query.limit}:${query.offset}:${query.sort ?? ""}:${query.filters
    .map((f) => `${f.field}.${f.op}=${f.value}`)
    .join("&")}`;
  const queryKey = refSig ? `${baseKey}:${refSig}` : baseKey;
  const etag = `W/"${collection.slug}-${collection.contentVersion}-${hashString(queryKey)}"`;

  return {
    response: {
      data,
      meta: { total: totalRow?.n ?? 0, limit: query.limit, offset: query.offset },
    },
    etag,
  };
}

export async function getSingletonContent(
  db: DrizzleDb,
  origin: string,
  { collection, defs }: DeliveryCollection,
): Promise<{ data: DeliveryEntry; etag: string }> {
  const row = await db
    .select()
    .from(entries)
    .where(and(eq(entries.collectionId, collection.id), isNotNull(entries.publishedData)))
    .orderBy(asc(entries.createdAt))
    .limit(1)
    .get();
  if (!row) throw notFound("Not published");
  const data = toDeliveryEntry(row, defs);
  await expandMedia(db, origin, defs, [data]);
  await expandReferences(db, defs, [data]);
  return { data, etag: entryEtag(row, await referencedVersionSignature(db, defs)) };
}

export async function getContentItem(
  db: DrizzleDb,
  origin: string,
  { collection, defs }: DeliveryCollection,
  idOrSlug: string,
): Promise<{ data: DeliveryEntry; etag: string }> {
  const row = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.collectionId, collection.id),
        isNotNull(entries.publishedData),
        or(eq(entries.id, idOrSlug), eq(entries.slug, idOrSlug)),
      ),
    )
    .get();
  if (!row) throw notFound("Not found");
  const data = toDeliveryEntry(row, defs);
  await expandMedia(db, origin, defs, [data]);
  await expandReferences(db, defs, [data]);
  return { data, etag: entryEtag(row, await referencedVersionSignature(db, defs)) };
}
