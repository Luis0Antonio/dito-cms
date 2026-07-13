import { useCallback, useEffect, useState } from "react";
import { useForm, type FieldValues } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { SlidersHorizontalIcon } from "lucide-react";

import { EntryStatusBar } from "./entry-status-bar";
import { FieldInput } from "./inputs/field-input";
import { toEntryData, toFormValues } from "./form-values";

import {
  createEntry,
  deleteEntry,
  discardDraft,
  entriesKeys,
  publishEntry,
  unpublishEntry,
  updateEntry,
} from "@/app/api/entries";
import { collectionsKeys } from "@/app/api/collections";
import { isApiError } from "@/app/api/client";
import { useI18n } from "@/app/i18n";
import { Form } from "@/app/components/ui/form";
import { Button } from "@/app/components/ui/button";
import { EmptyState } from "@/app/components/common/empty-state";
import { ConfirmDialog } from "@/app/components/common/confirm-dialog";
import { EntryUsageWarning } from "@/app/features/entries/entry-usage-warning";
import { useUnsavedChangesGuard } from "@/app/hooks/use-unsaved-changes-guard";
import type { CollectionDetail, EntryDetail } from "@/shared/api-types";

interface EntryEditorProps {
  collection: CollectionDetail;
  /** null → authoring a brand-new entry. */
  entry: EntryDetail | null;
  /** Singletons have no list to return to → hide the status-bar back button. */
  hideBack?: boolean;
}

/** Maps server fieldErrors onto the form and focuses the first one. Returns true if any. */
function applyFieldErrors(
  setError: ReturnType<typeof useForm>["setError"],
  setFocus: ReturnType<typeof useForm>["setFocus"],
  fieldErrors?: Record<string, string>,
): boolean {
  if (!fieldErrors) return false;
  const keys = Object.keys(fieldErrors);
  for (const key of keys) setError(key, { message: fieldErrors[key] });
  if (keys[0]) {
    try {
      setFocus(keys[0]);
    } catch {
      /* rich-text / media inputs aren't focusable — ignore */
    }
  }
  return keys.length > 0;
}

