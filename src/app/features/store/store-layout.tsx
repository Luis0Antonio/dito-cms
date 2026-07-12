import { Outlet, useRouterState } from "@tanstack/react-router";

import { useI18n } from "@/app/i18n";
import type { TranslationKey } from "@/app/i18n/translations/es";
import { PageHeader } from "@/app/components/common/page-header";

// Thin shell for the Store section. Navigation now lives in the sidebar (a collapsible group), so
// this only renders the header for the active sub-page — its title mirrors the sidebar entry. The
// product editor and order detail are separate full pages (they render outside this shell).
const TITLES: { path: string; labelKey: TranslationKey }[] = [
  { path: "/store/orders", labelKey: "store.tabs.orders" },
  { path: "/store/products", labelKey: "store.tabs.products" },
  { path: "/store/categories", labelKey: "store.tabs.categories" },
  { path: "/store/schema", labelKey: "store.tabs.schema" },
];

export function StoreLayout(): React.ReactElement {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = TITLES.find((x) => pathname.startsWith(x.path));

  return (
    <div className="space-y-6">
      <PageHeader title={t(active?.labelKey ?? "nav.store")} />
      <Outlet />
    </div>
  );
}
