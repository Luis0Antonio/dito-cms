import { and, asc, count, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";

import type { DrizzleDb } from "../../db/client";
import {
  categories,
  productImages,
  products,
  type MediaRow,
  type ProductImageRow,
  type ProductRow,
} from "../../db/schema";
import { conflict, notFound, validationError } from "../../lib/errors";
import { assertMediaRefs, fetchMediaByIds, toDeliveryMedia, toMediaDTO } from "../media";
import { regenerateRichText, seedDefaults, validateFieldData } from "../field-data";
import { loadProductFieldDefs } from "./product-schema";
import { assertCategoryId } from "./categories";

import { D1_IN_CHUNK, MAX_DELIVERY_LIMIT } from "@/shared/constants";
import type { FieldDefinition } from "@/shared/validation";
import { slugError } from "@/shared/slug";
import type {
  CatalogCategory,
  CatalogListResponse,
  CatalogProduct,
  EntryData,
  ListProductsParams,
  ProductDetail,
  ProductListResult,
  ProductStatus,
  ProductSummary,
} from "@/shared/api-types";

// Products: solid core columns + a shared custom-field layer (`customData`). customData is
// validated against the product schema (product_fields) with the same field system entries
// use — lenient on every write, plus a full publish-style check when status is `active` (the
// gate for the public catalog). Images are an ordered gallery over the media table.

const PRODUCT_STATUSES: readonly ProductStatus[] = ["draft", "active", "archived"];

export interface CreateProductInput {
  slug: string;
  name: string;
  description?: string | null;
  status?: ProductStatus;
  priceAmount?: number;
  sku?: string | null;
  stock?: number | null;
  categoryId?: string | null;
  customData?: EntryData;
  imageIds?: string[];
}

export interface UpdateProductPatch {
  slug?: string;
  name?: string;
  description?: string | null;
  status?: ProductStatus;
  priceAmount?: number;
  sku?: string | null;
  stock?: number | null;
  categoryId?: string | null;
  customData?: EntryData;
  imageIds?: string[];
  sortOrder?: number;
}

// --- mapping -----------------------------------------------------------------

function parseJson(text: string): EntryData {
  try {
    return JSON.parse(text) as EntryData;
  } catch {
    return {};
  }
}

function mapCore(row: ProductRow): Omit<ProductDetail, "images"> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    priceAmount: row.priceAmount,
    sku: row.sku,
    stock: row.stock,
    categoryId: row.categoryId,
    customData: parseJson(row.customData),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findProductRow(db: DrizzleDb, slug: string): Promise<ProductRow> {
  const row = await db.select().from(products).where(eq(products.slug, slug)).get();
  if (!row) throw notFound(`Product "${slug}" not found`);
  return row;
}

/** Load each product's ordered gallery as media rows, keyed by product id. */
async function loadImagesByProduct(db: DrizzleDb, productIds: string[]): Promise<Map<string, MediaRow[]>> {
  const out = new Map<string, MediaRow[]>();
  if (productIds.length === 0) return out;

  const links: ProductImageRow[] = [];
  for (let i = 0; i < productIds.length; i += D1_IN_CHUNK) {
    const chunk = productIds.slice(i, i + D1_IN_CHUNK);
    const rows = await db
      .select()
      .from(productImages)
      .where(inArray(productImages.productId, chunk))
      .orderBy(asc(productImages.productId), asc(productImages.sortOrder))
      .all();
    links.push(...rows);
  }
  const mediaById = await fetchMediaByIds(db, links.map((l) => l.mediaId));
  for (const link of links) {
    const media = mediaById.get(link.mediaId);
    if (!media) continue;
    const arr = out.get(link.productId) ?? [];
    arr.push(media);
    out.set(link.productId, arr);
  }
  return out;
}

// --- validation --------------------------------------------------------------

function normalizeProductSlug(slug: string): string {
  const trimmed = slug.trim();
  const err = slugError(trimmed);
  if (err) throw validationError(err, { slug: err });
  return trimmed;
}

function validatePrice(priceAmount: number): number {
  if (!Number.isInteger(priceAmount) || priceAmount < 0) {
    throw validationError("Price must be a whole number of minor units (≥ 0)", {
      priceAmount: "Enter a whole number ≥ 0",
    });
  }
  return priceAmount;
}

function normalizeStock(stock: number | null | undefined): number | null {
  if (stock === null || stock === undefined) return null;
  if (!Number.isInteger(stock) || stock < 0) {
    throw validationError("Stock must be a whole number ≥ 0, or empty for untracked", {
      stock: "Enter a whole number ≥ 0, or leave empty",
    });
  }
  return stock;
}

function normalizeSku(sku: string | null | undefined): string | null {
  if (sku === null || sku === undefined) return null;
  const trimmed = sku.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeStatus(status: ProductStatus | undefined, fallback: ProductStatus): ProductStatus {
  if (status === undefined) return fallback;
  if (!PRODUCT_STATUSES.includes(status)) {
    throw validationError("Invalid status", { status: "Must be draft, active or archived" });
  }
  return status;
}

/** Ensure no other product holds this slug. */
async function assertSlugFree(db: DrizzleDb, slug: string, exceptId: string | null): Promise<void> {
  const row = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug)).get();
  if (row && row.id !== exceptId) {
    throw conflict(`A product with slug "${slug}" already exists`, { slug: "Slug already in use" });
  }
}

