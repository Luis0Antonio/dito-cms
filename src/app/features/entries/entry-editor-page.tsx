import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import { EntryEditor } from "./entry-editor";
import { titleFromValue } from "./form-values";

import { collectionDetailQueryOptions } from "@/app/api/collections";
import { entryDetailQueryOptions } from "@/app/api/entries";
import { projectSettingsQueryOptions, toLocaleConfig } from "@/app/api/settings";
import { ErrorState } from "@/app/components/common/error-state";
import { Skeleton } from "@/app/components/ui/skeleton";

function EditorSkeleton(): React.ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-9 w-56" />
      <div className="space-y-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}

function EditorHeader({
  slug,
  name,
  heading,
}: {
  slug: string;
  name: string;
  heading: string;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <Link
        to="/collections/$slug"
        params={{ slug }}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← {name}
      </Link>
      <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
    </div>
  );
}

/** /collections/$slug/entries/new */
export function NewEntryPage(): React.ReactElement {
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug ?? "";
  const collectionQuery = useQuery(collectionDetailQueryOptions(slug));
  const settingsQuery = useQuery(projectSettingsQueryOptions);

  if (collectionQuery.isPending || settingsQuery.isPending) return <EditorSkeleton />;
  if (collectionQuery.isError) {
    return <ErrorState error={collectionQuery.error} onRetry={() => void collectionQuery.refetch()} />;
  }
  if (settingsQuery.isError) {
    return <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />;
  }

  const collection = collectionQuery.data;
  const localeConfig = toLocaleConfig(settingsQuery.data);

  return (
    <div className="space-y-6">
      <EditorHeader slug={slug} name={collection.name} heading="New entry" />
      <EntryEditor collection={collection} entry={null} localeConfig={localeConfig} />
    </div>
  );
}

/** /collections/$slug/entries/$id */
export function EditEntryPage(): React.ReactElement {
  const params = useParams({ strict: false }) as { slug?: string; id?: string };
  const slug = params.slug ?? "";
  const id = params.id ?? "";

  const collectionQuery = useQuery(collectionDetailQueryOptions(slug));
  const entryQuery = useQuery(entryDetailQueryOptions(id));
  const settingsQuery = useQuery(projectSettingsQueryOptions);

  if (collectionQuery.isPending || entryQuery.isPending || settingsQuery.isPending) {
    return <EditorSkeleton />;
  }
  if (collectionQuery.isError) {
    return <ErrorState error={collectionQuery.error} onRetry={() => void collectionQuery.refetch()} />;
  }
  if (entryQuery.isError) {
    return <ErrorState error={entryQuery.error} onRetry={() => void entryQuery.refetch()} />;
  }
  if (settingsQuery.isError) {
    return <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />;
  }

  const collection = collectionQuery.data;
  const entry = entryQuery.data;
  const localeConfig = toLocaleConfig(settingsQuery.data);
  const heading =
    (collection.titleField ? titleFromValue(entry.draftData[collection.titleField], localeConfig) : "") ||
    "Edit entry";

  return (
    <div className="space-y-6">
      <EditorHeader slug={slug} name={collection.name} heading={heading} />
      <EntryEditor collection={collection} entry={entry} localeConfig={localeConfig} />
    </div>
  );
}
