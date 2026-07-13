import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardListIcon,
  MailIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import {
  contactFormDetailQueryOptions,
  contactFormKeys,
  contactFormsListQueryOptions,
  createContactForm,
  deleteContactForm,
  setContactFormFields,
  updateContactForm,
} from "@/app/api/contact-forms";
import { CopyButton } from "@/app/components/common/copy-button";
import { EmptyState } from "@/app/components/common/empty-state";
import { ErrorState } from "@/app/components/common/error-state";
import { PageHeader } from "@/app/components/common/page-header";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Skeleton } from "@/app/components/ui/skeleton";
import { Switch } from "@/app/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { Textarea } from "@/app/components/ui/textarea";
import { formatDateTime, formatRelativeTime } from "@/app/lib/format";
import { camelize } from "@/shared/slug";
import type {
  ContactFormDetail,
  ContactFormFieldInput,
  ContactFormFieldType,
  ContactFormSummary,
} from "@/shared/api-types";

const FIELD_TYPES: Array<{ value: ContactFormFieldType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
  { value: "textarea", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "checkbox", label: "Checkbox" },
  { value: "select", label: "Select" },
];

interface EditableField extends ContactFormFieldInput {
  localId: string;
  choicesText: string;
}

function toEditableFields(form: ContactFormDetail | undefined): EditableField[] {
  return (form?.fields ?? []).map((field) => ({
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    localId: field.id,
    choicesText: field.options.choices?.join("\n") ?? "",
  }));
}

function toFieldInput(field: EditableField): ContactFormFieldInput {
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
    options:
      field.type === "select"
        ? { choices: field.choicesText.split("\n").map((choice) => choice.trim()).filter(Boolean) }
        : {},
  };
}

function endpointFor(form: ContactFormDetail): string {
  return `${window.location.origin}/api/v1/contact-forms/${form.publicKey}/submissions`;
}

function fetchSnippet(endpoint: string): string {
  return `await fetch("${endpoint}", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "Jane Doe",
    email: "jane@example.com",
    message: "Hello"
  })
});`;
}

