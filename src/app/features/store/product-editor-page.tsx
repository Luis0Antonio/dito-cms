import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import { ProductEditor } from "./product-editor";

import { categoriesListQueryOptions, productDetailQueryOptions, productSchemaQueryOptions } from "@/app/api/store";
import { useI18n } from "@/app/i18n";
import { ErrorState } from "@/app/components/common/error-state";
import { Skeleton } from "@/app/components/ui/skeleton";

function EditorSkeleton(): React.ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function EditorHeader({ heading }: { heading: string }): React.ReactElement {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <Link to="/store/products" className="text-sm text-muted-foreground hover:text-foreground">
        ← {t("store.editor.back")}
      </Link>
      <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
    </div>
  );
}

/** /store/products/new */
export function NewProductPage(): React.ReactElement {
  const { t } = useI18n();
  const schemaQuery = useQuery(productSchemaQueryOptions);
  const categoriesQuery = useQuery(categoriesListQueryOptions);

  if (schemaQuery.isPending || categoriesQuery.isPending) return <EditorSkeleton />;
  if (schemaQuery.isError) return <ErrorState error={schemaQuery.error} onRetry={() => void schemaQuery.refetch()} />;
  if (categoriesQuery.isError) {
    return <ErrorState error={categoriesQuery.error} onRetry={() => void categoriesQuery.refetch()} />;
  }

  return (
    <div className="space-y-6">
      <EditorHeader heading={t("store.editor.newProduct")} />
      <ProductEditor schema={schemaQuery.data} categories={categoriesQuery.data} product={null} />
    </div>
  );
}

/** /store/products/$slug */
export function EditProductPage(): React.ReactElement {
  const { t } = useI18n();
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug ?? "";

  const schemaQuery = useQuery(productSchemaQueryOptions);
  const categoriesQuery = useQuery(categoriesListQueryOptions);
  const productQuery = useQuery(productDetailQueryOptions(slug));

  if (schemaQuery.isPending || categoriesQuery.isPending || productQuery.isPending) return <EditorSkeleton />;
  if (productQuery.isError) return <ErrorState error={productQuery.error} onRetry={() => void productQuery.refetch()} />;
  if (schemaQuery.isError) return <ErrorState error={schemaQuery.error} onRetry={() => void schemaQuery.refetch()} />;
  if (categoriesQuery.isError) {
    return <ErrorState error={categoriesQuery.error} onRetry={() => void categoriesQuery.refetch()} />;
  }

  return (
    <div className="space-y-6">
      <EditorHeader heading={productQuery.data.name || t("store.editor.untitled")} />
      <ProductEditor
        // Remount when switching products so RHF + image state reseed.
        key={productQuery.data.id}
        schema={schemaQuery.data}
        categories={categoriesQuery.data}
        product={productQuery.data}
      />
    </div>
  );
}
