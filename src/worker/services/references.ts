import { and, asc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { DrizzleDb } from "../db/client";
import { collections, entries, fields } from "../db/schema";
import { hashString } from "../lib/hash";
import { notFound, validationError } from "../lib/errors";

import { D1_IN_CHUNK } from "@/shared/constants";
import { parseFieldOptions, type FieldOptions } from "@/shared/field-types";
import type { FieldDefinition } from "@/shared/validation";
import type { EntryData, EntryUsage, ReferenceMigrationResult } from "@/shared/api-types";

// A reference field stores a target entry id (or an ordered id[] when `multiple`)
// in the entry JSON — the media pattern (services/media.ts) pointed at `entries`.
// This module owns the server-side checks zod can't express: existence, the
// target-collection constraint, publish-readiness for required refs, slug→id
// resolution for agent/REST callers, and the reverse "what references X" scan.

/** Allowed target collection slugs for a reference field. null = any (empty / ["*"]). */
function allowedTargets(def: FieldDefinition): Set<string> | null {
  const targets = def.options.targetCollections;
  if (!targets || targets.length === 0 || targets.includes("*")) return null;
  return new Set(targets);
}

/** Every non-empty id string a reference field's value carries (single or multiple). */
export function referenceIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  if (typeof value === "string" && value) return [value];
  return [];
}

/** Batch-load referenced entries → their collection slug + whether they're published. */
async function fetchEntryTargets(
  db: DrizzleDb,
  ids: string[],
): Promise<Map<string, { collectionSlug: string; hasPublished: boolean }>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, { collectionSlug: string; hasPublished: boolean }>();
  for (let i = 0; i < unique.length; i += D1_IN_CHUNK) {
    const chunk = unique.slice(i, i + D1_IN_CHUNK);
    const rows = await db
      .select({
        id: entries.id,
        collectionSlug: collections.slug,
        publishedData: entries.publishedData,
      })
      .from(entries)
      .innerJoin(collections, eq(entries.collectionId, collections.id))
      .where(inArray(entries.id, chunk))
      .all();
    for (const r of rows) {
      out.set(r.id, { collectionSlug: r.collectionSlug, hasPublished: r.publishedData !== null });
    }
  }
  return out;
}

/**
 * Validate that every reference value points at an existing entry in an allowed target
 * collection. Called by the entries service on write, mirroring assertMediaRefs; throws
 * fieldErrors keyed by field name.
 *
 * With `requirePublishedTargets` (publish time), a *required* reference whose target has
 * no published version is rejected — otherwise it would publish and then resolve to `null`
 * at delivery. Non-required references stay permissive (they resolve to null until live).
 */
