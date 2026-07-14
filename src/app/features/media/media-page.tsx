import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageIcon, UploadIcon } from "lucide-react";

import { MediaGrid } from "./media-grid";
import { MediaDetailSheet } from "./media-detail-sheet";
import { useMediaUpload } from "./use-media-upload";
import { UploadQueue } from "./upload-queue";
import { useWebpGate, WebpConvertDialog } from "./webp-convert-dialog";

import { mediaKeys, mediaListInfiniteQueryOptions } from "@/app/api/media";
import { projectSettingsQueryOptions, settingsKeys } from "@/app/api/settings";
import { useI18n } from "@/app/i18n";
import { PageHeader } from "@/app/components/common/page-header";
import { EmptyState } from "@/app/components/common/empty-state";
import { ErrorState } from "@/app/components/common/error-state";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Progress } from "@/app/components/ui/progress";
import { Skeleton } from "@/app/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/app/components/ui/toggle-group";
import { useDebounce } from "@/app/hooks/use-debounce";
import { useInfiniteScroll } from "@/app/hooks/use-infinite-scroll";
import { formatBytes } from "@/app/lib/format";
import { BYTES_PER_GB } from "@/shared/constants";
import type { MediaDTO, MediaKind } from "@/shared/api-types";

type KindFilter = "all" | MediaKind;

function dragHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

export function MediaPage(): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounce(searchInput, 300);
  const [selected, setSelected] = useState<MediaDTO | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const FILTERS: { value: KindFilter; labelKey: "media.filter.all" | "media.filter.images" | "media.filter.videos" }[] = [
    { value: "all", labelKey: "media.filter.all" },
    { value: "image", labelKey: "media.filter.images" },
    { value: "video", labelKey: "media.filter.videos" },
  ];

  const query = useInfiniteQuery(
    mediaListInfiniteQueryOptions({
      kind: kindFilter === "all" ? undefined : kindFilter,
      search: search || undefined,
    }),
  );
  const items = query.data?.pages.flatMap((p) => p.media) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  // Storage usage indicator (used/limit). Visible to everyone — the surface the blocked-upload
  // toast points to. The limit lives on the shared project settings; usage self-corrects on delete.
  const settings = useQuery(projectSettingsQueryOptions);
  const storageLimitBytes = settings.data ? settings.data.storageLimitGb * BYTES_PER_GB : 0;
  const storagePct =
    storageLimitBytes > 0
      ? Math.min(100, Math.round((settings.data!.storageUsedBytes / storageLimitBytes) * 100))
      : 0;

  useInfiniteScroll(sentinel, {
    hasNextPage: query.hasNextPage,
    isFetching: query.isFetchingNextPage,
    onLoadMore: () => void query.fetchNextPage(),
  });

  const upload = useMediaUpload({
    // Refresh the media list and the storage usage bar (SUM changed) as each upload lands.
    onUploaded: () => {
      void queryClient.invalidateQueries({ queryKey: mediaKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
    },
  });
  const gate = useWebpGate(upload.enqueue);
  const request = gate.request;

  // Full-page drag-and-drop overlay.
  useEffect(() => {
    let depth = 0;
    const onEnter = (e: DragEvent): void => {
      if (dragHasFiles(e)) {
        depth += 1;
        setDragging(true);
      }
    };
    const onLeave = (): void => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent): void => {
      if (dragHasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent): void => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) request(Array.from(files));
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [request]);

  const openDetail = useCallback((media: MediaDTO) => {
    setSelected(media);
    setSheetOpen(true);
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("media.title")}
        description={t("media.description")}
        actions={
          <Button size="sm" onClick={() => inputRef.current?.click()}>
            <UploadIcon className="size-4" />
            {t("media.upload")}
          </Button>
        }
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) request(Array.from(e.target.files));
          e.target.value = "";
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder={t("media.search")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="max-w-xs"
        />
        <ToggleGroup
          type="single"
          value={kindFilter}
          onValueChange={(v) => v && setKindFilter(v as KindFilter)}
          variant="outline"
          size="sm"
        >
          {FILTERS.map((f) => (
            <ToggleGroupItem key={f.value} value={f.value} className="px-3">
              {t(f.labelKey)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {settings.data ? (
          <div className="ml-auto flex w-full items-center gap-2 sm:w-56">
            <Progress value={storagePct} className="h-1.5 flex-1" />
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("media.storageUsed", {
                used: formatBytes(settings.data.storageUsedBytes),
                limit: formatBytes(storageLimitBytes),
              })}
            </span>
          </div>
        ) : null}
      </div>

      {query.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square w-full" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title={search || kindFilter !== "all" ? t("media.empty.noMatch.title") : t("media.empty.title")}
          description={
            search || kindFilter !== "all"
              ? t("media.empty.noMatch.description")
              : t("media.empty.description")
          }
          action={
            !search && kindFilter === "all" ? (
              <Button onClick={() => inputRef.current?.click()}>
                <UploadIcon className="size-4" />
                {t("media.upload")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          <MediaGrid items={items} onSelect={openDetail} selectedId={sheetOpen ? selected?.id : null} />
          <div ref={sentinel} className="h-1" />
          <p className="text-center text-sm text-muted-foreground">
            {query.isFetchingNextPage ? t("media.loading") : t("media.count", { count: items.length, total })}
          </p>
        </div>
      )}

      <MediaDetailSheet media={selected} open={sheetOpen} onOpenChange={setSheetOpen} />
      <UploadQueue upload={upload} />
      <WebpConvertDialog files={gate.pending} onCancel={gate.cancel} onComplete={gate.complete} />

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary bg-background px-8 py-6 text-center shadow-lg">
            <UploadIcon className="mx-auto size-8 text-primary" />
            <p className="mt-2 font-medium">{t("media.dropToUpload")}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
