import {
  sqliteTable,
  text,
  integer,
  real,
  check,
  index,
  uniqueIndex,
  primaryKey,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

import { user } from "./auth-schema";

// Application schema. Better Auth tables live in ./auth-schema.ts (generated).
// The user's data model is metadata (collections + fields); entry content is JSON
// in `entries`. No dynamic DDL ever. Timestamps = INTEGER epoch ms.

/** Simple key/value store. v1 use: auto-generated auth_secret fallback + project name. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type SettingRow = typeof settings.$inferSelect;

/**
 * A content type the user defines. `collection` holds many entries; `singleton`
 * holds exactly one. `slug` and `type` are immutable after create (renaming breaks
 * consumers and would require JSON rewrites). `content_version` is bumped on
 * publish/unpublish/delete (Phase 3) for cheap list ETags.
 */
export const collections = sqliteTable(
  "collections",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type", { enum: ["collection", "singleton"] }).notNull(),
    /** Field name used as the list title; nullable until the user picks one. */
    titleField: text("title_field"),
    contentVersion: integer("content_version").notNull().default(0),
    sortOrder: real("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("collections_slug_unq").on(t.slug),
    index("collections_sort_idx").on(t.sortOrder),
    check("collections_type_chk", sql`${t.type} in ('collection', 'singleton')`),
  ],
);

export type CollectionRow = typeof collections.$inferSelect;

/**
 * One field on a collection. `name` is the API key (camelCase, immutable after
 * create). `type` is one of the 8 field types and is immutable too (delete + re-add
 * to change). `options` is per-type JSON, validated server-side via field-types.ts.
 */
export const fields = sqliteTable(
  "fields",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    label: text("label").notNull(),
    type: text("type", {
      enum: ["text", "rich_text", "number", "boolean", "picture", "video", "link", "reference"],
    }).notNull(),
    /** Per-type options, JSON-encoded. `{}` when no options set. */
    options: text("options").notNull().default("{}"),
    sortOrder: real("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("fields_collection_name_unq").on(t.collectionId, t.name),
    index("fields_collection_sort_idx").on(t.collectionId, t.sortOrder),
    check(
      "fields_type_chk",
      sql`${t.type} in ('text', 'rich_text', 'number', 'boolean', 'picture', 'video', 'link', 'reference')`,
    ),
  ],
);

export type FieldRow = typeof fields.$inferSelect;

/**
 * A content entry. `draft_data` / `published_data` are JSON blobs of field values
 * keyed by field name. Status is DERIVED, never stored:
 *   - published_data IS NULL                  → draft
 *   - draft_updated_at > published_at         → published, with pending changes
 *   - else                                    → published (clean)
 * `slug` is optional; when set it's unique within (collection, locale). `locale` is
 * reserved for future i18n (always '' in v1). `sort_order`: append = max+1024,
 * reorder rewrites to index×1024. `published_etag` is a content hash set at publish.
 */
export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    slug: text("slug"),
    locale: text("locale").notNull().default(""),
    draftData: text("draft_data").notNull().default("{}"),
    publishedData: text("published_data"),
    publishedEtag: text("published_etag"),
    sortOrder: real("sort_order").notNull().default(0),
    draftUpdatedAt: integer("draft_updated_at").notNull(),
    publishedAt: integer("published_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("entries_collection_slug_unq")
      .on(t.collectionId, t.locale, t.slug)
      .where(sql`${t.slug} IS NOT NULL`),
    index("entries_collection_sort_idx").on(t.collectionId, t.sortOrder),
    index("entries_published_sort_idx")
      .on(t.collectionId, t.sortOrder)
      .where(sql`${t.publishedData} IS NOT NULL`),
  ],
);

export type EntryRow = typeof entries.$inferSelect;

/**
 * An uploaded asset, stored on either Cloudflare R2 (default) or Cloudinary — selected at
 * deploy time by the presence of credentials (see services/storage). `provider` records
 * which backend owns this object so existing rows keep resolving after a switch.
 *
 * `r2_key` is the generic storage-key slot: the R2 object key `media/<id>/<filename>` for
 * R2, or the Cloudinary `public_id` for Cloudinary. `url` is null for R2 (served from our
 * own origin at `GET /media/:id/:filename`, immutable cache because the key never changes)
 * and holds Cloudinary's absolute `secure_url` for Cloudinary (served from its CDN).
 *
 * `status` is `uploading` while a multipart/chunked video upload is in flight (`upload_id`
 * holds the R2 multipart id or the Cloudinary X-Unique-Upload-Id) and flips to `ready` on
 * completion; direct image uploads land `ready`. `width`/`height` (images + videos) and
 * `duration` (videos) are captured client-side for R2, or from Cloudinary's upload response.
 */
