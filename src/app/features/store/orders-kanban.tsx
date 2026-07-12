import { useState } from "react";
import { useMutation, useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";

import { ORDER_STATUS_LABEL_KEY, formatMoney, orderStatusVariant } from "./format";

import {
  cancelOrder,
  fulfillOrder,
  ordersListQueryOptions,
  storeOrderKeys,
} from "@/app/api/store-orders";
import { useI18n } from "@/app/i18n";
import type { AdminOrderSummary, OrderListResult, OrderStatus } from "@/shared/api-types";
import { Badge } from "@/app/components/ui/badge";
import { Skeleton } from "@/app/components/ui/skeleton";
import { ErrorState } from "@/app/components/common/error-state";
import { formatDateTime, formatRelativeTime } from "@/app/lib/format";
import { cn } from "@/app/lib/utils";

// Kanban board of orders, one column per lifecycle stage (column id === the OrderStatus). The
// board mirrors the admin state machine, which exposes exactly two merchant transitions — so only
// two drags actually mutate: a paid order → Fulfilled (fulfill) and a pending/awaiting order →
// Cancelled (cancel). Every other drag snaps back with a toast; the payment stages advance
// automatically via the payment provider, and refunds are a later phase. Columns are fetched per
// status (not one big list) so the list's open-first ordering can't starve the terminal columns.

const COLUMNS: OrderStatus[] = [
  "pending",
  "awaiting_payment",
  "paid",
  "fulfilled",
  "cancelled",
  "refunded",
  "failed",
];

const BOARD_LIMIT = 50;

type Action = "fulfill" | "cancel";

/** The two merchant-driven transitions, keyed by (from → to). Anything else is not draggable. */
function actionFor(from: OrderStatus, to: OrderStatus): Action | null {
  if (to === "fulfilled" && from === "paid") return "fulfill";
  if (to === "cancelled" && (from === "pending" || from === "awaiting_payment")) return "cancel";
  return null;
}

interface MoveVars {
  id: string;
  action: Action;
  from: OrderStatus;
  to: OrderStatus;
  order: AdminOrderSummary;
}

export function OrdersKanban(): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const results = useQueries({
    queries: COLUMNS.map((status) => ordersListQueryOptions({ status, limit: BOARD_LIMIT })),
  });

  const [activeOrder, setActiveOrder] = useState<AdminOrderSummary | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const move = useMutation({
    mutationFn: ({ id, action }: MoveVars) => (action === "fulfill" ? fulfillOrder(id) : cancelOrder(id)),
    // Optimistically move the card between the two column caches; reconcile on settle.
    onMutate: async ({ id, from, to, order }: MoveVars) => {
      const sourceKey = storeOrderKeys.list({ status: from, limit: BOARD_LIMIT });
      const targetKey = storeOrderKeys.list({ status: to, limit: BOARD_LIMIT });
      await Promise.all([
        queryClient.cancelQueries({ queryKey: sourceKey }),
        queryClient.cancelQueries({ queryKey: targetKey }),
      ]);
      const prevSource = queryClient.getQueryData<OrderListResult>(sourceKey);
      const prevTarget = queryClient.getQueryData<OrderListResult>(targetKey);
      if (prevSource) {
        queryClient.setQueryData<OrderListResult>(sourceKey, {
          orders: prevSource.orders.filter((o) => o.id !== id),
          total: Math.max(0, prevSource.total - 1),
        });
      }
      if (prevTarget) {
        queryClient.setQueryData<OrderListResult>(targetKey, {
          orders: [{ ...order, status: to }, ...prevTarget.orders.filter((o) => o.id !== id)],
          total: prevTarget.total + 1,
        });
      }
      return { sourceKey, targetKey, prevSource, prevTarget };
    },
    onError: (e, { action }, ctx) => {
      // Roll back the optimistic move — a guarded UPDATE can 409 if the order raced out of state.
      if (ctx?.prevSource) queryClient.setQueryData(ctx.sourceKey, ctx.prevSource);
      if (ctx?.prevTarget) queryClient.setQueryData(ctx.targetKey, ctx.prevTarget);
      toast.error(
        e instanceof Error
          ? e.message
          : t(action === "fulfill" ? "store.orderDetail.fulfillError" : "store.orderDetail.cancelError"),
      );
    },
    onSuccess: (_data, { action }) => {
      toast.success(t(action === "fulfill" ? "store.orderDetail.fulfilled" : "store.orderDetail.cancelled"));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: storeOrderKeys.lists() });
    },
  });

  const onDragStart = (e: DragStartEvent): void => {
    setActiveOrder((e.active.data.current?.order as AdminOrderSummary | undefined) ?? null);
  };

  const onDragEnd = (e: DragEndEvent): void => {
    setActiveOrder(null);
    const { active, over } = e;
    if (!over) return;
    const from = active.data.current?.status as OrderStatus | undefined;
    const order = active.data.current?.order as AdminOrderSummary | undefined;
    const to = over.id as OrderStatus;
    if (!from || !order || from === to) return;
    const action = actionFor(from, to);
    if (!action) {
      toast.error(t("store.orders.kanban.invalidMove"));
      return;
    }
    move.mutate({ id: order.id, action, from, to, order });
  };

  const firstError = results.find((r) => r.isError)?.error;
  if (firstError) {
    return <ErrorState error={firstError} onRetry={() => void queryClient.invalidateQueries({ queryKey: storeOrderKeys.lists() })} />;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("store.orders.kanban.hint")}</p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveOrder(null)}
      >
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((status, i) => (
            <KanbanColumn key={status} status={status} result={results[i]} />
          ))}
        </div>
        <DragOverlay>
          {activeOrder ? (
            <div className="rounded-md border bg-card p-2.5 text-sm shadow-lg">
              <OrderCardBody order={activeOrder} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function KanbanColumn({
  status,
  result,
}: {
  status: OrderStatus;
  result: UseQueryResult<OrderListResult>;
}): React.ReactElement {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const orders = result.data?.orders ?? [];
  const total = result.data?.total ?? 0;
  const hidden = total - orders.length;

  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-1">
        <Badge variant={orderStatusVariant(status)}>{t(ORDER_STATUS_LABEL_KEY[status])}</Badge>
        <span className="text-xs tabular-nums text-muted-foreground">{total}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 rounded-lg border border-dashed p-2 transition-colors",
          isOver && "border-primary bg-accent/50",
        )}
      >
        {result.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : orders.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">{t("store.orders.kanban.empty")}</p>
        ) : (
          <>
            {orders.map((o) => (
              <OrderCard key={o.id} order={o} />
            ))}
            {hidden > 0 ? (
              <p className="px-1 pt-1 text-center text-xs text-muted-foreground">
                {t("store.orders.kanban.moreCount", { count: hidden })}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// Draggable card. The DragOverlay renders OrderCardBody directly (no useDraggable) so the dragged
// copy doesn't register a second draggable under the same id as this still-mounted source card.
function OrderCard({ order }: { order: AdminOrderSummary }): React.ReactElement {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: order.id,
    data: { status: order.status, order },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "cursor-grab touch-none rounded-md border bg-card p-2.5 text-sm shadow-sm active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
      {...listeners}
      {...attributes}
    >
      <OrderCardBody order={order} />
    </div>
  );
}

function OrderCardBody({ order }: { order: AdminOrderSummary }): React.ReactElement {
  const { t } = useI18n();
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Link
          to="/store/orders/$id"
          params={{ id: order.id }}
          className="font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          #{order.number}
        </Link>
        {order.stockConflict ? (
          <TriangleAlertIcon
            className="size-3.5 shrink-0 text-destructive"
            aria-label={t("store.orders.stockConflict")}
          />
        ) : null}
      </div>
      <div className="mt-1 min-w-0">
        {order.customerName ? <span className="block truncate">{order.customerName}</span> : null}
        <span className="block truncate text-xs text-muted-foreground">{order.email}</span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-xs">{formatMoney(order.totalAmount, order.currency)}</span>
        <span className="shrink-0 text-xs text-muted-foreground" title={formatDateTime(order.createdAt)}>
          {formatRelativeTime(order.createdAt)}
        </span>
      </div>
    </>
  );
}
