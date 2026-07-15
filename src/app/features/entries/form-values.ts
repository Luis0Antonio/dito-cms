import {
  isLocaleMap,
  isLocalized,
  resolveLocalizedValue,
  type LocaleConfig,
} from "@/shared/localization";
import type { EntryData, FieldDTO } from "@/shared/api-types";

type FormValues = Record<string, unknown>;

/** Coerce one raw entry-data value into the RHF value for its field type. */
function coerceToForm(field: FieldDTO, value: unknown, hasKey: boolean): unknown {
  switch (field.type) {
    case "boolean":
      return Boolean(value ?? field.options.default ?? false);
    case "number":
      return typeof value === "number" ? value : null;
    case "rich_text":
      return value && typeof value === "object" ? value : null;
    case "picture":
    case "video":
      return typeof value === "string" ? value : null;
    case "reference":
      return field.options.multiple
        ? Array.isArray(value)
          ? value.filter((v): v is string => typeof v === "string")
          : []
        : typeof value === "string"
          ? value
          : null;
    case "link": {
      const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      return {
        url: typeof obj.url === "string" ? obj.url : "",
        label: typeof obj.label === "string" ? obj.label : "",
        newTab: Boolean(obj.newTab),
      };
    }
    case "select":
      // Existing selection wins; otherwise seed the default only when the value is absent
      // (a saved-but-cleared select — key present, empty — stays empty). "" renders the
      // placeholder. `hasKey` = the field/locale key was present in the stored data.
      return typeof value === "string" && value
        ? value
        : !hasKey && typeof field.options.default === "string"
          ? field.options.default
          : "";
    default:
      return typeof value === "string" ? value : "";
  }
}

/** Coerce one RHF value into a clean entry-data value for its field type. */
function coerceToEntry(field: FieldDTO, value: unknown): unknown {
  switch (field.type) {
    case "boolean":
      return Boolean(value);
    case "number":
      return value === "" || value === undefined || value === null ? null : value;
    case "rich_text":
      return value && typeof value === "object" ? value : null;
    case "picture":
    case "video":
      return typeof value === "string" && value ? value : null;
    case "reference":
      return field.options.multiple
        ? Array.isArray(value)
          ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
          : []
        : typeof value === "string" && value
          ? value
          : null;
    case "link": {
      const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      const url = typeof obj.url === "string" ? obj.url.trim() : "";
      if (!url) return null;
      const label = typeof obj.label === "string" ? obj.label.trim() : "";
      return {
        url,
        ...(label ? { label } : {}),
        ...(obj.newTab ? { newTab: true } : {}),
      };
    }
    case "select":
      // A chosen option is a non-empty string; "" (placeholder) means unset → null.
      return typeof value === "string" && value ? value : null;
    default:
      return typeof value === "string" ? value : "";
  }
}

/** Whether a coerced entry value should be dropped from a locale map (missing → delivery fallback). */
function isBlankEntryValue(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Seed RHF form values from an entry's stored data, giving every field a defined value.
 * A localized field becomes a `{ [locale]: value }` map with every configured locale seeded so
 * each tab renders; a bare (not-yet-migrated) scalar is placed under the default locale.
 */
export function toFormValues(fields: FieldDTO[], data: EntryData, config: LocaleConfig): FormValues {
  const out: FormValues = {};
  for (const field of fields) {
    if (isLocalized(field)) {
      const stored = data[field.name];
      const raw: Record<string, unknown> = isLocaleMap(stored)
        ? stored
        : stored === undefined || stored === null
          ? {}
          : { [config.default]: stored };
      const map: Record<string, unknown> = {};
      for (const locale of config.locales) {
        map[locale] = coerceToForm(field, raw[locale], locale in raw);
      }
      out[field.name] = map;
    } else {
      out[field.name] = coerceToForm(field, data[field.name], field.name in data);
    }
  }
  return out;
}

/**
 * Convert RHF form values into a clean entry-data payload for the API. A localized field is
 * rebuilt as a `{ [locale]: value }` map over the configured locales; a blank locale is omitted
 * (not stored as ""/null) so a missing translation falls back to the default at delivery.
 * v1: only currently-configured locales are written, so an orphaned locale left behind by a
 * removed language is dropped on the next save (the admin is warned when removing a language).
 */
export function toEntryData(fields: FieldDTO[], values: FormValues, config: LocaleConfig): EntryData {
  const out: EntryData = {};
  for (const field of fields) {
    if (isLocalized(field)) {
      const src = asRecord(values[field.name]);
      const map: Record<string, unknown> = {};
      for (const locale of config.locales) {
        const coerced = coerceToEntry(field, src[locale]);
        if (!isBlankEntryValue(coerced)) map[locale] = coerced;
      }
      out[field.name] = map;
    } else {
      out[field.name] = coerceToEntry(field, values[field.name]);
    }
  }
  return out;
}

/**
 * Derive a human title from a watched title-field value (for the editor status bar / heading).
 * A localized title is a locale map, so resolve it to the default locale first.
 */
export function titleFromValue(value: unknown, config: LocaleConfig): string {
  const resolved = resolveLocalizedValue(value, config.default, config);
  if (typeof resolved === "string" && resolved.trim()) return resolved.trim();
  if (typeof resolved === "number" || typeof resolved === "boolean") return String(resolved);
  if (resolved && typeof resolved === "object") {
    const obj = resolved as Record<string, unknown>;
    if (typeof obj.label === "string" && obj.label.trim()) return obj.label.trim();
    if (typeof obj.url === "string" && obj.url.trim()) return obj.url.trim();
  }
  return "";
}
