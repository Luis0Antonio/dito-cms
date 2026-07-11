import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { inArray } from "drizzle-orm";

import type { AppEnv } from "../lib/app";
import { hashString } from "../lib/hash";
import { badRequest, notFound } from "../lib/errors";
import { clientIp, enforceRateLimit } from "../lib/rate-limit";
import { products } from "../db/schema";
import { isCommerceEnabled } from "../services/settings";
import {
  getCatalogProduct,
  listCatalogCategories,
  listCatalogProducts,
} from "../services/store/products";
import { createCheckout } from "../services/store/checkout";
import { getPublicOrder } from "../services/store/orders";
import { fireOrderHook } from "../services/store/order-hook";

import { MAX_DELIVERY_LIMIT } from "@/shared/constants";
import type {
  ApiErrorBody,
  AvailabilityResponse,
  CheckoutInput,
  CheckoutOrderDTO,
  CheckoutResponseBody,
  CheckoutValidationErrorBody,
  PublicOrderResponse,
} from "@/shared/api-types";

// Public (buyer-facing) commerce API at /api/commerce/*, CORS-open for storefronts. Two route
// flavors live here:
//   - CATALOG reads (products, categories): cacheable — ETag + short Cache-Control.
//   - LIVE commerce (availability, checkout, order status): always `Cache-Control: no-store` —
//     this is moment-of-truth state that must never be baked into caches or static pages.
// Everything is gated by the `commerce_enabled` setting — when the Store module is off, every
// route 404s. The catalog serves only `active` products, and it never exposes raw stock counts
// (only derived availability). Payment-provider webhooks are NOT here — they live in
// commerce-webhooks.ts (server-to-server: no CORS, no caching semantics).
export const commerceRouter = new Hono<AppEnv>();

const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

/**
 * Rate limit for POST /checkout: fixed 60s windows per client IP over the D1 `checkout_hits`
 * table (lib/rate-limit.ts). Checkout writes order rows and can call the payment gateway, so
 * it gets a tight budget; 10/min is far above any legitimate single-buyer flow (every attempt
 * is a whole cart submission), while blunting scripted card-testing and order-spam.
 */
const CHECKOUT_RATE_LIMIT = { scope: "checkout", limit: 10, windowSeconds: 60 } as const;

// POST is for /checkout only; preflights echo Access-Control-Request-Headers, which covers
// Content-Type and Idempotency-Key.
commerceRouter.use("*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "POST", "OPTIONS"], maxAge: 86400 }));

// Module gate: invisible when disabled.
commerceRouter.use("*", async (c, next) => {
  if (!(await isCommerceEnabled(c.get("db")))) {
    throw notFound("The Store module is not enabled");
  }
  await next();
});

/** True when the client's If-None-Match covers our ETag (honor `*` and comma lists). */
function notModified(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || t === etag);
}

