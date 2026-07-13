import { asc, eq } from "drizzle-orm";

import type { DrizzleDb } from "../db/client";
import { collections, entries, fields } from "../db/schema";
import { badRequest } from "../lib/errors";
import { createCollection, deleteCollection, updateCollection } from "./collections";
import { importEntries, remapImportedReferences, type RemapGroup } from "./entries";

import { isFieldType, parseFieldOptions, type FieldOptions } from "@/shared/field-types";
import type { FieldDefinition } from "@/shared/validation";
import type {
  EntryData,
  ExportDocument,
  ExportedCollection,
  ExportedField,
  ImportPreview,
  ImportPreviewCollection,
  ImportResolution,
  ImportResult,
} from "@/shared/api-types";

// Whole-project export/import. Owns the versioned bundle format and conflict handling.
// Collection + field validation is delegated to createCollection (services/collections.ts)
// and entry validation to importEntries (services/entries.ts) so there's one source of truth.
//
// Atomicity note: each collection is created (collection+fields batch inside createCollection)
// then its entries are inserted in a second batch — not a single transaction. Acceptable for
// an admin backup/restore tool; a failure mid-run leaves earlier collections applied.

// --- parsing helpers ---------------------------------------------------------

function parseJson(text: string): EntryData {
  try {
    return JSON.parse(text) as EntryData;
  } catch {
    return {};
  }
}

function safeOptions(type: ExportedField["type"], raw: string): FieldOptions {
  try {
    return parseFieldOptions(type, JSON.parse(raw));
  } catch {
    return {};
  }
}

// --- export ------------------------------------------------------------------

export async function exportProject(db: DrizzleDb, includeData: boolean): Promise<ExportDocument> {
  const collectionRows = await db
    .select()
    .from(collections)
    .orderBy(asc(collections.sortOrder), asc(collections.createdAt))
    .all();

  const exported: ExportedCollection[] = [];
  for (const col of collectionRows) {
    const fieldRows = await db
      .select()
      .from(fields)
      .where(eq(fields.collectionId, col.id))
      .orderBy(asc(fields.sortOrder))
      .all();

    const out: ExportedCollection = {
      slug: col.slug,
      name: col.name,
      description: col.description,
      type: col.type,
      titleField: col.titleField,
      sortOrder: col.sortOrder,
      fields: fieldRows.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        options: safeOptions(f.type, f.options),
        sortOrder: f.sortOrder,
      })),
    };

    if (includeData) {
      const entryRows = await db
        .select()
        .from(entries)
        .where(eq(entries.collectionId, col.id))
        .orderBy(asc(entries.sortOrder), asc(entries.createdAt))
        .all();
      out.entries = entryRows.map((e) => ({
        id: e.id, // v2: correlation key so cross-entry references remap old→new on import
        slug: e.slug,
        locale: e.locale,
        draftData: parseJson(e.draftData),
        publishedData: e.publishedData === null ? null : parseJson(e.publishedData),
        sortOrder: e.sortOrder,
        draftUpdatedAt: e.draftUpdatedAt,
        publishedAt: e.publishedAt,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      }));
    }

    exported.push(out);
  }

  return {
    format: "dito-export",
    version: 2,
    exportedAt: Date.now(),
    includesData: includeData,
    collections: exported,
  };
}

// --- envelope validation -----------------------------------------------------

/**
 * Shape-validate an uploaded bundle and narrow it to ExportDocument. Throws badRequest
 * on a malformed envelope. Deep field/option/slug validation is left to createCollection.
 */
function validateEnvelope(doc: unknown): ExportDocument {
  if (typeof doc !== "object" || doc === null) throw badRequest("Invalid import file");
  const d = doc as Record<string, unknown>;
  if (d.format !== "dito-export") throw badRequest("Not a Dito export file");
  if (d.version !== 1 && d.version !== 2) {
    throw badRequest(`Unsupported export version "${String(d.version)}"`);
  }
  if (!Array.isArray(d.collections)) throw badRequest("Export is missing a collections array");
  d.collections.forEach((raw, i) => validateCollection(raw, i));
  return d as unknown as ExportDocument;
}

function validateCollection(raw: unknown, index: number): void {
  if (typeof raw !== "object" || raw === null) {
    throw badRequest(`collections[${index}] must be an object`);
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.slug !== "string" || !c.slug) throw badRequest(`collections[${index}].slug is required`);
  if (typeof c.name !== "string" || !c.name) throw badRequest(`collections[${index}].name is required`);
  if (c.type !== "collection" && c.type !== "singleton") {
    throw badRequest(`collections[${index}].type must be 'collection' or 'singleton'`);
  }
  if (!Array.isArray(c.fields)) throw badRequest(`collections[${index}].fields must be an array`);
  c.fields.forEach((f, j) => {
    if (typeof f !== "object" || f === null) {
      throw badRequest(`collections[${index}].fields[${j}] must be an object`);
    }
    const field = f as Record<string, unknown>;
    if (typeof field.name !== "string" || !field.name) {
      throw badRequest(`collections[${index}].fields[${j}].name is required`);
    }
    if (typeof field.type !== "string" || !isFieldType(field.type)) {
      throw badRequest(`collections[${index}].fields[${j}] has an unknown field type`);
    }
  });
  if (c.entries !== undefined && !Array.isArray(c.entries)) {
    throw badRequest(`collections[${index}].entries must be an array`);
  }
}

