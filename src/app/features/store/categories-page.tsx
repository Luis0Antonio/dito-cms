import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTreeIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { CategoryDialog } from "./category-dialog";

import { categoriesListQueryOptions, deleteCategory, storeKeys } from "@/app/api/store";
import { isApiError } from "@/app/api/client";
import { useI18n } from "@/app/i18n";
import type { CategoryDTO, CategorySummary } from "@/shared/api-types";
import { EmptyState } from "@/app/components/common/empty-state";
import { ErrorState } from "@/app/components/common/error-state";
import { ConfirmDialog } from "@/app/components/common/confirm-dialog";
import { Button } from "@/app/components/ui/button";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";

export function CategoriesPage(): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(categoriesListQueryOptions);

  const [dialog, setDialog] = useState<{ open: boolean; category: CategoryDTO | null }>({ open: false, category: null });
  const [deleteTarget, setDeleteTarget] = useState<CategorySummary | null>(null);

  const remove = useMutation({
    mutationFn: (slug: string) => deleteCategory(slug),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storeKeys.categories() });
      toast.success(t("store.categories.deleted"));
      setDeleteTarget(null);
    },
    onError: (e) => toast.error(isApiError(e) ? e.message : t("store.categories.deleteError")),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("store.categories.description")}</p>
        <Button size="sm" onClick={() => setDialog({ open: true, category: null })}>
          <PlusIcon className="size-4" />
          {t("store.categories.new")}
        </Button>
      </div>

      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState
          icon={FolderTreeIcon}
          title={t("store.categories.empty.title")}
          description={t("store.categories.empty.description")}
          action={
            <Button onClick={() => setDialog({ open: true, category: null })}>
              <PlusIcon className="size-4" />
              {t("store.categories.new")}
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("store.categories.col.name")}</TableHead>
                <TableHead>{t("store.categories.col.slug")}</TableHead>
                <TableHead className="text-right">{t("store.categories.col.products")}</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{c.slug}</TableCell>
                  <TableCell className="text-right text-sm">{c.productCount}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Edit"
                        onClick={() => setDialog({ open: true, category: c })}
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteTarget(c)}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CategoryDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        category={dialog.category}
        categories={data ?? []}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("store.categories.deleteConfirm.title")}
        description={t("store.categories.deleteConfirm.description")}
        confirmLabel={t("store.categories.deleteConfirm.confirm")}
        destructive
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.slug)}
      />
    </div>
  );
}
