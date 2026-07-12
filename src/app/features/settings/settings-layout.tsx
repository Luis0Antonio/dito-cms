import { Outlet, useRouterState } from "@tanstack/react-router";

import { useI18n } from "@/app/i18n";
import type { TranslationKey } from "@/app/i18n/translations/es";
import { PageHeader } from "@/app/components/common/page-header";

// Thin shell for Settings. Navigation now lives in the sidebar (a collapsible group), so this only
// renders the header for the active sub-page — its title mirrors the sidebar entry. The Store
// settings page (/settings/store) is itself gated by the commerce toggle at the route level.
const TITLES: { path: string; labelKey: TranslationKey }[] = [
  { path: "/settings/general", labelKey: "settings.tabs.general" },
  { path: "/settings/users", labelKey: "settings.tabs.users" },
  { path: "/settings/api-keys", labelKey: "settings.tabs.apiKeys" },
  { path: "/settings/deploy", labelKey: "settings.tabs.deploy" },
  { path: "/settings/store", labelKey: "settings.tabs.store" },
  { path: "/settings/import-export", labelKey: "settings.tabs.importExport" },
];

export function SettingsLayout(): React.ReactElement {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = TITLES.find((x) => pathname.startsWith(x.path));

  return (
    <div className="space-y-6">
      <PageHeader title={t(active?.labelKey ?? "settings.title")} />
      <Outlet />
    </div>
  );
}
