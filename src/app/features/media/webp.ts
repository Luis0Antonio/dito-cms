// Browser-side WebP re-encoding: decode an image to a canvas and export it as
// WebP at a caller-chosen quality, entirely client-side before the upload to R2.

/**
 * Raster formats we can decode and re-encode to WebP. Excludes `image/gif`
 * (canvas captures a single frame, silently dropping animation) and
 * `image/svg+xml` (vector — rasterizing it loses scalability and has no
 * meaningful "quality"). Re-encoding `image/webp` is allowed so an existing
 * WebP can be recompressed at a lower quality.
 */
const WEBP_SOURCE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

/** Whether `encodeToWebp` can handle this file (a re-encodable raster image). */
export function canEncodeToWebp(file: File): boolean {
  return WEBP_SOURCE_MIME.has(file.type);
}

/** Swap a filename's extension, e.g. `photo.PNG` -> `photo.webp`. */
function replaceExtension(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.${ext}`;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Decode `file` to something drawable. Prefers `createImageBitmap` (fast,
 * honoring EXIF orientation) and falls back to an <img> element when the
 * browser can't bitmap-decode the format.
 */
async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Fall through to the <img> path below.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = url;
  });
}

function canvasToWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/webp", Math.min(1, Math.max(0, quality)));
  });
}

/**
 * Largest edge (px) we keep when re-encoding. A full-resolution phone/tablet
 * photo (often 4000px+) is far larger than any web layout needs, so capping the
 * longest side is what actually shrinks delivery — re-encoding at full size
 * barely helps and can even grow the file. Smaller images are never upscaled.
 */
export const MAX_EDGE = 2048;

/** Scale (w,h) down so its longest edge is at most `maxEdge`, keeping aspect ratio. Never upscales. */
function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Re-encode an image file as WebP at the given quality (0..1), downscaling so
 * its longest edge is at most `maxEdge` (defaults to {@link MAX_EDGE}). Returns
 * a new `File` with a `.webp` name and `image/webp` type. Rejects if the image
 * can't be decoded or the browser can't produce WebP, so callers can fall back
 * to the original.
 */
export async function encodeToWebp(file: File, quality: number, maxEdge: number = MAX_EDGE): Promise<File> {
  const decoded = await decode(file);
  try {
    const target = fitWithin(decoded.width, decoded.height, maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    // High-quality resampling so the downscaled image still looks crisp.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, target.width, target.height);

    const blob = await canvasToWebp(canvas, quality);
    // `canvas.toBlob` silently falls back to PNG when the browser can't encode
    // WebP (notably older Safari / iPadOS): it hands back a non-null PNG blob
    // that we'd otherwise mislabel `.webp`. A lossless PNG re-encode of a photo
    // is far *larger* than the source (a 7 MB JPEG balloons to ~10 MB), so treat
    // any non-WebP result as unsupported and let callers keep the original.
    if (!blob || blob.type !== "image/webp") {
      throw new Error("WebP encoding is not supported in this browser");
    }

    return new File([blob], replaceExtension(file.name, "webp"), {
      type: "image/webp",
      lastModified: file.lastModified,
    });
  } finally {
    decoded.release();
  }
}
