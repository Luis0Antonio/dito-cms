import { queryOptions } from "@tanstack/react-query";

import { api } from "./client";

import type {
  CategoryDTO,
  CategorySummary,
  FieldDTO,
  ListProductsParams,
  ProductDetail,
  ProductListResult,
  ProductStatus,
  SetFieldsInput,
  SetFieldsResult,
} from "@/shared/api-types";

// Client for the Store (commerce) admin API under /api/admin/store/*. These queries only run
// on store routes, which are gated behind `commerceEnabled`, so a content-only instance never
// calls them.

export const storeKeys = {
  all: ["store"] as const,
  products: () => [...storeKeys.all, "products"] as const,
  productList: (params: ListProductsParams) => [...storeKeys.products(), params] as const,
  product: (slug: string) => [...storeKeys.products(), "detail", slug] as const,
  categories: () => [...storeKeys.all, "categories"] as const,
  schema: () => [...storeKeys.all, "product-schema"] as const,
};

// --- products ----------------------------------------------------------------

function productQuery(params: ListProductsParams): string {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.search) q.set("search", params.search);
  if (params.categoryId) q.set("categoryId", params.categoryId);
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.offset !== undefined) q.set("offset", String(params.offset));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const productsListQueryOptions = (params: ListProductsParams = {}) =>
  queryOptions({
    queryKey: storeKeys.productList(params),
    queryFn: () => api.get<ProductListResult>(`/api/admin/store/products${productQuery(params)}`),
  });

export const productDetailQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: storeKeys.product(slug),
    queryFn: async (): Promise<ProductDetail> => {
      const { product } = await api.get<{ product: ProductDetail }>(`/api/admin/store/products/${slug}`);
      return product;
    },
  });

export interface ProductWriteBody {
  slug?: string;
  name?: string;
  description?: string | null;
  status?: ProductStatus;
  priceAmount?: number;
  sku?: string | null;
  stock?: number | null;
  categoryId?: string | null;
  customData?: Record<string, unknown>;
  imageIds?: string[];
}

export async function createProduct(body: ProductWriteBody): Promise<ProductDetail> {
  const { product } = await api.post<{ product: ProductDetail }>("/api/admin/store/products", body);
  return product;
}

export async function updateProduct(slug: string, body: ProductWriteBody): Promise<ProductDetail> {
  const { product } = await api.patch<{ product: ProductDetail }>(`/api/admin/store/products/${slug}`, body);
  return product;
}

export async function deleteProduct(slug: string): Promise<void> {
  await api.delete(`/api/admin/store/products/${slug}?confirm=${encodeURIComponent(slug)}`);
}

// --- categories --------------------------------------------------------------

export const categoriesListQueryOptions = queryOptions({
  queryKey: storeKeys.categories(),
  queryFn: async (): Promise<CategorySummary[]> => {
    const { categories } = await api.get<{ categories: CategorySummary[] }>("/api/admin/store/categories");
    return categories;
  },
});

export interface CategoryWriteBody {
  slug?: string;
  name?: string;
  description?: string | null;
  parentId?: string | null;
}

export async function createCategory(body: CategoryWriteBody): Promise<CategoryDTO> {
  const { category } = await api.post<{ category: CategoryDTO }>("/api/admin/store/categories", body);
  return category;
}

export async function updateCategory(slug: string, body: CategoryWriteBody): Promise<CategoryDTO> {
  const { category } = await api.patch<{ category: CategoryDTO }>(`/api/admin/store/categories/${slug}`, body);
  return category;
}

export async function deleteCategory(slug: string): Promise<void> {
  await api.delete(`/api/admin/store/categories/${slug}?confirm=${encodeURIComponent(slug)}`);
}

// --- product schema (shared custom fields) -----------------------------------

export const productSchemaQueryOptions = queryOptions({
  queryKey: storeKeys.schema(),
  queryFn: async (): Promise<FieldDTO[]> => {
    const { fields } = await api.get<{ fields: FieldDTO[] }>("/api/admin/store/product-schema");
    return fields;
  },
});

export async function setProductFields(body: SetFieldsInput): Promise<SetFieldsResult> {
  return api.put<SetFieldsResult>("/api/admin/store/product-schema", body);
}
