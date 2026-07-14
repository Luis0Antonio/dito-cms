// Isomorphic constants shared by the worker and the SPA.

export const APP_NAME = "Dito CMS";
export const APP_VERSION = "0.1.0";

/** Project homepage / docs. Update this if you fork or rename the project. */
export const REPO_URL = "https://github.com/Luis0Antonio/dito-cms";

/** R2 multipart part size. All parts except the last must equal this (≥5 MiB R2 rule). */
export const PART_SIZE = 10 * 1024 * 1024; // 10 MiB

/** Direct (non-multipart) image upload cap. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB

/** Hard ceiling for a single multipart video upload. */
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * Per-video cap applied only when the active storage provider is Cloudinary. Cloudinary's
 * real maximum is governed by the deployer's plan (free tiers are far lower than 2 GB), so
 * this is a safety valve: lower it to get a clean up-front error instead of a mid-upload
 * failure. Defaults to the same 2 GB ceiling as R2.
 */
export const MAX_CLOUDINARY_VIDEO_BYTES = MAX_VIDEO_BYTES;

/** Rich-text serialized size cap (D1 row stays well under 2 MB). */
export const MAX_RICH_TEXT_BYTES = 256 * 1024;

/** Brand logo: client-side cap on the original image file before it's inlined as a data URL. */
export const MAX_LOGO_BYTES = 256 * 1024; // 256 KB

/**
 * Server-side cap on the stored logo data-URL string. Larger than MAX_LOGO_BYTES to allow for
 * base64 inflation (~4/3) of a max-size image, keeping the D1 settings row small.
 */
export const MAX_LOGO_DATA_URL_BYTES = 512 * 1024;

/** Bytes in one gibibyte (1024³) — the unit `formatBytes` and the storage limit both use. */
export const BYTES_PER_GB = 1024 ** 3;

/**
 * Default per-deployment media storage cap, in GB. R2 is usage-billed (effectively unbounded),
 * so this soft cap blocks uploads once exceeded to keep the vendor's Cloudflare bill in check.
 * Adjustable in-app by a System Admin; enforcement is live on every deployment immediately.
 */
export const DEFAULT_STORAGE_LIMIT_GB = 5;

/** Upper bound accepted when a System Admin edits the storage cap (raising it has billing cost). */
export const MAX_STORAGE_LIMIT_GB = 1024;

/** Delivery list pagination ceiling. */
export const MAX_DELIVERY_LIMIT = 100;

/** D1 binds at most 100 params; chunk IN() queries below that. */
export const D1_IN_CHUNK = 90;

export const IMAGE_MIME_ALLOWLIST = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
] as const;

export const VIDEO_MIME_ALLOWLIST = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;
