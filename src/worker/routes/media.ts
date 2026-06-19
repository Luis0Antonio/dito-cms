import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { media } from "../db/schema";
import type { AppEnv } from "../lib/app";
import { isCloudinary, mediaKey, r2Binding } from "../services/storage";

// Public media serving: GET /media/:id/:filename.
// - R2 (default): the key is reconstructed straight from the path (`media/<id>/<filename>`) so
//   there is no D1 read on the hot path. URLs are unique per media id and content never changes
//   → immutable cache. Range + If-None-Match are delegated to R2 via the request headers.
// - Cloudinary: objects live on Cloudinary's CDN, so the media DTOs already point there and this
//   route is normally bypassed. When hit directly it looks up the row and 302-redirects to the
//   stored secure_url (Cloudinary's CDN handles Range/caching itself).
export const mediaServeRouter = new Hono<AppEnv>();

const IMMUTABLE = "public, max-age=31536000, immutable";
// Media is served from the worker's own origin, so a malicious SVG/HTML upload could run
// script in that origin. `sandbox` + `default-src 'none'` neutralizes scripts on direct
// navigation while still allowing the asset to render via <img>/<video>.
const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function setCommonHeaders(headers: Headers, object: R2Object): void {
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", IMMUTABLE);
  headers.set("Accept-Ranges", "bytes");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", SANDBOX_CSP);
}

/** Resolve R2's served range (which may be expressed as offset/length or suffix). */
function resolveRange(range: R2Range, size: number): { offset: number; length: number } {
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  const length = range.length ?? size - offset;
  return { offset, length };
}

mediaServeRouter.get("/:id/:filename", async (c) => {
  // Cloudinary deploy: redirect to the stored CDN URL (rare — DTOs already link there directly).
  if (isCloudinary(c.env)) {
    const row = await c
      .get("db")
      .select({ url: media.url })
      .from(media)
      .where(eq(media.id, c.req.param("id")))
      .get();
    if (!row?.url) {
      return c.json({ error: { code: "not_found", message: "Media not found" } }, 404);
    }
    return c.redirect(row.url, 302);
  }

  const bucket = r2Binding(c.env);
  if (!bucket) {
    return c.json({ error: { code: "not_found", message: "Media not found" } }, 404);
  }

  const key = mediaKey(c.req.param("id"), c.req.param("filename"));
  const reqHeaders = c.req.raw.headers;
  const rangeHeader = reqHeaders.get("range");

  // Opportunistic edge cache for full (non-Range) GETs — a no-op on workers.dev, so
  // correctness never depends on it. Only images are cached (see below).
  const cache = caches.default;
  if (!rangeHeader) {
    const cached = await cache.match(c.req.raw);
    if (cached) return cached;
  }

  const object = await bucket.get(key, {
    onlyIf: reqHeaders,
    range: rangeHeader ? reqHeaders : undefined,
  });
  if (object === null) {
    return c.json({ error: { code: "not_found", message: "Media not found" } }, 404);
  }

  const headers = new Headers();
  setCommonHeaders(headers, object);

  // Conditional request matched our ETag → R2 returns metadata without a body.
  if (!("body" in object)) {
    return new Response(null, { status: 304, headers });
  }

  if (rangeHeader && object.range) {
    const { offset, length } = resolveRange(object.range, object.size);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  const response = new Response(object.body, { status: 200, headers });

  const contentType = headers.get("content-type") ?? "";
  if (!rangeHeader && contentType.startsWith("image/")) {
    try {
      c.executionCtx.waitUntil(cache.put(c.req.raw, response.clone()));
    } catch {
      /* no execution context (e.g. some dev setups) — skip caching */
    }
  }
  return response;
});
