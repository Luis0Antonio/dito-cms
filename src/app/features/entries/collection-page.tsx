import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { SlidersHorizontalIcon } from "lucide-react";

import { EntriesListPage } from "./entries-list-page";
import { EntryEditor } from "./entry-editor";

import { collectionDetailQueryOptions } from "@/app/api/collections";
import { singletonEntryQueryOptions } from "@/app/api/entries";
import { projectSettingsQueryOptions, toLocaleConfig } from "@/app/api/settings";
import { useI18n } from "@/app/i18n";
import { Button } from "@/app/components/ui/button";
import { ErrorState } from "@/app/components/common/error-state";
import { Skeleton } from "@/app/components/ui/skeleton";
import type { CollectionDetail } from "@/shared/api-types";

function PageSkeleton(): React.ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function SingletonEditor({ collection }: { collection: CollectionDetail }): React.ReactElement {
  const { t } = useI18n();
  const entryQuery = useQuery(singletonEntryQueryOptions(collection.slug));
  const settingsQuery = useQuery(projectSettingsQueryOptions);

  if (entryQuery.isPending || settingsQuery.isPending) return <PageSkeleton />;
  if (entryQuery.isError) {
    return <ErrorState error={entryQuery.error} onRetry={() => void entryQuery.refetch()} />;
  }
  if (settingsQuery.isError) {
    return <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />;
  }

  const entry = entryQuery.data;
  const localeConfig = toLocaleConfig(settingsQuery.data);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link to="/collections" className="text-sm text-muted-foreground hover:text-foreground">
          {t("collection.backToCollections")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{collection.name}</h1>
            {collection.description ? (
              <p className="text-sm text-muted-foreground">{collection.description}</p>
            ) : null}
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/collections/$slug/schema" params={{ slug: collection.slug }}>
              <SlidersHorizontalIcon className="size-4" />
              {t("collection.schema")}
            </Link>
          </Button>
        </div>
      </div>
      <EntryEditor collection={collection} entry={entry} localeConfig={localeConfig} hideBack />
    </div>
  );
}

/** /collections/$slug — collection → entries table; singleton → its editor directly. */
export function CollectionPage(): React.ReactElement {
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug ?? "";
  const { data: collection, isPending, isError, error, refetch } = useQuery(
    collectionDetailQueryOptions(slug),
  );

  if (isPending) return <PageSkeleton />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return collection.type === "singleton" ? (
    <SingletonEditor collection={collection} />
  ) : (
    <EntriesListPage collection={collection} />
  );
}
