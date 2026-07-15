import { useEffect, useRef, useState } from "react";
import { useForm, useWatch, type Control } from "react-hook-form";
import { ChevronDownIcon, ChevronLeftIcon, PlusIcon, XIcon } from "lucide-react";
import { ZodError } from "zod";

import { FIELD_TYPE_ICONS } from "../field-type-meta";

import {
  FIELD_TYPES,
  FIELD_TYPE_LIST,
  type FieldOptions,
  type FieldType,
} from "@/shared/field-types";
import { LOCALIZABLE_TYPES } from "@/shared/localization";
import { camelize, fieldNameError } from "@/shared/slug";
import type { FieldDTO } from "@/shared/api-types";
import { Button } from "@/app/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/app/components/ui/form";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { Switch } from "@/app/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/app/components/ui/sheet";
import { cn } from "@/app/lib/utils";

/** A field as edited in the sheet — the shape the schema builder applies. */
export interface FieldDraft {
  name: string;
  label: string;
  type: FieldType;
  options: FieldOptions;
}

interface FieldSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit mode (type + name locked); absent → add mode. */
  initial: FieldDTO | null;
  /** Field names already used in this collection (for duplicate detection in add mode). */
  existingNames: string[];
  /** All collections, for a reference field's target-collection selector (self-reference allowed). */
  availableCollections: { slug: string; name: string }[];
  /** Field types to hide from the type picker (e.g. `reference` on product schemas). */
  excludeTypes?: FieldType[];
  submitting: boolean;
  onApply: (field: FieldDraft) => void;
}

interface FieldFormValues {
  label: string;
  name: string;
  options: FieldOptions;
}

function defaultOptionsFor(type: FieldType): FieldOptions {
  if (type === "link") return { allowRelative: true };
  if (type === "boolean") return { default: false };
  if (type === "reference") return { targetCollections: [], multiple: false };
  if (type === "select") return { choices: [""] };
  return {};
}

/** Drop empty strings / undefined so optional options don't get stored as "". */
function pruneOptions(options: FieldOptions): FieldOptions {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    // Array options (targetCollections, select's choices): trim + drop blank
    // entries, but keep the (possibly empty) array — `targetCollections: []`
    // means "any", so the key must survive.
    if (Array.isArray(value)) {
      out[key] = value
        .map((v) => (typeof v === "string" ? v.trim() : v))
        .filter((v) => !(typeof v === "string" && v === ""));
      continue;
    }
    if (typeof value === "string" && value.trim() === "") continue;
    if (typeof value === "number" && Number.isNaN(value)) continue;
    out[key] = typeof value === "string" ? value.trim() : value;
  }
  return out as FieldOptions;
}

