import { FieldFrame, LocaleIndicator, RequiredMark, isFieldRequired, localizedPath } from "./field-frame";
import { RichTextFieldInput } from "./rich-text-input";
import { MediaFieldInput } from "./media-input";
import { ReferenceFieldInput } from "./reference-input";
import type { EntryFieldInputProps } from "./types";

import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { Switch } from "@/app/components/ui/switch";
import { Button } from "@/app/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/app/components/ui/form";

function TextFieldInput(props: EntryFieldInputProps): React.ReactElement {
  const { field } = props;
  const multiline = field.options.multiline === true;
  return (
    <FieldFrame {...props}>
      {(rhf) =>
        multiline ? (
          <Textarea
            rows={4}
            placeholder={field.options.placeholder}
            {...rhf}
            value={(rhf.value as string) ?? ""}
          />
        ) : (
          <Input
            placeholder={field.options.placeholder}
            {...rhf}
            value={(rhf.value as string) ?? ""}
          />
        )
      }
    </FieldFrame>
  );
}

function NumberFieldInput(props: EntryFieldInputProps): React.ReactElement {
  const { field } = props;
  return (
    <FieldFrame {...props}>
      {(rhf) => (
        <Input
          type="number"
          inputMode={field.options.integer ? "numeric" : "decimal"}
          placeholder={field.options.placeholder}
          name={rhf.name}
          ref={rhf.ref}
          onBlur={rhf.onBlur}
          value={rhf.value === undefined || rhf.value === null ? "" : String(rhf.value)}
          onChange={(e) => rhf.onChange(e.target.value === "" ? null : e.target.valueAsNumber)}
        />
      )}
    </FieldFrame>
  );
}

function BooleanFieldInput({ control, field, activeLocale, locales }: EntryFieldInputProps): React.ReactElement {
  return (
    <FormField
      control={control}
      name={localizedPath(field, activeLocale)}
      render={({ field: rhf }) => (
        <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-0.5">
            <FormLabel>
              {field.label}
              <LocaleIndicator control={control} field={field} activeLocale={activeLocale} locales={locales} />
            </FormLabel>
            {field.options.help ? <FormDescription>{field.options.help}</FormDescription> : null}
          </div>
          <FormControl>
            <Switch checked={Boolean(rhf.value)} onCheckedChange={rhf.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

function LinkFieldInput({ control, field, activeLocale, locales }: EntryFieldInputProps): React.ReactElement {
  const base = localizedPath(field, activeLocale);
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <span className="text-sm leading-none font-medium">
          {field.label}
          <RequiredMark field={field} />
          <LocaleIndicator control={control} field={field} activeLocale={activeLocale} locales={locales} />
        </span>
        {field.options.help ? (
          <p className="text-sm text-muted-foreground">{field.options.help}</p>
        ) : null}
      </div>
      <div className="space-y-3 rounded-lg border p-3">
        <FormField
          control={control}
          name={`${base}.url`}
          render={({ field: rhf }) => (
            <FormItem>
              <FormLabel className="text-xs text-muted-foreground">URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://example.com or /pricing"
                  {...rhf}
                  value={(rhf.value as string) ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={`${base}.label`}
          render={({ field: rhf }) => (
            <FormItem>
              <FormLabel className="text-xs text-muted-foreground">Label (optional)</FormLabel>
              <FormControl>
                <Input placeholder="Learn more" {...rhf} value={(rhf.value as string) ?? ""} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={`${base}.newTab`}
          render={({ field: rhf }) => (
            <FormItem className="flex flex-row items-center justify-between gap-4">
              <FormLabel className="text-xs text-muted-foreground">Open in a new tab</FormLabel>
              <FormControl>
                <Switch checked={Boolean(rhf.value)} onCheckedChange={rhf.onChange} />
              </FormControl>
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}

function SelectFieldInput({ control, field, activeLocale, locales }: EntryFieldInputProps): React.ReactElement {
  const choices = Array.isArray(field.options.choices) ? field.options.choices : [];
  const placeholder = field.options.placeholder || "Select an option";
  const required = isFieldRequired(field);
  return (
    <FormField
      control={control}
      name={localizedPath(field, activeLocale)}
      render={({ field: rhf }) => {
        // Radix Select uses "" for "nothing selected" (renders the placeholder);
        // option values are always non-empty choices. Never feed it null/undefined.
        const value = typeof rhf.value === "string" ? rhf.value : "";
        return (
          <FormItem>
            <FormLabel>
              {field.label}
              <RequiredMark field={field} />
              <LocaleIndicator control={control} field={field} activeLocale={activeLocale} locales={locales} />
            </FormLabel>
            <div className="flex items-center gap-2">
              <Select value={value} onValueChange={rhf.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={placeholder} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {choices.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {choice}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!required && value ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => rhf.onChange("")}>
                  Clear
                </Button>
              ) : null}
            </div>
            {field.options.help ? <FormDescription>{field.options.help}</FormDescription> : null}
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

/** Render the right input for a field's type. */
export function FieldInput(props: EntryFieldInputProps): React.ReactElement {
  switch (props.field.type) {
    case "text":
      return <TextFieldInput {...props} />;
    case "number":
      return <NumberFieldInput {...props} />;
    case "boolean":
      return <BooleanFieldInput {...props} />;
    case "rich_text":
      return <RichTextFieldInput {...props} />;
    case "picture":
    case "video":
      return <MediaFieldInput {...props} />;
    case "link":
      return <LinkFieldInput {...props} />;
    case "reference":
      return <ReferenceFieldInput {...props} />;
    case "select":
      return <SelectFieldInput {...props} />;
  }
}

export { isFieldRequired };
