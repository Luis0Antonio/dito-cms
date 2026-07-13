import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";

import { FieldRow } from "../collections/builder/field-row";
import { FieldSheet, type FieldDraft } from "../collections/builder/field-sheet";

import { productSchemaQueryOptions, setProductFields, storeKeys } from "@/app/api/store";
import { isApiError } from "@/app/api/client";
import { useI18n } from "@/app/i18n";
import type { FieldDTO } from "@/shared/api-types";
import { Skeleton } from "@/app/components/ui/skeleton";
import { ErrorState } from "@/app/components/common/error-state";
import { ConfirmDialog } from "@/app/components/common/confirm-dialog";

function toDraft(field: FieldDTO): FieldDraft {
  return { name: field.name, label: field.label, type: field.type, options: field.options };
}

export function ProductSchemaPage(): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: fields, isPending, isError, error, refetch } = useQuery(productSchemaQueryOptions);

  const [sheet, setSheet] = useState<{ open: boolean; initial: FieldDTO | null }>({ open: false, initial: null });
  const [deleteTarget, setDeleteTarget] = useState<FieldDTO | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const setFieldsMutation = useMutation({
    mutationFn: (vars: { fields: FieldDraft[]; allowDestructive?: boolean }) =>
      setProductFields({ fields: vars.fields, allowDestructive: vars.allowDestructive }),
    onError: (e) => toast.error(isApiError(e) ? e.message : t("store.schema.saveError")),
    onSettled: () => queryClient.invalidateQueries({ queryKey: storeKeys.schema() }),
  });

  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const handleApply = async (draft: FieldDraft): Promise<void> => {
    const next = sheet.initial
      ? fields.map((f) => (f.name === sheet.initial!.name ? draft : toDraft(f)))
      : [...fields.map(toDraft), draft];
    try {
      await setFieldsMutation.mutateAsync({ fields: next });
      setSheet({ open: false, initial: null });
    } catch {
      // onError shows a toast; keep the sheet open.
    }
  };

  const handleDeleteField = async (field: FieldDTO): Promise<void> => {
    const next = fields.filter((f) => f.id !== field.id).map(toDraft);
    try {
      await setFieldsMutation.mutateAsync({ fields: next, allowDestructive: true });
      setDeleteTarget(null);
    } catch {
      // onError shows a toast.
    }
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = fields.findIndex((f) => f.id === active.id);
    const newIndex = fields.findIndex((f) => f.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(fields, oldIndex, newIndex);
    queryClient.setQueryData<FieldDTO[]>(storeKeys.schema(), reordered);
    setFieldsMutation.mutate({ fields: reordered.map(toDraft) });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("store.schema.description")}</p>

      <h2 className="text-sm font-medium text-muted-foreground">
        {t("store.schema.fields")} {fields.length > 0 ? `(${fields.length})` : ""}
      </h2>

      {fields.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {t("store.schema.noFields")}
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {fields.map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  isTitleField={false}
                  onEdit={() => setSheet({ open: true, initial: field })}
                  onDelete={() => setDeleteTarget(field)}
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
        {t("store.schema.addField")}
      </button>

      <FieldSheet
        open={sheet.open}
        onOpenChange={(next) => setSheet((s) => ({ ...s, open: next }))}
        initial={sheet.initial}
        existingNames={fields.map((f) => f.name)}
        availableCollections={[]}
        excludeTypes={["reference", "select"]}
        submitting={setFieldsMutation.isPending}
        onApply={handleApply}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}
        title={t("store.schema.deleteField.title", { label: deleteTarget?.label ?? "" })}
        description={t("store.schema.deleteField.description")}
        confirmLabel={t("store.schema.deleteField.confirm")}
        destructive
        loading={setFieldsMutation.isPending}
        onConfirm={() => { if (deleteTarget) void handleDeleteField(deleteTarget); }}
      />
    </div>
  );
}
