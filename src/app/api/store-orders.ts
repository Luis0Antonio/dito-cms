import { queryOptions } from "@tanstack/react-query";

import { api } from "./client";

import type { AdminOrderDetail, ListOrdersParams, OrderListResult } from "@/shared/api-types";

// Client for the Store orders admin API under /api/admin/store/orders/*. Like api/store.ts these
// queries only run on store routes, which are gated behind `commerceEnabled`, so a content-only
// instance never calls them. Orders are immutable financial records — the only writes are the two
// forward transitions (fulfill, cancel), both guarded server-side.

export const storeOrderKeys = {
  all: ["store", "orders"] as const,
  /** Prefix for every list query — invalidate this after a transition without touching detail. */
  lists: () => [...storeOrderKeys.all, "list"] as const,
  list: (params: ListOrdersParams) => [...storeOrderKeys.lists(), params] as const,
  detail: (id: string) => [...storeOrderKeys.all, "detail", id] as const,
};

function ordersQuery(params: ListOrdersParams): string {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.search) q.set("search", params.search);
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.offset !== undefined) q.set("offset", String(params.offset));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const ordersListQueryOptions = (params: ListOrdersParams = {}) =>
  queryOptions({
    queryKey: storeOrderKeys.list(params),
    queryFn: () => api.get<OrderListResult>(`/api/admin/store/orders${ordersQuery(params)}`),
  });

export const orderDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: storeOrderKeys.detail(id),
    queryFn: async (): Promise<AdminOrderDetail> => {
      const { order } = await api.get<{ order: AdminOrderDetail }>(`/api/admin/store/orders/${id}`);
      return order;
    },
  });

export async function fulfillOrder(id: string): Promise<AdminOrderDetail> {
  const { order } = await api.post<{ order: AdminOrderDetail }>(`/api/admin/store/orders/${id}/fulfill`);
  return order;
}

export async function cancelOrder(id: string): Promise<AdminOrderDetail> {
  const { order } = await api.post<{ order: AdminOrderDetail }>(`/api/admin/store/orders/${id}/cancel`);
  return order;
}
