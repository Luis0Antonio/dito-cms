import type { Control, FieldValues } from "react-hook-form";

import type { FieldDTO } from "@/shared/api-types";

/** Props every entry field input receives: the RHF control + the field definition. */
export interface EntryFieldInputProps {
  control: Control<FieldValues>;
  field: FieldDTO;
  /**
   * The content locale currently being edited. Set only in the entry editor; when a field is
   * localized, its input binds to `${field.name}.${activeLocale}`. Absent (e.g. the product
   * editor, where fields are never localized) → the field binds to its bare name.
   */
  activeLocale?: string;
  /** All configured content locales, for the per-locale filled/empty indicator. */
  locales?: string[];
}
