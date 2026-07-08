import { lt, sql } from "drizzle-orm";

import type { DrizzleDb } from "../db/client";
import { checkoutHits } from "../db/schema";

// D1-backed fixed-window rate limiting for the PUBLIC commerce routes (checkout, payment
// webhooks). This deployment has no KV/DO/cron bindings, so the counter lives in the
// `checkout_hits` table (phase 2A): one row per (scope, key, window) bucket, incremented
// with a single upsert per request. Fixed windows are deliberately simple — the goal is
// abuse damping (scripted checkout hammering, webhook floods), not precise QoS; the
// worst-case burst at a window boundary is 2× the limit, which is fine for that goal.
//
// Framework-free (db-only), like the other lib modules. Routes decide limits/scopes and
// build the 429 response; `clientIp` is the shared header-derivation helper.

export interface RateLimitInput {
  /** Route family, e.g. `checkout` / `webhook` — keeps buckets from colliding across routes. */
  scope: string;
  /** The client identity to bucket by (normally an IP from {@link clientIp}). */
  key: string;
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until the current window expires; set only when NOT allowed. */
  retryAfterSeconds?: number;
}

/**
 * Count this request against its (scope, key, window) bucket and report whether it is
 * within the limit. One upsert round-trip per call:
 *   INSERT (count=1) ON CONFLICT DO UPDATE count=count+1 RETURNING count
 * Expired buckets are swept opportunistically — only when this call CREATED its bucket
 * (count came back 1), so the sweep runs at most once per key per window and normal
 * in-window traffic pays a single statement.
 */
export async function enforceRateLimit(
  db: DrizzleDb,
  { scope, key, limit, windowSeconds }: RateLimitInput,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = now - (now % windowMs);
  const expiresAt = windowStart + windowMs;
  const bucket = `${scope}:${key}:${windowStart}`;

  const rows = await db
    .insert(checkoutHits)
    .values({ key: bucket, count: 1, expiresAt })
    .onConflictDoUpdate({
      target: checkoutHits.key,
      set: { count: sql`${checkoutHits.count} + 1` },
    })
    .returning({ count: checkoutHits.count });
  const count = rows[0]?.count ?? 1;

  if (count === 1) {
    // New bucket → cheap opportunistic sweep of everyone's expired windows. Best-effort:
    // a failed sweep must never fail the request that triggered it.
    try {
      await db.delete(checkoutHits).where(lt(checkoutHits.expiresAt, now)).run();
    } catch {
      /* sweep again on the next new bucket */
    }
  }

  if (count <= limit) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000)) };
}

/**
 * Best-available client IP for rate-limit bucketing. Cloudflare always sets
 * `CF-Connecting-IP` in production; the `X-Forwarded-For` first hop covers local dev
 * proxies, and `"unknown"` collapses header-less callers (e.g. plain local curl) into one
 * shared bucket — throttled together rather than not at all.
 */
export function clientIp(request: Request): string {
  const cf = request.headers.get("CF-Connecting-IP")?.trim();
  if (cf) return cf;
  const xff = request.headers.get("X-Forwarded-For");
  const firstHop = xff?.split(",")[0]?.trim();
  if (firstHop) return firstHop;
  return "unknown";
}
