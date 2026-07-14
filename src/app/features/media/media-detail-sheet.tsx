import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2Icon } from "lucide-react";

import { formatDuration } from "./media-grid";

import {
  deleteMedia,
  mediaKeys,
  mediaUsageQueryOptions,
  updateMedia,
} from "@/app/api/media";
import { settingsKeys } from "@/app/api/settings";
import { isApiError } from "@/app/api/client";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/app/components/ui/sheet";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/app/components/ui/alert-dialog";
import { CopyButton } from "@/app/components/common/copy-button";
import { formatBytes, formatDateTime } from "@/app/lib/format";
import type { MediaDTO } from "@/shared/api-types";

function InfoRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium" title={value}>
        {value}
      </span>
    </div>
  );
}

interface MediaDetailSheetProps {
  media: MediaDTO | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MediaDetailSheet({ media, open, onOpenChange }: MediaDetailSheetProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [alt, setAlt] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setAlt(media?.alt ?? "");
    setConfirmDelete(false);
  }, [media]);

  const absoluteUrl = media ? `${window.location.origin}${media.url}` : "";

  const altMutation = useMutation({
    mutationFn: () => updateMedia(media!.id, { alt }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(mediaKeys.detail(updated.id), updated);
      await queryClient.invalidateQueries({ queryKey: mediaKeys.lists() });
      toast.success("Alt text saved");
    },
    onError: (e) => toast.error(isApiError(e) ? e.message : "Could not save alt text"),
  });

  const usage = useQuery({
    ...mediaUsageQueryOptions(media?.id ?? ""),
    enabled: open && confirmDelete && media !== null,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteMedia(media!.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: mediaKeys.lists() });
      // Freed bytes change the SUM — refresh the storage usage bar / settings figures.
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      toast.success("Media deleted");
      setConfirmDelete(false);
      onOpenChange(false);
    },
    onError: (e) => toast.error(isApiError(e) ? e.message : "Could not delete media"),
  });

  const usageEntries = usage.data?.entries ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="truncate">{media?.filename ?? "Media"}</SheetTitle>
          <SheetDescription>Preview, edit alt text, copy the URL, or delete.</SheetDescription>
        </SheetHeader>

        {media ? (
          <div className="space-y-5 px-4 pb-6">
            <div className="overflow-hidden rounded-lg border bg-muted">
              {media.kind === "image" ? (
                <img src={media.url} alt={media.alt ?? media.filename} className="max-h-72 w-full object-contain" />
              ) : (
                <video src={media.url} controls className="max-h-72 w-full bg-black" />
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="media-alt">Alt text</Label>
              <div className="flex gap-2">
                <Input
                  id="media-alt"
                  value={alt}
                  placeholder="Describe this asset"
                  onChange={(e) => setAlt(e.target.value)}
                />
                <Button
                  onClick={() => altMutation.mutate()}
                  disabled={altMutation.isPending || alt === (media.alt ?? "")}
                >
                  Save
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Alt text lives on the asset, so it applies everywhere it's used.
              </p>
            </div>

            <div className="space-y-2">
              <Label>URL</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs">
                  {absoluteUrl}
                </code>
                <CopyButton value={absoluteUrl} />
              </div>
            </div>

            <div className="space-y-1.5 rounded-lg border p-3">
              <InfoRow label="Type" value={media.mime} />
              <InfoRow label="Size" value={formatBytes(media.size)} />
              {media.width && media.height ? (
                <InfoRow label="Dimensions" value={`${media.width} × ${media.height}`} />
              ) : null}
              {media.kind === "video" && formatDuration(media.duration) ? (
                <InfoRow label="Duration" value={formatDuration(media.duration)!} />
              ) : null}
              <InfoRow label="Uploaded" value={formatDateTime(media.createdAt)} />
            </div>

            <Button variant="outline" className="w-full text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2Icon className="size-4" />
              Delete
            </Button>
          </div>
        ) : null}
      </SheetContent>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this asset?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>This permanently removes the file. It can&apos;t be undone.</p>
                {usage.isPending ? (
                  <p className="text-xs">Checking where it&apos;s used…</p>
                ) : usageEntries.length > 0 ? (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                    <p className="font-medium">
                      Used by {usageEntries.length} {usageEntries.length === 1 ? "entry" : "entries"} — those
                      references will show as empty:
                    </p>
                    <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-4">
                      {usageEntries.map((e) => (
                        <li key={e.entryId}>
                          {e.title} <span className="text-amber-700">({e.collectionName})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Not referenced by any entry.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
