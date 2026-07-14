import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { isApiError } from "@/app/api/client";
import {
  abortMultipart,
  completeMultipart,
  initMultipart,
  uploadImage,
  uploadPart,
} from "@/app/api/media";
import { settingsKeys } from "@/app/api/settings";
import { useI18n } from "@/app/i18n";
import { formatBytes } from "@/app/lib/format";
import { BYTES_PER_GB } from "@/shared/constants";
import type { MediaDTO, MediaKind, ProjectSettings, UploadedPart } from "@/shared/api-types";

export type UploadStatus = "uploading" | "success" | "error" | "canceled";

export interface UploadTask {
  id: string;
  file: File;
  kind: MediaKind;
  status: UploadStatus;
  /** 0..1 */
  progress: number;
  error?: string;
  media?: MediaDTO;
}

interface Probed {
  width?: number;
  height?: number;
  duration?: number;
}

/** Per-task mutable control kept outside React state (survives re-renders, drives resume). */
interface Control {
  controller: AbortController;
  canceled: boolean;
  mediaId?: string;
  uploadId?: string;
  partSize?: number;
  parts: UploadedPart[];
  meta?: Probed;
}

function kindOf(file: File): MediaKind {
  return file.type.startsWith("video/") ? "video" : "image";
}

function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return "Upload failed";
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

function probeImage(file: File): Promise<Probed> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({});
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

function probeVideo(file: File): Promise<Probed> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        duration: Number.isFinite(video.duration) ? video.duration : undefined,
      });
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      resolve({});
      URL.revokeObjectURL(url);
    };
    video.src = url;
  });
}

/** Byte length of part `n` of `total`, given the equal-size rule (last part is the remainder). */
function partLength(n: number, total: number, partSize: number, fileSize: number): number {
  return n < total ? partSize : fileSize - (total - 1) * partSize;
}

export interface UseMediaUpload {
  tasks: UploadTask[];
  enqueue: (files: File[]) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
  activeCount: number;
}

/**
 * Drives the upload queue: streamed image POSTs and multipart (chunked) video uploads, with
 * per-file progress, cancellation (aborts + R2 abort), and resume-from-last-acked-part retry.
 * `onUploaded` fires once per successfully completed file (consumer invalidates / auto-selects).
 */
