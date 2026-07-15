import type { QueryClient } from "@tanstack/react-query";

import { settingsKeys } from "../api/settings";

import { APP_NAME } from "@/shared/constants";
import type { ProjectSettings } from "@/shared/api-types";

const DEFAULT_FAVICON_HREF = "/favicon.svg";
const DEFAULT_FAVICON_TYPE = "image/svg+xml";

/**
 * The browser tab title: `Dito - {projectName}`. When the project name is still the built-in
 * default (APP_NAME, "Dito CMS") we show the bare app name instead, to avoid "Dito - Dito CMS".
 */
function documentTitle(projectName: string | undefined): string {
  const name = (projectName ?? "").trim();
  return !name || name === APP_NAME ? APP_NAME : `Dito - ${name}`;
}

/**
 * Point the favicon at the brand logo when one is set, otherwise the bundled default. The logo is
 * a self-contained data URL or an http(s) URL (see ProjectSettings.logo). The <link> node is
 * replaced rather than mutated so every browser re-fetches; skipped when the href is unchanged.
 */
function applyFavicon(logo: string | null): void {
  const href = logo || DEFAULT_FAVICON_HREF;
  const existing = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (existing?.getAttribute("href") === href) return;

  const link = document.createElement("link");
  link.rel = "icon";
  if (logo) {
    // Set the type from a data URL's own mime; for http(s) URLs let the browser sniff it.
    const mime = /^data:(image\/[\w.+-]+)[;,]/.exec(logo)?.[1];
    if (mime) link.type = mime;
  } else {
    link.type = DEFAULT_FAVICON_TYPE;
  }
  link.href = href;
  existing?.remove();
  document.head.appendChild(link);
}

function sync(queryClient: QueryClient): void {
  const settings = queryClient.getQueryData<ProjectSettings>(settingsKeys.all);
  document.title = documentTitle(settings?.projectName);
  applyFavicon(settings?.logo ?? null);
}

/**
 * Keep the browser tab title and favicon in sync with project settings: the title becomes
 * `Dito - {projectName}` and the favicon becomes the uploaded brand logo (falling back to the
 * bundled favicon when none is set).
 *
 * Reads from the query cache only — it never triggers a fetch — so the unauthenticated login/setup
 * pages don't request admin settings. It re-syncs whenever the settings query lands or changes
 * (e.g. an admin edits the name/logo), and once up front in case the cache is already warm.
 */
export function startDocumentHeadSync(queryClient: QueryClient): void {
  queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] === settingsKeys.all[0]) sync(queryClient);
  });
  sync(queryClient);
}
