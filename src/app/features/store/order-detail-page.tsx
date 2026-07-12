import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";

import { ORDER_STATUS_LABEL_KEY, formatMoney, orderStatusVariant } from "./format";

import {
  cancelOrder,
  fulfillOrder,
  orderDetailQueryOptions,
  storeOrderKeys,
} from "@/app/api/store-orders";
import type { AdminOrderDetail, PaymentStatus } from "@/shared/api-types";
import { useI18n } from "@/app/i18n";
import type { TranslationKey } from "@/app/i18n/translations/es";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { ConfirmDialog } from "@/app/components/common/confirm-dialog";
import { CopyButton } from "@/app/components/common/copy-button";
import { ErrorState } from "@/app/components/common/error-state";
import { formatDateTime } from "@/app/lib/format";

const PAYMENT_STATUS_LABEL_KEY: Record<PaymentStatus, TranslationKey> = {
  created: "store.paymentStatus.created",
  paid: "store.paymentStatus.paid",
  failed: "store.paymentStatus.failed",
  refunded: "store.paymentStatus.refunded",
};

function paymentStatusVariant(s: PaymentStatus): "default" | "secondary" | "destructive" | "outline" {
  if (s === "paid") return "default";
  if (s === "failed") return "destructive";
  if (s === "refunded") return "outline";
  return "secondary";
}

function BackLink(): React.ReactElement {
  const { t } = useI18n();
  return (
    <Link to="/store/orders" className="text-sm text-muted-foreground hover:text-foreground">
      ← {t("store.orderDetail.back")}
    </Link>
  );
}

function DetailSkeleton(): React.ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-8 w-40" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-64 lg:col-span-2" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}

