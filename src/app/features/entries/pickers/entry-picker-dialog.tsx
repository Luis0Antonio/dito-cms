import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LayersIcon } from "lucide-react";

import { entriesPickerInfiniteQueryOptions } from "@/app/api/entries";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Skeleton } from "@/app/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/app/components/ui/toggle-group";
import { EmptyState } from "@/app/components/common/empty-state";
import { ErrorState } from "@/app/components/common/error-state";
import { StatusBadge } from "@/app/components/common/status-badge";
import { useDebounce } from "@/app/hooks/use-debounce";
import { useInfiniteScroll } from "@/app/hooks/use-infinite-scroll";
import type { EntrySummary } from "@/shared/api-types";

export interface PickerCollection {
  slug: string;
  name: string;
}

interface EntryPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Target collections the field may point at (≥1). More than one → a collection switcher. */
  collections: PickerCollection[];
  /** Ids already chosen (hidden from the list so a multiple field can't add dupes). */
  excludeIds?: string[];
  onSelect: (entry: EntrySummary, collectionSlug: string) => void;
}

export function EntryPickerDialog({
  open,
  onOpenChange,
  collections,
  excludeIds = [],
  onSelect,
}: EntryPickerDialogProps): React.ReactElement {
  const [activeSlug, setActiveSlug] = useState(collections[0]?.slug ?? "");
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounce(searchInput, 300);
  const sentinel = useRef<HTMLDivElement>(null);

  // Keep the active collection valid as the target list changes (and default to the first).
  useEffect(() => {
    if (!collections.some((c) => c.slug === activeSlug)) {
      setActiveSlug(collections[0]?.slug ?? "");
    }
  }, [collections, activeSlug]);

  const query = useInfiniteQuery({
    ...entriesPickerInfiniteQueryOptions(activeSlug, search),
    enabled: open && !!activeSlug,
  });
  const excluded = new Set(excludeIds);
  const items = (query.data?.pages.flatMap((p) => p.entries) ?? []).filter((e) => !excluded.has(e.id));

  useInfiniteScroll(sentinel, {
    hasNextPage: query.hasNextPage,
    isFetching: query.isFetchingNextPage,
    onLoadMore: () => void query.fetchNextPage(),
  });

  // If an entire loaded page is masked by excludeIds (e.g. a `multiple` field already holding
  // the first page of targets), items is empty and the scroll sentinel never renders — keep
  // paging so later, still-selectable entries remain reachable instead of stalling on an
  // "empty" state.
  useEffect(() => {
    if (open && !query.isPending && !query.isFetchingNextPage && query.hasNextPage && items.length === 0) {
      void query.fetchNextPage();
    }
  }, [open, query.isPending, query.isFetchingNextPage, query.hasNextPage, items.length, query]);

  const choose = (entry: EntrySummary): void => {
    onSelect(entry, activeSlug);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose an entry</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-3">
          {collections.length > 1 ? (
            <ToggleGroup
              type="single"
              value={activeSlug}
              onValueChange={(v) => v && setActiveSlug(v)}
              variant="outline"
              size="sm"
              className="flex-wrap"
            >
              {collections.map((c) => (
                <ToggleGroupItem key={c.slug} value={c.slug} className="px-3">
                  {c.name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <span className="text-sm text-muted-foreground">{collections[0]?.name}</span>
          )}
          <Input
            placeholder="Search entries…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="max-w-xs"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {query.isPending ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={LayersIcon}
              title={search ? "No entries match" : "No entries yet"}
              description={search ? "Try a different search." : "Create an entry in the target collection first."}
            />
          ) : (
            <>
              <ul className="space-y-1.5">
                {items.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => choose(entry)}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.title}</span>
                      <StatusBadge status={entry.status} className="shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
              <div ref={sentinel} className="h-1" />
              {query.isFetchingNextPage ? (
                <p className="py-3 text-center text-sm text-muted-foreground">Loading…</p>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
