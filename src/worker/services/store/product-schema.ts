import { asc, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import { ZodError } from "zod";

import type { DrizzleDb } from "../../db/client";
import { productFields, type ProductFieldRow } from "../../db/schema";
import { conflict, validationError, zodToFieldErrors } from "../../lib/errors";

import {
  isFieldType,
  parseFieldOptions,
  type FieldOptions,
  type FieldType,
} from "@/shared/field-types";
import type { FieldDefinition } from "@/shared/validation";
import { fieldNameError } from "@/shared/slug";
import type { FieldDTO, SetFieldsResult } from "@/shared/api-types";

// The shared product schema: one custom-field set applied to every product. This mirrors
// the collections field logic (services/collections.ts) but is global — there is no
// collectionId and field `name` is unique across the whole `product_fields` table. Product
// `customData` is validated against these definitions via the same field system entries use.

interface FieldInput {
  name: string;
  label: string;
  type: FieldType;
  options?: FieldOptions;
}

/** Product custom fields support every field type except `reference` (see normalizeField). */
type ProductFieldType = Exclude<FieldType, "reference">;

interface NormalizedField {
  name: string;
  label: string;
  type: ProductFieldType;
  options: FieldOptions;
}

function parseOptions(raw: string): FieldOptions {
  try {
    return JSON.parse(raw) as FieldOptions;
  } catch {
    return {};
  }
}

function mapField(row: ProductFieldRow): FieldDTO {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    type: row.type,
    options: parseOptions(row.options),
    sortOrder: row.sortOrder,
  };
}

/** Validate one incoming field and parse its options through the type's schema. */
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
  // `reference` is a valid FieldType but points at entries, not products; it is
  // not supported on product custom fields in v1. Reject explicitly — otherwise
  // isFieldType() above would let it through (and the product_fields CHECK,
  // which was left unwidened, would reject the insert with a cryptic error).
  if (input.type === "reference") {
    throw validationError("References aren't supported on product fields yet", {
      [`${prefix}.type`]: "Reference fields can't be used on products",
    });
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

async function loadFieldRows(db: DrizzleDb): Promise<ProductFieldRow[]> {
  return db.select().from(productFields).orderBy(asc(productFields.sortOrder)).all();
}

export async function getProductFields(db: DrizzleDb): Promise<FieldDTO[]> {
  return (await loadFieldRows(db)).map(mapField);
}

/** Field definitions used to validate a product's `customData`. */
export async function loadProductFieldDefs(db: DrizzleDb): Promise<FieldDefinition[]> {
  return (await loadFieldRows(db)).map((r) => ({
    name: r.name,
    type: r.type,
    options: parseOptions(r.options),
  }));
}

/**
 * Declaratively replace the whole product field set. Diffs by field name and returns
 * { added, updated, removed }. Removing a field or changing its type discards stored
 * values in every product's customData, so those require allowDestructive.
 */
export async function setProductFields(
  db: DrizzleDb,
  input: { fields: FieldInput[]; allowDestructive?: boolean },
): Promise<SetFieldsResult> {
  const normalized = input.fields.map(normalizeField);
  assertUniqueNames(normalized);

  const existingRows = await loadFieldRows(db);
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
      if (!input.allowDestructive) {
        throw conflict(
          `Changing the type of "${field.name}" would invalidate existing product content. Re-run with allowDestructive to proceed.`,
          { [`fields.${normalized.indexOf(field)}.type`]: "Type is immutable; delete and re-add instead" },
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
    statements.push(db.delete(productFields).where(eq(productFields.id, prev.id)));
  }
  normalized.forEach((field, index) => {
    const prev = existingByName.get(field.name);
    if (!prev) {
      statements.push(
        db.insert(productFields).values({
          id: nanoid(),
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
          .update(productFields)
          .set({
            label: field.label,
            type: field.type,
            options: JSON.stringify(field.options),
            sortOrder: index,
            updatedAt: now,
          })
          .where(eq(productFields.id, prev.id)),
      );
    }
  });

  if (statements.length > 0) {
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }

  return { added, updated, removed };
}
