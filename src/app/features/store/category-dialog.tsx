import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createCategory, storeKeys, updateCategory } from "@/app/api/store";
import { isApiError } from "@/app/api/client";
import { useI18n } from "@/app/i18n";
import { slugify } from "@/shared/slug";
import type { CategoryDTO, CategorySummary } from "@/shared/api-types";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Textarea } from "@/app/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";

interface CategoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null → create; otherwise edit. */
  category: CategoryDTO | null;
  /** All categories (for the parent picker). */
  categories: CategorySummary[];
}

export function CategoryDialog({ open, onOpenChange, category, categories }: CategoryDialogProps): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const isEdit = category !== null;

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Reseed whenever the dialog (re)opens.
  useEffect(() => {
    if (!open) return;
    setName(category?.name ?? "");
    setSlug(category?.slug ?? "");
    setSlugEdited(isEdit);
    setDescription(category?.description ?? "");
    setParentId(category?.parentId ?? "");
    setErrors({});
  }, [open, category, isEdit]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        parentId: parentId || null,
      };
      return isEdit
        ? updateCategory(category.slug, body)
        : createCategory({ ...body, slug: slug.trim() });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storeKeys.categories() });
      toast.success(isEdit ? t("store.categories.saved") : t("store.categories.created"));
      onOpenChange(false);
    },
    onError: (e) => {
      if (isApiError(e) && e.fieldErrors) {
        setErrors(e.fieldErrors);
      } else {
        toast.error(isApiError(e) ? e.message : t("store.categories.saveError"));
      }
    },
  });

  // Categories that can be a parent (exclude self when editing).
  const parentOptions = categories.filter((c) => c.id !== category?.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("store.categories.edit.title") : t("store.categories.create.title")}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="cat-name">{t("store.categories.name")}</Label>
            <Input
              id="cat-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!isEdit && !slugEdited) setSlug(slugify(e.target.value));
              }}
            />
            {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-slug">{t("store.categories.slug")}</Label>
            <Input
              id="cat-slug"
              className="font-mono"
              value={slug}
              disabled={isEdit}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">{t("store.categories.slugHint")}</p>
            {errors.slug ? <p className="text-xs text-destructive">{errors.slug}</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-desc">{t("store.categories.descriptionField")}</Label>
            <Textarea id="cat-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {parentOptions.length > 0 ? (
            <div className="space-y-1.5">
              <Label>{t("store.categories.parent")}</Label>
              <Select
                value={parentId || "__none__"}
                onValueChange={(v) => setParentId(v === "__none__" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t("store.categories.parentNone")}</SelectItem>
                  {parentOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.parentId ? <p className="text-xs text-destructive">{errors.parentId}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("store.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending || !name.trim() || (!isEdit && !slug.trim())}>
              {save.isPending
                ? t("store.categories.saving")
                : isEdit
                  ? t("store.categories.save")
                  : t("store.categories.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
