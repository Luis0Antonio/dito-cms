import { FieldFrame, RequiredMark, isFieldRequired } from "./field-frame";
import { RichTextFieldInput } from "./rich-text-input";
import { MediaFieldInput } from "./media-input";
import { ReferenceFieldInput } from "./reference-input";
import type { EntryFieldInputProps } from "./types";

import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { Switch } from "@/app/components/ui/switch";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/app/components/ui/form";

function TextFieldInput({ control, field }: EntryFieldInputProps): React.ReactElement {
  const multiline = field.options.multiline === true;
  return (
    <FieldFrame control={control} field={field}>
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

function NumberFieldInput({ control, field }: EntryFieldInputProps): React.ReactElement {
  return (
    <FieldFrame control={control} field={field}>
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

function BooleanFieldInput({ control, field }: EntryFieldInputProps): React.ReactElement {
  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => (
        <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-0.5">
            <FormLabel>{field.label}</FormLabel>
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

function LinkFieldInput({ control, field }: EntryFieldInputProps): React.ReactElement {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <span className="text-sm leading-none font-medium">
          {field.label}
          <RequiredMark field={field} />
        </span>
        {field.options.help ? (
          <p className="text-sm text-muted-foreground">{field.options.help}</p>
        ) : null}
      </div>
      <div className="space-y-3 rounded-lg border p-3">
        <FormField
          control={control}
          name={`${field.name}.url`}
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
          name={`${field.name}.label`}
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
          name={`${field.name}.newTab`}
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
  }
}

export { isFieldRequired };