function FormCard({
  form,
  selected,
  onSelect,
}: {
  form: ContactFormSummary;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border p-4 text-left transition-colors ${
        selected ? "border-primary bg-accent/50" : "hover:border-primary/50 hover:bg-accent/40"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{form.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{form.publicKey}</div>
        </div>
        <Badge variant={form.enabled ? "secondary" : "outline"}>
          {form.enabled ? "Enabled" : "Off"}
        </Badge>
      </div>
      <div className="mt-3 flex gap-3 text-xs text-muted-foreground">
        <span>{form.fieldCount} fields</span>
        <span>{form.submissionCount} submissions</span>
      </div>
    </button>
  );
}

function ContactFormEditor({
  id,
  onDeleted,
}: {
  id: string;
  onDeleted: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(contactFormDetailQueryOptions(id));
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [rateLimitMax, setRateLimitMax] = useState(5);
  const [rateLimitWindowSeconds, setRateLimitWindowSeconds] = useState(60);
  const [fields, setFields] = useState<EditableField[]>([]);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setEnabled(data.enabled);
    setRateLimitMax(data.rateLimitMax);
    setRateLimitWindowSeconds(data.rateLimitWindowSeconds);
    setFields(toEditableFields(data));
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!data) throw new Error("Form not loaded");
      await updateContactForm(data.id, {
        name,
        enabled,
        rateLimitMax,
        rateLimitWindowSeconds,
      });
      return setContactFormFields(data.id, fields.map(toFieldInput));
    },
    onSuccess: (form) => {
      queryClient.setQueryData(contactFormKeys.detail(form.id), form);
      void queryClient.invalidateQueries({ queryKey: contactFormKeys.list() });
      toast.success("Contact form saved");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save contact form"),
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!data) return;
      await deleteContactForm(data.id);
    },
    onSuccess: () => {
      toast.success("Contact form deleted");
      void queryClient.invalidateQueries({ queryKey: contactFormKeys.list() });
      onDeleted();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete contact form"),
  });

  const updateField = (localId: string, patch: Partial<EditableField>): void => {
    setFields((current) =>
      current.map((field) => (field.localId === localId ? { ...field, ...patch } : field)),
    );
  };

  const addField = (): void => {
    const label = "New field";
    setFields((current) => {
      const used = new Set(current.map((field) => field.name));
      const base = camelize(label);
      let suffix = current.length + 1;
      while (used.has(`${base}${suffix}`)) suffix += 1;
      return [
        ...current,
        {
          localId: `new-${Date.now()}`,
          name: `${base}${suffix}`,
          label,
          type: "text",
          required: false,
          options: {},
          choicesText: "",
        },
      ];
    });
  };

  if (isPending) return <Skeleton className="h-[34rem] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data) return <EmptyState icon={MailIcon} title="Select a form" description="Choose a form to edit." />;

  const endpoint = endpointFor(data);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Form settings</CardTitle>
              <p className="text-sm text-muted-foreground">Use the public key from your website frontend.</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              <Trash2Icon className="size-4" />
              Delete
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="contact-form-name">Name</Label>
              <Input id="contact-form-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
              <div>
                <Label htmlFor="contact-form-enabled">Enabled</Label>
                <p className="text-xs text-muted-foreground">Disabled forms reject public submissions.</p>
              </div>
              <Switch id="contact-form-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="contact-form-rate-max">Max submissions</Label>
              <Input
                id="contact-form-rate-max"
                type="number"
                min={1}
                max={1000}
                value={rateLimitMax}
                onChange={(e) => setRateLimitMax(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-form-rate-window">Window seconds</Label>
              <Input
                id="contact-form-rate-window"
                type="number"
                min={10}
                max={86400}
                value={rateLimitWindowSeconds}
                onChange={(e) => setRateLimitWindowSeconds(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Endpoint</Label>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs">
                {endpoint}
              </code>
              <CopyButton value={endpoint} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Example request</Label>
            <div className="flex items-start gap-2">
              <pre className="max-h-40 min-w-0 flex-1 overflow-auto rounded-md bg-muted p-3 text-xs">
                {fetchSnippet(endpoint)}
              </pre>
              <CopyButton value={fetchSnippet(endpoint)} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Fields</CardTitle>
              <p className="text-sm text-muted-foreground">Incoming submissions are validated against these fields.</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addField}>
              <PlusIcon className="size-4" />
              Add field
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            {fields.map((field) => (
              <div key={field.localId} className="grid gap-3 rounded-md border p-3 lg:grid-cols-[1fr_1fr_10rem_7rem_auto]">
                <div className="space-y-1.5">
                  <Label>Label</Label>
                  <Input
                    value={field.label}
                    onChange={(e) => {
                      const label = e.target.value;
                      updateField(field.localId, {
                        label,
                        name: field.name ? field.name : camelize(label),
                      });
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input value={field.name} onChange={(e) => updateField(field.localId, { name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select
                    value={field.type}
                    onValueChange={(value) => updateField(field.localId, { type: value as ContactFormFieldType })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end gap-2 pb-2">
                  <Switch
                    id={`required-${field.localId}`}
                    checked={field.required === true}
                    onCheckedChange={(required) => updateField(field.localId, { required })}
                  />
                  <Label htmlFor={`required-${field.localId}`}>Required</Label>
                </div>
                <div className="flex items-end justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setFields((current) => current.filter((f) => f.localId !== field.localId))}
                    aria-label="Remove field"
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
                {field.type === "select" ? (
                  <div className="space-y-1.5 lg:col-span-5">
                    <Label>Choices</Label>
                    <Textarea
                      value={field.choicesText}
                      onChange={(e) => updateField(field.localId, { choicesText: e.target.value })}
                      placeholder="One choice per line"
                      rows={3}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            <SaveIcon className="size-4" />
            {save.isPending ? "Saving..." : "Save changes"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent submissions</CardTitle>
          <p className="text-sm text-muted-foreground">The latest 50 submissions are shown here.</p>
        </CardHeader>
        <CardContent>
          {data.submissions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No submissions yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Data</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.submissions.map((submission) => (
                  <TableRow key={submission.id}>
                    <TableCell
                      className="w-44 whitespace-nowrap text-xs text-muted-foreground"
                      title={formatDateTime(submission.createdAt)}
                    >
                      {formatRelativeTime(submission.createdAt)}
                    </TableCell>
                    <TableCell>
                      <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                        {JSON.stringify(submission.data, null, 2)}
                      </pre>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ContactFormsPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(contactFormsListQueryOptions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("Contact form");

  useEffect(() => {
    if (!selectedId && data?.[0]) setSelectedId(data[0].id);
  }, [data, selectedId]);

  const selectedExists = useMemo(
    () => (selectedId ? data?.some((form) => form.id === selectedId) : false),
    [data, selectedId],
  );

  useEffect(() => {
    if (selectedId && data && !selectedExists) setSelectedId(data[0]?.id ?? null);
  }, [data, selectedExists, selectedId]);

  const create = useMutation({
    mutationFn: () => createContactForm({ name: newName }),
    onSuccess: (form) => {
      queryClient.setQueryData(contactFormKeys.detail(form.id), form);
      void queryClient.invalidateQueries({ queryKey: contactFormKeys.list() });
      setSelectedId(form.id);
      setNewName("Contact form");
      toast.success("Contact form created");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not create contact form"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contact forms"
        description="Create public, rate-limited form endpoints for website contact forms."
        actions={
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <Input
              className="h-9 w-48"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              aria-label="New contact form name"
            />
            <Button type="submit" size="sm" disabled={create.isPending}>
              <PlusIcon className="size-4" />
              New form
            </Button>
          </form>
        }
      />

      {isPending ? (
        <Skeleton className="h-80 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState
          icon={ClipboardListIcon}
          title="No contact forms yet"
          description="Create a form to get a public endpoint for your website."
          action={
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              <PlusIcon className="size-4" />
              New form
            </Button>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
          <div className="space-y-3">
            {data.map((form) => (
              <FormCard
                key={form.id}
                form={form}
                selected={form.id === selectedId}
                onSelect={() => setSelectedId(form.id)}
              />
            ))}
          </div>
          {selectedId ? <ContactFormEditor id={selectedId} onDeleted={() => setSelectedId(null)} /> : null}
        </div>
      )}
    </div>
  );
}
