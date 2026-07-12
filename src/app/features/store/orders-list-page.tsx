import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Columns3Icon, ListIcon, PackageIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";

import { ORDER_STATUS_LABEL_KEY, formatMoney, orderStatusVariant } from "./format";
import { OrdersKanban } from "./orders-kanban";

import { ordersListQueryOptions } from "@/app/api/store-orders";
import { useI18n } from "@/app/i18n";
import type { OrderStatus } from "@/shared/api-types";
import { EmptyState } from "@/app/components/common/empty-state";
import { ErrorState } from "@/app/components/common/error-state";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Skeleton } from "@/app/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/app/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { formatDateTime, formatRelativeTime } from "@/app/lib/format";

const PAGE_SIZE = 20;
const ORDER_STATUSES = Object.keys(ORDER_STATUS_LABEL_KEY) as OrderStatus[];
const ALL = "all";

export function OrdersListPage(): React.ReactElement {
  const { t } = useI18n();

  const [status, setStatus] = useState<OrderStatus | typeof ALL>(ALL);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<"list" | "board">("list");

  const filtered = status !== ALL || search !== "";

  const { data, isPending, isError, error, refetch, isPlaceholderData } = useQuery({
    ...ordersListQueryOptions({
      status: status === ALL ? undefined : status,
      search: search || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    placeholderData: keepPreviousData,
    enabled: view === "list",
  });

  // Filter changes reset paging to the first page.
  const changeStatus = (next: OrderStatus | typeof ALL): void => {
    setStatus(next);
    setOffset(0);
  };
  const submitSearch = (e: React.FormEvent): void => {
    e.preventDefault();
    setSearch(searchInput.trim());
    setOffset(0);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("store.orders.description")}</p>
        <div className="flex flex-wrap items-center gap-2">
          {view === "list" ? (
            <>
              <Select value={status} onValueChange={(v) => changeStatus(v as OrderStatus | typeof ALL)}>
                <SelectTrigger size="sm" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("store.orders.filter.allStatuses")}</SelectItem>
                  {ORDER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(ORDER_STATUS_LABEL_KEY[s])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <form onSubmit={submitSearch} className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={t("store.orders.search.placeholder")}
                  className="h-8 w-56 pl-8"
                  autoComplete="off"
                />
              </form>
            </>
          ) : null}
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(v) => {
              if (v) setView(v as "list" | "board");
            }}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="list" aria-label={t("store.orders.view.list")}>
              <ListIcon className="size-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="board" aria-label={t("store.orders.view.board")}>
              <Columns3Icon className="size-4" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {view === "board" ? (
        <OrdersKanban />
      ) : isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.orders.length === 0 ? (
        <EmptyState
          icon={PackageIcon}
          title={filtered ? t("store.orders.noMatch.title") : t("store.orders.empty.title")}
          description={filtered ? t("store.orders.noMatch.description") : t("store.orders.empty.description")}
        />
      ) : (
        <>
          <div className={`rounded-lg border ${isPlaceholderData ? "opacity-60" : ""}`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("store.orders.col.order")}</TableHead>
                  <TableHead>{t("store.orders.col.customer")}</TableHead>
                  <TableHead>{t("store.orders.col.status")}</TableHead>
                  <TableHead className="text-right">{t("store.orders.col.date")}</TableHead>
                  <TableHead className="text-right">{t("store.orders.col.total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.orders.map((o) => (
                  <TableRow key={o.id} className="cursor-pointer">
                    <TableCell>
                      <Link to="/store/orders/$id" params={{ id: o.id }} className="block font-medium">
                        #{o.number}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link to="/store/orders/$id" params={{ id: o.id }} className="block min-w-0">
                        {o.customerName ? (
                          <span className="block truncate">{o.customerName}</span>
                        ) : null}
                        <span className="block truncate text-xs text-muted-foreground">{o.email}</span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={orderStatusVariant(o.status)}>
                          {t(ORDER_STATUS_LABEL_KEY[o.status])}
                        </Badge>
                        {o.stockConflict ? (
                          <TriangleAlertIcon
                            className="size-4 text-destructive"
                            aria-label={t("store.orders.stockConflict")}
                          />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-right text-xs text-muted-foreground"
                      title={formatDateTime(o.createdAt)}
                    >
                      {formatRelativeTime(o.createdAt)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatMoney(o.totalAmount, o.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {t("store.orders.showing", {
                from: data.total === 0 ? 0 : offset + 1,
                to: offset + data.orders.length,
                total: data.total,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >
                {t("store.orders.prev")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + data.orders.length >= data.total}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                {t("store.orders.next")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
