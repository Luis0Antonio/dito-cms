import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ImageIcon, LayoutGridIcon, type LucideIcon, SettingsIcon } from "lucide-react";

import { UserMenu } from "./user-menu";

import { useI18n } from "@/app/i18n";
import { projectSettingsQueryOptions } from "@/app/api/settings";
import { APP_NAME } from "@/shared/constants";
import { cn } from "@/app/lib/utils";


interface NavItem {
  to: string;
  labelKey: "nav.collections" | "nav.media" | "nav.settings";
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { to: "/collections", labelKey: "nav.collections", icon: LayoutGridIcon },
  { to: "/media", labelKey: "nav.media", icon: ImageIcon },
  { to: "/settings", labelKey: "nav.settings", icon: SettingsIcon },
];

export function Sidebar(): React.ReactElement {
  const { t } = useI18n();
  const { data: settings } = useQuery(projectSettingsQueryOptions);
  const projectName = settings?.projectName ?? APP_NAME;
  return (
    <aside className="sticky top-0 flex h-dvh w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2 px-4">
        {settings?.logo ? (
          <img src={settings.logo} alt="" className="size-6 shrink-0 rounded object-contain" />
        ) : (
          <img src="/favicon.svg" alt="" className="size-6 shrink-0" />
        )}
        <span className="truncate text-sm font-semibold">{projectName}</span>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            activeProps={{ className: cn("bg-sidebar-accent text-sidebar-accent-foreground") }}
            activeOptions={{ exact: false }}
          >
            <item.icon className="size-4" />
            {t(item.labelKey)}
          </Link>
        ))}
      </nav>
      <div className="border-t p-3">
        <UserMenu />
      </div>
    </aside>
  );
}
