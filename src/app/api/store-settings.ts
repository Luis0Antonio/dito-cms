import { queryOptions } from "@tanstack/react-query";

import { api } from "./client";

import type {
  OrderHookActivity,
  OrderHookTestResult,
  StoreSettings,
  UpdateCulqiInput,
  UpdateOrderHookInput,
} from "@/shared/api-types";

// Client for the redacted store-settings surface under /api/admin/store/settings and the
// order-hook admin surface (mirrors api/deploy-hook.ts). Payment/webhook secrets are write-only:
// they travel out (PATCH) but never come back — reads report only whether each is configured.

/** PATCH body for the store settings bundle; each fragment is independent and optional. */
export interface UpdateStoreSettingsInput {
  currency?: string;
  culqi?: UpdateCulqiInput;
  orderHook?: UpdateOrderHookInput;
}

export const storeSettingsKeys = {
  all: ["store", "settings"] as const,
  orderHookActivity: ["store", "settings", "order-hook-activity"] as const,
};

export const storeSettingsQueryOptions = queryOptions({
  queryKey: storeSettingsKeys.all,
  queryFn: () => api.get<StoreSettings>("/api/admin/store/settings"),
  staleTime: 30_000,
});

export const orderHookActivityQueryOptions = queryOptions({
  queryKey: storeSettingsKeys.orderHookActivity,
  queryFn: () => api.get<OrderHookActivity>("/api/admin/store/order-hook/deliveries"),
  staleTime: 10_000,
});

export function updateStoreSettings(body: UpdateStoreSettingsInput): Promise<StoreSettings> {
  return api.patch<StoreSettings>("/api/admin/store/settings", body);
}

export function testOrderHook(): Promise<OrderHookTestResult> {
  return api.post<OrderHookTestResult>("/api/admin/store/order-hook/test");
}
