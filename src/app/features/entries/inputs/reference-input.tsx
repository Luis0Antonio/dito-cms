import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangleIcon, GripVerticalIcon, LayersIcon, PlusIcon } from "lucide-react";

import { RequiredMark } from "./field-frame";
import type { EntryFieldInputProps } from "./types";

import { EntryPickerDialog, type PickerCollection } from "@/app/features/entries/pickers/entry-picker-dialog";
import { entriesKeys, entryRefQueryOptions } from "@/app/api/entries";
import { collectionsListQueryOptions } from "@/app/api/collections";
import { Button } from "@/app/components/ui/button";
import { Skeleton } from "@/app/components/ui/skeleton";
import { StatusBadge } from "@/app/components/common/status-badge";
import {
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/app/components/ui/form";
import type { EntryRef, EntrySummary } from "@/shared/api-types";

/** Resolves a stored entry id to its title + status; shows a placeholder if it's gone. */
function ReferencePreview({
  id,
  onReplace,
  onRemove,
  dragHandle,
}: {
  id: string;
  onReplace?: () => void;
  onRemove: () => void;
  dragHandle?: React.ReactNode;
}): React.ReactElement {
  const { data, isPending, isError } = useQuery(entryRefQueryOptions(id));

  if (isPending) return <Skeleton className="h-14 w-full rounded-lg" />;

  if (isError || !data) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
        <span className="flex items-center gap-2 text-sm text-amber-900">
          <AlertTriangleIcon className="size-4 shrink-0" />
          This entry is no longer available.
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border p-3">
      {dragHandle}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{data.title}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{data.collectionSlug}</p>
      </div>
      <StatusBadge status={data.status} className="shrink-0" />
      <div className="flex shrink-0 gap-1">
        {onReplace ? (
          <Button type="button" variant="outline" size="sm" onClick={onReplace}>
            Replace
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

/** A draggable row in the multiple-reference list. */
function SortableReference({
  id,
  onRemove,
}: {
  id: string;
  onRemove: () => void;
}): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  const handle = (
    <button
      type="button"
      className="cursor-grab text-muted-foreground hover:text-foreground"
      aria-label="Reorder"
      {...attributes}
      {...listeners}
    >
      <GripVerticalIcon className="size-4" />
    </button>
  );
  return (
    <li ref={setNodeRef} style={style}>
      <ReferencePreview id={id} onRemove={onRemove} dragHandle={handle} />
    </li>
  );
}

export function ReferenceFieldInput({ control, field }: EntryFieldInputProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const multiple = field.options.multiple === true;
  const { data: allCollections } = useQuery(collectionsListQueryOptions);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Resolve the field's allowed targets to concrete collections for the picker.
  const targets = field.options.targetCollections ?? [];
  const isAny = targets.length === 0 || targets.includes("*");
  const pickerCollections: PickerCollection[] = (allCollections ?? [])
    .filter((c) => isAny || targets.includes(c.slug))
    .map((c) => ({ slug: c.slug, name: c.name }));

  // Prime the ref cache so the preview resolves instantly without a round-trip.
  const primeCache = (entry: EntrySummary, collectionSlug: string): void => {
    const ref: EntryRef = {
      id: entry.id,
      title: entry.title,
      slug: entry.slug,
      collectionSlug,
      status: entry.status,
    };
    queryClient.setQueryData(entriesKeys.ref(entry.id), ref);
  };

  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => {
        const ids: string[] = multiple ? (Array.isArray(rhf.value) ? (rhf.value as string[]) : []) : [];
        const singleId = !multiple && typeof rhf.value === "string" && rhf.value ? rhf.value : null;

        const selectSingle = (entry: EntrySummary, collectionSlug: string): void => {
          primeCache(entry, collectionSlug);
          rhf.onChange(entry.id);
        };
        const addMultiple = (entry: EntrySummary, collectionSlug: string): void => {
          primeCache(entry, collectionSlug);
          if (!ids.includes(entry.id)) rhf.onChange([...ids, entry.id]);
        };
        const removeAt = (id: string): void => rhf.onChange(ids.filter((x) => x !== id));
        const onDragEnd = (event: DragEndEvent): void => {
          const { active, over } = event;
          if (!over || active.id === over.id) return;
          const from = ids.indexOf(String(active.id));
          const to = ids.indexOf(String(over.id));
          if (from < 0 || to < 0) return;
          rhf.onChange(arrayMove(ids, from, to));
        };

        const noTargets = pickerCollections.length === 0;

        return (
          <FormItem>
            <FormLabel>
              {field.label}
              <RequiredMark field={field} />
            </FormLabel>

            {multiple ? (
              <div className="space-y-2">
                {ids.length > 0 ? (
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                      <ul className="space-y-2">
                        {ids.map((id) => (
                          <SortableReference key={id} id={id} onRemove={() => removeAt(id)} />
                        ))}
                      </ul>
                    </SortableContext>
                  </DndContext>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={noTargets}
                  onClick={() => setPickerOpen(true)}
                >
                  <PlusIcon className="size-4" />
                  Add reference
                </Button>
              </div>
            ) : singleId ? (
              <ReferencePreview
                id={singleId}
                onReplace={() => setPickerOpen(true)}
                onRemove={() => rhf.onChange(null)}
              />
            ) : (
              <button
                type="button"
                disabled={noTargets}
                onClick={() => setPickerOpen(true)}
                className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition-colors hover:border-primary/60 hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <LayersIcon className="size-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {noTargets ? "No target collection configured" : "Choose an entry"}
                </span>
              </button>
            )}

            {field.options.help ? <FormDescription>{field.options.help}</FormDescription> : null}
            <FormMessage />

            {noTargets ? null : (
              <EntryPickerDialog
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                collections={pickerCollections}
                excludeIds={multiple ? ids : []}
                onSelect={multiple ? addMultiple : selectSingle}
              />
            )}
          </FormItem>
        );
      }}
    />
  );
}
