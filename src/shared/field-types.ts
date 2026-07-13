import { z } from "zod";

import { richTextDocSchema } from "./richtext";

// Single source of truth for the 8 field types. Isomorphic: no React, no Hono,
// no worker imports. Each type carries:
//   - optionsSchema    : validates the per-type options the user configures
//   - buildValueSchema : (options, mode) => zod schema for a stored value
//   - resolveDefault   : the value to seed a fresh entry with
//
// `mode` splits draft from publish: drafts are lenient (type/format only, so
// half-finished content saves), publish enforces bounds. `required` is enforced
// in validation.ts at publish time, not here.

export const FIELD_TYPE_LIST = [
  "text",
  "rich_text",
  "number",
  "boolean",
  "picture",
  "video",
  "link",
  "reference",
] as const;

export type FieldType = (typeof FIELD_TYPE_LIST)[number];

export type ValueMode = "draft" | "publish";

/** Union of every option key across all field types (all optional). */
export interface FieldOptions {
  required?: boolean;
  help?: string;
  placeholder?: string;
  multiline?: boolean;
  default?: string | number | boolean;
  minLength?: number;
  maxLength?: number;
  integer?: boolean;
  min?: number;
  max?: number;
  allowRelative?: boolean;
  /** reference: allowed target collection slugs. [] / ["*"] = any (polymorphic). */
  targetCollections?: string[];
  /** reference: false → one id (string); true → ordered id[]. */
  multiple?: boolean;
}

export interface FieldTypeDef {
  type: FieldType;
  label: string;
  description: string;
  /** Whether `required` applies (boolean is always present, so it doesn't). */
  hasRequired: boolean;
  optionsSchema: z.ZodType<FieldOptions>;
  buildValueSchema: (options: FieldOptions, mode: ValueMode) => z.ZodTypeAny;
  resolveDefault: (options: FieldOptions) => unknown;
}

// --- shared option fragments -------------------------------------------------

const help = z.string().trim().max(280).optional();
const required = z.boolean().optional();
const placeholder = z.string().trim().max(120).optional();

/** Attach a "default must satisfy the field's own value schema" check. */
function withDefaultCheck<T extends z.ZodType<FieldOptions>>(
  schema: T,
  build: (options: FieldOptions) => z.ZodTypeAny,
): z.ZodType<FieldOptions> {
  return schema.superRefine((options, ctx) => {
    if (options.default === undefined) return;
    const result = build(options).safeParse(options.default);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: result.error.issues[0]?.message ?? "Default value is invalid",
      });
    }
  }) as unknown as z.ZodType<FieldOptions>;
}

// --- text --------------------------------------------------------------------

function textValueSchema(options: FieldOptions, mode: ValueMode): z.ZodTypeAny {
  let schema = z.string();
  if (mode === "publish") {
    if (typeof options.minLength === "number") schema = schema.min(options.minLength);
    if (typeof options.maxLength === "number") schema = schema.max(options.maxLength);
  }
  return schema;
}

const textOptionsSchema = withDefaultCheck(
  z
    .object({
      required,
      help,
      placeholder,
      multiline: z.boolean().optional(),
      default: z.string().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
    })
    .refine(
      (o) => o.minLength === undefined || o.maxLength === undefined || o.minLength <= o.maxLength,
      { path: ["maxLength"], message: "Max length must be ≥ min length" },
    ),
  (o) => textValueSchema(o, "publish"),
);

// --- rich_text ---------------------------------------------------------------

// Stored value is the TipTap doc + its server-regenerated HTML. The doc shape is
// validated against richtext.ts's allowlist schema; `html` is always recomputed
// server-side (see services/entries.ts) so a client value here is never trusted.
function richTextValueSchema(): z.ZodTypeAny {
  return z.object({
    json: richTextDocSchema,
    html: z.string(),
  });
}

const richTextOptionsSchema: z.ZodType<FieldOptions> = z.object({
  required,
  help,
  placeholder,
});

// --- number ------------------------------------------------------------------

function numberValueSchema(options: FieldOptions, mode: ValueMode): z.ZodTypeAny {
  let schema = z.number();
  if (options.integer) schema = schema.int();
  if (mode === "publish") {
    if (typeof options.min === "number") schema = schema.min(options.min);
    if (typeof options.max === "number") schema = schema.max(options.max);
  }
  return schema;
}

const numberOptionsSchema = withDefaultCheck(
  z
    .object({
      required,
      help,
      placeholder,
      integer: z.boolean().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      default: z.number().optional(),
    })
    .refine((o) => o.min === undefined || o.max === undefined || o.min <= o.max, {
      path: ["max"],
      message: "Max must be ≥ min",
    }),
  (o) => numberValueSchema(o, "publish"),
);

// --- boolean -----------------------------------------------------------------

function booleanValueSchema(): z.ZodTypeAny {
  return z.boolean();
}

