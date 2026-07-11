// Isomorphic API contract shared by the worker and the SPA.
// No React, no Hono, no worker imports allowed here.

import type { FieldType, FieldOptions } from "./field-types";

/** Canonical error envelope returned by every API route on failure. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Per-field validation messages, keyed by field name → mapped into RHF setError. */
    fieldErrors?: Record<string, string>;
  };
}

export type ApiErrorCode =
  | "bad_request"
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  /** 503 from checkout: a paymentToken was sent but no payment gateway is configured+enabled. */
  | "payments_unavailable"
  | "internal_error";

/** Health/setup status returned by the public bootstrap endpoints. */
export interface SetupStatus {
  /** True once at least one user exists (setup complete; signup disabled). */
  initialized: boolean;
}

export interface HealthStatus {
  ok: true;
  name: string;
  version: string;
}

/** Editable instance settings shown on the General settings page. */
export interface ProjectSettings {
  projectName: string;
  /**
   * Optional company/brand logo shown in the sidebar, stored as a self-contained data URL
   * (`data:image/…;base64,…`) or an `http(s)` URL. Null when no logo has been set.
   */
  logo: string | null;
  /**
   * Whether the optional Store (commerce) module is enabled. OFF by default. Gates the
   * store admin routes, MCP store tools and the SPA store nav/routes. Content-only
   * instances leave this off and are entirely unaffected.
   */
  commerceEnabled: boolean;
}

// --- Deploy hook -------------------------------------------------------------

/**
 * Redacted deploy-hook view returned by GET/PATCH. The hook URL and auth header value
 * are treated as secrets (the URL embeds the credential, per the Cloudflare deploy-hook
 * contract) and are NEVER returned to the browser — only a masked preview is exposed.
 */
export interface DeployHookSettings {
  /** Whether the hook fires automatically on published-content changes. */
  enabled: boolean;
  /** True once a hook URL has been stored. */
  configured: boolean;
  /** Masked preview of the stored URL (`scheme://host/…/<last4>`); empty when not configured. */
  urlPreview: string;
  /** True when a complete optional auth header (name + value) is stored. */
  hasAuthHeader: boolean;
  /** The auth header name (safe to show); the value is never returned. */
  authHeaderName: string | null;
  /** Epoch ms of the last delivery attempt, or null if never fired. */
  lastFiredAt: number | null;
  /** Outcome of the last attempt (null if never fired). */
  lastOk: boolean | null;
  /** HTTP status of the last attempt, or null (network error / never fired). */
  lastStatus: number | null;
  /** Error message from the last attempt, if it failed. */
  lastError: string | null;
}

/**
 * PATCH body for the deploy hook. PATCH semantics: an omitted field is left unchanged
 * (so `enabled` can toggle without resending the secret). An empty-string `url` clears
 * the whole config. `authHeaderValue` is write-only — send it only to set a new value.
 */
export interface UpdateDeployHookInput {
  url?: string;
  enabled?: boolean;
  authHeaderName?: string | null;
  authHeaderValue?: string | null;
}

/** Result of POST /test (and the shape used internally for the last-delivery record). */
export interface DeployHookTestResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

/**
 * One row of the deploy-hook activity log (a single HTTP delivery attempt). Returned by
 * GET /api/admin/deploy-hook/deliveries, newest first. `urlPreview` is the masked URL —
 * the raw secret URL is never logged or returned.
 */
export interface DeployHookDelivery {
  id: string;
  /** Epoch ms of the attempt. */
  firedAt: number;
  /** Trigger event, e.g. `entry.publish`, `entry.reorder`, `collection.delete`, `test`. */
  event: string;
  /** Optional human reference for the change (collection or entry slug); null if none. */
  detail: string | null;
  /** Masked URL that was hit (`scheme://host/…/<last4>`). */
  urlPreview: string;
  ok: boolean;
  /** HTTP status, or null on a network error / timeout. */
  status: number | null;
  error: string | null;
}

export interface DeployHookActivity {
  deliveries: DeployHookDelivery[];
}

// --- Store settings (commerce module) ---------------------------------------
// All store settings live behind the `commerce_enabled` gate at the route/MCP level. These
// DTOs are the REDACTED, admin-facing shapes: payment/webhook secrets are write-only and
// never travel back to the browser — only whether they are configured is reported.

/**
 * Redacted Culqi gateway config for admin GET/PATCH. The public key is safe to show; the
 * secret key is write-only — the browser only learns whether one is stored (`secretKeyConfigured`).
 */
