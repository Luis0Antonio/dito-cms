import type { EntryData, FieldDTO } from "@/shared/api-types";

type FormValues = Record<string, unknown>;

/** Seed RHF form values from an entry's stored data, giving every field a defined value. */
export function toFormValues(fields: FieldDTO[], data: EntryData): FormValues {
  const out: FormValues = {};
  for (const field of fields) {
    const value = data[field.name];
    switch (field.type) {
      case "boolean":
        out[field.name] = Boolean(value ?? field.options.default ?? false);
        break;
      case "number":
        out[field.name] = typeof value === "number" ? value : null;
        break;
      case "rich_text":
        out[field.name] = value && typeof value === "object" ? value : null;
        break;
      case "picture":
      case "video":
        out[field.name] = typeof value === "string" ? value : null;
        break;
      case "reference":
        out[field.name] = field.options.multiple
          ? Array.isArray(value)
            ? value.filter((v): v is string => typeof v === "string")
            : []
          : typeof value === "string"
            ? value
            : null;
        break;
      case "link": {
        const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
        out[field.name] = {
          url: typeof obj.url === "string" ? obj.url : "",
          label: typeof obj.label === "string" ? obj.label : "",
          newTab: Boolean(obj.newTab),
        };
        break;
      }
      default:
        out[field.name] = typeof value === "string" ? value : "";
    }
  }
  return out;
}

/** Convert RHF form values into a clean entry-data payload for the API. */
export function toEntryData(fields: FieldDTO[], values: FormValues): EntryData {
  const out: EntryData = {};
  for (const field of fields) {
    const value = values[field.name];
    switch (field.type) {
      case "boolean":
        out[field.name] = Boolean(value);
        break;
      case "number":
        out[field.name] = value === "" || value === undefined || value === null ? null : value;
        break;
      case "rich_text":
        out[field.name] = value && typeof value === "object" ? value : null;
        break;
      case "picture":
      case "video":
        out[field.name] = typeof value === "string" && value ? value : null;
        break;
      case "reference":
        out[field.name] = field.options.multiple
          ? Array.isArray(value)
            ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
            : []
          : typeof value === "string" && value
            ? value
            : null;
        break;
      case "link": {
        const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
        const url = typeof obj.url === "string" ? obj.url.trim() : "";
        if (!url) {
          out[field.name] = null;
        } else {
          const label = typeof obj.label === "string" ? obj.label.trim() : "";
          out[field.name] = {
            url,
            ...(label ? { label } : {}),
            ...(obj.newTab ? { newTab: true } : {}),
          };
        }
        break;
      }
      default: {
        const text = typeof value === "string" ? value : "";
        out[field.name] = text;
      }
    }
  }
  return out;
}

/** Derive a human title from a watched title-field value (for the editor status bar). */
export function titleFromValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.label === "string" && obj.label.trim()) return obj.label.trim();
    if (typeof obj.url === "string" && obj.url.trim()) return obj.url.trim();
  }
  return "";
}