const booleanOptionsSchema: z.ZodType<FieldOptions> = z.object({
  help,
  default: z.boolean().optional(),
});

// --- picture / video ---------------------------------------------------------

// Stored value is a media id. Existence + kind + ready are checked server-side
// (async, batched) at write time — not expressible in zod.
function mediaValueSchema(): z.ZodTypeAny {
  return z.string().min(1);
}

const mediaOptionsSchema: z.ZodType<FieldOptions> = z.object({
  required,
  help,
});

// --- link --------------------------------------------------------------------

function linkValueSchema(options: FieldOptions, mode: ValueMode): z.ZodTypeAny {
  const allowRelative = options.allowRelative ?? true;
  const url =
    mode === "publish"
      ? z.string().min(1).refine(
          (v) => {
            if (/^https?:\/\//i.test(v) || /^mailto:/i.test(v) || /^tel:/i.test(v)) return true;
            if (allowRelative && (v.startsWith("/") || v.startsWith("#"))) return true;
            return false;
          },
          {
            message: allowRelative
              ? "Enter a URL or a relative path (/path, #anchor)"
              : "Enter an absolute http(s) URL",
          },
        )
      : z.string();
  return z.object({
    url,
    label: z.string().optional(),
    newTab: z.boolean().optional(),
  });
}

const linkOptionsSchema: z.ZodType<FieldOptions> = z.object({
  required,
  help,
  allowRelative: z.boolean().optional(),
});

// --- reference ---------------------------------------------------------------

// Stored value is a target entry id (or an ordered id[] when `multiple`).
// Existence + target-collection are checked server-side (async, batched) at
// write time by assertEntryRefs — not expressible in zod, exactly like media.
function referenceValueSchema(options: FieldOptions, _mode: ValueMode): z.ZodTypeAny {
  const id = z.string().min(1);
  return options.multiple ? z.array(id) : id;
}

const referenceOptionsSchema: z.ZodType<FieldOptions> = z.object({
  required,
  help,
  // Slugs of the collections this field may point at. Empty / ["*"] = any.
  targetCollections: z.array(z.string().trim().min(1)).optional().default([]),
  multiple: z.boolean().optional(),
});

// --- registry ----------------------------------------------------------------

export const FIELD_TYPES: Record<FieldType, FieldTypeDef> = {
  text: {
    type: "text",
    label: "Text",
    description: "Single or multi-line plain text.",
    hasRequired: true,
    optionsSchema: textOptionsSchema,
    buildValueSchema: textValueSchema,
    resolveDefault: (o) => o.default,
  },
  rich_text: {
    type: "rich_text",
    label: "Rich text",
    description: "Formatted prose with headings, lists and links.",
    hasRequired: true,
    optionsSchema: richTextOptionsSchema,
    buildValueSchema: richTextValueSchema,
    resolveDefault: () => undefined,
  },
  number: {
    type: "number",
    label: "Number",
    description: "Integer or decimal value.",
    hasRequired: true,
    optionsSchema: numberOptionsSchema,
    buildValueSchema: numberValueSchema,
    resolveDefault: (o) => o.default,
  },
  boolean: {
    type: "boolean",
    label: "Boolean",
    description: "A true/false toggle.",
    hasRequired: false,
    optionsSchema: booleanOptionsSchema,
    buildValueSchema: booleanValueSchema,
    resolveDefault: (o) => o.default ?? false,
  },
  picture: {
    type: "picture",
    label: "Picture",
    description: "An image from the media library.",
    hasRequired: true,
    optionsSchema: mediaOptionsSchema,
    buildValueSchema: mediaValueSchema,
    resolveDefault: () => undefined,
  },
  video: {
    type: "video",
    label: "Video",
    description: "A video from the media library.",
    hasRequired: true,
    optionsSchema: mediaOptionsSchema,
    buildValueSchema: mediaValueSchema,
    resolveDefault: () => undefined,
  },
  link: {
    type: "link",
    label: "Link",
    description: "A URL with optional label and new-tab flag.",
    hasRequired: true,
    optionsSchema: linkOptionsSchema,
    buildValueSchema: linkValueSchema,
    resolveDefault: () => undefined,
  },
  reference: {
    type: "reference",
    label: "Reference",
    description: "A link to one or more entries in another collection.",
    hasRequired: true,
    optionsSchema: referenceOptionsSchema,
    buildValueSchema: referenceValueSchema,
    resolveDefault: (o) => (o.multiple ? [] : undefined),
  },
};

export function isFieldType(value: string): value is FieldType {
  return (FIELD_TYPE_LIST as readonly string[]).includes(value);
}

/** Parse and validate raw options for a field type. Throws ZodError on failure. */
export function parseFieldOptions(type: FieldType, raw: unknown): FieldOptions {
  return FIELD_TYPES[type].optionsSchema.parse(raw ?? {});
}