export interface CulqiSettings {
  /** Whether Culqi is enabled as the checkout gateway. */
  enabled: boolean;
  /** The Culqi publishable key (`pk_test_…` / `pk_live_…`), safe to display; empty when unset. */
  publicKey: string;
  /** True once a Culqi secret key has been stored (encrypted at rest). The value is never returned. */
  secretKeyConfigured: boolean;
}

/**
 * PATCH body for the Culqi config. PATCH semantics mirror the deploy hook: an omitted field is
 * left unchanged (so `enabled` can toggle without resending the secret key). `secretKey` is
 * write-only — send it only to set a new value; an empty-string value clears it.
 */
export interface UpdateCulqiInput {
  enabled?: boolean;
  publicKey?: string;
  secretKey?: string;
}

/**
 * Redacted order-hook view for admin GET/PATCH. Same shape/semantics as the deploy hook's
 * config (single URL + optional auth header), minus the delivery-log fields — firing and its
 * activity log land in a later phase. The URL and auth header value are treated as secrets and
 * never returned; only a masked URL preview and the (safe) header name are exposed.
 */
export interface OrderHookSettings {
  /** Whether the hook fires automatically when an order is paid. */
  enabled: boolean;
  /** True once a hook URL has been stored. */
  configured: boolean;
  /** Masked preview of the stored URL (`scheme://host/…/<last4>`); empty when not configured. */
  urlPreview: string;
  /** True when a complete optional auth header (name + value) is stored. */
  hasAuthHeader: boolean;
  /** The auth header name (safe to show); the value is never returned. */
  authHeaderName: string | null;
}

/**
 * PATCH body for the order hook. PATCH semantics as the deploy hook: an omitted field is left
 * unchanged; an empty-string `url` clears the whole config; `authHeaderValue` is write-only.
 */
export interface UpdateOrderHookInput {
  url?: string;
  enabled?: boolean;
  authHeaderName?: string | null;
  authHeaderValue?: string | null;
}

/** The full redacted store-settings bundle returned by the admin store-settings endpoint. */
export interface StoreSettings {
  /** ISO 4217 currency code used for new orders (default `PEN`). */
  currency: string;
  culqi: CulqiSettings;
  orderHook: OrderHookSettings;
}

// --- Collections & fields (Phase 2) -----------------------------------------

export type CollectionType = "collection" | "singleton";

/** A field definition as returned by the admin API. */
export interface FieldDTO {
  id: string;
  name: string;
  label: string;
  type: FieldType;
  options: FieldOptions;
  sortOrder: number;
}

/** A collection in the list view (no fields, with a derived entry count). */
export interface CollectionSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: CollectionType;
  titleField: string | null;
  fieldCount: number;
  /** Number of entries; always 0 until the entries table lands (Phase 3). */
  entryCount: number;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** A single collection with its ordered fields. */
export interface CollectionDetail extends Omit<CollectionSummary, "fieldCount"> {
  fields: FieldDTO[];
}

/** Request body for declarative full-state field replacement. */
export interface SetFieldsInput {
  fields: Array<{
    name: string;
    label: string;
    type: FieldType;
    options?: FieldOptions;
  }>;
  /** Required to permit field removals or (rejected) type changes. */
  allowDestructive?: boolean;
}

/** Result of a declarative field replacement: what changed, by field name. */
export interface SetFieldsResult {
  added: string[];
  updated: string[];
  removed: string[];
}

// --- Entries (Phase 3) -------------------------------------------------------

/**
 * Derived publication state of an entry (never stored):
 *  - `draft`     — never published.
 *  - `published` — published, draft matches the published version.
 *  - `changed`   — published, but the draft has unpublished edits ("pending").
 */
export type EntryStatus = "draft" | "published" | "changed";

/** Field values keyed by field name. */
export type EntryData = Record<string, unknown>;

/** An entry as shown in the admin list view (compact, with a title preview). */
export interface EntrySummary {
  id: string;
  slug: string | null;
  status: EntryStatus;
  /** Preview drawn from the collection's title field (or a fallback). */
  title: string;
  sortOrder: number;
  draftUpdatedAt: number;
  publishedAt: number | null;
  updatedAt: number;
}

