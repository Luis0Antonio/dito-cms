import { asc, count, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import { ZodError } from "zod";

import type { DrizzleDb } from "../db/client";
import { collections, fields, type CollectionRow, type FieldRow } from "../db/schema";
import { badRequest, conflict, notFound, validationError, zodToFieldErrors } from "../lib/errors";
import { countEntries, countEntriesByCollection, countPublishedEntries } from "./entries";

import {
  isFieldType,
  parseFieldOptions,
  type FieldOptions,
  type FieldType,
} from "@/shared/field-types";
import { fieldNameError, slugError } from "@/shared/slug";
import type {
  CollectionDetail,
  CollectionSummary,
  CollectionType,
  FieldDTO,
  SetFieldsResult,
} from "@/shared/api-types";

// Business logic for the data model. The admin routes and (Phase 5) MCP tools both
// call these — keep validation here, not in the route handlers.

interface FieldInput {
  name: string;
  label: string;
  type: FieldType;
  options?: FieldOptions;
}

interface CreateCollectionInput {
  slug: string;
  name: string;
  type: CollectionType;
  description?: string | null;
  fields?: FieldInput[];
}

interface UpdateCollectionPatch {
  name?: string;
  description?: string | null;
  titleField?: string | null;
  sortOrder?: number;
}

/** A normalized + validated field ready to persist. */
interface NormalizedField {
  name: string;
  label: string;
  type: FieldType;
  options: FieldOptions;
}

/** The persisted `multiple` flag of a stored field (false when unparseable/unset). */
function storedMultiple(row: FieldRow): boolean {
  try {
    return (JSON.parse(row.options) as FieldOptions).multiple === true;
  } catch {
    return false;
  }
}

/** The persisted `localized` flag of a stored field (false when unparseable/unset). */
function storedLocalized(row: FieldRow): boolean {
  try {
    return (JSON.parse(row.options) as FieldOptions).localized === true;
  } catch {
    return false;
  }
}

function mapField(row: FieldRow): FieldDTO {
  let options: FieldOptions = {};
  try {
    options = JSON.parse(row.options) as FieldOptions;
  } catch {
    options = {};
  }
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    type: row.type,
    options,
    sortOrder: row.sortOrder,
  };
}

async function findCollectionRow(db: DrizzleDb, slug: string): Promise<CollectionRow> {
  const row = await db.select().from(collections).where(eq(collections.slug, slug)).get();
  if (!row) throw notFound(`Collection "${slug}" not found`);
  return row;
}

async function loadFields(db: DrizzleDb, collectionId: string): Promise<FieldRow[]> {
  return db
    .select()
    .from(fields)
    .where(eq(fields.collectionId, collectionId))
    .orderBy(asc(fields.sortOrder))
    .all();
}

/**
 * Validate one incoming field and parse its options through the type's schema.
 * Field errors are keyed `fields.<name>.<path>` so the SPA can map them inline.
 */
function normalizeField(input: FieldInput, index: number): NormalizedField {
  const prefix = `fields.${index}`;
  const nameErr = fieldNameError(input.name);
  if (nameErr) throw validationError(nameErr, { [`${prefix}.name`]: nameErr });
  if (!input.label || !input.label.trim()) {
    throw validationError("Label is required", { [`${prefix}.label`]: "Label is required" });
  }
  if (!isFieldType(input.type)) {
    throw validationError(`Unknown field type "${input.type}"`, { [`${prefix}.type`]: "Unknown field type" });
  }
  let options: FieldOptions;
  try {
    options = parseFieldOptions(input.type, input.options ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      const inner = zodToFieldErrors(err);
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(inner)) mapped[`${prefix}.options.${k}`] = v;
      throw validationError("Invalid field options", mapped);
    }
    throw err;
  }
  return { name: input.name, label: input.label.trim(), type: input.type, options };
}

function assertUniqueNames(normalized: NormalizedField[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < normalized.length; i++) {
    const name = normalized[i].name;
    if (seen.has(name)) {
      throw validationError(`Duplicate field name "${name}"`, {
        [`fields.${i}.name`]: "Field names must be unique",
      });
    }
    seen.add(name);
  }
}

