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
  stock: number | null;
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
