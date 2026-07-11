import type { ProductStatus } from "@/shared/api-types";

// Display helpers for the store UI. Prices are stored as integer minor units; until a store
// currency + locale is configured (a later phase) we present them as a plain 2-decimal amount
// with no currency symbol, which reads naturally for most currencies.
export function formatPrice(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
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
