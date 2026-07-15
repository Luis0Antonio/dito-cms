import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  BoldIcon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  Redo2Icon,
  Undo2Icon,
  Unlink2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { LocaleIndicator, RequiredMark, localizedPath } from "./field-frame";
import type { EntryFieldInputProps } from "./types";

import { emptyRichTextDoc, isSafeHref, type RichTextDoc } from "@/shared/richtext";
import { Toggle } from "@/app/components/ui/toggle";
import { Button } from "@/app/components/ui/button";
import { Separator } from "@/app/components/ui/separator";
import {
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/app/components/ui/form";

interface RichTextValue {
  json: RichTextDoc;
  html: string;
}

function asRichTextValue(value: unknown): RichTextValue | null {
  if (value && typeof value === "object" && "json" in value) {
    return value as RichTextValue;
  }
  return null;
}

function Toolbar({ editor }: { editor: Editor }): React.ReactElement {
  // The editor re-renders on every transaction, so reading isActive() inline keeps the
  // toolbar in sync with the selection without a separate subscription.
  const state = {
    isH2: editor.isActive("heading", { level: 2 }),
    isH3: editor.isActive("heading", { level: 3 }),
    isBold: editor.isActive("bold"),
    isItalic: editor.isActive("italic"),
    isBullet: editor.isActive("bulletList"),
    isOrdered: editor.isActive("orderedList"),
    isQuote: editor.isActive("blockquote"),
    isLink: editor.isActive("link"),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
  };

  const setLink = (): void => {
    const previous = (editor.getAttributes("link").href as string) ?? "";
    const url = window.prompt("Link URL", previous);
    if (url === null) return;
    if (url.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (!isSafeHref(url)) {
      toast.error("Enter an http(s), mailto, tel, or relative (/path, #anchor) URL");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b bg-muted/40 p-1">
      <Toggle size="sm" pressed={state.isH2} onPressedChange={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} aria-label="Heading 2">
        <Heading2Icon className="size-4" />
      </Toggle>
      <Toggle size="sm" pressed={state.isH3} onPressedChange={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} aria-label="Heading 3">
        <Heading3Icon className="size-4" />
      </Toggle>
      <Separator orientation="vertical" className="mx-0.5 h-5" />
      <Toggle size="sm" pressed={state.isBold} onPressedChange={() => editor.chain().focus().toggleBold().run()} aria-label="Bold">
        <BoldIcon className="size-4" />
      </Toggle>
      <Toggle size="sm" pressed={state.isItalic} onPressedChange={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic">
        <ItalicIcon className="size-4" />
      </Toggle>
      <Separator orientation="vertical" className="mx-0.5 h-5" />
      <Toggle size="sm" pressed={state.isBullet} onPressedChange={() => editor.chain().focus().toggleBulletList().run()} aria-label="Bullet list">
        <ListIcon className="size-4" />
      </Toggle>
      <Toggle size="sm" pressed={state.isOrdered} onPressedChange={() => editor.chain().focus().toggleOrderedList().run()} aria-label="Ordered list">
        <ListOrderedIcon className="size-4" />
      </Toggle>
      <Toggle size="sm" pressed={state.isQuote} onPressedChange={() => editor.chain().focus().toggleBlockquote().run()} aria-label="Quote">
        <QuoteIcon className="size-4" />
      </Toggle>
      <Separator orientation="vertical" className="mx-0.5 h-5" />
      <Toggle size="sm" pressed={state.isLink} onPressedChange={setLink} aria-label="Link">
        <LinkIcon className="size-4" />
      </Toggle>
      {state.isLink ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
          aria-label="Remove link"
        >
          <Unlink2Icon className="size-4" />
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-0.5">
        <Button type="button" variant="ghost" size="icon-sm" disabled={!state.canUndo} onClick={() => editor.chain().focus().undo().run()} aria-label="Undo">
          <Undo2Icon className="size-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={!state.canRedo} onClick={() => editor.chain().focus().redo().run()} aria-label="Redo">
          <Redo2Icon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function RichTextEditor({
  value,
  onChange,
  placeholder,
}: {
  value: unknown;
  onChange: (value: RichTextValue) => void;
  placeholder?: string;
}): React.ReactElement {
  const initial = asRichTextValue(value);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        code: false,
        codeBlock: false,
        strike: false,
        underline: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          protocols: ["http", "https", "mailto", "tel"],
          HTMLAttributes: { rel: "noopener noreferrer nofollow" },
        },
      }),
      Placeholder.configure({ placeholder: placeholder || "Write something…" }),
    ],
    content: initial?.json ?? emptyRichTextDoc(),
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none px-3 py-2 min-h-[10rem] focus:outline-none [&_a]:text-primary [&_a]:underline",
      },
    },
    onUpdate: ({ editor: e }) => onChange({ json: e.getJSON() as RichTextDoc, html: e.getHTML() }),
  });

  return (
    <div className="overflow-hidden rounded-md border focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
      {editor ? <Toolbar editor={editor} /> : null}
      <EditorContent editor={editor} />
    </div>
  );
}

/** Rich-text field: TipTap editor wrapped in the shared label/help/error frame. */
export function RichTextFieldInput({
  control,
  field,
  activeLocale,
  locales,
}: EntryFieldInputProps): React.ReactElement {
  // For a localized field the path is `name.locale`; keying the editor on it remounts (reloading
  // content) when the active locale changes, since TipTap only reads `content` on init.
  const path = localizedPath(field, activeLocale);
  return (
    <FormField
      control={control}
      name={path}
      render={({ field: rhf }) => (
        <FormItem>
          <FormLabel>
            {field.label}
            <RequiredMark field={field} />
            <LocaleIndicator control={control} field={field} activeLocale={activeLocale} locales={locales} />
          </FormLabel>
          <RichTextEditor
            key={path}
            value={rhf.value}
            onChange={rhf.onChange}
            placeholder={field.options.placeholder}
          />
          {field.options.help ? <FormDescription>{field.options.help}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