function EntryEditorForm({
  collection,
  entry,
  hideBack,
  onReload,
}: EntryEditorProps & { onReload: () => void }): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const fields = collection.fields;
  const isNew = entry === null;
  const status = entry?.status ?? "draft";

  const form = useForm<FieldValues>({
    defaultValues: toFormValues(fields, entry?.draftData ?? {}),
  });
  const isDirty = form.formState.isDirty;
  const [busy, setBusy] = useState<null | "save" | "publish">(null);
  const [confirm, setConfirm] = useState<null | "discard" | "unpublish" | "delete">(null);

  useUnsavedChangesGuard(isDirty && busy === null);

  const syncCaches = useCallback(
    (saved: EntryDetail) => {
      queryClient.setQueryData(entriesKeys.detail(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: entriesKeys.lists(collection.slug) });
      void queryClient.invalidateQueries({ queryKey: collectionsKeys.all });
    },
    [queryClient, collection.slug],
  );

  const onSaveDraft = form.handleSubmit(async (values) => {
    setBusy("save");
    try {
      const data = toEntryData(fields, values);
      const saved = isNew
        ? await createEntry(collection.slug, { data })
        : await updateEntry(entry.id, { data });
      syncCaches(saved);
      form.reset(values); // clear the dirty baseline before any navigation
      toast.success(t("editor.saveDraft.success"));
      if (isNew) {
        void navigate({
          to: "/collections/$slug/entries/$id",
          params: { slug: collection.slug, id: saved.id },
        });
      }
    } catch (e) {
      if (isApiError(e) && applyFieldErrors(form.setError, form.setFocus, e.fieldErrors)) {
        toast.error(t("editor.fieldsError"));
      } else {
        toast.error(isApiError(e) ? e.message : t("editor.saveDraft.error"));
      }
    } finally {
      setBusy(null);
    }
  });

  const onPublish = form.handleSubmit(async (values) => {
    setBusy("publish");
    try {
      const data = toEntryData(fields, values);
      let result: EntryDetail;
      if (isNew) {
        result = await createEntry(collection.slug, { data, publish: true });
      } else {
        await updateEntry(entry.id, { data });
        result = await publishEntry(entry.id);
      }
      syncCaches(result);
      form.reset(values);
      toast.success(t("editor.publish.success"));
      if (isNew) {
        void navigate({
          to: "/collections/$slug/entries/$id",
          params: { slug: collection.slug, id: result.id },
        });
      }
    } catch (e) {
      if (isApiError(e) && applyFieldErrors(form.setError, form.setFocus, e.fieldErrors)) {
        toast.error(t("editor.fieldsPublishError"));
      } else {
        toast.error(isApiError(e) ? e.message : t("editor.publish.error"));
      }
      if (!isNew) void queryClient.invalidateQueries({ queryKey: entriesKeys.detail(entry.id) });
    } finally {
      setBusy(null);
    }
  });

  // Cmd/Ctrl+S → save draft.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (busy === null) void onSaveDraft();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSaveDraft, busy]);

  const doDiscard = async (): Promise<void> => {
    try {
      if (status === "changed" && entry) {
        const reverted = await discardDraft(entry.id);
        syncCaches(reverted);
      }
      form.reset(); // drop local unsaved edits
      onReload(); // remount from the (reverted) server draft
      toast.success(t("editor.discard.success"));
    } catch (e) {
      toast.error(isApiError(e) ? e.message : t("editor.discard.error"));
    } finally {
      setConfirm(null);
    }
  };

  const doUnpublish = async (): Promise<void> => {
    if (!entry) return;
    try {
      const updated = await unpublishEntry(entry.id);
      syncCaches(updated);
      toast.success(t("editor.unpublish.success"));
    } catch (e) {
      toast.error(isApiError(e) ? e.message : t("editor.unpublish.error"));
    } finally {
      setConfirm(null);
    }
  };

  const doDelete = async (): Promise<void> => {
    if (!entry) return;
    try {
      await deleteEntry(entry.id);
      void queryClient.invalidateQueries({ queryKey: entriesKeys.lists(collection.slug) });
      void queryClient.invalidateQueries({ queryKey: collectionsKeys.all });
      form.reset(form.getValues()); // clear dirty so the guard doesn't block leaving
      toast.success(t("editor.deleteEntry.success"));
      void navigate({ to: "/collections/$slug", params: { slug: collection.slug } });
    } catch (e) {
      toast.error(isApiError(e) ? e.message : t("editor.deleteEntry.error"));
      setConfirm(null);
    }
  };

  const isSingleton = collection.type === "singleton";

  return (
    <Form {...form}>
      <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
        {fields.length === 0 ? (
          <EmptyState
            icon={SlidersHorizontalIcon}
            title={t("editor.empty.title")}
            description={t("editor.empty.description")}
            action={
              <Button asChild>
                <Link to="/collections/$slug/schema" params={{ slug: collection.slug }}>
                  {t("editor.editSchema")}
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="space-y-6">
            {fields.map((field) => (
              <FieldInput key={field.id} control={form.control} field={field} />
            ))}
          </div>
        )}

        <EntryStatusBar
          slug={collection.slug}
          status={status}
          isNew={isNew}
          hideBack={hideBack}
          isDirty={isDirty}
          savedAt={entry?.draftUpdatedAt ?? null}
          busy={busy}
          canDiscard={!isNew && (status === "changed" || isDirty)}
          canUnpublish={!isNew && (status === "published" || status === "changed")}
          canDelete={!isNew && !isSingleton}
          onSaveDraft={() => void onSaveDraft()}
          onPublish={() => void onPublish()}
          onDiscard={() => setConfirm("discard")}
          onUnpublish={() => setConfirm("unpublish")}
          onDelete={() => setConfirm("delete")}
        />
      </form>

      <ConfirmDialog
        open={confirm === "discard"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t("editor.discard.title")}
        description={
          status === "changed"
            ? t("editor.discard.changedDesc")
            : t("editor.discard.dirtyDesc")
        }
        confirmLabel={t("editor.discard.confirm")}
        destructive
        onConfirm={() => void doDiscard()}
      />
      <ConfirmDialog
        open={confirm === "unpublish"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t("editor.unpublish.title")}
        description={t("editor.unpublish.description")}
        confirmLabel={t("editor.unpublish.confirm")}
        destructive
        onConfirm={() => void doUnpublish()}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t("editor.deleteEntry.title")}
        description={
          <span className="space-y-2">
            <span className="block">
              {status === "draft"
                ? t("editor.deleteEntry.draftDesc")
                : t("editor.deleteEntry.publishedDesc")}
            </span>
            <EntryUsageWarning entryId={entry?.id ?? ""} />
          </span>
        }
        confirmLabel={t("editor.deleteEntry.confirm")}
        destructive
        onConfirm={() => void doDelete()}
      />
    </Form>
  );
}

/** Remounts the form (resetting all inputs incl. the rich-text editor) when reloadKey bumps. */
export function EntryEditor({ collection, entry, hideBack }: EntryEditorProps): React.ReactElement {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <EntryEditorForm
      key={`${entry?.id ?? "new"}:${reloadKey}`}
      collection={collection}
      entry={entry}
      hideBack={hideBack}
      onReload={() => setReloadKey((k) => k + 1)}
    />
  );
}