function parseInt0(value: string | null, fallback: number): number {
  // Number(null) and Number("") are 0 (finite), so guard those explicitly — otherwise an
  // absent ?limit would resolve to 0 instead of the fallback.
  if (value === null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Send a JSON body with an ETag derived from its content, honoring If-None-Match. */
function cached(c: Context<AppEnv>, body: unknown): Response {
  const json = JSON.stringify(body);
  const etag = `"${hashString(json)}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", CACHE_CONTROL);
  if (notModified(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  c.header("Content-Type", "application/json; charset=UTF-8");
  return c.body(json);
}

// Paginated list of active products. Supports ?category=<slug>&search=&limit=&offset=.
commerceRouter.get("/products", async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(Math.max(parseInt0(url.searchParams.get("limit"), 20), 1), MAX_DELIVERY_LIMIT);
  const offset = Math.max(parseInt0(url.searchParams.get("offset"), 0), 0);
  const response = await listCatalogProducts(c.get("db"), c.get("origin"), {
    categorySlug: url.searchParams.get("category") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    limit,
    offset,
  });
  return cached(c, response);
});

// A single active product by slug.
commerceRouter.get("/products/:slug", async (c) => {
  const data = await getCatalogProduct(c.get("db"), c.get("origin"), c.req.param("slug"));
  return cached(c, { data });
});

// The category tree (flat, with parent slugs).
commerceRouter.get("/categories", async (c) => {
  const categories = await listCatalogCategories(c.get("db"));
  return cached(c, { data: categories });
});

// --- live commerce (always no-store) ------------------------------------------

/** Mark a response as uncacheable: live commerce state (availability, checkout, orders). */
function noStore(c: Context<AppEnv>): void {
  c.header("Cache-Control", "no-store");
}

/** 429 with Retry-After. Built directly (not thrown) so the header always ships. */
function rateLimited(c: Context<AppEnv>, retryAfterSeconds: number | undefined): Response {
  c.header("Retry-After", String(retryAfterSeconds ?? 60));
  return c.json(
    { error: { code: "rate_limited", message: "Too many requests. Try again shortly." } } satisfies ApiErrorBody,
    429,
  );
}

/** Ceiling for one availability request; matches checkout's per-order line ceiling scale. */
const MAX_AVAILABILITY_SLUGS = 50;
/** Same per-slug length bound checkout enforces on its line items. */
const MAX_SLUG_LEN = 200;

// Live availability for up to 50 products in ONE indexed query (products.slug is unique;
// ≤50 ids is always a single IN list). This is the storefront's dynamic source of truth —
// product pages/cart islands fetch it at view time, so stock state is never baked into
// static pages or stale caches. Only a derived boolean is exposed, NEVER counts.
commerceRouter.get("/availability", async (c) => {
  noStore(c);
  const raw = c.req.query("slugs");
  if (!raw || raw.trim() === "") {
    throw badRequest("Provide product slugs: ?slugs=a,b,c");
  }
  const requested = raw.split(",").map((s) => s.trim());
  if (requested.length > MAX_AVAILABILITY_SLUGS) {
    throw badRequest(`At most ${MAX_AVAILABILITY_SLUGS} slugs per request`);
  }
  if (requested.some((s) => s === "" || s.length > MAX_SLUG_LEN)) {
    throw badRequest("Malformed `slugs` list: empty or oversized entries");
  }

  const unique = [...new Set(requested)];
  const rows = await c
    .get("db")
    .select({ slug: products.slug, status: products.status, stock: products.stock })
    .from(products)
    .where(inArray(products.slug, unique))
    .all();
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  // Every requested slug gets an answer; unknown/draft/archived are indistinguishable (false).
  const availability: AvailabilityResponse["availability"] = {};
  for (const slug of unique) {
    const row = bySlug.get(slug);
    availability[slug] = {
      available: row !== undefined && row.status === "active" && (row.stock === null || row.stock > 0),
    };
  }
  return c.json({ availability } satisfies AvailabilityResponse);
});

/**
 * Deterministic JSON for idempotency hashing: object keys sorted recursively, so the same
 * logical payload hashes identically regardless of the client's key order. Array order is
 * preserved (cart line order is meaningful). undefined renders as null — only determinism
 * matters here, not JSON.stringify parity.
 */
function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  const primitive: string | undefined = JSON.stringify(value);
  return primitive ?? "null";
}

/** SHA-256 → lowercase hex (WebCrypto). */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toCheckoutBody(
  order: CheckoutOrderDTO,
  error?: { code: string; message: string },
): CheckoutResponseBody {
  return error ? { order, error } : { order };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled checkout result: ${String(value)}`);
}

// Guest checkout — deliberately NO auth (buyers have no accounts); the rate limit and the
// service's validation/re-pricing are the protection. The route only: rate-limits, hashes the
// optional Idempotency-Key, and maps the service's typed result onto HTTP (the mapping is
// documented on CheckoutResult in shared/api-types.ts).
commerceRouter.post("/checkout", async (c) => {
  noStore(c);
  const db = c.get("db");

  const rl = await enforceRateLimit(db, { ...CHECKOUT_RATE_LIMIT, key: clientIp(c.req.raw) });
  if (!rl.allowed) return rateLimited(c, rl.retryAfterSeconds);

  const body = (await c.req.json().catch(() => ({}))) as CheckoutInput;

  // Optional Idempotency-Key, stored as ONE opaque column: sha256(key \n email \n canonical
  // body). DOCUMENTED DIVERGENCE from the plan text ("payload mismatch → 409"): with the full
  // triple hashed into a single value, a reused key with a DIFFERENT payload simply produces a
  // DIFFERENT hash and therefore a NEW order — no 409 is ever raised. The hardening's actual
  // point is fully preserved: a bare key can never resolve to another buyer's order, because
  // the buyer's email + exact payload are baked into the identity. A client that reuses a key
  // across different carts has a client bug; it gets a separate order, never someone else's.
  let idempotencyKeyHash: string | undefined;
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (idempotencyKey) {
    const email = typeof body.email === "string" ? body.email.trim() : "";
    idempotencyKeyHash = await sha256Hex(`${idempotencyKey}\n${email}\n${canonicalJSON(body)}`);
  }

  const result = await createCheckout(db, c.env, { ...body, idempotencyKeyHash });

  switch (result.kind) {
    case "validation_error":
      return c.json(
        {
          error: {
            code: "validation_error",
            message: result.message,
            fieldErrors: result.fieldErrors,
            itemErrors: result.itemErrors,
          },
        } satisfies CheckoutValidationErrorBody,
        400,
      );
    case "payments_unavailable":
      return c.json(
        {
          error: {
            code: "payments_unavailable",
            message: "Online payments are not available right now. Try again later.",
          },
        } satisfies ApiErrorBody,
        503,
      );
    case "replay":
      // 200 with the body shaped like the ORIGINAL outcome (the service derives it from
      // order.status; failed orders carry their original decline as `error`).
      return c.json(toCheckoutBody(result.order, result.error), 200);
    case "pending":
      return c.json(toCheckoutBody(result.order), 201);
    case "paid":
      // `transitioned` is route-internal: fire the order hook EXACTLY once — only when THIS
      // request performed the paid transition (false = a concurrent webhook won the race and
      // the webhook route already fired it). Deliberately omitted from the wire body.
      if (result.transitioned) fireOrderHook(c, result.order.id);
      return c.json(toCheckoutBody(result.order), 201);
    case "payment_failed":
      return c.json(toCheckoutBody(result.order, result.error), 402);
    case "payment_pending":
      return c.json(toCheckoutBody(result.order), 202);
    default:
      return assertNever(result);
  }
});

// The buyer's order-status view, gated solely by the unguessable accessToken from checkout.
// A missing/wrong token behaves EXACTLY like an unknown id (404), so the endpoint leaks
// nothing about which order ids exist. Limited DTO — no PII echo (the link may be forwarded).
commerceRouter.get("/orders/:id", async (c) => {
  noStore(c);
  const order = await getPublicOrder(c.get("db"), c.req.param("id"), c.req.query("token") ?? "");
  return c.json({ order } satisfies PublicOrderResponse);
});
