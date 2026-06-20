import { queryOptions } from "@tanstack/react-query";

import { api } from "./client";

import type {
  CollectionDetail,
  CollectionSummary,
  CollectionType,
  SetFieldsInput,
  SetFieldsResult,
} from "@/shared/api-types";

export const collectionsKeys = {
  all: ["collections"] as const,
  list: () => [...collectionsKeys.all, "list"] as const,
  detail: (slug: string) => [...collectionsKeys.all, "detail", slug] as const,
};

export const collectionsListQueryOptions = queryOptions({
  queryKey: collectionsKeys.list(),
  queryFn: async (): Promise<CollectionSummary[]> => {
    const { collections } = await api.get<{ collections: CollectionSummary[] }>("/api/admin/collections");
    return collections;
  },
});

export const collectionDetailQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: collectionsKeys.detail(slug),
    queryFn: async (): Promise<CollectionDetail> => {
      const { collection } = await api.get<{ collection: CollectionDetail }>(
        `/api/admin/collections/${slug}`,
      );
      return collection;
    },
    // The schema editor and collection pages must always reflect the latest saved
    // state. The global 10s staleTime (see app/api/query-client.ts) otherwise lets a
    // remount within that window render cached data — so editing the schema, leaving,
    // and coming back could briefly show the old value until a hard refresh. Opt this
    // view out of the window: always revalidate on (re)mount.
    refetchOnMount: "always",
  });

export interface CreateCollectionBody {
  slug: string;
  name: string;
  type: CollectionType;
  description?: string;
}

export async function createCollection(body: CreateCollectionBody): Promise<CollectionDetail> {
  const { collection } = await api.post<{ collection: CollectionDetail }>("/api/admin/collections", body);
  return collection;
}

export interface UpdateCollectionBody {
  name?: string;
  description?: string | null;
  titleField?: string | null;
}

export async function updateCollection(slug: string, body: UpdateCollectionBody): Promise<CollectionDetail> {
  const { collection } = await api.patch<{ collection: CollectionDetail }>(
    `/api/admin/collections/${slug}`,
    body,
  );
  return collection;
}

export async function setFields(slug: string, body: SetFieldsInput): Promise<SetFieldsResult> {
  return api.put<SetFieldsResult>(`/api/admin/collections/${slug}/fields`, body);
}

export async function deleteCollection(slug: string): Promise<void> {
  await api.delete(`/api/admin/collections/${slug}?confirm=${encodeURIComponent(slug)}`);
}
