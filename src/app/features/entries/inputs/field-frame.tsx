import { useWatch, type Control, type ControllerRenderProps, type FieldValues } from "react-hook-form";

import type { EntryFieldInputProps } from "./types";

import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/app/components/ui/form";
import { cn } from "@/app/lib/utils";
import { FIELD_TYPES } from "@/shared/field-types";
import { isLocalized } from "@/shared/localization";
import type { FieldDTO } from "@/shared/api-types";

/** Whether a field is required (boolean has no required flag). */
export function isFieldRequired(field: FieldDTO): boolean {
  return FIELD_TYPES[field.type].hasRequired && field.options.required === true;
}

/**
 * The RHF path a field's input binds to. A localized field stores a `{ [locale]: value }` map, so
 * its input targets `name.locale`; a non-localized field (or the product editor, which passes no
 * locale) binds to its bare `name`.
 */
export function localizedPath(field: FieldDTO, activeLocale?: string): string {
  return isLocalized(field) && activeLocale ? `${field.name}.${activeLocale}` : field.name;
}

export function RequiredMark({ field }: { field: FieldDTO }): React.ReactElement | null {
  return isFieldRequired(field) ? (
    <span className="text-destructive" aria-hidden>
      {" *"}
    </span>
  ) : null;
}

/** Whether a stored per-locale value counts as "filled" for the indicator. */
function isFilledLocaleValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("url" in obj) return typeof obj.url === "string" && obj.url.trim().length > 0; // link
    if ("json" in obj) return true; // rich_text — has a doc
    return Object.keys(obj).length > 0;
  }
  return true;
}

/**
 * Small per-locale chips shown next to a localized field's label, marking each configured locale
 * as filled or empty (the active one is ring-highlighted). Renders nothing for a non-localized
 * field or when no locales are supplied (e.g. the product editor).
 */
export function LocaleIndicator({
  control,
  field,
  activeLocale,
  locales,
}: {
  control: Control<FieldValues>;
  field: FieldDTO;
  activeLocale?: string;
  locales?: string[];
}): React.ReactElement | null {
  const map = useWatch({ control, name: field.name }) as unknown;
  if (!isLocalized(field) || !locales || locales.length === 0) return null;
  const record = map && typeof map === "object" ? (map as Record<string, unknown>) : {};
  return (
    <span className="ml-2 inline-flex gap-1 align-middle">
      {locales.map((loc) => {
        const filled = isFilledLocaleValue(record[loc]);
        return (
          <span
            key={loc}
            title={filled ? `${loc}: filled` : `${loc}: empty`}
            className={cn(
              "inline-flex items-center rounded px-1 text-[10px] leading-4 font-medium uppercase",
              loc === activeLocale ? "ring-1 ring-ring" : "",
              filled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
            )}
          >
            {loc}
          </span>
        );
      })}
    </span>
  );
}

/**
 * Standard label / control / help / error frame for single-control field inputs.
 * The render-prop receives the RHF field bag so the input can bind to it. For a localized field
 * the control binds to the active locale's path; all locales stay in form state and submit together.
 */
export function FieldFrame({
  control,
  field,
  activeLocale,
  locales,
  children,
}: EntryFieldInputProps & {
  children: (rhf: ControllerRenderProps<FieldValues, string>) => React.ReactNode;
}): React.ReactElement {
  return (
    <FormField
      control={control}
      name={localizedPath(field, activeLocale)}
      render={({ field: rhf }) => (
        <FormItem>
          <FormLabel>
            {field.label}
            <RequiredMark field={field} />
            <LocaleIndicator control={control} field={field} activeLocale={activeLocale} locales={locales} />
          </FormLabel>
          <FormControl>{children(rhf)}</FormControl>
          {field.options.help ? <FormDescription>{field.options.help}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