export async function assertEntryRefs(
  db: DrizzleDb,
  defs: FieldDefinition[],
  data: EntryData,
  opts: { requirePublishedTargets?: boolean } = {},
): Promise<void> {
  const refs: { field: string; id: string; allowed: Set<string> | null; required: boolean }[] = [];
  for (const def of defs) {
    if (def.type !== "reference") continue;
    const allowed = allowedTargets(def);
    const required = def.options.required === true;
    for (const id of referenceIds(data[def.name])) {
      refs.push({ field: def.name, id, allowed, required });
    }
  }
  if (refs.length === 0) return;

  const byId = await fetchEntryTargets(db, refs.map((r) => r.id));
  const fieldErrors: Record<string, string> = {};
  for (const ref of refs) {
    if (fieldErrors[ref.field]) continue; // first error per field wins
    const row = byId.get(ref.id);
    if (!row) {
      fieldErrors[ref.field] = "Referenced entry no longer exists";
    } else if (ref.allowed && !ref.allowed.has(row.collectionSlug)) {
      fieldErrors[ref.field] = `Referenced entry must be in: ${[...ref.allowed].join(", ")}`;
    } else if (opts.requirePublishedTargets && ref.required && !row.hasPublished) {
      fieldErrors[ref.field] = "Referenced entry must be published before this entry can be published";
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw validationError("Some references are invalid", fieldErrors);
  }
}

/** Batch-load entries by slug → the (possibly several) entries sharing that slug. */
async function fetchEntriesBySlug(
  db: DrizzleDb,
  slugs: string[],
): Promise<Map<string, { id: string; collectionSlug: string }[]>> {
  const unique = [...new Set(slugs)];
  const out = new Map<string, { id: string; collectionSlug: string }[]>();
  for (let i = 0; i < unique.length; i += D1_IN_CHUNK) {
    const chunk = unique.slice(i, i + D1_IN_CHUNK);
    const rows = await db
      .select({ id: entries.id, slug: entries.slug, collectionSlug: collections.slug })
      .from(entries)
      .innerJoin(collections, eq(entries.collectionId, collections.id))
      .where(inArray(entries.slug, chunk))
      .all();
    for (const r of rows) {
      if (r.slug === null) continue;
      const list = out.get(r.slug) ?? [];
      list.push({ id: r.id, collectionSlug: r.collectionSlug });
      out.set(r.slug, list);
    }
  }
  return out;
}

/**
 * Rewrite reference values so callers may pass a target entry *slug* instead of an id —
 * a convenience for agents/REST callers (the admin UI always sends ids, so this no-ops).
 * A value that is already a known entry id is left untouched. Slugs are unique only per
 * (collection, locale), so resolution is scoped to the field's allowed target collections
 * and any ambiguous slug is left as-is for assertEntryRefs to reject with a clear error.
 */
export async function resolveReferenceValues(
  db: DrizzleDb,
  defs: FieldDefinition[],
  data: EntryData,
): Promise<EntryData> {
  const refDefs = defs.filter((d) => d.type === "reference");
  if (refDefs.length === 0) return data;

  const candidates = new Set<string>();
  for (const def of refDefs) {
    for (const v of referenceIds(data[def.name])) candidates.add(v);
  }
  if (candidates.size === 0) return data;

  // Which candidates are already real entry ids? Those need no resolution.
  const all = [...candidates];
  const knownIds = new Set<string>();
  for (let i = 0; i < all.length; i += D1_IN_CHUNK) {
    const chunk = all.slice(i, i + D1_IN_CHUNK);
    const rows = await db.select({ id: entries.id }).from(entries).where(inArray(entries.id, chunk)).all();
    for (const r of rows) knownIds.add(r.id);
  }

  const unresolved = all.filter((v) => !knownIds.has(v));
  if (unresolved.length === 0) return data;

  const bySlug = await fetchEntriesBySlug(db, unresolved);

  const out: EntryData = { ...data };
  for (const def of refDefs) {
    const allowed = allowedTargets(def);
    const value = data[def.name];
    const rewriteOne = (v: unknown): unknown => {
      if (typeof v !== "string" || !v || knownIds.has(v)) return v;
      const matches = (bySlug.get(v) ?? []).filter((m) => !allowed || allowed.has(m.collectionSlug));
      return matches.length === 1 ? matches[0].id : v; // ambiguous / none → leave as-is
    };
    if (Array.isArray(value)) {
      out[def.name] = value.map(rewriteOne);
    } else if (typeof value === "string") {
      out[def.name] = rewriteOne(value);
    }
  }
  return out;
}

/** Best-effort human title for a usage row, drawn from the collection's title field. */
function titleFromJson(json: string, titleField: string | null): string {
  if (!titleField) return "Untitled";
  try {
    const data = JSON.parse(json) as EntryData;
    const v = data[titleField];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  } catch {
    /* fall through */
  }
  return "Untitled";
}

/**
 * Entries that reference the given entry id in their draft or published JSON (LIKE scan),
 * excluding the entry itself. Generalizes getMediaUsage for the pre-delete usage warning:
 * ids are stored as quoted JSON string values, so `"<id>"` avoids substring false positives.
 */
export async function getEntryUsage(db: DrizzleDb, id: string): Promise<EntryUsage> {
  const needle = `%"${id}"%`;
  const rows = await db
    .select({
      entryId: entries.id,
      draftData: entries.draftData,
      collectionSlug: collections.slug,
      collectionName: collections.name,
      titleField: collections.titleField,
    })
    .from(entries)
    .innerJoin(collections, eq(entries.collectionId, collections.id))
    .where(and(or(like(entries.draftData, needle), like(entries.publishedData, needle)), ne(entries.id, id)))
    .orderBy(asc(collections.name))
    .all();

  return {
    entries: rows.map((r) => ({
      entryId: r.entryId,
      collectionSlug: r.collectionSlug,
      collectionName: r.collectionName,
      title: titleFromJson(r.draftData, r.titleField),
    })),
  };
}

// --- string → reference migration (WS7) --------------------------------------
// Converts the legacy "link by name string" pattern into real references: for each
// source entry, the fromField string is matched (trimmed, case-insensitive) against the
// target collection's titles, and the resolved target id is written into the new reference
// field. It writes JSON directly (like remapImportedReferences) rather than routing through
// updateEntry — that's the only way to convert `published_data` without a re-publish, and the
// written id is safe by construction (it's an existing entry in an allowed target collection,
// so assertEntryRefs would pass anyway). Ambiguous names are reported, never auto-resolved.

function parseEntryJson(text: string): EntryData {
  try {
    return JSON.parse(text) as EntryData;
  } catch {
    return {};
  }
}

interface CollectionMeta {
  id: string;
  titleField: string | null;
  fields: { name: string; type: FieldDefinition["type"]; options: FieldOptions }[];
}

/** Load a collection's id, title field and parsed field defs by slug (local to avoid a cycle). */
async function loadCollectionMeta(db: DrizzleDb, slug: string): Promise<CollectionMeta> {
  const col = await db
    .select({ id: collections.id, titleField: collections.titleField })
    .from(collections)
    .where(eq(collections.slug, slug))
    .get();
  if (!col) throw notFound(`Collection "${slug}" not found`);
  const rows = await db
    .select({ name: fields.name, type: fields.type, options: fields.options })
    .from(fields)
    .where(eq(fields.collectionId, col.id))
    .orderBy(asc(fields.sortOrder))
    .all();
  return {
    id: col.id,
    titleField: col.titleField,
    fields: rows.map((r) => {
      let options: FieldOptions = {};
      try {
        options = parseFieldOptions(r.type, JSON.parse(r.options));
      } catch {
        options = {};
      }
      return { name: r.name, type: r.type, options };
    }),
  };
}

/** The title used to match a target entry, or null when it carries no usable title value. */
function matchableTitle(data: EntryData, titleField: string): string | null {
  const v = data[titleField];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Whether a stored reference value already equals the one we'd write (skip redundant updates). */
function referenceValueEquals(current: unknown, next: string | string[]): boolean {
  if (Array.isArray(next)) {
    return Array.isArray(current) && current.length === next.length && current.every((v, i) => v === next[i]);
  }
  return current === next;
}

export interface MigrateStringFieldToReferenceInput {
  /** Slug of the collection whose entries hold the string links. */
  collectionSlug: string;
  /** Existing field holding the target's name/title (read as a string). */
  fromField: string;
  /** The `reference` field to populate (must already exist on the collection). */
  toField: string;
  /** Slug of the collection the names point at; its title field is matched. */
  targetCollectionSlug: string;
}

/**
 * Backfill a `reference` field from a legacy name-string field. See the module comment above.
 * Returns the result plus `publishedChanged` — true only when a row that already had a
 * published version was modified — so the caller knows whether to fire a deploy hook (the
 * collection's contentVersion is bumped here in the same batch when so).
 */
export async function migrateStringFieldToReference(
  db: DrizzleDb,
  input: MigrateStringFieldToReferenceInput,
): Promise<{ result: ReferenceMigrationResult; publishedChanged: boolean }> {
  const { collectionSlug, fromField, toField, targetCollectionSlug } = input;
  if (fromField === toField) {
    throw validationError("fromField and toField must be different fields", {
      toField: "Choose a field other than fromField",
    });
  }

  const source = await loadCollectionMeta(db, collectionSlug);
  const fromDef = source.fields.find((f) => f.name === fromField);
  if (!fromDef) {
    throw validationError(`Field "${fromField}" not found on "${collectionSlug}"`, { fromField: "Unknown field" });
  }
  const toDef = source.fields.find((f) => f.name === toField);
  if (!toDef) {
    throw validationError(`Field "${toField}" not found on "${collectionSlug}"`, { toField: "Unknown field" });
  }
  if (toDef.type !== "reference") {
    throw validationError(`Field "${toField}" is not a reference field`, { toField: "Must be a reference field" });
  }

  const target = await loadCollectionMeta(db, targetCollectionSlug);
  const titleField = target.titleField;
  if (!titleField) {
    throw validationError(
      `Target collection "${targetCollectionSlug}" has no title field to match names against — set one first`,
      { targetCollection: "Target collection needs a title field" },
    );
  }

  // The destination reference must actually allow this target collection, or the migration
  // would write values assertEntryRefs rejects on the next edit. [] / ["*"] = any collection.
  const allowed = toDef.options.targetCollections;
  if (allowed && allowed.length > 0 && !allowed.includes("*") && !allowed.includes(targetCollectionSlug)) {
    throw validationError(
      `Reference field "${toField}" does not allow targets in "${targetCollectionSlug}"`,
      { targetCollection: `Allowed target collections: ${allowed.join(", ")}` },
    );
  }
  const multiple = toDef.options.multiple === true;

  // Index the target collection by (lower-cased, trimmed) draft title — the same title the
  // admin picker shows — mapping to the id(s) that share it. A shared title → ambiguous.
  const targetRows = await db
    .select({ id: entries.id, draftData: entries.draftData })
    .from(entries)
    .where(eq(entries.collectionId, target.id))
    .all();
  const idsByTitle = new Map<string, string[]>();
  for (const row of targetRows) {
    const title = matchableTitle(parseEntryJson(row.draftData), titleField);
    if (title === null) continue;
    const key = title.toLowerCase();
    const list = idsByTitle.get(key) ?? [];
    list.push(row.id);
    idsByTitle.set(key, list);
  }

  const sourceRows = await db
    .select({ id: entries.id, draftData: entries.draftData, publishedData: entries.publishedData })
    .from(entries)
    .where(eq(entries.collectionId, source.id))
    .all();

  const result: ReferenceMigrationResult = { converted: 0, unmatched: [], ambiguous: [] };
  const updates: BatchItem<"sqlite">[] = [];
  let publishedChanged = false;

  for (const row of sourceRows) {
    const draft = parseEntryJson(row.draftData);
    const raw = draft[fromField];
    if (typeof raw !== "string" || !raw.trim()) continue; // nothing to convert on this entry
    const value = raw.trim();

    const matches = idsByTitle.get(value.toLowerCase()) ?? [];
    if (matches.length === 0) {
      result.unmatched.push({ entryId: row.id, value });
      continue;
    }
    if (matches.length > 1) {
      result.ambiguous.push({ entryId: row.id, value, candidateIds: matches });
      continue; // never silently pick one
    }

    result.converted += 1;
    const refValue: string | string[] = multiple ? [matches[0]] : matches[0];

    const published = row.publishedData === null ? null : parseEntryJson(row.publishedData);
    let changed = false;
    if (!referenceValueEquals(draft[toField], refValue)) {
      draft[toField] = refValue;
      changed = true;
    }
    if (published && !referenceValueEquals(published[toField], refValue)) {
      published[toField] = refValue;
      changed = true;
      publishedChanged = true; // a live row changed → delivery must be invalidated
    }
    if (!changed) continue; // already migrated (idempotent re-run)

    // Recompute publishedEtag from the exact bytes stored — item/singleton ETags derive from
    // it (not contentVersion), so a stale etag would serve a 304 with the old data forever.
    const publishedJson = published === null ? null : JSON.stringify(published);
    updates.push(
      db
        .update(entries)
        .set({
          draftData: JSON.stringify(draft),
          publishedData: publishedJson,
          publishedEtag: publishedJson === null ? null : hashString(publishedJson),
        })
        .where(eq(entries.id, row.id)),
    );
  }

  // Bump the source collection's contentVersion so delivery *list* ETags change too — but only
  // when live content actually moved (a draft-only conversion is invisible to delivery).
  if (publishedChanged) {
    updates.push(
      db
        .update(collections)
        .set({ contentVersion: sql`${collections.contentVersion} + 1`, updatedAt: Date.now() })
        .where(eq(collections.id, source.id)),
    );
  }

  for (let i = 0; i < updates.length; i += D1_IN_CHUNK) {
    const slice = updates.slice(i, i + D1_IN_CHUNK);
    await db.batch(slice as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }

  return { result, publishedChanged };
}
