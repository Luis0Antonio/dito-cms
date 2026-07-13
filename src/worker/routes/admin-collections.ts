import { Hono } from "hono";

import type { AppEnv } from "../lib/app";
import { badRequest } from "../lib/errors";
import { fireDeployHook } from "./admin-deploy-hook";
import {
  createCollection,
  deleteCollection,
  getCollectionDetail,
  listCollections,
  setFields,
  updateCollection,
} from "../services/collections";
import { migrateStringFieldToReference } from "../services/references";

import type { CollectionType, SetFieldsInput } from "@/shared/api-types";
import type { FieldType, FieldOptions } from "@/shared/field-types";

// Collections + fields CRUD. Mounted under /api/admin/collections; auth is applied
// by the parent adminRouter. Deep validation lives in services/collections.ts.
export const collectionsRouter = new Hono<AppEnv>();

interface CreateBody {
  slug?: unknown;
  name?: unknown;
  type?: unknown;
  description?: unknown;
  fields?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Coerce a raw incoming fields array into the service's FieldInput[] (shape only). */
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

collectionsRouter.get("/", async (c) => {
  const data = await listCollections(c.get("db"));
  return c.json({ collections: data });
});

collectionsRouter.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateBody;
  const slug = asString(body.slug);
  const name = asString(body.name);
  const type = asString(body.type) as CollectionType | undefined;
  if (!slug || !name || !type) throw badRequest("slug, name and type are required");

  const detail = await createCollection(c.get("db"), {
    slug,
    name,
    type,
    description: asString(body.description) ?? null,
    fields: readFieldInputs(body.fields),
  });
  return c.json({ collection: detail }, 201);
});

collectionsRouter.get("/:slug", async (c) => {
  const detail = await getCollectionDetail(c.get("db"), c.req.param("slug"));
  return c.json({ collection: detail });
});

collectionsRouter.patch("/:slug", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: { name?: string; description?: string | null; titleField?: string | null; sortOrder?: number } = {};
  if ("name" in body) patch.name = asString(body.name) ?? "";
  if ("description" in body) patch.description = asString(body.description) ?? null;
  if ("titleField" in body) patch.titleField = body.titleField === null ? null : asString(body.titleField) ?? null;
  if ("sortOrder" in body && typeof body.sortOrder === "number") patch.sortOrder = body.sortOrder;

  const detail = await updateCollection(c.get("db"), c.req.param("slug"), patch);
  return c.json({ collection: detail });
});

collectionsRouter.put("/:slug/fields", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<SetFieldsInput>;
  const result = await setFields(c.get("db"), c.req.param("slug"), {
    fields: readFieldInputs(body.fields),
    allowDestructive: body.allowDestructive === true,
  });
  return c.json(result);
});

// Backfill a reference field from a legacy name-string field (WS7). Returns { converted,
// unmatched, ambiguous } so the caller can reconcile stragglers before dropping the old field.
collectionsRouter.post("/:slug/migrate-reference", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const fromField = asString(body.fromField);
  const toField = asString(body.toField);
  const targetCollection = asString(body.targetCollection);
  if (!fromField || !toField || !targetCollection) {
    throw badRequest("`fromField`, `toField` and `targetCollection` are required");
  }
  const { result, publishedChanged } = await migrateStringFieldToReference(c.get("db"), {
    collectionSlug: c.req.param("slug"),
    fromField,
    toField,
    targetCollectionSlug: targetCollection,
  });
  // Rewriting published entries changes what delivery serves → notify the deploy hook.
  if (publishedChanged) fireDeployHook(c, { event: "collection.migrate-reference", detail: c.req.param("slug") });
  return c.json(result);
});

collectionsRouter.delete("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const confirm = c.req.query("confirm") ?? "";
  const { hadPublishedEntries } = await deleteCollection(c.get("db"), slug, confirm);
  // Dropping a collection that had live entries changes the delivery API → notify the hook.
  if (hadPublishedEntries) fireDeployHook(c, { event: "collection.delete", detail: slug });
  return c.body(null, 204);
});
