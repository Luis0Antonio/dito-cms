import { and, asc, count, eq, isNull, like, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";

import type { DrizzleDb } from "../db/client";
import {
  collections,
  entries,
  fields,
  type CollectionRow,
  type EntryRow,
  type FieldRow,
} from "../db/schema";
import { hashString } from "../lib/hash";
import { badRequest, conflict, notFound, validationError } from "../lib/errors";
import { assertMediaRefs } from "./media";
import { assertEntryRefs, resolveReferenceValues } from "./references";
import { regenerateRichText, seedDefaults, validateFieldData } from "./field-data";

import { parseFieldOptions, type FieldOptions } from "@/shared/field-types";
import { type FieldDefinition } from "@/shared/validation";
import { isValidSlug } from "@/shared/slug";
import type {
  EntryData,
  EntryDetail,
  EntryListResult,
  EntryRef,
  EntryStatus,
  EntrySummary,
  ExportedEntry,
  ListEntriesParams,
} from "@/shared/api-types";

// Entry content lives as JSON in `entries`; this module is the single owner of the
// draft→publish lifecycle. Admin routes and (Phase 5) MCP tools both call these.

export interface CreateEntryInput {
  data?: EntryData;
  slug?: string | null;
  publish?: boolean;
  /** Resolve reference values given as a target entry *slug* to its id (MCP/REST convenience). */
  resolveReferences?: boolean;
}

export interface UpdateEntryPatch {
  data?: EntryData;
  slug?: string | null;
  sortOrder?: number;
  /** Resolve reference values given as a target entry *slug* to its id (MCP/REST convenience). */
  resolveReferences?: boolean;
}

interface LoadedCollection {
  collection: CollectionRow;
  defs: FieldDefinition[];
}

// --- loading + mapping -------------------------------------------------------

function parseJson(text: string): EntryData {
  try {
    return JSON.parse(text) as EntryData;
  } catch {
    return {};
  }
}

function toDefs(rows: FieldRow[]): FieldDefinition[] {
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

async function loadFieldDefs(db: DrizzleDb, collectionId: string): Promise<FieldDefinition[]> {
  const rows = await db
    .select()
    .from(fields)
    .where(eq(fields.collectionId, collectionId))
    .orderBy(asc(fields.sortOrder))
    .all();
  return toDefs(rows);
}

async function loadBySlug(db: DrizzleDb, slug: string): Promise<LoadedCollection> {
  const collection = await db.select().from(collections).where(eq(collections.slug, slug)).get();
  if (!collection) throw notFound(`Collection "${slug}" not found`);
  return { collection, defs: await loadFieldDefs(db, collection.id) };
}

async function loadById(db: DrizzleDb, id: string): Promise<LoadedCollection> {
  const collection = await db.select().from(collections).where(eq(collections.id, id)).get();
  if (!collection) throw notFound("Collection not found");
  return { collection, defs: await loadFieldDefs(db, collection.id) };
}

async function findEntry(db: DrizzleDb, id: string): Promise<EntryRow> {
  const row = await db.select().from(entries).where(eq(entries.id, id)).get();
  if (!row) throw notFound("Entry not found");
  return row;
}

async function firstEntry(db: DrizzleDb, collectionId: string): Promise<EntryRow | undefined> {
  return db
    .select()
    .from(entries)
    .where(eq(entries.collectionId, collectionId))
    .orderBy(asc(entries.createdAt))
    .limit(1)
    .get();
}

/** published_data IS NULL → draft; draft newer than publish → changed; else published. */
function deriveStatus(row: EntryRow): EntryStatus {
  if (row.publishedData === null) return "draft";
  if (row.publishedAt !== null && row.draftUpdatedAt > row.publishedAt) return "changed";
  return "published";
}

/** Best-effort human title for the list, drawn from the collection's title field. */
function titlePreview(draft: EntryData, titleField: string | null): string {
  if (titleField) {
    const v = draft[titleField];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (typeof obj.label === "string" && obj.label.trim()) return obj.label.trim();
      if (typeof obj.url === "string" && obj.url.trim()) return obj.url.trim();
    }
  }
  return "Untitled";
}

function mapDetail(row: EntryRow): EntryDetail {
  return {
    id: row.id,
    collectionId: row.collectionId,
    slug: row.slug,
    status: deriveStatus(row),
    draftData: parseJson(row.draftData),
    publishedData: row.publishedData === null ? null : parseJson(row.publishedData),
    sortOrder: row.sortOrder,
    draftUpdatedAt: row.draftUpdatedAt,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapSummary(row: EntryRow, titleField: string | null): EntrySummary {
  return {
    id: row.id,
    slug: row.slug,
    status: deriveStatus(row),
    title: titlePreview(parseJson(row.draftData), titleField),
    sortOrder: row.sortOrder,
    draftUpdatedAt: row.draftUpdatedAt,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
}

// --- normalization + validation ----------------------------------------------

/** Validate entry data with entry-specific messages (wraps the shared validator). */
function validate(defs: FieldDefinition[], data: EntryData, mode: "draft" | "publish"): EntryData {
  return validateFieldData(defs, data, mode, {
    draft: "Some fields are invalid",
    publish: "Entry is not ready to publish",
  });
}

function normalizeEntrySlug(slug: string | null | undefined): string | null {
  if (slug === null || slug === undefined) return null;
  const trimmed = slug.trim();
  if (trimmed === "") return null;
  if (!isValidSlug(trimmed)) {
    throw validationError("Invalid slug", {
      slug: "Use lowercase letters, numbers and hyphens, starting with a letter",
    });
  }
  return trimmed;
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}

function bumpVersion(db: DrizzleDb, collectionId: string, now: number): BatchItem<"sqlite"> {
  return db
    .update(collections)
    .set({ contentVersion: sql`${collections.contentVersion} + 1`, updatedAt: now })
    .where(eq(collections.id, collectionId));
}

async function nextSortOrder(db: DrizzleDb, collectionId: string): Promise<number> {
  const row = await db
    .select({ max: sql<number | null>`max(${entries.sortOrder})` })
    .from(entries)
    .where(eq(entries.collectionId, collectionId))
    .get();
  return (row?.max ?? 0) + 1024;
}

// --- queries -----------------------------------------------------------------

function statusCondition(status: EntryStatus): SQL {
  if (status === "draft") return isNull(entries.publishedData);
  if (status === "changed") {
    return sql`${entries.publishedData} IS NOT NULL AND ${entries.draftUpdatedAt} > ${entries.publishedAt}`;
  }
  return sql`${entries.publishedData} IS NOT NULL AND ${entries.draftUpdatedAt} <= ${entries.publishedAt}`;
}

export async function listEntries(
  db: DrizzleDb,
  slug: string,
  params: ListEntriesParams,
): Promise<EntryListResult> {
  const { collection } = await loadBySlug(db, slug);
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);

  const conds = [eq(entries.collectionId, collection.id)];
  if (params.status) conds.push(statusCondition(params.status));
  if (params.search && params.search.trim()) {
    conds.push(like(entries.draftData, `%${params.search.trim()}%`));
  }
  const where = and(...conds);

  const totalRow = await db.select({ n: count() }).from(entries).where(where).get();
  const rows = await db
    .select()
    .from(entries)
    .where(where)
    .orderBy(asc(entries.sortOrder), asc(entries.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  return {
    entries: rows.map((r) => mapSummary(r, collection.titleField)),
    total: totalRow?.n ?? 0,
  };
}

export async function getEntryDetail(db: DrizzleDb, id: string): Promise<EntryDetail> {
  return mapDetail(await findEntry(db, id));
}

/** A lightweight resolved reference target (id → title/slug/collection/status) for pickers. */
export async function getEntryRef(db: DrizzleDb, id: string): Promise<EntryRef> {
  const row = await db
    .select({
      entry: entries,
      collectionSlug: collections.slug,
      titleField: collections.titleField,
    })
    .from(entries)
    .innerJoin(collections, eq(entries.collectionId, collections.id))
    .where(eq(entries.id, id))
    .get();
  if (!row) throw notFound("Entry not found");
  return {
    id: row.entry.id,
    title: titlePreview(parseJson(row.entry.draftData), row.titleField),
    slug: row.entry.slug,
    collectionSlug: row.collectionSlug,
    status: deriveStatus(row.entry),
  };
}

export async function countEntriesByCollection(db: DrizzleDb): Promise<Map<string, number>> {
  const rows = await db
    .select({ collectionId: entries.collectionId, n: count() })
    .from(entries)
    .groupBy(entries.collectionId)
    .all();
  return new Map(rows.map((r) => [r.collectionId, r.n]));
}

export async function countEntries(db: DrizzleDb, collectionId: string): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(entries)
    .where(eq(entries.collectionId, collectionId))
    .get();
  return row?.n ?? 0;
}

/** Count entries with a published version — used to decide whether a delete fires a deploy hook. */
export async function countPublishedEntries(db: DrizzleDb, collectionId: string): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(entries)
    .where(and(eq(entries.collectionId, collectionId), sql`${entries.publishedData} IS NOT NULL`))
    .get();
  return row?.n ?? 0;
}

// --- mutations ---------------------------------------------------------------

export async function createEntry(
  db: DrizzleDb,
  slug: string,
  input: CreateEntryInput,
  userId: string | undefined,
): Promise<EntryDetail> {
  const { collection, defs } = await loadBySlug(db, slug);
  if (collection.type === "singleton" && (await firstEntry(db, collection.id))) {
    throw conflict("This singleton already has an entry");
  }

  const inputData = input.resolveReferences
    ? await resolveReferenceValues(db, defs, input.data ?? {})
    : input.data ?? {};
  const merged = { ...seedDefaults(defs), ...inputData };
  const normalized = regenerateRichText(defs, merged);
  const draftData = validate(defs, normalized, "draft");
  await assertMediaRefs(db, defs, draftData);
  await assertEntryRefs(db, defs, draftData);
  const slugValue = normalizeEntrySlug(input.slug);

  const now = Date.now();
  const id = nanoid();
  const sortOrder = await nextSortOrder(db, collection.id);

  let publishedJson: string | null = null;
  let publishedEtag: string | null = null;
  let publishedAt: number | null = null;
  if (input.publish) {
    const publishedData = validate(defs, normalized, "publish");
    await assertEntryRefs(db, defs, publishedData, { requirePublishedTargets: true });
    publishedJson = JSON.stringify(publishedData);
    publishedEtag = hashString(publishedJson);
    publishedAt = now;
  }

  const insert = db.insert(entries).values({
    id,
    collectionId: collection.id,
    slug: slugValue,
    locale: "",
    draftData: JSON.stringify(draftData),
    publishedData: publishedJson,
    publishedEtag,
    sortOrder,
    draftUpdatedAt: now,
    publishedAt,
    createdAt: now,
    updatedAt: now,
    createdBy: userId ?? null,
    updatedBy: userId ?? null,
  });

  try {
    if (input.publish) {
      await db.batch([insert, bumpVersion(db, collection.id, now)]);
    } else {
      await insert.run();
    }
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("Slug already in use", { slug: "Slug already in use" });
    throw err;
  }

  return getEntryDetail(db, id);
}

export async function updateEntry(
  db: DrizzleDb,
  id: string,
  patch: UpdateEntryPatch,
  userId: string | undefined,
): Promise<EntryDetail> {
  const row = await findEntry(db, id);
  const { defs } = await loadById(db, row.collectionId);

  const now = Date.now();
  const values: Partial<typeof entries.$inferInsert> = { updatedAt: now, updatedBy: userId ?? null };

  if (patch.data !== undefined) {
    const patchData = patch.resolveReferences
      ? await resolveReferenceValues(db, defs, patch.data)
      : patch.data;
    const merged = { ...parseJson(row.draftData), ...patchData };
    const normalized = regenerateRichText(defs, merged);
    const draft = validate(defs, normalized, "draft");
    await assertMediaRefs(db, defs, draft);
    await assertEntryRefs(db, defs, draft);
    values.draftData = JSON.stringify(draft);
    values.draftUpdatedAt = now;
  }
  if (patch.slug !== undefined) values.slug = normalizeEntrySlug(patch.slug);
  if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder;

  try {
    await db.update(entries).set(values).where(eq(entries.id, id)).run();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("Slug already in use", { slug: "Slug already in use" });
    throw err;
  }

  return getEntryDetail(db, id);
}

export async function publishEntry(
  db: DrizzleDb,
  id: string,
  userId: string | undefined,
): Promise<EntryDetail> {
  const row = await findEntry(db, id);
  const { collection, defs } = await loadById(db, row.collectionId);

  const normalized = regenerateRichText(defs, parseJson(row.draftData));
  const publishedData = validate(defs, normalized, "publish");
  await assertMediaRefs(db, defs, publishedData);
  await assertEntryRefs(db, defs, publishedData, { requirePublishedTargets: true });
  const publishedJson = JSON.stringify(publishedData);
  const etag = hashString(publishedJson);
  const now = Date.now();

  await db.batch([
    db
      .update(entries)
      .set({
        publishedData: publishedJson,
        publishedEtag: etag,
        publishedAt: now,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .where(eq(entries.id, id)),
    bumpVersion(db, collection.id, now),
  ]);

  return getEntryDetail(db, id);
}

export async function unpublishEntry(
  db: DrizzleDb,
  id: string,
  userId: string | undefined,
): Promise<EntryDetail> {
  const row = await findEntry(db, id);
  const now = Date.now();
  await db.batch([
    db
      .update(entries)
      .set({
        publishedData: null,
        publishedEtag: null,
        publishedAt: null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .where(eq(entries.id, id)),
    bumpVersion(db, row.collectionId, now),
  ]);
  return getEntryDetail(db, id);
}

/** Revert the draft to the currently-published version (only when published). */
export async function discardDraft(
  db: DrizzleDb,
  id: string,
  userId: string | undefined,
): Promise<EntryDetail> {
  const row = await findEntry(db, id);
  if (row.publishedData === null || row.publishedAt === null) {
    throw badRequest("There are no published changes to revert to");
  }
  const now = Date.now();
  await db
    .update(entries)
    .set({
      draftData: row.publishedData,
      draftUpdatedAt: row.publishedAt,
      updatedAt: now,
      updatedBy: userId ?? null,
    })
    .where(eq(entries.id, id))
    .run();
  return getEntryDetail(db, id);
}

/** Returns whether the deleted entry was published, so callers can fire a deploy hook. */
export async function deleteEntry(db: DrizzleDb, id: string): Promise<{ wasPublished: boolean }> {
  const row = await findEntry(db, id);
  const now = Date.now();
  const wasPublished = row.publishedData !== null;
  if (wasPublished) {
    // Was live → bump content_version so delivery list ETags change.
    await db.batch([
      db.delete(entries).where(eq(entries.id, id)),
      bumpVersion(db, row.collectionId, now),
    ]);
  } else {
    await db.delete(entries).where(eq(entries.id, id)).run();
  }
  return { wasPublished };
}

export async function reorderEntries(db: DrizzleDb, slug: string, ids: string[]): Promise<void> {
  if (ids.length === 0) throw badRequest("`ids` must be a non-empty array");
  const { collection } = await loadBySlug(db, slug);
  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = ids.map((id, index) =>
    db
      .update(entries)
      .set({ sortOrder: (index + 1) * 1024, updatedAt: now })
      .where(and(eq(entries.id, id), eq(entries.collectionId, collection.id))),
  );
  // Reordering changes published list order → invalidate list ETags.
  statements.push(bumpVersion(db, collection.id, now));
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/**
 * Bulk-insert entries from an export bundle into a freshly-created collection.
 *
 * Reuses the same lifecycle internals as createEntry: rich_text HTML is regenerated
 * server-side (no stored XSS) and both draft and published payloads are schema-validated.
 * Media references are deliberately NOT checked (`assertMediaRefs` is skipped) — exports carry
 * media ids by reference and the target instance may not hold those assets. Entry references
 * (`assertEntryRefs`) are likewise skipped: ids are re-minted here, so a source reference value
 * would fail an existence check. NOTE: preserving cross-entry references across import (an
 * old→new id remap pass) is a separate, not-yet-built step; until it lands, imported reference
 * values keep their SOURCE ids and will resolve to `null` in the target instance.
 *
 * All timestamps, slug and sortOrder are preserved from the export so the derived status
 * (draft/published/changed) is reproduced. Runs as one D1 batch.
 */
export async function importEntries(
  db: DrizzleDb,
  collectionId: string,
  defs: FieldDefinition[],
  exported: ExportedEntry[],
  userId: string | undefined,
): Promise<number> {
  if (exported.length === 0) return 0;

  const statements: BatchItem<"sqlite">[] = exported.map((e) => {
    const draftData = validate(defs, regenerateRichText(defs, e.draftData ?? {}), "draft");

    let publishedJson: string | null = null;
    let publishedEtag: string | null = null;
    let publishedAt: number | null = null;
    if (e.publishedData !== null && e.publishedData !== undefined) {
      const publishedData = validate(defs, regenerateRichText(defs, e.publishedData), "publish");
      publishedJson = JSON.stringify(publishedData);
      publishedEtag = hashString(publishedJson);
      publishedAt = e.publishedAt;
    }

    return db.insert(entries).values({
      id: nanoid(),
      collectionId,
      slug: normalizeEntrySlug(e.slug),
      locale: e.locale ?? "",
      draftData: JSON.stringify(draftData),
      publishedData: publishedJson,
      publishedEtag,
      sortOrder: e.sortOrder,
      draftUpdatedAt: e.draftUpdatedAt,
      publishedAt,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      createdBy: userId ?? null,
      updatedBy: userId ?? null,
    });
  });

  try {
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("Duplicate entry slug in import data", { slug: "Slug already in use" });
    }
    throw err;
  }
  return exported.length;
}

/** Idempotent get-or-create of a singleton's sole entry. */
export async function getOrCreateSingletonEntry(
  db: DrizzleDb,
  slug: string,
  userId: string | undefined,
): Promise<EntryDetail> {
  const { collection, defs } = await loadBySlug(db, slug);
  if (collection.type !== "singleton") throw badRequest("Not a singleton collection");

  const existing = await firstEntry(db, collection.id);
  if (existing) return mapDetail(existing);

  const draftData = validate(defs, regenerateRichText(defs, seedDefaults(defs)), "draft");
  const now = Date.now();
  const id = nanoid();
  await db
    .insert(entries)
    .values({
      id,
      collectionId: collection.id,
      slug: null,
      locale: "",
      draftData: JSON.stringify(draftData),
      publishedData: null,
      publishedEtag: null,
      sortOrder: 1024,
      draftUpdatedAt: now,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: userId ?? null,
      updatedBy: userId ?? null,
    })
    .run();
  return getEntryDetail(db, id);
}