/** A label/value line in the customer & meta cards; renders nothing when the value is empty. */
function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement | null {
  if (children == null || children === "") return null;
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

/** Render a parsed shipping address (unknown JSON) as plain lines; null when empty/not an object. */
function renderAddress(address: unknown): React.ReactNode {
  if (!address || typeof address !== "object") return null;
  const entries = Object.entries(address as Record<string, unknown>).filter(
    ([, v]) => v != null && v !== "",
  );
  if (entries.length === 0) return null;
  return (
    <div className="space-y-0.5 text-sm">
      {entries.map(([k, v]) => (
        <div key={k}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</div>
      ))}
    </div>
  );
}

/** /store/orders/$id — full-page order detail (outside the tabbed Store shell). */
export function OrderDetailPage(): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params.id ?? "";

  const { data, isPending, isError, error, refetch } = useQuery(orderDetailQueryOptions(id));
  const [confirm, setConfirm] = useState<null | "fulfill" | "cancel">(null);

  const applyResult = (order: AdminOrderDetail): void => {
    queryClient.setQueryData(storeOrderKeys.detail(id), order);
    // Refresh the list views (status changed) without invalidating the detail we just set.
    void queryClient.invalidateQueries({ queryKey: storeOrderKeys.lists() });
    setConfirm(null);
  };

  const fulfill = useMutation({
    mutationFn: () => fulfillOrder(id),
    onSuccess: (order) => {
      applyResult(order);
      toast.success(t("store.orderDetail.fulfilled"));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("store.orderDetail.fulfillError")),
  });

  const cancel = useMutation({
    mutationFn: () => cancelOrder(id),
    onSuccess: (order) => {
      applyResult(order);
      toast.success(t("store.orderDetail.cancelled"));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("store.orderDetail.cancelError")),
  });

  if (isPending) return <DetailSkeleton />;
  if (isError) {
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorState error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  const o = data;
  const canFulfill = o.status === "paid";
  const canCancel = o.status === "pending" || o.status === "awaiting_payment";
  const busy = fulfill.isPending || cancel.isPending;

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">#{o.number}</h1>
          <Badge variant={orderStatusVariant(o.status)}>{t(ORDER_STATUS_LABEL_KEY[o.status])}</Badge>
        </div>
        {canFulfill || canCancel ? (
          <div className="flex gap-2">
            {canCancel ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm("cancel")}>
                {cancel.isPending ? t("store.orderDetail.cancelling") : t("store.orderDetail.cancel")}
              </Button>
            ) : null}
            {canFulfill ? (
              <Button size="sm" disabled={busy} onClick={() => setConfirm("fulfill")}>
                {fulfill.isPending ? t("store.orderDetail.fulfilling") : t("store.orderDetail.fulfill")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {o.stockConflict ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2.5 text-sm">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-destructive">{t("store.orderDetail.stockConflict.title")}</p>
            <p className="text-muted-foreground">{t("store.orderDetail.stockConflict.description")}</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("store.orderDetail.items.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("store.orderDetail.items.col.product")}</TableHead>
                    <TableHead className="text-right">{t("store.orderDetail.items.col.qty")}</TableHead>
                    <TableHead className="text-right">{t("store.orderDetail.items.col.unit")}</TableHead>
                    <TableHead className="text-right">{t("store.orderDetail.items.col.total")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {o.items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell>
                        <div className="font-medium">{it.name}</div>
                        {it.sku ? (
                          <div className="font-mono text-xs text-muted-foreground">{it.sku}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{it.quantity}</TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {formatMoney(it.unitAmount, o.currency)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {formatMoney(it.totalAmount, o.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="ml-auto max-w-xs space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("store.orderDetail.totals.subtotal")}</span>
                  <span className="font-mono">{formatMoney(o.subtotalAmount, o.currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("store.orderDetail.totals.shipping")}</span>
                  <span className="font-mono">{formatMoney(o.shippingAmount, o.currency)}</span>
                </div>
                <div className="flex justify-between border-t pt-1.5 text-base font-semibold">
                  <span>{t("store.orderDetail.totals.total")}</span>
                  <span className="font-mono">{formatMoney(o.totalAmount, o.currency)}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("store.orderDetail.payments.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              {o.payments.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("store.orderDetail.payments.empty")}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("store.orderDetail.payments.col.provider")}</TableHead>
                      <TableHead>{t("store.orderDetail.payments.col.status")}</TableHead>
                      <TableHead>{t("store.orderDetail.payments.col.reference")}</TableHead>
                      <TableHead className="text-right">{t("store.orderDetail.payments.col.amount")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {o.payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="capitalize">{p.provider}</TableCell>
                        <TableCell>
                          <Badge variant={paymentStatusVariant(p.status)}>
                            {t(PAYMENT_STATUS_LABEL_KEY[p.status])}
                          </Badge>
                          {p.errorMessage || p.errorCode ? (
                            <div className="mt-1 text-xs text-destructive">
                              {p.errorMessage ?? p.errorCode}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {p.providerRef ?? "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatMoney(p.amount, p.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("store.orderDetail.customer.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <Field label={t("store.orderDetail.customer.email")}>{o.email}</Field>
                <Field label={t("store.orderDetail.customer.name")}>{o.customerName}</Field>
                <Field label={t("store.orderDetail.customer.phone")}>{o.customerPhone}</Field>
                <Field label={t("store.orderDetail.customer.address")}>{renderAddress(o.shippingAddress)}</Field>
                <Field label={t("store.orderDetail.customer.note")}>{o.note}</Field>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("store.orderDetail.meta.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <div className="space-y-1">
                  <dt className="text-xs text-muted-foreground">{t("store.orderDetail.meta.accessToken")}</dt>
                  <dd className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                      {o.accessToken}
                    </code>
                    <CopyButton value={o.accessToken} />
                  </dd>
                  <p className="text-xs text-muted-foreground">{t("store.orderDetail.meta.accessTokenHint")}</p>
                </div>
                <Field label={t("store.orderDetail.meta.created")}>{formatDateTime(o.createdAt)}</Field>
                <Field label={t("store.orderDetail.meta.paid")}>
                  {o.paidAt != null ? formatDateTime(o.paidAt) : null}
                </Field>
                <Field label={t("store.orderDetail.meta.fulfilled")}>
                  {o.fulfilledAt != null ? formatDateTime(o.fulfilledAt) : null}
                </Field>
                <Field label={t("store.orderDetail.meta.cancelled")}>
                  {o.cancelledAt != null ? formatDateTime(o.cancelledAt) : null}
                </Field>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirm === "fulfill"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("store.orderDetail.fulfillConfirm.title")}
        description={t("store.orderDetail.fulfillConfirm.description")}
        confirmLabel={t("store.orderDetail.fulfill")}
        cancelLabel={t("store.orderDetail.confirmCancel")}
        loading={fulfill.isPending}
        onConfirm={() => fulfill.mutate()}
      />
      <ConfirmDialog
        open={confirm === "cancel"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("store.orderDetail.cancelConfirm.title")}
        description={t("store.orderDetail.cancelConfirm.description")}
        confirmLabel={t("store.orderDetail.cancel")}
        cancelLabel={t("store.orderDetail.confirmCancel")}
        destructive
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </div>
  );
}