export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["image", "video"] }).notNull(),
    filename: text("filename").notNull(),
    /** Storage-key slot: R2 object key `media/<id>/<filename>`, or the Cloudinary public_id. */
    r2Key: text("r2_key").notNull(),
    /** Storage backend that owns this object. */
    provider: text("provider", { enum: ["r2", "cloudinary"] }).notNull().default("r2"),
    /** Absolute delivery URL for Cloudinary (secure_url); null for R2 (served from our origin). */
    url: text("url"),
    mime: text("mime").notNull(),
    size: integer("size").notNull().default(0),
    width: integer("width"),
    height: integer("height"),
    /** Video duration in seconds (may be fractional). */
    duration: real("duration"),
    alt: text("alt"),
    status: text("status", { enum: ["uploading", "ready"] }).notNull().default("ready"),
    /** Multipart upload id while a video upload is in flight; null once ready. */
    uploadId: text("upload_id"),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("media_r2_key_unq").on(t.r2Key),
    index("media_created_idx").on(t.createdAt),
    index("media_kind_idx").on(t.kind),
    check("media_kind_chk", sql`${t.kind} in ('image', 'video')`),
    check("media_status_chk", sql`${t.status} in ('uploading', 'ready')`),
  ],
);

export type MediaRow = typeof media.$inferSelect;

/**
 * Append-only-ish activity log for the deploy hook: one row per actual HTTP delivery
 * attempt (auto-fire on a published-content change, or a manual "send test"). `event`
 * is the trigger (e.g. `entry.publish`, `collection.delete`, `test`); `detail` is an
 * optional human reference (collection slug, entry slug). `url` is the MASKED hook URL —
 * the raw URL is a secret and is never copied here. `ok`/`status`/`error` capture the
 * response. Pruned to the most recent rows on insert (services/deploy-hook.ts).
 */
export const deployHookDeliveries = sqliteTable(
  "deploy_hook_deliveries",
  {
    id: text("id").primaryKey(),
    firedAt: integer("fired_at").notNull(),
    event: text("event").notNull(),
    detail: text("detail"),
    /** Masked hook URL (`scheme://host/…/<last4>`); never the raw secret URL. */
    url: text("url").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    /** HTTP status of the response, or null on a network error / timeout. */
    status: integer("status"),
    error: text("error"),
  },
  (t) => [index("deploy_hook_deliveries_fired_idx").on(t.firedAt)],
);

export type DeployHookDeliveryRow = typeof deployHookDeliveries.$inferSelect;

// =============================================================================
// Commerce (optional Store module) — Phase 1: catalog.
// Gated entirely by the `commerce_enabled` setting; content-only instances never
// touch these tables. Unlike content (collections + JSON entries), commerce uses
// solid relational columns. Money is an INTEGER in minor units; the store currency
// lives in settings. The model leaves room for variants (a later phase).
// =============================================================================

/**
 * A product category. Self-referential `parentId` allows a shallow tree (a parent
 * delete nulls children's parent, never cascades them away). `slug` is unique and
 * used in catalog URLs.
 */
export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    parentId: text("parent_id").references((): AnySQLiteColumn => categories.id, {
      onDelete: "set null",
    }),
    sortOrder: real("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("categories_slug_unq").on(t.slug),
    index("categories_parent_idx").on(t.parentId),
    index("categories_sort_idx").on(t.sortOrder),
  ],
);

export type CategoryRow = typeof categories.$inferSelect;

/**
 * The shared product schema: one set of custom fields applied to ALL products (no
 * per-type schemas). Mirrors the `fields` table but with no collectionId — `name`
 * is globally unique. Product `customData` is validated against these via the same
 * field system used for entry content.
 */
export const productFields = sqliteTable(
  "product_fields",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    label: text("label").notNull(),
    type: text("type", {
      enum: ["text", "rich_text", "number", "boolean", "picture", "video", "link"],
    }).notNull(),
    options: text("options").notNull().default("{}"),
    sortOrder: real("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("product_fields_name_unq").on(t.name),
    index("product_fields_sort_idx").on(t.sortOrder),
    check(
      "product_fields_type_chk",
      sql`${t.type} in ('text', 'rich_text', 'number', 'boolean', 'picture', 'video', 'link')`,
    ),
  ],
);

export type ProductFieldRow = typeof productFields.$inferSelect;

