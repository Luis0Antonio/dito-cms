import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  ArrowLeftIcon,
  FileIcon,
  LayersIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { FieldRow } from "./field-row";
import { FieldSheet, type FieldDraft } from "./field-sheet";
import { EditCollectionDialog } from "../edit-collection-dialog";
import { DeleteCollectionDialog } from "../delete-collection-dialog";

import {
  collectionDetailQueryOptions,
  collectionsKeys,
  collectionsListQueryOptions,
  deleteCollection,
  setFields,
} from "@/app/api/collections";
import { isApiError } from "@/app/api/client";
import { useI18n } from "@/app/i18n";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Skeleton } from "@/app/components/ui/skeleton";
import { ErrorState } from "@/app/components/common/error-state";
import { ConfirmDialog } from "@/app/components/common/confirm-dialog";
import type { CollectionDetail, FieldDTO } from "@/shared/api-types";

function toDraft(field: FieldDTO): FieldDraft {
  return { name: field.name, label: field.label, type: field.type, options: field.options };
}

export function SchemaBuilderPage(): React.ReactElement {
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const { data: collection, isPending, isError, error, refetch } = useQuery(collectionDetailQueryOptions(slug));
  const { data: allCollections } = useQuery(collectionsListQueryOptions);

  const [sheet, setSheet] = useState<{ open: boolean; initial: FieldDTO | null }>({ open: false, initial: null });
  const [deleteFieldTarget, setDeleteFieldTarget] = useState<FieldDTO | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteCollectionOpen, setDeleteCollectionOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const setFieldsMutation = useMutation({
    mutationFn: (vars: { fields: FieldDraft[]; allowDestructive?: boolean }) =>
      setFields(slug, { fields: vars.fields, allowDestructive: vars.allowDestructive }),
    onError: (e) => toast.error(isApiError(e) ? e.message : t("schema.fields.saveError")),
    onSettled: () => queryClient.invalidateQueries({ queryKey: collectionsKeys.all }),
  });

  const deleteCollectionMutation = useMutation({
    mutationFn: () => deleteCollection(slug),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: collectionsKeys.all });
      toast.success(t("schema.collection.deleted"));
      void navigate({ to: "/collections" });
    },
    onError: (e) => toast.error(isApiError(e) ? e.message : t("schema.collection.deleteError")),
  });

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  const col: CollectionDetail = collection;
  const fields = col.fields;

  const handleApply = async (draft: FieldDraft): Promise<void> => {
    const next = sheet.initial
      ? fields.map((f) => (f.name === sheet.initial!.name ? draft : toDraft(f)))
      : [...fields.map(toDraft), draft];
    try {
      await setFieldsMutation.mutateAsync({ fields: next });
      setSheet({ open: false, initial: null });
    } catch {
      // Error toast is shown by the mutation's onError; keep the sheet open.
    }
  };

  const handleDeleteField = async (field: FieldDTO): Promise<void> => {
    const next = fields.filter((f) => f.id !== field.id).map(toDraft);
    try {
      await setFieldsMutation.mutateAsync({ fields: next, allowDestructive: true });
      setDeleteFieldTarget(null);
    } catch {
      // Error toast is shown by the mutation's onError.
    }
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = fields.findIndex((f) => f.id === active.id);
    const newIndex = fields.findIndex((f) => f.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(fields, oldIndex, newIndex);
    const detailKey = collectionsKeys.detail(slug);
    queryClient.setQueryData<CollectionDetail>(detailKey, (old) =>
      old ? { ...old, fields: reordered } : old,
    );
    setFieldsMutation.mutate({ fields: reordered.map(toDraft) });
  };

  const TypeIcon = col.type === "singleton" ? FileIcon : LayersIcon;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link to="/collections" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-4" />
          {t("schema.backToCollections")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{col.name}</h1>
              <Badge variant="secondary">
                <TypeIcon className="size-3" />
                {col.type === "singleton" ? t("schema.badge.singleton") : t("schema.badge.collection")}
              </Badge>
            </div>
            <p className="font-mono text-xs text-muted-foreground">{col.slug}</p>
            {col.description ? <p className="text-sm text-muted-foreground">{col.description}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <PencilIcon className="size-4" />
              {t("schema.editDetails")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setDeleteCollectionOpen(true)}
            >
              <Trash2Icon className="size-4" />
              {t("schema.delete")}
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t("schema.fields")} {fields.length > 0 ? `(${fields.length})` : ""}
        </h2>

        {fields.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {col.type === "singleton" ? t("schema.noFields.singleton") : t("schema.noFields.collection")}
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {fields.map((field) => (
                  <FieldRow
                    key={field.id}
                    field={field}
                    isTitleField={col.titleField === field.name}
                    onEdit={() => setSheet({ open: true, initial: field })}
                    onDelete={() => setDeleteFieldTarget(field)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}

        <button
          type="button"
          onClick={() => setSheet({ open: true, initial: null })}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <PlusIcon className="size-4" />
          {t("schema.addField")}
        </button>
      </div>

      <FieldSheet
        open={sheet.open}
        onOpenChange={(next) => setSheet((s) => ({ ...s, open: next }))}
        initial={sheet.initial}
        existingNames={fields.map((f) => f.name)}
        availableCollections={(allCollections ?? []).map((c) => ({ slug: c.slug, name: c.name }))}
        submitting={setFieldsMutation.isPending}
        onApply={handleApply}
      />

      <ConfirmDialog
        open={!!deleteFieldTarget}
        onOpenChange={(next) => { if (!next) setDeleteFieldTarget(null); }}
        title={t("schema.deleteField.title", { label: deleteFieldTarget?.label ?? "" })}
        description={t("schema.deleteField.description")}
        confirmLabel={t("schema.deleteField.confirm")}
        destructive
        loading={setFieldsMutation.isPending}
        onConfirm={() => { if (deleteFieldTarget) handleDeleteField(deleteFieldTarget); }}
      />

      <EditCollectionDialog collection={col} open={editOpen} onOpenChange={setEditOpen} />

      <DeleteCollectionDialog
        slug={col.slug}
        name={col.name}
        entryCount={col.entryCount}
        open={deleteCollectionOpen}
        onOpenChange={setDeleteCollectionOpen}
        loading={deleteCollectionMutation.isPending}
        onConfirm={() => deleteCollectionMutation.mutate()}
      />
    </div>
  );
}
