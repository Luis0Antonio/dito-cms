import { queryOptions } from "@tanstack/react-query";

import { api } from "./client";

import type { LocaleConfig } from "@/shared/localization";
import type { ProjectSettings } from "@/shared/api-types";

export const settingsKeys = {
  all: ["admin-settings"] as const,
};

export const projectSettingsQueryOptions = queryOptions({
  queryKey: settingsKeys.all,
  queryFn: () => api.get<ProjectSettings>("/api/admin/settings"),
  staleTime: 30_000,
});

export function updateProjectSettings(body: Partial<ProjectSettings>): Promise<ProjectSettings> {
  return api.patch<ProjectSettings>("/api/admin/settings", body);
}

/** The content-locale config (locales + default) carried by project settings. */
export function toLocaleConfig(settings: ProjectSettings): LocaleConfig {
  return { locales: settings.contentLocales, default: settings.defaultLocale };
}