/**
 * A simple product: solid core columns plus a shared custom-field layer (`customData`,
 * validated against `product_fields`). `priceAmount` is an integer in the store's
 * minor currency units. `sku` is optional but unique when present. `stock` null means
 * stock is untracked. `status` drives delivery: only `active` products are served by
 * the public catalog. One SKU/price/stock per product for now; variants come later.
 */
export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["draft", "active", "archived"] })
      .notNull()
      .default("draft"),
    /** Price in minor currency units (e.g. cents). Integer to avoid float drift. */
    priceAmount: integer("price_amount").notNull().default(0),
    sku: text("sku"),
    /** Units in stock; null = untracked (always available). */
    stock: integer("stock"),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    /** Custom-field values keyed by product_fields.name. JSON `{}` when none. */
    customData: text("custom_data").notNull().default("{}"),
    sortOrder: real("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("products_slug_unq").on(t.slug),
    uniqueIndex("products_sku_unq").on(t.sku).where(sql`${t.sku} IS NOT NULL`),
    index("products_status_sort_idx").on(t.status, t.sortOrder),
    index("products_category_idx").on(t.categoryId),
    check("products_status_chk", sql`${t.status} in ('draft', 'active', 'archived')`),
  ],
);

export type ProductRow = typeof products.$inferSelect;

/**
 * Ordered image gallery for a product, reusing the `media` table. Composite key
 * (productId, mediaId) prevents the same asset being attached twice. Both sides
 * cascade: deleting a product or the underlying media drops the link.
 */
export const productImages = sqliteTable(
  "product_images",
  {
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    sortOrder: real("sort_order").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.mediaId] }),
    index("product_images_product_sort_idx").on(t.productId, t.sortOrder),
  ],
);

export type ProductImageRow = typeof productImages.$inferSelect;

// =============================================================================
// Commerce (optional Store module) — Phase 2: orders, payments, checkout.
// Still gated by `commerce_enabled`. Orders are immutable financial records:
// prices, names and images are SNAPSHOTTED onto order_items at purchase time so
// they survive product/media edits and deletions. Money stays an INTEGER in the
// store's minor currency units. Buyer-facing status is served live; a sale
// changes what the catalog API answers, never triggers a deploy/rebuild.
// =============================================================================

/**
 * A placed order — an immutable financial record once created. `number` is a
 * human-facing sequential id allocated from `counters` (first order is #1);
 * `accessToken` is a nanoid(24) unguessable secret the buyer uses to read their
 * order status without auth (`GET /orders/:id?token=`). `status` walks:
 *   pending → awaiting_payment → paid → fulfilled
 * with `cancelled`/`failed`/`refunded` as terminal off-ramps. `failed` is terminal
 * — a buyer retry is a brand-new checkout (an unpaid order holds no stock).
 * `shippingAddress` is nullable JSON. All amounts are integer minor units and are
 * priced server-side from the DB, never from the client. `stockConflict` (bool as
 * 0/1) flags a paid order whose stock decrement could not be applied — money moved
 * but inventory went negative, so the merchant must resolve it manually.
 * `idempotencyKey` is a hash(key + email + payload) that dedupes replayed
 * checkouts; unique only when present (a bare key can never map to another buyer's
 * order). `paidAt`/`fulfilledAt`/`cancelledAt` stamp the terminal transitions.
 */
export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    /** Sequential human-facing order number, allocated from `counters`. First is 1. */
    number: integer("number").notNull(),
    /** Unguessable nanoid(24) secret for the public status endpoint; not auth. */
    accessToken: text("access_token").notNull(),
    status: text("status", {
      enum: [
        "pending",
        "awaiting_payment",
        "paid",
        "fulfilled",
        "cancelled",
        "failed",
        "refunded",
      ],
    })
      .notNull()
      .default("pending"),
    email: text("email").notNull(),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    /** Shipping address as JSON; nullable (digital goods / pickup). */
    shippingAddress: text("shipping_address"),
    note: text("note"),
    /** ISO currency code, snapshotted from settings at checkout time. */
    currency: text("currency").notNull(),
    /** Sum of item totals, minor units. */
    subtotalAmount: integer("subtotal_amount").notNull(),
    /** Shipping cost, minor units. */
    shippingAmount: integer("shipping_amount").notNull().default(0),
    /** subtotal + shipping, minor units. */
    totalAmount: integer("total_amount").notNull(),
    /** Bool as 0/1: paid order whose stock decrement failed — merchant resolves. */
    stockConflict: integer("stock_conflict").notNull().default(0),
    /** hash(idempotency-key + email + payload); unique when present, dedupes replays. */
    idempotencyKey: text("idempotency_key"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    paidAt: integer("paid_at"),
    fulfilledAt: integer("fulfilled_at"),
    cancelledAt: integer("cancelled_at"),
  },
  (t) => [
    uniqueIndex("orders_number_unq").on(t.number),
    uniqueIndex("orders_idempotency_key_unq")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index("orders_status_created_idx").on(t.status, t.createdAt),
    index("orders_email_idx").on(t.email),
    index("orders_created_idx").on(t.createdAt),
    check(
      "orders_status_chk",
      sql`${t.status} in ('pending', 'awaiting_payment', 'paid', 'fulfilled', 'cancelled', 'failed', 'refunded')`,
    ),
  ],
);

