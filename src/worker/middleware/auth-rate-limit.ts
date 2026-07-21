import { createMiddleware } from "hono/factory";
import type { Context } from "hono";

import type { AppEnv } from "../lib/app";
import { hashString } from "../lib/hash";
import { clientIp, enforceRateLimit } from "../lib/rate-limit";

import type { ApiErrorBody } from "@/shared/api-types";

/**
 * Durable throttle for the UNAUTHENTICATED credential endpoints (sign-in / sign-up).
 *
 * Better Auth's own `rateLimit` is deliberately not used: it defaults to in-memory storage,
 * which on Workers is per-isolate and ephemeral — no real protection at edge scale — and its
 * `enabled` default keys off `process.env.NODE_ENV === "production"`, which is unset in
 * workerd, so it may never even switch on. This reuses the D1 fixed-window limiter
 * (lib/rate-limit.ts) already backing checkout and webhooks: same `checkout_hits` bucket
 * table, different scopes, so no new schema.
 *
 * TWO keys, because either one alone leaves a hole:
 *   - per IP      — blunts a single host grinding through a password list.
 *   - per account — blunts DISTRIBUTED credential stuffing against one known admin email,
 *                   which a per-IP limit cannot see at all. That is the live threat here:
 *                   admin emails are guessable and one compromised account is full admin.
 *
 * Deliberately a THROTTLE, not a lockout — windows auto-expire, nothing is written to the
 * user row, no manual unlock. A durable lockout would be a remote self-DoS in this
 * everyone-is-admin model: anyone who knows the admin's email could lock the only admin out
 * of their own CMS.
 */

/** Both buckets share one window; 15 min is short enough that any throttle self-clears. */
const WINDOW_SECONDS = 15 * 60;

/**
 * Per-IP ceiling. Ten attempts per quarter-hour is far above a human fumbling their password
 * and ~5 orders of magnitude below what scripted guessing needs. Nothing legitimate is
 * high-volume here — delivery sites, MCP and CI all authenticate with API keys, never sign-in.
 */
const IP_LIMIT = 10;

/**
 * Per-account ceiling, intentionally 3x the IP limit. A single IP is cut off at {@link IP_LIMIT},
 * so it can only ever push that many hits into the victim's account bucket — locking a real
 * admin out takes 3+ distinct IPs. That residual is inherent to per-account keying and can only
 * be priced, not removed; the short window is the rest of the answer.
 */
const ACCOUNT_LIMIT = 30;

export const authRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get("db");

  // IP first, and RETURN before the account bucket is touched — otherwise a single-IP attacker
  // would spend the victim's account budget on its own way to being cut off.
  const byIp = await enforceRateLimit(db, {
    scope: "auth-ip",
    key: clientIp(c.req.raw),
    limit: IP_LIMIT,
    windowSeconds: WINDOW_SECONDS,
  });
  if (!byIp.allowed) return tooManyRequests(c, byIp.retryAfterSeconds);

  const account = await accountKey(c.req.raw);
  if (account) {
    const byAccount = await enforceRateLimit(db, {
      scope: "auth-account",
      key: account,
      limit: ACCOUNT_LIMIT,
      windowSeconds: WINDOW_SECONDS,
    });
    if (!byAccount.allowed) return tooManyRequests(c, byAccount.retryAfterSeconds);
  }

  return next();
});

/**
 * Hashed, case-normalized email from the body — or null when the body carries none, in which
 * case only the IP limit applied (a malformed body can't reach an account anyway).
 *
 * Read from a CLONE: Better Auth's handler receives the untouched `c.req.raw` and has to read
 * that same body itself.
 *
 * Normalizing is load-bearing, not cosmetic. Better Auth lowercases emails, so without it
 * `Admin@x.com` and `admin@x.com` would land in different buckets and the per-account limit
 * could be bypassed just by varying the casing. Hashing keeps plaintext emails out of the
 * bucket table (contact-forms hashes its IPs for the same reason); cyrb53 collisions are
 * harmless here — the worst case is two accounts sharing one throttle bucket.
 */
async function accountKey(request: Request): Promise<string | null> {
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  return email ? hashString(email) : null;
}

/**
 * 429 + Retry-After. Built directly (not thrown) so the header always ships, matching how the
 * commerce routes answer. The message is uniform whether or not the account exists.
 */
function tooManyRequests(c: Context<AppEnv>, retryAfterSeconds: number | undefined): Response {
  c.header("Retry-After", String(retryAfterSeconds ?? WINDOW_SECONDS));
  return c.json(
    {
      error: { code: "rate_limited", message: "Too many attempts. Try again later." },
    } satisfies ApiErrorBody,
    429,
  );
}
