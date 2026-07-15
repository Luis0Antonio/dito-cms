import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { FIELD_TYPE_ICONS } from "../field-type-meta";

import { FIELD_TYPES } from "@/shared/field-types";
import type { FieldDTO } from "@/shared/api-types";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";

interface FieldRowProps {
  field: FieldDTO;
  isTitleField: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export function FieldRow({ field, isTitleField, onEdit, onDelete }: FieldRowProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  });
  const Icon = FIELD_TYPE_ICONS[field.type];

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-3",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-4" />
      </button>

      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{field.label}</span>
          {isTitleField ? (
            <Badge variant="secondary" className="shrink-0">
              Title
            </Badge>
          ) : null}
          {field.options.required ? (
            <Badge variant="outline" className="shrink-0 text-amber-600">
              Required
            </Badge>
          ) : null}
          {field.options.localized ? (
            <Badge variant="outline" className="shrink-0">
              Localized
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate font-mono">{field.name}</span>
          <span>·</span>
          <span>{FIELD_TYPES[field.type].label}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Edit field">
          <PencilIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          aria-label="Delete field"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
