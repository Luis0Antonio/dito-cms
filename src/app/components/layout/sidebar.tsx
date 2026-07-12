import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRightIcon,
  ImageIcon,
  LayoutGridIcon,
  type LucideIcon,
  SettingsIcon,
  ShoppingBagIcon,
} from "lucide-react";

import { UserMenu } from "./user-menu";

import { useI18n } from "@/app/i18n";
import { projectSettingsQueryOptions } from "@/app/api/settings";
import { APP_NAME } from "@/shared/constants";
import { cn } from "@/app/lib/utils";

interface NavChild {
  to: string;
  label: string;
}

// A single flat destination (Collections, Media).
function NavLink({ to, icon: Icon, label }: { to: string; icon: LucideIcon; label: string }): React.ReactElement {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      activeProps={{ className: cn("bg-sidebar-accent text-sidebar-accent-foreground") }}
      activeOptions={{ exact: false }}
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </Link>
  );
}

// A collapsible section (Store, Settings) whose children are the destinations. The header toggles
// expansion; it does not navigate. Initial open state follows the active route so a deep link into
// a child lands with its section already expanded; after mount the user's manual toggle sticks
// (the Sidebar lives in AppShell and persists across client-side navigation).
function NavGroup({
  icon: Icon,
  label,
  basePath,
  items,
}: {
  icon: LucideIcon;
  label: string;
  basePath: string;
  items: NavChild[];
}): React.ReactElement {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const sectionActive = pathname === basePath || pathname.startsWith(`${basePath}/`);
  const [open, setOpen] = useState(sectionActive);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          sectionActive && "text-foreground",
        )}
      >
        <Icon className="size-4 shrink-0" />
        <span className="flex-1 text-left">{label}</span>
        <ChevronRightIcon className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="mt-1 ml-4 space-y-1 border-l border-sidebar-border pl-2">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="block rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              activeProps={{ className: cn("bg-sidebar-accent text-sidebar-accent-foreground") }}
              activeOptions={{ exact: false }}
            >
              {item.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar(): React.ReactElement {
  const { t } = useI18n();
  const { data: settings } = useQuery(projectSettingsQueryOptions);
  const projectName = settings?.projectName ?? APP_NAME;
  const commerce = settings?.commerceEnabled ?? false;

  // Store settings live under Settings but are gated by the commerce toggle, like the Store section.
  const settingsItems: NavChild[] = [
    { to: "/settings/general", label: t("settings.tabs.general") },
    { to: "/settings/users", label: t("settings.tabs.users") },
    { to: "/settings/api-keys", label: t("settings.tabs.apiKeys") },
    { to: "/settings/deploy", label: t("settings.tabs.deploy") },
    ...(commerce ? [{ to: "/settings/store", label: t("settings.tabs.store") }] : []),
    { to: "/settings/import-export", label: t("settings.tabs.importExport") },
  ];

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
        <NavLink to="/collections" icon={LayoutGridIcon} label={t("nav.collections")} />
        <NavLink to="/media" icon={ImageIcon} label={t("nav.media")} />
        {/* The Store section is only shown when the commerce module is enabled. Orders first. */}
        {commerce ? (
          <NavGroup
            icon={ShoppingBagIcon}
            label={t("nav.store")}
            basePath="/store"
            items={[
              { to: "/store/orders", label: t("store.tabs.orders") },
              { to: "/store/products", label: t("store.tabs.products") },
              { to: "/store/categories", label: t("store.tabs.categories") },
              { to: "/store/schema", label: t("store.tabs.schema") },
            ]}
          />
        ) : null}
        <NavGroup
          icon={SettingsIcon}
          label={t("nav.settings")}
          basePath="/settings"
          items={settingsItems}
        />
      </nav>
      <div className="border-t p-3">
        <UserMenu />
      </div>
    </aside>
  );
}
