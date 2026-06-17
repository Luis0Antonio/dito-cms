// Storage-provider selection. The provider is auto-detected from credentials at request time:
// if CLOUDINARY_URL is set (and parses), media goes to Cloudinary; otherwise it uses the R2
// bucket bound as MEDIA. Each provider's absence never blocks the other — getStorageProvider
// only throws when the *active* path is unconfigured, so a Cloudinary-only deploy needs no R2
// bucket and an R2 deploy needs no Cloudinary account.

import { CloudinaryProvider, type CloudinaryCreds } from "./cloudinary";
import { R2Provider } from "./r2";
import type { ProviderName, StorageProvider } from "./types";

export type { StorageProvider, PutResult, ProviderName } from "./types";
export { mediaKey } from "./r2";

/**
 * Read the optional R2 binding. Accessed through a cast so the worker compiles whether or not
 * `MEDIA` is present in the generated env types (a Cloudinary-only deploy omits the binding).
 */
export function r2Binding(env: Env): R2Bucket | undefined {
  return (env as { MEDIA?: R2Bucket }).MEDIA;
}

/** Parse `cloudinary://<api_key>:<api_secret>@<cloud_name>`; null if absent or malformed. */
export function parseCloudinaryUrl(raw: string | undefined): CloudinaryCreds | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "cloudinary:") return null;
    const apiKey = decodeURIComponent(u.username);
    const apiSecret = decodeURIComponent(u.password);
    const cloudName = u.host;
    if (!apiKey || !apiSecret || !cloudName) return null;
    return { cloudName, apiKey, apiSecret };
  } catch {
    return null;
  }
}

/** True when Cloudinary is the active provider for this deployment. */
export function isCloudinary(env: Env): boolean {
  return parseCloudinaryUrl(env.CLOUDINARY_URL) !== null;
}

export function activeProviderName(env: Env): ProviderName {
  return isCloudinary(env) ? "cloudinary" : "r2";
}

/** The active storage provider — Cloudinary if its credentials are set, otherwise R2. */
export function getStorageProvider(env: Env): StorageProvider {
  const creds = parseCloudinaryUrl(env.CLOUDINARY_URL);
  if (creds) return new CloudinaryProvider(creds);
  const bucket = r2Binding(env);
  if (bucket) return new R2Provider(bucket);
  throw new Error("No media storage configured: set CLOUDINARY_URL or bind an R2 bucket as MEDIA.");
}
