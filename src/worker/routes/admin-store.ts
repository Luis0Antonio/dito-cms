import { Hono } from "hono";

import type { AppEnv } from "../lib/app";
import { badRequest, notFound } from "../lib/errors";
import { isCommerceEnabled } from "../services/settings";
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
  type CreateProductInput,
  type UpdateProductPatch,
} from "../services/store/products";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "../services/store/categories";
import { getProductFields, setProductFields } from "../services/store/product-schema";

import type { EntryData, ProductStatus, SetFieldsInput } from "@/shared/api-types";
import type { FieldType, FieldOptions } from "@/shared/field-types";

// Store (commerce) admin API under /api/admin/store/*. Auth is applied by the parent
// adminRouter; on top of that, the whole module is gated by the `commerce_enabled` setting —
// when off, every route 404s so the feature is invisible. Deep validation lives in the
// services/store/* modules.
export const storeRouter = new Hono<AppEnv>();

// Module gate: behave as if these routes don't exist when commerce is disabled.
storeRouter.use("*", async (c, next) => {
  if (!(await isCommerceEnabled(c.get("db")))) {
    throw notFound("The Store module is not enabled");
  }
  await next();
});

// --- coercion helpers --------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStatus(value: unknown): ProductStatus | undefined {
  return value === "draft" || value === "active" || value === "archived" ? value : undefined;
}

function asImageIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest("`imageIds` must be an array of media ids");
  return value.map((v) => String(v));
}

function asCustomData(value: unknown): EntryData | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("`customData` must be an object");
  }
  return value as EntryData;
}

/** Coerce a raw fields array into the schema service's input (shape only). */
function readFieldInputs(raw: unknown): Array<{ name: string; label: string; type: FieldType; options?: FieldOptions }> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw badRequest("`fields` must be an array");
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null) throw badRequest(`fields[${i}] must be an object`);
    const f = item as Record<string, unknown>;
    return {
      name: asString(f.name) ?? "",
      label: asString(f.label) ?? "",
      type: f.type as FieldType,
      options: (f.options ?? undefined) as FieldOptions | undefined,
    };
  });
}

// --- products ----------------------------------------------------------------

const productsRouter = new Hono<AppEnv>();

productsRouter.get("/", async (c) => {
  const q = c.req.query();
  const limit = q.limit ? Number(q.limit) : undefined;
  const offset = q.offset ? Number(q.offset) : undefined;
  const result = await listProducts(c.get("db"), {
    status: asStatus(q.status),
    search: q.search,
    categoryId: q.categoryId || undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: Number.isFinite(offset) ? offset : undefined,
  });
  return c.json(result);
});

productsRouter.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const slug = asString(body.slug);
  const name = asString(body.name);
  if (!slug || !name) throw badRequest("slug and name are required");

  const input: CreateProductInput = {
    slug,
    name,
    description: asString(body.description) ?? null,
    status: asStatus(body.status),
    priceAmount: typeof body.priceAmount === "number" ? body.priceAmount : undefined,
    sku: body.sku === null ? null : asString(body.sku),
    stock: body.stock === null ? null : typeof body.stock === "number" ? body.stock : undefined,
    categoryId: body.categoryId === null ? null : asString(body.categoryId),
    customData: asCustomData(body.customData),
    imageIds: asImageIds(body.imageIds),
  };
  const product = await createProduct(c.get("db"), input, c.get("authUserId"));
  return c.json({ product }, 201);
});

productsRouter.get("/:slug", async (c) => {
  const product = await getProduct(c.get("db"), c.req.param("slug"));
  return c.json({ product });
});

productsRouter.patch("/:slug", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: UpdateProductPatch = {};
  if ("slug" in body) patch.slug = asString(body.slug) ?? "";
  if ("name" in body) patch.name = asString(body.name) ?? "";
  if ("description" in body) patch.description = body.description === null ? null : asString(body.description) ?? null;
  if ("status" in body) patch.status = asStatus(body.status);
  if ("priceAmount" in body && typeof body.priceAmount === "number") patch.priceAmount = body.priceAmount;
  if ("sku" in body) patch.sku = body.sku === null ? null : asString(body.sku) ?? null;
  if ("stock" in body) patch.stock = body.stock === null ? null : typeof body.stock === "number" ? body.stock : undefined;
  if ("categoryId" in body) patch.categoryId = body.categoryId === null ? null : asString(body.categoryId) ?? null;
  if ("customData" in body) patch.customData = asCustomData(body.customData);
  if ("imageIds" in body) patch.imageIds = asImageIds(body.imageIds);
  if ("sortOrder" in body && typeof body.sortOrder === "number") patch.sortOrder = body.sortOrder;

  const product = await updateProduct(c.get("db"), c.req.param("slug"), patch, c.get("authUserId"));
  return c.json({ product });
});

productsRouter.delete("/:slug", async (c) => {
  await deleteProduct(c.get("db"), c.req.param("slug"), c.req.query("confirm") ?? "");
  return c.body(null, 204);
});

// --- categories --------------------------------------------------------------

const categoriesRouter = new Hono<AppEnv>();

categoriesRouter.get("/", async (c) => {
  const categories = await listCategories(c.get("db"));
  return c.json({ categories });
});

categoriesRouter.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const slug = asString(body.slug);
  const name = asString(body.name);
  if (!slug || !name) throw badRequest("slug and name are required");
  const category = await createCategory(c.get("db"), {
    slug,
    name,
    description: asString(body.description) ?? null,
    parentId: body.parentId === null ? null : asString(body.parentId),
  });
  return c.json({ category }, 201);
});

categoriesRouter.get("/:slug", async (c) => {
  const category = await getCategory(c.get("db"), c.req.param("slug"));
  return c.json({ category });
});

categoriesRouter.patch("/:slug", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: { name?: string; description?: string | null; parentId?: string | null; sortOrder?: number } = {};
  if ("name" in body) patch.name = asString(body.name) ?? "";
  if ("description" in body) patch.description = body.description === null ? null : asString(body.description) ?? null;
  if ("parentId" in body) patch.parentId = body.parentId === null ? null : asString(body.parentId) ?? null;
  if ("sortOrder" in body && typeof body.sortOrder === "number") patch.sortOrder = body.sortOrder;
  const category = await updateCategory(c.get("db"), c.req.param("slug"), patch);
  return c.json({ category });
});

categoriesRouter.delete("/:slug", async (c) => {
  await deleteCategory(c.get("db"), c.req.param("slug"), c.req.query("confirm") ?? "");
  return c.body(null, 204);
});

// --- product schema (shared custom fields) -----------------------------------

const schemaRouter = new Hono<AppEnv>();

schemaRouter.get("/", async (c) => {
  const fields = await getProductFields(c.get("db"));
  return c.json({ fields });
});

schemaRouter.put("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<SetFieldsInput>;
  const result = await setProductFields(c.get("db"), {
    fields: readFieldInputs(body.fields),
    allowDestructive: body.allowDestructive === true,
  });
  return c.json(result);
});

storeRouter.route("/products", productsRouter);
storeRouter.route("/categories", categoriesRouter);
storeRouter.route("/product-schema", schemaRouter);
