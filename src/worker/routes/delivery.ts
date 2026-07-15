import { Hono } from "hono";
import { cors } from "hono/cors";

import type { AppEnv } from "../lib/app";
import { badRequest, notFound, payloadTooLarge } from "../lib/errors";
import { submitContactForm } from "../services/contact-forms";
import { getContentLocales, isFormsEnabled } from "../services/settings";
import {
  getContentItem,
  getPublicSchema,
  getSingletonContent,
  loadDeliveryCollection,
  queryCollectionContent,
  type RawFilter,
} from "../services/delivery";

import { MAX_DELIVERY_LIMIT } from "@/shared/constants";
import type { LocaleConfig } from "@/shared/localization";

// Public delivery API at /api/v1/*. CORS open to any origin (read-only verbs); serves
// published content with ETag / Cache-Control so CDNs and clients can cache + revalidate.
export const deliveryRouter = new Hono<AppEnv>();

const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

deliveryRouter.use(
  "*",
  cors({ origin: "*", allowMethods: ["GET", "HEAD", "POST", "OPTIONS"], maxAge: 86400 }),
);

/** True when the client's If-None-Match covers our ETag (honor `*` and comma lists). */
function notModified(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || t === etag);
}

function parseFilters(url: URL): RawFilter[] {
  const filters: RawFilter[] = [];
  for (const [key, value] of url.searchParams) {
    const match = key.match(/^filter\[([^\]]+)\]\[([^\]]+)\]$/);
    if (match) filters.push({ field: match[1], op: match[2], value });
  }
  return filters;
}

function parseInt0(value: string | null, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Resolve `?locale=` against the configured locales; an unknown or absent value falls back to
 * the default locale. Locale is read from the URL ONLY — never the `Accept-Language` header:
 * delivery bodies are cacheable (`max-age=60`), so a header-driven language switch would let an
 * edge serve whichever language cached first to every client (cross-locale cache poisoning).
 * `?locale=es` and `?locale=en` are distinct URLs, so they cache independently and safely.
 */
function resolveLocale(url: URL, config: LocaleConfig): string {
  const requested = url.searchParams.get("locale");
  return requested && config.locales.includes(requested) ? requested : config.default;
}

// Public schema (collections + field defs) for typed clients, plus the deployment's content
// locales + default so a typed client knows which `?locale=` values are valid.
deliveryRouter.get("/collections", async (c) => {
  const db = c.get("db");
  const schema = await getPublicSchema(db, await getContentLocales(db));
  c.header("Cache-Control", CACHE_CONTROL);
  return c.json(schema);
});

// Collection → paginated list; singleton → the single published object.
deliveryRouter.get("/content/:slug", async (c) => {
  const db = c.get("db");
  const loaded = await loadDeliveryCollection(db, c.req.param("slug"));
  const config = await getContentLocales(db);
  const url = new URL(c.req.url);
  const locale = resolveLocale(url, config);

  if (loaded.collection.type === "singleton") {
    const { data, etag } = await getSingletonContent(db, c.get("origin"), loaded, locale, config);
    c.header("ETag", etag);
    c.header("Cache-Control", CACHE_CONTROL);
    if (notModified(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
    return c.json({ data });
  }

  const limit = Math.min(Math.max(parseInt0(url.searchParams.get("limit"), 20), 1), MAX_DELIVERY_LIMIT);
  const offset = Math.max(parseInt0(url.searchParams.get("offset"), 0), 0);
  const { response, etag } = await queryCollectionContent(
    db,
    c.get("origin"),
    loaded,
    {
      limit,
      offset,
      sort: url.searchParams.get("sort") ?? undefined,
      filters: parseFilters(url),
      locale,
    },
    config,
  );
  c.header("ETag", etag);
  c.header("Cache-Control", CACHE_CONTROL);
  if (notModified(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  return c.json(response);
});

// A single published entry by id or slug.
deliveryRouter.get("/content/:slug/:idOrSlug", async (c) => {
  const db = c.get("db");
  const loaded = await loadDeliveryCollection(db, c.req.param("slug"));
  const config = await getContentLocales(db);
  const locale = resolveLocale(new URL(c.req.url), config);
  const { data, etag } = await getContentItem(
    db,
    c.get("origin"),
    loaded,
    c.req.param("idOrSlug"),
    locale,
    config,
  );
  c.header("ETag", etag);
  c.header("Cache-Control", CACHE_CONTROL);
  if (notModified(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  return c.json({ data });
});

// Public write-only contact form endpoint. The public key is intended for frontend code;
// server-side validation strips unknown fields and rate-limits by form + hashed client IP.
deliveryRouter.post("/contact-forms/:publicKey/submissions", async (c) => {
  // Module gate: when the Forms module is off, submissions 404 as if the endpoint doesn't
  // exist (mirrors the Store module's public catalog gate in commerce.ts).
  if (!(await isFormsEnabled(c.get("db")))) {
    throw notFound("The Forms module is not enabled");
  }
  const contentLength = Number(c.req.header("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    throw payloadTooLarge("Submission is too large");
  }
  const body = (await c.req.json().catch(() => undefined)) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("Submission body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const rawData =
    typeof record.data === "object" && record.data !== null && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : record;
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const clientIp = c.req.header("cf-connecting-ip") ?? forwarded ?? "unknown";
  const result = await submitContactForm(
    c.get("db"),
    c.req.param("publicKey"),
    rawData,
    clientIp,
    c.req.header("user-agent") ?? null,
  );
  return c.json({ ok: true, submissionId: result.submissionId }, 201);
});
