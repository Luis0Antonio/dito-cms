import { ZodError } from "zod";

import { validationError, zodToFieldErrors } from "../lib/errors";

import { FIELD_TYPES } from "@/shared/field-types";
import { buildDraftSchema, buildPublishSchema, type FieldDefinition } from "@/shared/validation";
import { isLocaleMap, isLocalized, type LocaleConfig } from "@/shared/localization";
import { plainTextToDoc, renderRichTextHtml } from "@/shared/richtext";
import { MAX_RICH_TEXT_BYTES } from "@/shared/constants";
import type { EntryData } from "@/shared/api-types";

// Shared field-value helpers used by every "field-data + custom schema" surface: entry
// content (services/entries.ts) and product customData (services/store/products.ts). Keeping
// these in one place means the security-sensitive rich-text HTML regeneration lives once.

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Regenerate every rich_text field's HTML server-side from its JSON doc — the client value
 * is never trusted (no stored XSS) — and enforce the size cap. Returns a copy.
 *
 * The incoming value may be the editor's `{ json, html }` (html ignored), a bare TipTap doc
 * (`{ type: "doc", … }`), or a plain string (wrapped into paragraphs) — the latter two let
 * the MCP server author rich_text without constructing the full shape.
 */
export function regenerateRichText(defs: FieldDefinition[], data: EntryData): EntryData {
  const out: EntryData = { ...data };
  for (const def of defs) {
    if (def.type !== "rich_text") continue;
    const value = out[def.name];
    if (value === null || value === undefined) continue;

    if (isLocalized(def)) {
      // Localized rich_text stores a `{ [locale]: value }` map — regenerate each locale's HTML.
      // A bare value here is defended against by normalizeLocalizedFields (run upstream); if one
      // still slips through, leave it for the schema to surface a field-keyed error.
      if (!isLocaleMap(value)) continue;
      const next: Record<string, unknown> = {};
      for (const [locale, localeValue] of Object.entries(value)) {
        if (localeValue === null || localeValue === undefined) {
          next[locale] = localeValue;
          continue;
        }
        const regen = regenRichTextValue(localeValue, def.name);
        next[locale] = regen ?? localeValue;
      }
      out[def.name] = next;
      continue;
    }

    const regen = regenRichTextValue(value, def.name);
    if (regen !== undefined) out[def.name] = regen;
  }
  return out;
}

/**
 * Regenerate one rich_text value's HTML from its JSON doc. Returns the `{ json, html }` pair, or
 * `undefined` when the value's shape is wrong (the caller leaves it for the schema to reject).
 */
function regenRichTextValue(
  value: unknown,
  fieldName: string,
): { json: unknown; html: string } | undefined {
  let json: unknown;
  if (typeof value === "string") {
    json = plainTextToDoc(value);
  } else if (typeof value === "object" && value !== null && "json" in (value as object)) {
    json = (value as { json: unknown }).json;
  } else if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "doc") {
    json = value;
  } else {
    return undefined;
  }
  let html: string;
  try {
    html = renderRichTextHtml(json);
  } catch (err) {
    if (err instanceof ZodError) {
      throw validationError("Invalid rich text content", { [fieldName]: "Invalid rich text content" });
    }
    throw err;
  }
  if (byteLength(html) > MAX_RICH_TEXT_BYTES) {
    throw validationError("Rich text is too large", { [fieldName]: "Content is too large" });
  }
  return { json, html };
}

/**
 * Coerce a bare value on a localized field into a default-locale map `{ [default]: value }`.
 * The backend mirror of the SPA's per-locale coercion: after a metadata-only `localized` flip
 * the stored value is still bare, and an MCP client may send a bare value too — both must become
 * a locale map before regenerateRichText/validation, which expect one. Non-localized fields, an
 * already-shaped map, and absent values are left untouched. Returns a copy.
 */
export function normalizeLocalizedFields(
  defs: FieldDefinition[],
  data: EntryData,
  config: LocaleConfig,
): EntryData {
  const out: EntryData = { ...data };
  for (const def of defs) {
    if (!isLocalized(def)) continue;
    const value = out[def.name];
    if (value === undefined || value === null) continue; // absent — seed/validation handle it
    if (isLocaleMap(value)) continue; // already a map (including a seeded `{}`)
    out[def.name] = { [config.default]: value };
  }
  return out;
}

/** Validate field data against the generated draft/publish schema; throws field-keyed errors. */
export function validateFieldData(
  defs: FieldDefinition[],
  data: EntryData,
  mode: "draft" | "publish",
  messages: { draft?: string; publish?: string } | undefined,
  config: LocaleConfig,
): EntryData {
  const schema = mode === "publish" ? buildPublishSchema(defs, config) : buildDraftSchema(defs, config);
  const result = schema.safeParse(data);
  if (!result.success) {
    const message =
      mode === "publish"
        ? (messages?.publish ?? "Not ready to publish")
        : (messages?.draft ?? "Some fields are invalid");
    throw validationError(message, zodToFieldErrors(result.error));
  }
  return result.data as EntryData;
}

/** Seed default values for fields that declare one. */
export function seedDefaults(defs: FieldDefinition[]): EntryData {
  const out: EntryData = {};
  for (const def of defs) {
    if (isLocalized(def)) {
      // A localized field seeds as an empty locale map; per-locale defaults (if any) apply at
      // delivery via resolveLocalizedValue's fallback, not at seed time.
      out[def.name] = {};
      continue;
    }
    const value = FIELD_TYPES[def.type].resolveDefault(def.options);
    if (value !== undefined) out[def.name] = value;
  }
  return out;
}
