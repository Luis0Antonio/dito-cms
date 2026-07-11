import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ImageIcon, PackageIcon, PlusIcon } from "lucide-react";

import { formatPrice, STATUS_LABEL_KEY, statusVariant } from "./format";

import { productsListQueryOptions } from "@/app/api/store";
import { useI18n } from "@/app/i18n";
import { EmptyState } from "@/app/components/common/empty-state";
import { ErrorState } from "@/app/components/common/error-state";
import { Badge } from "@/app/components/ui/badge";
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

export function ProductsListPage(): React.ReactElement {
  const { t } = useI18n();
  const { data, isPending, isError, error, refetch } = useQuery(productsListQueryOptions());

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("store.products.description")}</p>
        <Button asChild size="sm">
          <Link to="/store/products/new">
            <PlusIcon className="size-4" />
            {t("store.products.new")}
          </Link>
        </Button>
      </div>

      {isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.products.length === 0 ? (
        <EmptyState
          icon={PackageIcon}
          title={t("store.products.empty.title")}
          description={t("store.products.empty.description")}
          action={
            <Button asChild>
              <Link to="/store/products/new">
                <PlusIcon className="size-4" />
                {t("store.products.new")}
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("store.products.col.product")}</TableHead>
                <TableHead>{t("store.products.col.status")}</TableHead>
                <TableHead className="text-right">{t("store.products.col.price")}</TableHead>
                <TableHead className="text-right">{t("store.products.col.stock")}</TableHead>
                <TableHead>{t("store.products.col.category")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.products.map((p) => (
                <TableRow key={p.id} className="cursor-pointer">
                  <TableCell>
                    <Link
                      to="/store/products/$slug"
                      params={{ slug: p.slug }}
                      className="flex items-center gap-3"
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                        {p.image ? (
                          <img src={p.image.url} alt="" className="size-full object-cover" />
                        ) : (
                          <ImageIcon className="size-4 text-muted-foreground" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{p.name}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">{p.slug}</span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(p.status)}>{t(STATUS_LABEL_KEY[p.status])}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{formatPrice(p.priceAmount)}</TableCell>
                  <TableCell className="text-right text-sm">
                    {p.stock === null ? (
                      <span className="text-muted-foreground">{t("store.stock.untracked")}</span>
                    ) : (
                      p.stock
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {p.categoryName ?? t("store.products.noCategory")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