/** A single entry with both its draft and published payloads. */
export interface EntryDetail {
  id: string;
  collectionId: string;
  slug: string | null;
  status: EntryStatus;
  draftData: EntryData;
  publishedData: EntryData | null;
  sortOrder: number;
  draftUpdatedAt: number;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EntryListResult {
  entries: EntrySummary[];
  total: number;
}

/** Admin list query parameters. */
export interface ListEntriesParams {
  status?: EntryStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

// --- Delivery API (Phase 3, public) -----------------------------------------

/** A published entry as served by the delivery API. */
export interface DeliveryEntry {
  id: string;
  slug: string | null;
  sortOrder: number;
  publishedAt: number | null;
  data: EntryData;
}

export interface DeliveryListResponse {
  data: DeliveryEntry[];
  meta: { total: number; limit: number; offset: number };
}

export interface DeliveryItemResponse {
  data: DeliveryEntry;
}

/**
 * An expanded media reference as served by the delivery API. Picture/video field values
 * (stored as bare media ids) are replaced with this object; dangling refs become `null`.
 * `url` is absolute, derived from the request origin so it works on any domain.
 */
export interface DeliveryMedia {
  id: string;
  kind: MediaKind;
  url: string;
  mime: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  alt: string | null;
  size: number;
}

// --- Media (Phase 4) ---------------------------------------------------------

export type MediaKind = "image" | "video";

/** An uploaded asset as returned by the admin API. `url` is a same-origin serving path. */
export interface MediaDTO {
  id: string;
  kind: MediaKind;
  filename: string;
  url: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  alt: string | null;
  createdAt: number;
}

export interface MediaListResult {
  media: MediaDTO[];
  total: number;
}

export interface ListMediaParams {
  kind?: MediaKind;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Response to initiating a multipart (video) upload. */
export interface MultipartInit {
  mediaId: string;
  uploadId: string;
  /** Required size for every part except the final one (R2 rule: equal, ≥5 MiB). */
  partSize: number;
}

/** One uploaded part's R2-returned etag, echoed back at completion. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface CompleteMultipartBody {
  uploadId: string;
  parts: UploadedPart[];
  width?: number;
  height?: number;
  duration?: number;
}

/** One entry referencing a media asset (for the delete-usage warning). */
export interface MediaUsageEntry {
  entryId: string;
  collectionSlug: string;
  collectionName: string;
  title: string;
}

export interface MediaUsage {
  entries: MediaUsageEntry[];
}

/** Public schema descriptor (collections + field defs) for typed delivery clients. */
export interface DeliveryCollectionSchema {
  slug: string;
  name: string;
  description: string | null;
  type: CollectionType;
  titleField: string | null;
  fields: Array<{ name: string; label: string; type: FieldType; options: FieldOptions }>;
}

// --- Export / Import (whole-project backup) ---------------------------------

/** One field as serialized in an export bundle. */
export interface ExportedField {
  name: string;
  label: string;
  type: FieldType;
  options: FieldOptions;
  sortOrder: number;
}

/**
 * One entry as serialized in an export bundle. Both payloads and all timestamps are
 * preserved so the derived status (draft/published/changed) is reproduced on import.
 */
export interface ExportedEntry {
  slug: string | null;
  locale: string;
  draftData: EntryData;
  publishedData: EntryData | null;
  sortOrder: number;
  draftUpdatedAt: number;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** One collection (schema + optional entries) as serialized in an export bundle. */
export interface ExportedCollection {
  slug: string;
  name: string;
  description: string | null;
  type: CollectionType;
  titleField: string | null;
  sortOrder: number;
  fields: ExportedField[];
  /** Present iff the bundle includes data. */
  entries?: ExportedEntry[];
}

/** A versioned, whole-project export envelope. */
export interface ExportDocument {
  format: "dito-export";
  version: 1;
  exportedAt: number;
  includesData: boolean;
  collections: ExportedCollection[];
}

/** Per-collection conflict resolution chosen by the user before applying an import. */
export type ImportResolution = "skip" | "rename" | "overwrite";

/** One collection's status in an import preview. */
export interface ImportPreviewCollection {
  slug: string;
  name: string;
  type: CollectionType;
  status: "new" | "conflict";
  fieldCount: number;
  entryCount: number;
}

/** The server's read of an uploaded bundle: what it contains and which slugs conflict. */
export interface ImportPreview {
  includesData: boolean;
  collections: ImportPreviewCollection[];
}

/** Apply request: the bundle plus per-conflicting-slug resolutions. */
export interface ImportApplyInput {
  document: ExportDocument;
  resolutions: Record<string, ImportResolution>;
}

/** What an import actually did, by collection slug. */
export interface ImportResult {
  created: string[];
  renamed: { from: string; to: string }[];
  overwritten: string[];
  skipped: string[];
}

// --- Commerce: catalog (Store module, Phase 1) ------------------------------
// All of these are gated behind the `commerceEnabled` setting. Money (`priceAmount`)
// is an integer in the store's minor currency units.

export type ProductStatus = "draft" | "active" | "archived";

/** A product category. `parentId` allows a shallow tree. */
export interface CategoryDTO {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parentId: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** A category in the list view, with how many products reference it. */
export interface CategorySummary extends CategoryDTO {
  productCount: number;
}

/** A product as shown in the admin list (compact, with a thumbnail + category name). */
export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  status: ProductStatus;
  priceAmount: number;
  sku: string | null;
  stock: number | null;
  categoryId: string | null;
  categoryName: string | null;
  /** First gallery image, expanded for the list thumbnail; null if none. */
  image: MediaDTO | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** A single product with its custom-field values and ordered image gallery. */
export interface ProductDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: ProductStatus;
  priceAmount: number;
  sku: string | null;
  stock: number | null;
  categoryId: string | null;
  /** Custom-field values keyed by product field name. */
  customData: EntryData;
  /** Ordered gallery, expanded to media DTOs. */
  images: MediaDTO[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProductListResult {
  products: ProductSummary[];
  total: number;
}

export interface ListProductsParams {
  status?: ProductStatus;
  search?: string;
  categoryId?: string;
  limit?: number;
  offset?: number;
}

// --- Commerce: public catalog (delivery, read-only) -------------------------

/** A published (active) product as served by the public catalog API. */
export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceAmount: number;
  sku: string | null;
  /**
   * Derived availability: `stock === null || stock > 0` at response-build time. Raw stock
   * counts are ADMIN-ONLY — the public catalog never leaks inventory to scrapers. Cached
   * responses make this a listing-page approximation (sold-out badges); the availability
   * endpoint ({@link AvailabilityResponse}) is the exact-moment truth.
   */
  available: boolean;
  category: { slug: string; name: string } | null;
  /** Ordered images with absolute URLs. */
  images: DeliveryMedia[];
  /** Custom-field values keyed by product field name. */
  data: EntryData;
}

export interface CatalogCategory {
  slug: string;
  name: string;
  description: string | null;
  parentSlug: string | null;
}

export interface CatalogListResponse {
  data: CatalogProduct[];
  meta: { total: number; limit: number; offset: number };
}

/**
 * GET /api/commerce/availability?slugs=a,b,c — LIVE availability for up to 50 products,
 * keyed by requested slug. Always `Cache-Control: no-store`: product pages and cart islands
 * fetch this at view time, so stock state is never baked into static pages or stale caches
 * (the cached catalog's `available` flag is the cheap listing approximation). A slug that
 * doesn't resolve to an `active` product reports `available: false` — unknown, draft and
 * archived are indistinguishable. Raw stock counts are never exposed.
 */
export interface AvailabilityResponse {
  availability: Record<string, { available: boolean }>;
}

// --- Commerce: checkout + orders (Store module, Phase 2) --------------------
// All amounts are integers in the store's minor currency units and are ALWAYS
// priced server-side from the products table — client-sent amounts are ignored.

/**
 * Order lifecycle: pending → awaiting_payment → paid → fulfilled, with
 * cancelled / failed / refunded as terminal off-ramps. `failed` is terminal —
 * a buyer retry is a brand-new checkout (unpaid orders hold no stock).
 */
export type OrderStatus =
  | "pending"
  | "awaiting_payment"
  | "paid"
  | "fulfilled"
  | "cancelled"
  | "failed"
  | "refunded";

/** Payment attempt lifecycle: created (intent) → paid | failed; refunded is post-payment. */
export type PaymentStatus = "created" | "paid" | "failed" | "refunded";

/** One line of a checkout request. Validated server-side: integer quantity 1..999. */
export interface CheckoutItemInput {
  /** Product slug (only `active` products are purchasable). */
  slug: string;
  quantity: number;
}

/**
 * POST /api/commerce/checkout body. Prices/currency are NEVER read from here — the server
 * re-prices every line from the DB. `paymentToken` is the client-side gateway token (Culqi
 * `tkn_…`/`ype_…`); when absent the order is created `pending` with no charge attempt.
 * The Idempotency-Key header is NOT part of this body — the route hashes it (2E).
 */
export interface CheckoutInput {
  email: string;
  items: CheckoutItemInput[];
  customerName?: string;
  customerPhone?: string;
  /** Small free-form address object, stored as JSON; omit for digital goods / pickup. */
  shippingAddress?: Record<string, unknown>;
  note?: string;
  paymentToken?: string;
}

/** Machine-readable per-line checkout rejection. Inactive/unknown slugs are indistinguishable. */
export type CheckoutItemErrorCode = "unknown_product" | "insufficient_stock";

/** A per-line checkout failure; `index` points into the submitted `items` array. */
export interface CheckoutItemError {
  index: number;
  slug: string;
  code: CheckoutItemErrorCode;
}

/** One order line in the buyer-facing order view (frozen snapshot amounts, minor units). */
export interface PublicOrderItem {
  name: string;
  quantity: number;
  unitAmount: number;
  totalAmount: number;
}

/**
 * The buyer-facing order served by GET /api/commerce/orders/:id?token=. Deliberately
 * excludes email/customer fields: the tokenized link may leak (chat forwards, referrers),
 * so it must never echo PII back.
 */
export interface PublicOrderDTO {
  number: number;
  status: OrderStatus;
  items: PublicOrderItem[];
  subtotalAmount: number;
  shippingAmount: number;
  totalAmount: number;
  currency: string;
  createdAt: number;
}

/**
 * The order shape checkout responses carry: the public view plus the `id` + `accessToken`
 * the buyer needs to build their status link. Only checkout ever returns the token — the
 * public status endpoint requires it but never echoes it.
 */
export interface CheckoutOrderDTO extends PublicOrderDTO {
  id: string;
  accessToken: string;
}

export type CheckoutResultKind =
  | "validation_error"
  | "payments_unavailable"
  | "replay"
  | "pending"
  | "paid"
  | "payment_failed"
  | "payment_pending";

/**
 * The typed outcome of `createCheckout` (services/store/checkout.ts). EXPECTED outcomes are
 * returned, never thrown — the checkout route (2E) maps kinds to HTTP:
 *   - `validation_error`      → 400. No order was created. `itemErrors` carries per-line codes.
 *   - `payments_unavailable`  → 503. A paymentToken was sent but no gateway is configured+enabled;
 *                               no order was created.
 *   - `replay`                → 200 with the body shaped like the ORIGINAL outcome, derived from
 *                               `order.status` (`error` carries the decline for failed orders).
 *   - `pending`               → 201. Order created with no charge attempt (no token sent).
 *   - `paid`                  → 201. Charge confirmed. `transitioned` is route-internal: fire the
 *                               order hook iff true (false = a concurrent webhook completed the
 *                               payment first and 2E's webhook path already fired it); omit it
 *                               from the response body.
 *   - `payment_failed`        → 402. DEFINITIVE decline; the order is terminally `failed` and a
 *                               buyer retry is a NEW checkout. `error.message` is buyer-safe
 *                               Spanish straight from the payment driver — do not re-localize.
 *   - `payment_pending`       → 202. Charge outcome UNKNOWN (timeout/429/5xx): the order stays
 *                               `awaiting_payment` for webhook/reconciliation resolution.
 */
export type CheckoutResult =
  | {
      kind: "validation_error";
      message: string;
      fieldErrors?: Record<string, string>;
      itemErrors?: CheckoutItemError[];
    }
  | { kind: "payments_unavailable" }
  | { kind: "replay"; order: CheckoutOrderDTO; error?: { code: string; message: string } }
  | { kind: "pending"; order: CheckoutOrderDTO }
  | { kind: "paid"; order: CheckoutOrderDTO; transitioned: boolean }
  | { kind: "payment_failed"; order: CheckoutOrderDTO; error: { code: string; message: string } }
  | { kind: "payment_pending"; order: CheckoutOrderDTO };

/**
 * Wire body of every POST /api/commerce/checkout response that carries an order
 * (201 pending/paid, 200 replay, 202 payment_pending, 402 payment_failed). `error` is
 * present on 402 declines and on replays of failed orders — its message is the buyer-safe
 * text from the payment driver. The paid outcome's route-internal `transitioned` flag is
 * deliberately NOT part of this shape.
 */
export interface CheckoutResponseBody {
  order: CheckoutOrderDTO;
  error?: { code: string; message: string };
}

/**
 * Wire body of a 400 checkout rejection: the standard error envelope whose `error` also
 * carries per-line `itemErrors` (unknown_product / insufficient_stock) when line items
 * were the problem. No order was created.
 */
export interface CheckoutValidationErrorBody {
  error: ApiErrorBody["error"] & { itemErrors?: CheckoutItemError[] };
}

/** Wire body of GET /api/commerce/orders/:id?token= — the buyer's status view. */
export interface PublicOrderResponse {
  order: PublicOrderDTO;
}

/** A compact order row for the admin orders list. */
export interface AdminOrderSummary {
  id: string;
  number: number;
  status: OrderStatus;
  email: string;
  customerName: string | null;
  currency: string;
  totalAmount: number;
  /** True when the paid transition could not decrement stock — merchant must resolve. */
  stockConflict: boolean;
  createdAt: number;
  paidAt: number | null;
}

/** One order line in the admin detail (frozen purchase-time snapshot). */
export interface AdminOrderItem {
  id: string;
  /** Live product reference; null once the product is deleted (the snapshot survives). */
  productId: string | null;
  name: string;
  sku: string | null;
  quantity: number;
  unitAmount: number;
  totalAmount: number;
  imageMediaId: string | null;
}

/** A payment attempt in the admin order detail. `raw` is the REDACTED gateway snapshot. */
export interface AdminPayment {
  id: string;
  provider: string;
  providerRef: string | null;
  status: PaymentStatus;
  amount: number;
  currency: string;
  errorCode: string | null;
  errorMessage: string | null;
  /** Parsed redacted gateway response (scalars only, redacted by the driver); null if none. */
  raw: unknown;
  createdAt: number;
  updatedAt: number;
}

/** Full admin view of one order: the row plus its items and payment attempts. */
export interface AdminOrderDetail {
  id: string;
  number: number;
  /** The buyer's status-link token, shown so the merchant can re-send the order link. */
  accessToken: string;
  status: OrderStatus;
  email: string;
  customerName: string | null;
  customerPhone: string | null;
  /** Parsed shipping address object, or null. */
  shippingAddress: unknown;
  note: string | null;
  currency: string;
  subtotalAmount: number;
  shippingAmount: number;
  totalAmount: number;
  stockConflict: boolean;
  createdAt: number;
  updatedAt: number;
  paidAt: number | null;
  fulfilledAt: number | null;
  cancelledAt: number | null;
  items: AdminOrderItem[];
  payments: AdminPayment[];
}

export interface OrderListResult {
  orders: AdminOrderSummary[];
  total: number;
}

export interface ListOrdersParams {
  status?: OrderStatus;
  /** Matches an exact order number (`42` / `#42`) or an email (case-insensitive / prefix). */
  search?: string;
  limit?: number;
  offset?: number;
}

// --- Commerce: order hook ----------------------------------------------------
// Merchant notification webhook fired when an order is PAID (email service, Zapier, ERP,
// WhatsApp bridge…). Completely unrelated to the deploy hook — buyer actions never rebuild.

/** One order line in the hook payload (snapshot amounts, minor units). */
export interface OrderHookItem {
  name: string;
  sku: string | null;
  quantity: number;
  unitAmount: number;
  totalAmount: number;
}

/** POSTed as JSON to the configured order-hook URL when an order transitions to paid. */
export interface OrderHookPayload {
  event: "order.paid";
  order: {
    id: string;
    number: number;
    status: OrderStatus;
    email: string;
    customerName: string | null;
    items: OrderHookItem[];
    subtotalAmount: number;
    shippingAmount: number;
    totalAmount: number;
    currency: string;
    paidAt: number | null;
  };
}

/** Result of one order-hook delivery attempt (mirrors DeployHookTestResult). */
export interface OrderHookTestResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

/**
 * One row of the order-hook activity log (mirrors DeployHookDelivery). `urlPreview` is the
 * masked URL — the raw URL is never logged or returned.
 */
export interface OrderHookDelivery {
  id: string;
  /** Epoch ms of the attempt. */
  firedAt: number;
  /** Trigger event: `order.paid` (or `test` from the 2F settings page). */
  event: string;
  /** Optional human reference (the order number, e.g. `#42`); null if none. */
  detail: string | null;
  /** Masked URL that was hit (`scheme://host/…/<last4>`). */
  urlPreview: string;
  ok: boolean;
  /** HTTP status, or null on a network error / timeout. */
  status: number | null;
  error: string | null;
}

export interface OrderHookActivity {
  deliveries: OrderHookDelivery[];
}