export type OrderRow = typeof orders.$inferSelect;

/**
 * A single line on an order — a full price/name/image SNAPSHOT taken at checkout,
 * intentionally decoupled from the live product. `productId` references `products`
 * with SET NULL (not cascade): deleting a product must NOT erase historical order
 * lines. `orderId` cascades — deleting an order drops its items. `name`, `sku` and
 * `unitAmount` are frozen copies (`unitAmount` = per-unit price in minor units at
 * purchase time). `quantity` is > 0. `totalAmount` = unitAmount × quantity.
 * `imageMediaId` references `media` with SET NULL so the snapshot survives media
 * deletion (deliberately different from product_images, which cascades).
 */
export const orderItems = sqliteTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Nullable: product may be deleted after purchase; the snapshot below survives. */
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    /** Snapshot of product name at purchase time. */
    name: text("name").notNull(),
    /** Snapshot of product SKU at purchase time; nullable. */
    sku: text("sku"),
    /** Snapshot of per-unit price in minor units at purchase time. */
    unitAmount: integer("unit_amount").notNull(),
    quantity: integer("quantity").notNull(),
    /** unitAmount × quantity, minor units. */
    totalAmount: integer("total_amount").notNull(),
    /** Snapshot image; SET NULL on media delete so the line survives (unlike product_images). */
    imageMediaId: text("image_media_id").references(() => media.id, { onDelete: "set null" }),
  },
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    check("order_items_quantity_chk", sql`${t.quantity} > 0`),
  ],
);

export type OrderItemRow = typeof orderItems.$inferSelect;

/**
 * A payment attempt against an order. A `created` intent row is written BEFORE the
 * gateway call so a crash between charge success and the paid transition is
 * webhook-recoverable via the provider's charge id. `provider` is the driver name
 * (e.g. `culqi`); `providerRef` is the gateway charge id, nullable until the charge
 * exists. `status` walks created → paid | failed | refunded. `raw` is the redacted
 * gateway response JSON (never store card data or secrets). `orderId` cascades with
 * the order. The partial unique on (provider, providerRef) makes a given gateway
 * charge idempotent here while allowing many `created` intents with no ref yet.
 */
export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Payment driver name, e.g. `culqi`. */
    provider: text("provider").notNull(),
    /** Gateway charge id; null until the charge is created. */
    providerRef: text("provider_ref"),
    status: text("status", { enum: ["created", "paid", "failed", "refunded"] }).notNull(),
    /** Charged amount in minor units. */
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** Redacted gateway response JSON; never secrets or card data. Nullable. */
    raw: text("raw"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("payments_provider_ref_unq")
      .on(t.provider, t.providerRef)
      .where(sql`${t.providerRef} IS NOT NULL`),
    index("payments_order_idx").on(t.orderId),
    check(
      "payments_status_chk",
      sql`${t.status} in ('created', 'paid', 'failed', 'refunded')`,
    ),
  ],
);

export type PaymentRow = typeof payments.$inferSelect;

/**
 * A raw inbound webhook event from a payment provider, stored for idempotency and
 * audit. Providers have no webhook signatures (Culqi confirmed) so events are
 * untrusted hints: the driver re-fetches the charge before acting. The unique
 * (provider, eventId) makes redelivery a no-op (insert-or-ignore → exactly one
 * transition). `orderId` is deliberately a plain nullable text column with NO FK
 * constraint: a real charge whose order we don't recognise is still recorded (with
 * null orderId) and surfaced for merchant review rather than rejected. `payload` is
 * the received event JSON; `processedAt` stamps when we handled it.
 */
export const paymentEvents = sqliteTable(
  "payment_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    /** Provider's event id; unique per provider for webhook dedupe. */
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    /** Nullable, intentionally NO FK: unknown-order events are kept for review. */
    orderId: text("order_id"),
    /** Received event JSON. */
    payload: text("payload"),
    processedAt: integer("processed_at").notNull(),
  },
  (t) => [uniqueIndex("payment_events_provider_event_unq").on(t.provider, t.eventId)],
);

export type PaymentEventRow = typeof paymentEvents.$inferSelect;

