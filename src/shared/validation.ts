import { z } from "zod";

import { FIELD_TYPES, parseFieldOptions, type FieldType, type FieldOptions } from "./field-types";

// Generated entry schemas, built from a collection's field list. Entry content
// (Phase 3) is validated against these. Two flavours:
//   - buildDraftSchema   : lenient — types/format checked, everything optional.
//   - buildPublishSchema : full — `required` and bounds enforced.
// Unknown keys are stripped on write, so schema changes never corrupt old rows.

/** The shape validation needs from a field: its API name, type, and parsed options. */
export interface FieldDefinition {
  name: string;
  type: FieldType;
  options: FieldOptions;
}

/** Convenience: accept a raw options blob and parse it through the type's schema. */
export function toFieldDefinition(name: string, type: FieldType, rawOptions: unknown): FieldDefinition {
  return { name, type, options: parseFieldOptions(type, rawOptions) };
}

/** Guard a required field so a missing/null value reports a friendly message. */
function requireValue(value: z.ZodTypeAny): z.ZodTypeAny {
  return z
    .any()
    .refine(
      // An empty array counts as absent too, so a required `multiple` reference (the only
      // array-valued field type) can't publish with zero targets.
      (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
      { message: "This field is required" },
    )
    .pipe(value);
}

function buildSchema(fields: FieldDefinition[], mode: "draft" | "publish"): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const def = FIELD_TYPES[field.type];
    const value = def.buildValueSchema(field.options, mode);
    if (mode === "draft") {
      // Drafts may be half-finished: every field is optional (and may be null).
      shape[field.name] = value.nullish();
    } else {
      const isRequired = def.hasRequired && field.options.required === true;
      shape[field.name] = isRequired ? requireValue(value) : value.nullish();
    }
  }
  // z.object strips unknown keys by default → removed fields are ignored on write.
  return z.object(shape);
}

export function buildDraftSchema(fields: FieldDefinition[]): z.ZodTypeAny {
  return buildSchema(fields, "draft");
}

export function buildPublishSchema(fields: FieldDefinition[]): z.ZodTypeAny {
  return buildSchema(fields, "publish");
}