// --- preview -----------------------------------------------------------------

export async function previewImport(db: DrizzleDb, doc: unknown): Promise<ImportPreview> {
  const document = validateEnvelope(doc);
  const existing = await db.select({ slug: collections.slug }).from(collections).all();
  const existingSlugs = new Set(existing.map((r) => r.slug));

  const previews: ImportPreviewCollection[] = document.collections.map((c) => ({
    slug: c.slug,
    name: c.name,
    type: c.type,
    status: existingSlugs.has(c.slug) ? "conflict" : "new",
    fieldCount: c.fields.length,
    entryCount: c.entries?.length ?? 0,
  }));

  const hasReferences = document.collections.some((c) => c.fields.some((f) => f.type === "reference"));

  return {
    includesData: document.includesData,
    version: document.version,
    hasReferences,
    collections: previews,
  };
}

// --- apply -------------------------------------------------------------------

/** Find a free collection slug by appending -2, -3, … to `base`. */
async function uniqueSlug(db: DrizzleDb, base: string): Promise<string> {
  const rows = await db.select({ slug: collections.slug }).from(collections).all();
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Create a collection (+ fields + entries) from one bundle entry under the given slug. Merges
 * this collection's entries into the shared `idMap` (source→new id) and, if it has any reference
 * fields, returns a RemapGroup so applyImport's second pass can rewrite those references once the
 * whole map is built.
 */
async function createImportedCollection(
  db: DrizzleDb,
  col: ExportedCollection,
  slug: string,
  userId: string | undefined,
  idMap: Map<string, string>,
): Promise<RemapGroup | null> {
  const detail = await createCollection(db, {
    slug,
    name: col.name,
    type: col.type,
    description: col.description,
    fields: col.fields
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((f) => ({ name: f.name, label: f.label, type: f.type, options: f.options })),
  });

  // createCollection always starts with titleField null and a fresh sortOrder; restore both.
  await updateCollection(db, detail.slug, {
    sortOrder: col.sortOrder,
    titleField: col.titleField ?? null,
  });

  if (!col.entries || col.entries.length === 0) return null;

  const defs: FieldDefinition[] = detail.fields.map((f) => ({
    name: f.name,
    type: f.type,
    options: f.options,
  }));
  const inserted = await importEntries(db, detail.id, defs, col.entries, userId);
  for (const [oldId, newId] of inserted.idMap) idMap.set(oldId, newId);

  const refDefs = defs.filter((d) => d.type === "reference");
  return refDefs.length > 0 ? { refDefs, newIds: inserted.newIds } : null;
}

export async function applyImport(
  db: DrizzleDb,
  doc: unknown,
  resolutions: Record<string, ImportResolution>,
  userId: string | undefined,
): Promise<ImportResult> {
  const document = validateEnvelope(doc);
  const existing = await db.select({ slug: collections.slug }).from(collections).all();
  const existingSlugs = new Set(existing.map((r) => r.slug));

  const result: ImportResult = {
    created: [],
    renamed: [],
    overwritten: [],
    skipped: [],
    unresolvedReferences: 0,
  };

  // A reference A→B fails if B is imported after A, so ids are re-minted first (pass 1) across
  // ALL collections into one shared map, then references are rewritten (pass 2). The map spans
  // created/renamed/overwritten collections alike; references into a *skipped* collection have no
  // new id to point at and stay unresolved (→ null at delivery), counted in unresolvedReferences.
  const idMap = new Map<string, string>();
  const groups: RemapGroup[] = [];
  const collect = (g: RemapGroup | null): void => {
    if (g) groups.push(g);
  };

  // Pass 1 — create collections + insert entries.
  for (const col of document.collections) {
    if (!existingSlugs.has(col.slug)) {
      collect(await createImportedCollection(db, col, col.slug, userId, idMap));
      existingSlugs.add(col.slug);
      result.created.push(col.slug);
      continue;
    }

    const resolution = resolutions[col.slug] ?? "skip";
    if (resolution === "skip") {
      result.skipped.push(col.slug);
    } else if (resolution === "rename") {
      const slug = await uniqueSlug(db, col.slug);
      collect(await createImportedCollection(db, col, slug, userId, idMap));
      existingSlugs.add(slug);
      result.renamed.push({ from: col.slug, to: slug });
    } else {
      // overwrite — drop the existing collection (cascades fields + entries) then recreate.
      await deleteCollection(db, col.slug, col.slug);
      collect(await createImportedCollection(db, col, col.slug, userId, idMap));
      result.overwritten.push(col.slug);
    }
  }

  // Pass 2 — rewrite reference values through the completed id map.
  result.unresolvedReferences = await remapImportedReferences(db, idMap, groups);

  return result;
}
