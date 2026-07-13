import { and, asc, eq, inArray, like, ne, or } from "drizzle-orm";

import type { DrizzleDb } from "../db/client";
import { collections, entries } from "../db/schema";
import { validationError } from "../lib/errors";

import { D1_IN_CHUNK } from "@/shared/constants";
import type { FieldDefinition } from "@/shared/validation";
import type { EntryData, EntryUsage } from "@/shared/api-types";

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