export async function listCollections(db: DrizzleDb): Promise<CollectionSummary[]> {
  const rows = await db
    .select()
    .from(collections)
    .orderBy(asc(collections.sortOrder), asc(collections.createdAt))
    .all();
  const counts = await db
    .select({ collectionId: fields.collectionId, n: count() })
    .from(fields)
    .groupBy(fields.collectionId)
    .all();
  const fieldCountBy = new Map(counts.map((c) => [c.collectionId, c.n]));
  const entryCountBy = await countEntriesByCollection(db);

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    type: row.type,
    titleField: row.titleField,
    fieldCount: fieldCountBy.get(row.id) ?? 0,
    entryCount: entryCountBy.get(row.id) ?? 0,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getCollectionDetail(db: DrizzleDb, slug: string): Promise<CollectionDetail> {
  const row = await findCollectionRow(db, slug);
  const fieldRows = await loadFields(db, row.id);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    type: row.type,
    titleField: row.titleField,
    entryCount: await countEntries(db, row.id),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    fields: fieldRows.map(mapField),
  };
}

export async function createCollection(
  db: DrizzleDb,
  input: CreateCollectionInput,
): Promise<CollectionDetail> {
  const slug = input.slug.trim();
  const slugErr = slugError(slug);
  if (slugErr) throw validationError(slugErr, { slug: slugErr });
  if (input.type !== "collection" && input.type !== "singleton") {
    throw badRequest("type must be 'collection' or 'singleton'");
  }
  if (!input.name || !input.name.trim()) {
    throw validationError("Name is required", { name: "Name is required" });
  }

  const existing = await db.select({ id: collections.id }).from(collections).where(eq(collections.slug, slug)).get();
  if (existing) throw conflict(`A collection with slug "${slug}" already exists`, { slug: "Slug already in use" });

  const normalized = (input.fields ?? []).map(normalizeField);
  assertUniqueNames(normalized);

  const now = Date.now();
  const collectionId = nanoid();

  const statements: BatchItem<"sqlite">[] = [
    db.insert(collections).values({
      id: collectionId,
      slug,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      type: input.type,
      titleField: null,
      contentVersion: 0,
      sortOrder: now,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  normalized.forEach((field, index) => {
    statements.push(
      db.insert(fields).values({
        id: nanoid(),
        collectionId,
        name: field.name,
        label: field.label,
        type: field.type,
        options: JSON.stringify(field.options),
        sortOrder: index,
        createdAt: now,
        updatedAt: now,
      }),
    );
  });

  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  // Singleton entry bootstrap is idempotent get-or-create at edit time (Phase 3),
  // so creating the collection row is all there is to do here.
  return getCollectionDetail(db, slug);
}

export async function updateCollection(
  db: DrizzleDb,
  slug: string,
  patch: UpdateCollectionPatch,
): Promise<CollectionDetail> {
  const row = await findCollectionRow(db, slug);

  const values: Partial<typeof collections.$inferInsert> = { updatedAt: Date.now() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw validationError("Name is required", { name: "Name is required" });
    values.name = name;
  }
  if (patch.description !== undefined) {
    values.description = patch.description?.trim() || null;
  }
  if (patch.sortOrder !== undefined) {
    values.sortOrder = patch.sortOrder;
  }
  if (patch.titleField !== undefined) {
    if (patch.titleField === null || patch.titleField === "") {
      values.titleField = null;
    } else {
      const fieldRows = await loadFields(db, row.id);
      if (!fieldRows.some((f) => f.name === patch.titleField)) {
        throw validationError("Title field must be an existing field", {
          titleField: "Unknown field",
        });
      }
      values.titleField = patch.titleField;
    }
  }

  await db.update(collections).set(values).where(eq(collections.id, row.id)).run();
  return getCollectionDetail(db, slug);
}

export async function setFields(
  db: DrizzleDb,
  slug: string,
  input: { fields: FieldInput[]; allowDestructive?: boolean },
): Promise<SetFieldsResult> {
  const row = await findCollectionRow(db, slug);
  const normalized = input.fields.map(normalizeField);
  assertUniqueNames(normalized);

  const existingRows = await loadFields(db, row.id);
  const existingByName = new Map(existingRows.map((f) => [f.name, f]));
  const incomingNames = new Set(normalized.map((f) => f.name));

  const removed = existingRows.filter((f) => !incomingNames.has(f.name)).map((f) => f.name);
  const added: string[] = [];
  const updated: string[] = [];
  for (const field of normalized) {
    const prev = existingByName.get(field.name);
    if (!prev) {
      added.push(field.name);
    } else if (prev.type !== field.type) {
      // Type changes invalidate stored values for the field → destructive.
      if (!input.allowDestructive) {
        throw conflict(
          `Changing the type of "${field.name}" would invalidate existing content. Re-run with allowDestructive to proceed.`,
          { [`fields.${normalized.indexOf(field)}.type`]: "Type is immutable; delete and re-add instead" },
        );
      }
      updated.push(field.name);
    } else if (
      field.type === "reference" &&
      storedMultiple(prev) !== (field.options.multiple ?? false)
    ) {
      // Same type, but toggling a reference's `multiple` reshapes stored values
      // (id string ↔ id[]) → destructive, exactly like a type change.
      if (!input.allowDestructive) {
        throw conflict(
          `Switching "${field.name}" between single and multiple would invalidate existing content. Re-run with allowDestructive to proceed.`,
          {
            [`fields.${normalized.indexOf(field)}.options.multiple`]:
              "Toggling multiple reshapes stored values; re-run with allowDestructive",
          },
        );
      }
      updated.push(field.name);
    } else if (storedLocalized(prev) !== (field.options.localized ?? false)) {
      // Same type, but toggling `localized` reshapes stored values (a bare value ↔ a
      // `{ [locale]: value }` map) → destructive, exactly like the reference multiple flip.
      if (!input.allowDestructive) {
        throw conflict(
          `Switching "${field.name}" between localized and shared would invalidate existing content. Re-run with allowDestructive to proceed.`,
          {
            [`fields.${normalized.indexOf(field)}.options.localized`]:
              "Toggling localized reshapes stored values; re-run with allowDestructive",
          },
        );
      }
      updated.push(field.name);
    } else {
      updated.push(field.name);
    }
  }

  if (removed.length > 0 && !input.allowDestructive) {
    throw conflict(
      `Removing ${removed.length} field(s) (${removed.join(", ")}) deletes their content. Re-run with allowDestructive to proceed.`,
    );
  }

  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [];

  for (const name of removed) {
    const prev = existingByName.get(name)!;
    statements.push(db.delete(fields).where(eq(fields.id, prev.id)));
  }
  normalized.forEach((field, index) => {
    const prev = existingByName.get(field.name);
    if (!prev) {
      statements.push(
        db.insert(fields).values({
          id: nanoid(),
          collectionId: row.id,
          name: field.name,
          label: field.label,
          type: field.type,
          options: JSON.stringify(field.options),
          sortOrder: index,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } else {
      statements.push(
        db
          .update(fields)
          .set({
            label: field.label,
            type: field.type,
            options: JSON.stringify(field.options),
            sortOrder: index,
            updatedAt: now,
          })
          .where(eq(fields.id, prev.id)),
      );
    }
  });
  statements.push(db.update(collections).set({ updatedAt: now }).where(eq(collections.id, row.id)));

  // If the title field was removed, clear it so it can't dangle.
  if (row.titleField && removed.includes(row.titleField)) {
    statements.push(
      db.update(collections).set({ titleField: null }).where(eq(collections.id, row.id)),
    );
  }

  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  return { added, updated, removed };
}

/** Returns whether the collection had published entries, so callers can fire a deploy hook. */
export async function deleteCollection(
  db: DrizzleDb,
  slug: string,
  confirm: string,
): Promise<{ hadPublishedEntries: boolean }> {
  const row = await findCollectionRow(db, slug);
  if (confirm !== slug) {
    throw badRequest("Confirmation does not match the collection slug");
  }
  const hadPublishedEntries = (await countPublishedEntries(db, row.id)) > 0;
  // Fields cascade via FK; entries (Phase 3) cascade too.
  await db.delete(collections).where(eq(collections.id, row.id)).run();
  return { hadPublishedEntries };
}
