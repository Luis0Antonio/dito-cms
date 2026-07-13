import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import { api } from "./client";

import type {
  EntryData,
  EntryDetail,
  EntryListResult,
  EntryRef,
  ListEntriesParams,
} from "@/shared/api-types";

export const ENTRY_PICKER_PAGE_SIZE = 30;

export const entriesKeys = {
  all: ["entries"] as const,
  lists: (slug: string) => [...entriesKeys.all, "list", slug] as const,
  list: (slug: string, params: ListEntriesParams) =>
    [...entriesKeys.lists(slug), params] as const,
  picker: (slug: string, search: string) => [...entriesKeys.lists(slug), "picker", search] as const,
  detail: (id: string) => [...entriesKeys.all, "detail", id] as const,
  ref: (id: string) => [...entriesKeys.all, "ref", id] as const,
  singleton: (slug: string) => [...entriesKeys.all, "singleton", slug] as const,
};

/** Lightweight resolved reference target (title/slug/status) — powers the reference preview. */
export const entryRefQueryOptions = (id: string) =>
  queryOptions({
    queryKey: entriesKeys.ref(id),
    queryFn: async () => {
      const { ref } = await api.get<{ ref: EntryRef }>(`/api/admin/entries/${id}/ref`);
      return ref;
    },
    retry: false,
  });

/** Infinite, searchable list of a collection's entries for the reference picker. */
export const entriesPickerInfiniteQueryOptions = (slug: string, search: string) =>
  infiniteQueryOptions({
    queryKey: entriesKeys.picker(slug, search),
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (search) qs.set("search", search);
      qs.set("limit", String(ENTRY_PICKER_PAGE_SIZE));
      qs.set("offset", String(pageParam));
      return api.get<EntryListResult>(`/api/admin/collections/${slug}/entries?${qs.toString()}`);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.entries.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

export const entriesListQueryOptions = (slug: string, params: ListEntriesParams) =>
  queryOptions({
    queryKey: entriesKeys.list(slug, params),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params.status) qs.set("status", params.status);
      if (params.search) qs.set("search", params.search);
      qs.set("limit", String(params.limit ?? 50));
      qs.set("offset", String(params.offset ?? 0));
      return api.get<EntryListResult>(`/api/admin/collections/${slug}/entries?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

export const entryDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: entriesKeys.detail(id),
    queryFn: async () => {
      const { entry } = await api.get<{ entry: EntryDetail }>(`/api/admin/entries/${id}`);
      return entry;
    },
  });

/** Bootstraps (idempotent get-or-create) and returns a singleton's sole entry. */
export const singletonEntryQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: entriesKeys.singleton(slug),
    queryFn: async () => {
      const { entry } = await api.get<{ entry: EntryDetail }>(
        `/api/admin/collections/${slug}/singleton`,
      );
      return entry;
    },
  });

export interface CreateEntryBody {
  data: EntryData;
  slug?: string | null;
  publish?: boolean;
}

export async function createEntry(slug: string, body: CreateEntryBody): Promise<EntryDetail> {
  const { entry } = await api.post<{ entry: EntryDetail }>(
    `/api/admin/collections/${slug}/entries`,
    body,
  );
  return entry;
}

export interface UpdateEntryBody {
  data?: EntryData;
  slug?: string | null;
  sortOrder?: number;
}

export async function updateEntry(id: string, body: UpdateEntryBody): Promise<EntryDetail> {
  const { entry } = await api.patch<{ entry: EntryDetail }>(`/api/admin/entries/${id}`, body);
  return entry;
}

export async function publishEntry(id: string): Promise<EntryDetail> {
  const { entry } = await api.post<{ entry: EntryDetail }>(`/api/admin/entries/${id}/publish`);
  return entry;
}

export async function unpublishEntry(id: string): Promise<EntryDetail> {
  const { entry } = await api.post<{ entry: EntryDetail }>(`/api/admin/entries/${id}/unpublish`);
  return entry;
}

export async function discardDraft(id: string): Promise<EntryDetail> {
  const { entry } = await api.post<{ entry: EntryDetail }>(`/api/admin/entries/${id}/discard`);
  return entry;
}

export async function deleteEntry(id: string): Promise<void> {
  await api.delete(`/api/admin/entries/${id}`);
}

export async function reorderEntries(slug: string, ids: string[]): Promise<void> {
  await api.post(`/api/admin/collections/${slug}/entries/reorder`, { ids });
}