export function FieldSheet({
  open,
  onOpenChange,
  initial,
  existingNames,
  availableCollections,
  excludeTypes = [],
  submitting,
  onApply,
}: FieldSheetProps): React.ReactElement {
  const isEdit = initial !== null;
  const [type, setType] = useState<FieldType | null>(initial?.type ?? null);
  const nameEdited = useRef(isEdit);

  const form = useForm<FieldFormValues>({
    defaultValues: {
      label: initial?.label ?? "",
      name: initial?.name ?? "",
      options: initial?.options ?? {},
    },
  });

  // Reset everything whenever the sheet (re)opens.
  useEffect(() => {
    if (open) {
      setType(initial?.type ?? null);
      nameEdited.current = isEdit;
      form.reset({
        label: initial?.label ?? "",
        name: initial?.name ?? "",
        options: initial?.options ?? defaultOptionsFor(initial?.type ?? "text"),
      });
    }
  }, [open, initial, isEdit, form]);

  const pickType = (next: FieldType): void => {
    setType(next);
    form.reset({ label: form.getValues("label"), name: form.getValues("name"), options: defaultOptionsFor(next) });
  };

  const onSubmit = (values: FieldFormValues): void => {
    if (!type) return;
    form.clearErrors();

    const label = values.label.trim();
    if (!label) {
      form.setError("label", { message: "Label is required" });
      return;
    }
    const name = isEdit ? initial.name : values.name.trim();
    const nameErr = fieldNameError(name);
    if (nameErr) {
      form.setError("name", { message: nameErr });
      return;
    }
    if (!isEdit && existingNames.includes(name)) {
      form.setError("name", { message: "A field with this name already exists" });
      return;
    }

    const pruned = pruneOptions(values.options);
    if (type === "select") {
      // A default that the author later removed from the options would fail the
      // "default must be a valid option" check — drop it rather than error.
      const choices = Array.isArray(pruned.choices) ? pruned.choices : [];
      if (typeof pruned.default === "string" && !choices.includes(pruned.default)) {
        delete pruned.default;
      }
    }
    try {
      const parsed = FIELD_TYPES[type].optionsSchema.parse(pruned);
      onApply({ name, label, type, options: parsed });
    } catch (err) {
      if (err instanceof ZodError) {
        for (const issue of err.issues) {
          const path = issue.path.length ? `options.${issue.path.join(".")}` : "options";
          form.setError(path as Parameters<typeof form.setError>[0], { message: issue.message });
        }
        return;
      }
      throw err;
    }
  };

  const showTypePicker = !isEdit && type === null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="border-b">
          <div className="flex items-center gap-2">
            {!isEdit && type !== null ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setType(null)}
                aria-label="Back to field types"
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
            ) : null}
            <div>
              <SheetTitle>
                {isEdit ? `Edit ${initial.label}` : type ? `New ${FIELD_TYPES[type].label} field` : "Add a field"}
              </SheetTitle>
              <SheetDescription>
                {showTypePicker
                  ? "Choose a field type."
                  : "Configure how this field behaves and validates."}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        {showTypePicker ? (
          <div className="grid grid-cols-2 gap-3 p-4">
            {FIELD_TYPE_LIST.filter((t) => !excludeTypes.includes(t)).map((t) => {
              const Icon = FIELD_TYPE_ICONS[t];
              return (
                <button
                  type="button"
                  key={t}
                  onClick={() => pickType(t)}
                  className="flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent"
                >
                  <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <span className="text-sm font-medium">{FIELD_TYPES[t].label}</span>
                  <span className="text-xs text-muted-foreground">{FIELD_TYPES[t].description}</span>
                </button>
              );
            })}
          </div>
        ) : type ? (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
              <div className="flex-1 space-y-4 overflow-y-auto p-4">
                <FormField
                  control={form.control}
                  name="label"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Label</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Headline"
                          {...field}
                          onChange={(e) => {
                            field.onChange(e);
                            if (!nameEdited.current) {
                              form.setValue("name", camelize(e.target.value));
                            }
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API name</FormLabel>
                      <FormControl>
                        <Input
                          className="font-mono"
                          placeholder="headline"
                          disabled={isEdit}
                          {...field}
                          onChange={(e) => {
                            nameEdited.current = true;
                            field.onChange(e);
                          }}
                        />
                      </FormControl>
                      <FormDescription>
                        {isEdit ? "Immutable — delete and re-add to rename." : "Key used in the delivery API. Immutable once created."}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <TypeOptions type={type} control={form.control} availableCollections={availableCollections} />
              </div>

              <SheetFooter className="border-t">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Saving…" : isEdit ? "Save field" : "Add field"}
                </Button>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
              </SheetFooter>
            </form>
          </Form>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

// --- per-type option inputs --------------------------------------------------

function SwitchRow({
  control,
  name,
  label,
  description,
}: {
  control: Control<FieldFormValues>;
  name: `options.${string}`;
  label: string;
  description?: string;
}): React.ReactElement {
  return (
    <FormField
      control={control}
      name={name as never}
      render={({ field }) => (
        <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-0.5">
            <FormLabel>{label}</FormLabel>
            {description ? <FormDescription>{description}</FormDescription> : null}
          </div>
          <FormControl>
            <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

function TextRow({
  control,
  name,
  label,
  placeholder,
  multiline,
}: {
  control: Control<FieldFormValues>;
  name: `options.${string}`;
  label: string;
  placeholder?: string;
  multiline?: boolean;
}): React.ReactElement {
  return (
    <FormField
      control={control}
      name={name as never}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            {multiline ? (
              <Textarea rows={2} placeholder={placeholder} {...field} value={(field.value as string) ?? ""} />
            ) : (
              <Input placeholder={placeholder} {...field} value={(field.value as string) ?? ""} />
            )}
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function NumberRow({
  control,
  name,
  label,
  placeholder,
}: {
  control: Control<FieldFormValues>;
  name: `options.${string}`;
  label: string;
  placeholder?: string;
}): React.ReactElement {
  return (
    <FormField
      control={control}
      name={name as never}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              placeholder={placeholder}
              value={field.value === undefined || field.value === null ? "" : String(field.value)}
              onChange={(e) => field.onChange(e.target.value === "" ? undefined : e.target.valueAsNumber)}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Editable list of a select field's text options (at least one row is kept). */
function ChoicesEditor({ control }: { control: Control<FieldFormValues> }): React.ReactElement {
  return (
    <FormField
      control={control}
      name={"options.choices" as never}
      render={({ field }) => {
        const choices: string[] = Array.isArray(field.value) ? (field.value as string[]) : [];
        const update = (next: string[]): void => field.onChange(next);
        return (
          <FormItem>
            <FormLabel>Options</FormLabel>
            <FormDescription>The values an editor can choose from.</FormDescription>
            <div className="space-y-2">
              {choices.map((choice, i) => (
                // Index key is safe here: rows aren't reordered, only edited/removed.
                <div key={i} className="flex items-center gap-2">
                  <Input
                    placeholder={`Option ${i + 1}`}
                    value={choice}
                    onChange={(e) => update(choices.map((c, idx) => (idx === i ? e.target.value : c)))}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove option"
                    disabled={choices.length <= 1}
                    onClick={() => update(choices.filter((_, idx) => idx !== i))}
                  >
                    <XIcon className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => update([...choices, ""])}
            >
              <PlusIcon className="size-4" />
              Add option
            </Button>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

/** Optional default value, chosen from the field's current (non-blank, unique) options. */
function DefaultChoiceRow({ control }: { control: Control<FieldFormValues> }): React.ReactElement {
  const watched = useWatch({ control, name: "options.choices" as never }) as unknown;
  const options = (Array.isArray(watched) ? (watched as unknown[]) : [])
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter((c, i, all) => c !== "" && all.indexOf(c) === i);

  return (
    <FormField
      control={control}
      name={"options.default" as never}
      render={({ field }) => {
        // Radix Select needs string | undefined; a default that's no longer a
        // current option collapses to undefined (placeholder) here and is dropped
        // on submit, so it never lingers as an invalid value.
        const value =
          typeof field.value === "string" && options.includes(field.value) ? field.value : undefined;
        return (
          <FormItem>
            <FormLabel>Default value</FormLabel>
            <div className="flex items-center gap-2">
              <Select value={value} onValueChange={field.onChange} disabled={options.length === 0}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={options.length === 0 ? "Add options first" : "No default"} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {options.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {value ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => field.onChange(undefined)}
                >
                  Clear
                </Button>
              ) : null}
            </div>
            <FormDescription>Pre-selected when a new entry is created.</FormDescription>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

function TypeOptions({
  type,
  control,
  availableCollections,
}: {
  type: FieldType;
  control: Control<FieldFormValues>;
  availableCollections: { slug: string; name: string }[];
}): React.ReactElement {
  const required = FIELD_TYPES[type].hasRequired ? (
    <SwitchRow control={control} name="options.required" label="Required" description="Must be set before publishing." />
  ) : null;
  const help = (
    <TextRow control={control} name="options.help" label="Help text" placeholder="Shown under the field in the editor." />
  );

  return (
    <div className={cn("space-y-4")}>
      {required}
      {LOCALIZABLE_TYPES.has(type) ? (
        <SwitchRow
          control={control}
          name="options.localized"
          label="Localized"
          description="Store a separate value per content language (configure languages in Settings)."
        />
      ) : null}
      {type === "text" ? (
        <>
          <SwitchRow control={control} name="options.multiline" label="Multi-line" />
          <TextRow control={control} name="options.placeholder" label="Placeholder" />
          <TextRow control={control} name="options.default" label="Default value" />
          <div className="grid grid-cols-2 gap-3">
            <NumberRow control={control} name="options.minLength" label="Min length" />
            <NumberRow control={control} name="options.maxLength" label="Max length" />
          </div>
        </>
      ) : null}
      {type === "rich_text" ? <TextRow control={control} name="options.placeholder" label="Placeholder" /> : null}
      {type === "number" ? (
        <>
          <SwitchRow control={control} name="options.integer" label="Integer only" />
          <div className="grid grid-cols-2 gap-3">
            <NumberRow control={control} name="options.min" label="Min" />
            <NumberRow control={control} name="options.max" label="Max" />
          </div>
          <NumberRow control={control} name="options.default" label="Default value" />
          <TextRow control={control} name="options.placeholder" label="Placeholder" />
        </>
      ) : null}
      {type === "boolean" ? (
        <SwitchRow control={control} name="options.default" label="Default value" description="Starting state for new entries." />
      ) : null}
      {type === "link" ? (
        <SwitchRow
          control={control}
          name="options.allowRelative"
          label="Allow relative links"
          description="Permit /path and #anchor in addition to full URLs."
        />
      ) : null}
      {type === "reference" ? (
        <>
          <FormField
            control={control}
            name={"options.targetCollections" as never}
            render={({ field }) => {
              const selected = Array.isArray(field.value) ? (field.value as string[]) : [];
              const selectedNames = availableCollections
                .filter((c) => selected.includes(c.slug))
                .map((c) => c.name);
              return (
                <FormItem>
                  <FormLabel>Target collections</FormLabel>
                  <FormDescription>
                    Which collections this field can link to. Leave all unselected to allow any.
                  </FormDescription>
                  <FormControl>
                    {availableCollections.length > 0 ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            className="w-full justify-between font-normal"
                          >
                            <span
                              className={cn(
                                "truncate",
                                selectedNames.length === 0 && "text-muted-foreground",
                              )}
                            >
                              {selectedNames.length === 0 ? "Any collection" : selectedNames.join(", ")}
                            </span>
                            <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          className="w-[var(--radix-dropdown-menu-trigger-width)]"
                        >
                          {availableCollections.map((c) => (
                            <DropdownMenuCheckboxItem
                              key={c.slug}
                              checked={selected.includes(c.slug)}
                              onCheckedChange={(checked) =>
                                field.onChange(
                                  checked
                                    ? [...selected, c.slug]
                                    : selected.filter((s) => s !== c.slug),
                                )
                              }
                              onSelect={(e) => e.preventDefault()}
                            >
                              {c.name}
                            </DropdownMenuCheckboxItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <p className="text-sm text-muted-foreground">No other collections yet — any is allowed.</p>
                    )}
                  </FormControl>
                  <FormMessage />
                </FormItem>
              );
            }}
          />
          <SwitchRow
            control={control}
            name="options.multiple"
            label="Allow multiple"
            description="Store an ordered list of entries instead of a single one."
          />
        </>
      ) : null}
      {type === "select" ? (
        <>
          <ChoicesEditor control={control} />
          <DefaultChoiceRow control={control} />
          <TextRow control={control} name="options.placeholder" label="Placeholder" />
        </>
      ) : null}
      {help}
    </div>
  );
}
