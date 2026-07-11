import { asc, count, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import type { DrizzleDb } from "../../db/client";
import { categories, products, type CategoryRow } from "../../db/schema";
import { badRequest, conflict, notFound, validationError } from "../../lib/errors";

import { slugError } from "@/shared/slug";
import type { CategoryDTO, CategorySummary } from "@/shared/api-types";

// Product categories. Keyed externally by slug (like collections); a product references a
// category by its internal id. A shallow parent tree is supported via `parentId`.

interface CreateCategoryInput {
  slug: string;
  name: string;
  description?: string | null;
  parentId?: string | null;
}

interface UpdateCategoryPatch {
  name?: string;
  description?: string | null;
  parentId?: string | null;
  sortOrder?: number;
}

function mapCategory(row: CategoryRow): CategoryDTO {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findCategoryRow(db: DrizzleDb, slug: string): Promise<CategoryRow> {
  const row = await db.select().from(categories).where(eq(categories.slug, slug)).get();
  if (!row) throw notFound(`Category "${slug}" not found`);
  return row;
}

/** Resolve a category by id, asserting it exists. Used to validate a product's categoryId. */
export async function assertCategoryId(db: DrizzleDb, id: string): Promise<CategoryRow> {
  const row = await db.select().from(categories).where(eq(categories.id, id)).get();
  if (!row) throw validationError("Category not found", { categoryId: "Unknown category" });
  return row;
}

export async function listCategories(db: DrizzleDb): Promise<CategorySummary[]> {
  const rows = await db
    .select()
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.createdAt))
    .all();
  const counts = await db
    .select({ categoryId: products.categoryId, n: count() })
    .from(products)
    .groupBy(products.categoryId)
    .all();
  const countBy = new Map(counts.map((c) => [c.categoryId, c.n]));
  return rows.map((row) => ({ ...mapCategory(row), productCount: countBy.get(row.id) ?? 0 }));
}

export async function getCategory(db: DrizzleDb, slug: string): Promise<CategoryDTO> {
  return mapCategory(await findCategoryRow(db, slug));
}

export async function createCategory(db: DrizzleDb, input: CreateCategoryInput): Promise<CategoryDTO> {
  const slug = input.slug.trim();
  const slugErr = slugError(slug);
  if (slugErr) throw validationError(slugErr, { slug: slugErr });
  if (!input.name || !input.name.trim()) {
    throw validationError("Name is required", { name: "Name is required" });
  }

  const existing = await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, slug)).get();
  if (existing) throw conflict(`A category with slug "${slug}" already exists`, { slug: "Slug already in use" });

  if (input.parentId) await assertParent(db, input.parentId, null);

  const now = Date.now();
  const id = nanoid();
  await db
    .insert(categories)
    .values({
      id,
      slug,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      parentId: input.parentId ?? null,
      sortOrder: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const created = await db.select().from(categories).where(eq(categories.id, id)).get();
  return mapCategory(created!);
}

export async function updateCategory(
  db: DrizzleDb,
  slug: string,
  patch: UpdateCategoryPatch,
): Promise<CategoryDTO> {
  const row = await findCategoryRow(db, slug);

  const values: Partial<typeof categories.$inferInsert> = { updatedAt: Date.now() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw validationError("Name is required", { name: "Name is required" });
    values.name = name;
  }
  if (patch.description !== undefined) {
    values.description = patch.description?.trim() || null;
  }
  if (patch.sortOrder !== undefined) {
    values.sortOrder = patch.sortOrder;
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId === null || patch.parentId === "") {
      values.parentId = null;
    } else {
      await assertParent(db, patch.parentId, row.id);
      values.parentId = patch.parentId;
    }
  }

  await db.update(categories).set(values).where(eq(categories.id, row.id)).run();
  return getCategory(db, slug);
}

/** Validate a parent reference: it must exist and may not be the category itself. */
async function assertParent(db: DrizzleDb, parentId: string, selfId: string | null): Promise<void> {
  if (selfId && parentId === selfId) {
    throw validationError("A category cannot be its own parent", { parentId: "Invalid parent" });
  }
  const parent = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, parentId)).get();
  if (!parent) throw validationError("Parent category not found", { parentId: "Unknown category" });
}

/** Delete a category. Products in it have their categoryId nulled (FK ON DELETE set null). */
export async function deleteCategory(db: DrizzleDb, slug: string, confirm: string): Promise<void> {
  const row = await findCategoryRow(db, slug);
  if (confirm !== slug) {
    throw badRequest("Confirmation does not match the category slug");
  }
  await db.delete(categories).where(eq(categories.id, row.id)).run();
}
