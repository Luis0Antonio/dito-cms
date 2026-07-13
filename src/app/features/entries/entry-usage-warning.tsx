import { useQuery } from "@tanstack/react-query";

import { entryUsageQueryOptions } from "@/app/api/entries";
import { useI18n } from "@/app/i18n";

/**
 * Pre-delete warning listing the entries that reference `entryId`. Rendered inside a
 * delete ConfirmDialog's description; the usage query only fires while that dialog is
 * mounted (open). Mirrors the media delete-usage warning — a deleted target keeps
 * resolving to `null` for its referrers, so we surface who that affects first.
 */
export function EntryUsageWarning({ entryId }: { entryId: string }): React.ReactElement | null {
  const { t } = useI18n();
  const usage = useQuery({ ...entryUsageQueryOptions(entryId), enabled: entryId !== "" });
  const referrers = usage.data?.entries ?? [];

  if (usage.isLoading) {
    return <span className="block text-xs">{t("entries.delete.usage.checking")}</span>;
  }
  if (referrers.length === 0) return null;

  return (
    <span className="block rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
      <span className="block font-medium">
        {t(referrers.length === 1 ? "entries.delete.usage.one" : "entries.delete.usage.other", {
          count: referrers.length,
        })}
      </span>
      <span className="mt-1 block max-h-32 space-y-0.5 overflow-y-auto">
        {referrers.map((e) => (
          <span key={e.entryId} className="block">
            • {e.title} <span className="text-amber-700">({e.collectionName})</span>
          </span>
        ))}
      </span>
    </span>
  );
}
