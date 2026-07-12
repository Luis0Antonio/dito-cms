import { Link, Outlet } from "@tanstack/react-router";

import { useI18n } from "@/app/i18n";
import { PageHeader } from "@/app/components/common/page-header";
import { cn } from "@/app/lib/utils";

export function SettingsLayout(): React.ReactElement {
  const { t } = useI18n();

  const TABS = [
    { to: "/settings/general", labelKey: "settings.tabs.general" as const },
    { to: "/settings/users", labelKey: "settings.tabs.users" as const },
    { to: "/settings/api-keys", labelKey: "settings.tabs.apiKeys" as const },
    { to: "/settings/agents", labelKey: "settings.tabs.agents" as const },
    { to: "/settings/deploy", labelKey: "settings.tabs.deploy" as const },
    { to: "/settings/import-export", labelKey: "settings.tabs.importExport" as const },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t("settings.title")} />
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
