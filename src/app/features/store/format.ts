import type { OrderStatus, ProductStatus } from "@/shared/api-types";
import type { TranslationKey } from "@/app/i18n/translations/es";

// Display helpers for the store UI. Prices are stored as integer minor units; until a store
// currency + locale is configured (a later phase) we present them as a plain 2-decimal amount
// with no currency symbol, which reads naturally for most currencies.
export function formatPrice(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

/**
 * Format an order amount with its currency. Orders always carry a concrete currency (snapshot
 * at checkout), so unlike the currency-less product `formatPrice` we render the real symbol via
 * Intl. Falls back to `amount + code` for an unknown/invalid ISO code so it never throws.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  const amount = minorUnits / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Badge variant for a product status. */
export function statusVariant(status: ProductStatus): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "archived") return "outline";
  return "secondary";
}

export const STATUS_LABEL_KEY: Record<ProductStatus, "store.status.draft" | "store.status.active" | "store.status.archived"> = {
  draft: "store.status.draft",
  active: "store.status.active",
  archived: "store.status.archived",
};

/** Badge variant for an order status: paid stands out, failed is destructive, terminals calm. */
export function orderStatusVariant(
  status: OrderStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "paid":
      return "default";
    case "failed":
      return "destructive";
    case "fulfilled":
    case "cancelled":
    case "refunded":
      return "outline";
    default:
      // pending, awaiting_payment
      return "secondary";
  }
}

export const ORDER_STATUS_LABEL_KEY: Record<OrderStatus, TranslationKey> = {
  pending: "store.orderStatus.pending",
  awaiting_payment: "store.orderStatus.awaiting_payment",
  paid: "store.orderStatus.paid",
  fulfilled: "store.orderStatus.fulfilled",
  cancelled: "store.orderStatus.cancelled",
  failed: "store.orderStatus.failed",
  refunded: "store.orderStatus.refunded",
};