/** Ensure no other product holds this (non-null) SKU. */
async function assertSkuFree(db: DrizzleDb, sku: string, exceptId: string | null): Promise<void> {
  const row = await db.select({ id: products.id }).from(products).where(eq(products.sku, sku)).get();
  if (row && row.id !== exceptId) {
    throw conflict(`SKU "${sku}" is already in use`, { sku: "SKU already in use" });
  }
}

/** Validate the gallery: every id must be an existing, ready image. Returns de-duped ids. */
async function validateImageIds(db: DrizzleDb, imageIds: string[]): Promise<string[]> {
  const unique = [...new Set(imageIds)];
  if (unique.length === 0) return [];
  const byId = await fetchMediaByIds(db, unique);
  for (const id of unique) {
    const row = byId.get(id);
    if (!row || row.status !== "ready") {
      throw validationError("A selected image no longer exists", { images: "Selected media no longer exists" });
    }
    if (row.kind !== "image") {
      throw validationError("Gallery items must be images", { images: "Only images can be added to a product" });
    }
  }
  return unique;
}

/**
 * Validate customData against the shared product schema. Always draft-checked (type/format);
 * additionally publish-checked when the product is `active` (required fields + bounds), which
 * is the gate for the public catalog. Returns the cleaned customData to persist.
 */
async function validateCustomData(
  db: DrizzleDb,
  defs: FieldDefinition[],
  raw: EntryData,
  status: ProductStatus,
): Promise<EntryData> {
  const normalized = regenerateRichText(defs, raw);
  const cleaned = validateFieldData(defs, normalized, "draft", { draft: "Some product fields are invalid" });
  if (status === "active") {
    validateFieldData(defs, normalized, "publish", {
      publish: "Product can't be active until its required fields are filled",
    });
  }
  await assertMediaRefs(db, defs, cleaned);
  return cleaned;
}

async function nextSortOrder(db: DrizzleDb): Promise<number> {
  const row = await db.select({ max: sql<number | null>`max(${products.sortOrder})` }).from(products).get();
  return (row?.max ?? 0) + 1024;
}

function imageInserts(db: DrizzleDb, productId: string, imageIds: string[]): BatchItem<"sqlite">[] {
  return imageIds.map((mediaId, index) =>
    db.insert(productImages).values({ productId, mediaId, sortOrder: index }),
  );
}

// --- queries -----------------------------------------------------------------