/**
 * Named monotonic counters. v1 use: `order_number`, seeded to 0 by the migration so
 * the first allocation yields #1. Allocation is atomic in a later phase via
 * `UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value` (D1
 * supports RETURNING).
 */
export const counters = sqliteTable("counters", {
  name: text("name").primaryKey(),
  value: integer("value").notNull(),
});

export type CounterRow = typeof counters.$inferSelect;

/**
 * D1-based fixed-window rate limiting for the public checkout route (no KV/DO in
 * this deployment). `key` is an ip+window bucket; `count` is the hits so far in the
 * window; `expiresAt` is the window end (epoch ms). Rows are cleaned up
 * opportunistically on write.
 */
export const checkoutHits = sqliteTable("checkout_hits", {
  /** Bucket key: client ip + time window. */
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  /** Window expiry, epoch ms; expired rows are swept on write. */
  expiresAt: integer("expires_at").notNull(),
});

export type CheckoutHitRow = typeof checkoutHits.$inferSelect;

/**
 * Activity log for the ORDER hook (merchant order-paid notifications) — a column-for-column
 * mirror of `deploy_hook_deliveries`: one row per actual HTTP delivery attempt, masked URL
 * only, pruned to the most recent rows on insert (services/store/order-hook.ts). Kept as a
 * separate table (not shared with the deploy log) because the two hooks are unrelated
 * systems: rebuild triggers vs. commerce notifications, gated and configured independently.
 */
export const orderHookDeliveries = sqliteTable(
  "order_hook_deliveries",
  {
    id: text("id").primaryKey(),
    firedAt: integer("fired_at").notNull(),
    /** Trigger event: `order.paid` (or `test` from the settings page, phase 2F). */
    event: text("event").notNull(),
    /** Optional human reference — the order number, e.g. `#42`. */
    detail: text("detail"),
    /** Masked hook URL (`scheme://host/…/<last4>`); never the raw URL. */
    url: text("url").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    /** HTTP status of the response, or null on a network error / timeout. */
    status: integer("status"),
    error: text("error"),
  },
  (t) => [index("order_hook_deliveries_fired_idx").on(t.firedAt)],
);

export type OrderHookDeliveryRow = typeof orderHookDeliveries.$inferSelect;

// Contact forms expose a public write-only endpoint. `public_key` is safe to embed in
// frontend code; admin APIs use the internal id. Rate limiting is per form + hashed
// client IP over a configurable rolling window.
export const contactForms = sqliteTable(
  "contact_forms",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    publicKey: text("public_key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    rateLimitMax: integer("rate_limit_max").notNull().default(5),
    rateLimitWindowSeconds: integer("rate_limit_window_seconds").notNull().default(60),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("contact_forms_public_key_unq").on(t.publicKey),
    index("contact_forms_created_idx").on(t.createdAt),
    check("contact_forms_rate_max_chk", sql`${t.rateLimitMax} between 1 and 1000`),
    check("contact_forms_rate_window_chk", sql`${t.rateLimitWindowSeconds} between 10 and 86400`),
  ],
);

export type ContactFormRow = typeof contactForms.$inferSelect;

export const contactFormFields = sqliteTable(
  "contact_form_fields",
  {
    id: text("id").primaryKey(),
    formId: text("form_id")
      .notNull()
      .references(() => contactForms.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    label: text("label").notNull(),
    type: text("type", {
      enum: ["text", "email", "textarea", "number", "checkbox", "select"],
    }).notNull(),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    options: text("options").notNull().default("{}"),
    sortOrder: real("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("contact_form_fields_form_name_unq").on(t.formId, t.name),
    index("contact_form_fields_sort_idx").on(t.formId, t.sortOrder),
    check(
      "contact_form_fields_type_chk",
      sql`${t.type} in ('text', 'email', 'textarea', 'number', 'checkbox', 'select')`,
    ),
  ],
);

export type ContactFormFieldRow = typeof contactFormFields.$inferSelect;

export const contactFormSubmissions = sqliteTable(
  "contact_form_submissions",
  {
    id: text("id").primaryKey(),
    formId: text("form_id")
      .notNull()
      .references(() => contactForms.id, { onDelete: "cascade" }),
    data: text("data").notNull(),
    ipHash: text("ip_hash").notNull(),
    userAgent: text("user_agent"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("contact_form_submissions_form_created_idx").on(t.formId, t.createdAt),
    index("contact_form_submissions_rate_idx").on(t.formId, t.ipHash, t.createdAt),
  ],
);

export type ContactFormSubmissionRow = typeof contactFormSubmissions.$inferSelect;