export function useMediaUpload(options?: { onUploaded?: (media: MediaDTO) => void }): UseMediaUpload {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const controls = useRef(new Map<string, Control>());
  const mounted = useRef(true);
  const onUploaded = useRef(options?.onUploaded);
  onUploaded.current = options?.onUploaded;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback((id: string, patch: Partial<UploadTask>) => {
    if (!mounted.current) return;
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const runImage = useCallback(
    async (id: string, file: File, ctl: Control) => {
      const meta = await probeImage(file);
      const media = await uploadImage(
        file,
        { width: meta.width, height: meta.height },
        { onProgress: (f) => update(id, { progress: f }), signal: ctl.controller.signal },
      );
      update(id, { status: "success", progress: 1, media });
      onUploaded.current?.(media);
    },
    [update],
  );

  const runVideo = useCallback(
    async (id: string, file: File, ctl: Control) => {
      if (!ctl.uploadId) {
        const init = await initMultipart({ filename: file.name, mime: file.type, size: file.size });
        ctl.mediaId = init.mediaId;
        ctl.uploadId = init.uploadId;
        ctl.partSize = init.partSize;
        ctl.meta = await probeVideo(file);
      }
      const partSize = ctl.partSize ?? file.size;
      const total = Math.max(1, Math.ceil(file.size / partSize));
      const done = new Set(ctl.parts.map((p) => p.partNumber));

      for (let n = 1; n <= total; n++) {
        if (ctl.canceled) return;
        if (done.has(n)) continue;
        const start = (n - 1) * partSize;
        const blob = file.slice(start, Math.min(start + partSize, file.size));
        const part = await uploadPart(ctl.mediaId!, ctl.uploadId!, n, blob, {
          signal: ctl.controller.signal,
          onProgress: (loaded) => {
            const completed = ctl.parts.reduce(
              (b, p) => b + partLength(p.partNumber, total, partSize, file.size),
              0,
            );
            update(id, { progress: Math.min(0.99, (completed + loaded) / file.size) });
          },
        });
        ctl.parts.push(part);
      }

      const media = await completeMultipart(ctl.mediaId!, {
        uploadId: ctl.uploadId!,
        parts: ctl.parts,
        width: ctl.meta?.width,
        height: ctl.meta?.height,
        duration: ctl.meta?.duration,
      });
      update(id, { status: "success", progress: 1, media });
      onUploaded.current?.(media);
    },
    [update],
  );

  const run = useCallback(
    async (id: string, file: File, kind: MediaKind, ctl: Control) => {
      update(id, { status: "uploading", error: undefined });
      try {
        if (kind === "video") await runVideo(id, file, ctl);
        else await runImage(id, file, ctl);
      } catch (e) {
        if (ctl.canceled || isAbort(e)) return;
        update(id, { status: "error", error: errorMessage(e) });
        // A blocked-by-storage-limit upload must not fail silently — surface it here (the shared
        // hook), so it toasts from every upload surface (Media page, entry-editor picker). The
        // picker has no upload queue, so this toast is its only feedback: include the live
        // used/limit from the settings cache, then point at the Media library usage bar.
        if (isApiError(e) && e.code === "storage_limit_exceeded") {
          const s = queryClient.getQueryData<ProjectSettings>(settingsKeys.all);
          const description = s
            ? `${t("media.storageLimitUsage", {
                used: formatBytes(s.storageUsedBytes),
                limit: formatBytes(s.storageLimitGb * BYTES_PER_GB),
              })} ${t("media.storageLimitBody")}`
            : t("media.storageLimitBody");
          toast.error(t("media.storageLimitTitle"), { description });
        }
      }
    },
    [runImage, runVideo, update, t, queryClient],
  );

  const enqueue = useCallback(
    (files: File[]) => {
      const fresh: UploadTask[] = files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        kind: kindOf(file),
        status: "uploading",
        progress: 0,
      }));
      setTasks((ts) => [...fresh, ...ts]);
      for (const task of fresh) {
        const ctl: Control = { controller: new AbortController(), canceled: false, parts: [] };
        controls.current.set(task.id, ctl);
        void run(task.id, task.file, task.kind, ctl);
      }
    },
    [run],
  );

  const cancel = useCallback(
    (id: string) => {
      const ctl = controls.current.get(id);
      if (ctl) {
        ctl.canceled = true;
        ctl.controller.abort();
        if (ctl.mediaId && ctl.uploadId) void abortMultipart(ctl.mediaId, ctl.uploadId).catch(() => {});
      }
      update(id, { status: "canceled" });
    },
    [update],
  );

  const retry = useCallback(
    (id: string) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) return;
      const prev = controls.current.get(id);
      const ctl: Control = {
        controller: new AbortController(),
        canceled: false,
        // Resume video uploads from the parts already acked by R2.
        parts: prev?.parts ?? [],
        mediaId: prev?.mediaId,
        uploadId: prev?.uploadId,
        partSize: prev?.partSize,
        meta: prev?.meta,
      };
      controls.current.set(id, ctl);
      void run(id, task.file, task.kind, ctl);
    },
    [run, tasks],
  );

  const remove = useCallback((id: string) => {
    controls.current.delete(id);
    setTasks((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setTasks((ts) => {
      for (const t of ts) if (t.status !== "uploading") controls.current.delete(t.id);
      return ts.filter((t) => t.status === "uploading");
    });
  }, []);

  return {
    tasks,
    enqueue,
    cancel,
    retry,
    remove,
    clearFinished,
    activeCount: tasks.filter((t) => t.status === "uploading").length,
  };
}
