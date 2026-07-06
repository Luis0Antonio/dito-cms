import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";

import type { AppEnv } from "../lib/app";
import { hashString } from "../lib/hash";
import { notFound } from "../lib/errors";
import { isCommerceEnabled } from "../services/settings";
import {
  getCatalogProduct,
  listCatalogCategories,
  listCatalogProducts,
} from "../services/store/products";

import { MAX_DELIVERY_LIMIT } from "@/shared/constants";

// Public catalog (delivery) API at /api/commerce/*. Read-only, CORS-open for storefronts,
// and cacheable (ETag + short Cache-Control). Gated by the `commerce_enabled` setting — when
// the Store module is off, every route 404s. Serves only `active` products.
export const commerceRouter = new Hono<AppEnv>();

const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

commerceRouter.use("*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], maxAge: 86400 }));

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