export async function listProducts(db: DrizzleDb, params: ListProductsParams): Promise<ProductListResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);

  const conds: SQL[] = [];
  if (params.status) conds.push(eq(products.status, params.status));
  if (params.categoryId) conds.push(eq(products.categoryId, params.categoryId));
  if (params.search && params.search.trim()) {
    const term = `%${params.search.trim()}%`;
    conds.push(or(like(products.name, term), like(products.sku, term)) as SQL);
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  const totalRow = await db.select({ n: count() }).from(products).where(where).get();
  const rows = await db
    .select({ product: products, categoryName: categories.name })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(where)
    .orderBy(asc(products.sortOrder), asc(products.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  const imagesByProduct = await loadImagesByProduct(db, rows.map((r) => r.product.id));

  const summaries: ProductSummary[] = rows.map(({ product, categoryName }) => {
    const first = imagesByProduct.get(product.id)?.[0];
    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      status: product.status,
      priceAmount: product.priceAmount,
      sku: product.sku,
      stock: product.stock,
      categoryId: product.categoryId,
      categoryName: categoryName ?? null,
      image: first ? toMediaDTO(first) : null,
      sortOrder: product.sortOrder,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  });

  return { products: summaries, total: totalRow?.n ?? 0 };
}

export async function getProduct(db: DrizzleDb, slug: string): Promise<ProductDetail> {
  const row = await findProductRow(db, slug);
  const images = (await loadImagesByProduct(db, [row.id])).get(row.id) ?? [];
  return { ...mapCore(row), images: images.map(toMediaDTO) };
}

// --- mutations ---------------------------------------------------------------

export async function createProduct(
  db: DrizzleDb,
  input: CreateProductInput,
  userId: string | undefined,
): Promise<ProductDetail> {
  const slug = normalizeProductSlug(input.slug);
  if (!input.name || !input.name.trim()) {
    throw validationError("Name is required", { name: "Name is required" });
  }
  const status = normalizeStatus(input.status, "draft");
  const priceAmount = validatePrice(input.priceAmount ?? 0);
  const sku = normalizeSku(input.sku);
  const stock = normalizeStock(input.stock);

  await assertSlugFree(db, slug, null);
  if (sku) await assertSkuFree(db, sku, null);
  if (input.categoryId) await assertCategoryId(db, input.categoryId);

  const defs = await loadProductFieldDefs(db);
  const merged = { ...seedDefaults(defs), ...(input.customData ?? {}) };
  const customData = await validateCustomData(db, defs, merged, status);
  const imageIds = await validateImageIds(db, input.imageIds ?? []);

  const now = Date.now();
  const id = nanoid();
  const sortOrder = await nextSortOrder(db);

  const statements: BatchItem<"sqlite">[] = [
    db.insert(products).values({
      id,
      slug,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      status,
      priceAmount,
      sku,
      stock,
      categoryId: input.categoryId ?? null,
      customData: JSON.stringify(customData),
      sortOrder,
      createdAt: now,
      updatedAt: now,
      createdBy: userId ?? null,
      updatedBy: userId ?? null,
    }),
    ...imageInserts(db, id, imageIds),
  ];
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  return getProduct(db, slug);
}

export async function updateProduct(
  db: DrizzleDb,
  slug: string,
  patch: UpdateProductPatch,
  userId: string | undefined,
): Promise<ProductDetail> {
  const row = await findProductRow(db, slug);
  const now = Date.now();
  const values: Partial<typeof products.$inferInsert> = { updatedAt: now, updatedBy: userId ?? null };

  let nextSlug = row.slug;
  if (patch.slug !== undefined) {
    nextSlug = normalizeProductSlug(patch.slug);
    if (nextSlug !== row.slug) await assertSlugFree(db, nextSlug, row.id);
    values.slug = nextSlug;
  }
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw validationError("Name is required", { name: "Name is required" });
    values.name = patch.name.trim();
  }
  if (patch.description !== undefined) values.description = patch.description?.trim() || null;
  if (patch.priceAmount !== undefined) values.priceAmount = validatePrice(patch.priceAmount);
  if (patch.stock !== undefined) values.stock = normalizeStock(patch.stock);
  if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder;
  if (patch.sku !== undefined) {
    const sku = normalizeSku(patch.sku);
    if (sku && sku !== row.sku) await assertSkuFree(db, sku, row.id);
    values.sku = sku;
  }
  if (patch.categoryId !== undefined) {
    if (patch.categoryId === null || patch.categoryId === "") {
      values.categoryId = null;
    } else {
      await assertCategoryId(db, patch.categoryId);
      values.categoryId = patch.categoryId;
    }
  }

  const status = normalizeStatus(patch.status, row.status);
  if (patch.status !== undefined) values.status = status;

  // Re-validate customData whenever it changes OR the product is (becoming) active, so an
  // active product always satisfies the publish rules.
  const customDataChanged = patch.customData !== undefined;
  if (customDataChanged || status === "active") {
    const defs = await loadProductFieldDefs(db);
    const merged = { ...parseJson(row.customData), ...(patch.customData ?? {}) };
    const customData = await validateCustomData(db, defs, merged, status);
    values.customData = JSON.stringify(customData);
  }

  const statements: BatchItem<"sqlite">[] = [
    db.update(products).set(values).where(eq(products.id, row.id)),
  ];
  // A provided imageIds array replaces the whole gallery.
  if (patch.imageIds !== undefined) {
    const imageIds = await validateImageIds(db, patch.imageIds);
    statements.push(db.delete(productImages).where(eq(productImages.productId, row.id)));
    statements.push(...imageInserts(db, row.id, imageIds));
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  return getProduct(db, nextSlug);
}

export async function deleteProduct(db: DrizzleDb, slug: string, confirm: string): Promise<void> {
  const row = await findProductRow(db, slug);
  if (confirm !== slug) {
    throw validationError("Confirmation does not match the product slug", { confirm: "Does not match" });
  }
  // product_images cascade via FK.
  await db.delete(products).where(eq(products.id, row.id)).run();
}

// --- public catalog (delivery, active products only) -------------------------

function mapCatalogProduct(origin: string, row: ProductRow, images: MediaRow[], categoryName: string | null, categorySlug: string | null): CatalogProduct {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    priceAmount: row.priceAmount,
    sku: row.sku,
    // Derived availability ONLY — raw stock counts are admin-only and must never reach the
    // public catalog (don't leak inventory to scrapers). Exact-moment truth lives at the
    // live availability endpoint; this cached flag powers listing-page sold-out badges.
    available: row.stock === null || row.stock > 0,
    category: categorySlug && categoryName ? { slug: categorySlug, name: categoryName } : null,
    images: images.map((m) => toDeliveryMedia(origin, m)),
    data: parseJson(row.customData),
  };
}

export async function listCatalogProducts(
  db: DrizzleDb,
  origin: string,
  params: { categorySlug?: string; search?: string; limit?: number; offset?: number },
): Promise<CatalogListResponse> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), MAX_DELIVERY_LIMIT);
  const offset = Math.max(params.offset ?? 0, 0);

  const conds: SQL[] = [eq(products.status, "active")];
  if (params.categorySlug) conds.push(eq(categories.slug, params.categorySlug));
  if (params.search && params.search.trim()) {
    conds.push(like(products.name, `%${params.search.trim()}%`));
  }
  const where = and(...conds);

  const totalRow = await db
    .select({ n: count() })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(where)
    .get();
  const rows = await db
    .select({ product: products, categoryName: categories.name, categorySlug: categories.slug })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(where)
    .orderBy(asc(products.sortOrder), asc(products.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  const imagesByProduct = await loadImagesByProduct(db, rows.map((r) => r.product.id));
  const data = rows.map((r) =>
    mapCatalogProduct(origin, r.product, imagesByProduct.get(r.product.id) ?? [], r.categoryName, r.categorySlug),
  );
  return { data, meta: { total: totalRow?.n ?? 0, limit, offset } };
}

export async function getCatalogProduct(db: DrizzleDb, origin: string, slug: string): Promise<CatalogProduct> {
  const row = await db
    .select({ product: products, categoryName: categories.name, categorySlug: categories.slug })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(and(eq(products.slug, slug), eq(products.status, "active")))
    .get();
  if (!row) throw notFound(`Product "${slug}" not found`);
  const images = (await loadImagesByProduct(db, [row.product.id])).get(row.product.id) ?? [];
  return mapCatalogProduct(origin, row.product, images, row.categoryName, row.categorySlug);
}

export async function listCatalogCategories(db: DrizzleDb): Promise<CatalogCategory[]> {
  const parents = db.$with("parents").as(
    db.select({ id: categories.id, slug: categories.slug }).from(categories),
  );
  const rows = await db
    .with(parents)
    .select({
      slug: categories.slug,
      name: categories.name,
      description: categories.description,
      parentSlug: parents.slug,
    })
    .from(categories)
    .leftJoin(parents, eq(categories.parentId, parents.id))
    .orderBy(asc(categories.sortOrder), asc(categories.createdAt))
    .all();
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    parentSlug: r.parentSlug ?? null,
  }));
}
