import { z } from "zod";

import type { FieldOptions, FieldType, ValueMode } from "./field-types";

// Single source of truth for field-level content localization. Isomorphic: no React, no Hono,
// no worker imports — shared by validation, delivery, the entry service and the admin SPA.
//
// A localized field stores a locale map `{ [locale]: value }` in place of a bare value; a
// non-localized field is unchanged. Only text-like types may be localized (media & reference
// stay bare/shared), so assertMediaRefs/assertEntryRefs/expand* never see a map.

/** The configured content locales and which one is the default (and delivery fallback). */
export interface LocaleConfig {
  locales: string[];
  default: string;
}

/** BCP-47-ish code: `es`, `en`, `pt-BR`. Used for validation AND safe SQL path building. */
export const LOCALE_CODE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** Every deployment starts single-locale (Spanish default), so existing content is untouched. */
export const DEFAULT_LOCALE_CONFIG: LocaleConfig = { locales: ["es"], default: "es" };

/** Field types whose values may be localized in v1. Media & reference stay bare/shared. */
export const LOCALIZABLE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "text",
  "rich_text",
  "number",
  "boolean",
  "link",
  "select",
]);

/** Whether a field is actually localized: the flag is set AND its type supports it. */
export function isLocalized(def: { type: FieldType; options: FieldOptions }): boolean {
  return def.options.localized === true && LOCALIZABLE_TYPES.has(def.type);
}

/**
 * Whether a stored value is a locale map (vs a bare value). A map's keys are all locale codes;
 * a bare rich_text `{json,html}` or link `{url,label,newTab}` has non-locale keys, and a scalar
 * isn't an object — so both correctly read as "not a map". An empty `{}` (a freshly seeded
 * localized field) reads as a map that resolves to nothing.
 */
export function isLocaleMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((k) => LOCALE_CODE_RE.test(k));
}

/**
 * Resolve a (possibly localized) stored value to a single value for the requested locale:
 * `map[locale] ?? map[default] ?? fallback`. A bare value (an unmigrated `localized` flip)
 * passes through unchanged, so delivery keeps working before a migration runs.
 */
export function resolveLocalizedValue(
  value: unknown,
  locale: string,
  config: LocaleConfig,
  fallback: unknown = null,
): unknown {
  if (value === undefined || value === null) return fallback;
  if (!isLocaleMap(value)) return value; // bare / not-yet-migrated — deliver as-is
  const forLocale = value[locale];
  if (forLocale !== undefined && forLocale !== null) return forLocale;
  const forDefault = value[config.default];
  if (forDefault !== undefined && forDefault !== null) return forDefault;
  return fallback;
}

/**
 * Wrap a per-type value schema into a locale-keyed record. Each locale's value is optional
 * (translations may be missing); at publish, a required field additionally needs a non-empty
 * DEFAULT-locale value (other locales fall back to it at delivery). Draft stays fully lenient.
 * Keys are left permissive (any string) so an orphaned locale from a removed language is
 * ignored rather than rejected.
 */
export function buildLocalizedValueSchema(
  perLocaleSchema: z.ZodTypeAny,
  config: LocaleConfig,
  mode: ValueMode,
  required: boolean,
): z.ZodTypeAny {
  const localeMap = z.record(z.string(), perLocaleSchema.nullish());
  if (mode === "draft" || !required) return localeMap.nullish();
  // Required at publish: the default locale must carry a non-empty value; the map's per-locale
  // values are still validated (publish-strict) by localeMap via `.pipe` below.
  return z
    .any()
    .refine(
      (v) => {
        const dv = isLocaleMap(v) ? v[config.default] : undefined;
        return (
          dv !== undefined && dv !== null && dv !== "" && !(Array.isArray(dv) && dv.length === 0)
        );
      },
      { message: "This field is required" },
    )
    .pipe(localeMap);
}
