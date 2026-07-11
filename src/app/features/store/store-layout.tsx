import { Link, Outlet } from "@tanstack/react-router";

import { useI18n } from "@/app/i18n";
import { PageHeader } from "@/app/components/common/page-header";
import { cn } from "@/app/lib/utils";

// Tabbed shell for the Store section (Products / Categories / Fields), mirroring the
// Settings layout. The product editor is a separate full page (it renders outside this shell).
export function StoreLayout(): React.ReactElement {
  const { t } = useI18n();

  const TABS = [
    { to: "/store/products", labelKey: "store.tabs.products" as const },
    { to: "/store/categories", labelKey: "store.tabs.categories" as const },
    { to: "/store/schema", labelKey: "store.tabs.schema" as const },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t("nav.store")} />
      <div className="flex gap-1 border-b">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            activeProps={{ className: cn("border-primary text-foreground") }}
          >
            {t(tab.labelKey)}
          </Link>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
