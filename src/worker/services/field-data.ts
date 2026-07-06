import { ZodError } from "zod";

import { validationError, zodToFieldErrors } from "../lib/errors";

import { FIELD_TYPES } from "@/shared/field-types";
import { buildDraftSchema, buildPublishSchema, type FieldDefinition } from "@/shared/validation";
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

    let json: unknown;
    if (typeof value === "string") {
      json = plainTextToDoc(value);
    } else if (typeof value === "object" && "json" in (value as object)) {
      json = (value as { json: unknown }).json;
    } else if (typeof value === "object" && (value as { type?: unknown }).type === "doc") {
      json = value;
    } else {
      // Wrong shape — let the schema below surface a field-keyed error.
      continue;
    }
    let html: string;
    try {
      html = renderRichTextHtml(json);
    } catch (err) {
      if (err instanceof ZodError) {
        throw validationError("Invalid rich text content", { [def.name]: "Invalid rich text content" });
      }
      throw err;
    }
    if (byteLength(html) > MAX_RICH_TEXT_BYTES) {
      throw validationError("Rich text is too large", { [def.name]: "Content is too large" });
    }
    out[def.name] = { json, html };
  }
  return out;
}

/** Validate field data against the generated draft/publish schema; throws field-keyed errors. */
export function validateFieldData(
  defs: FieldDefinition[],
  data: EntryData,
  mode: "draft" | "publish",
  messages?: { draft?: string; publish?: string },
): EntryData {
  const schema = mode === "publish" ? buildPublishSchema(defs) : buildDraftSchema(defs);
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
    const value = FIELD_TYPES[def.type].resolveDefault(def.options);
    if (value !== undefined) out[def.name] = value;
  }
  return out;
}
