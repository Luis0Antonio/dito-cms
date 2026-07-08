import {
  createRootRouteWithContext,
  createRoute,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import { sessionQueryOptions } from "./api/session";
import { setupStatusQueryOptions } from "./api/system";
import { AppShell } from "./components/layout/app-shell";
import { LoginPage } from "./features/auth/login-page";
import { SetupPage } from "./features/auth/setup-page";
import { CollectionsListPage } from "./features/collections/collections-list-page";
import { SchemaBuilderPage } from "./features/collections/builder/schema-builder-page";
import { CollectionPage } from "./features/entries/collection-page";
import { NewEntryPage, EditEntryPage } from "./features/entries/entry-editor-page";
import { ContactFormsPage } from "./features/contact-forms/contact-forms-page";
import { MediaPage } from "./features/media/media-page";
import { SettingsLayout } from "./features/settings/settings-layout";
import { GeneralSettingsPage } from "./features/settings/general-page";
import { UsersPage } from "./features/settings/users-page";
import { ApiKeysPage } from "./features/settings/api-keys-page";
import { ImportExportPage } from "./features/settings/import-export-page";
import { DeploySettingsPage } from "./features/settings/deploy-page";
import { NotFoundPage } from "./features/misc/not-found-page";

export interface RouterContext {
  queryClient: QueryClient;
}

// Per-route document titles (the deepest matched route with a title wins; applied in main.tsx).
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    title?: string;
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: NotFoundPage,
});

// First-run only: redirect away once an admin exists.
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
  staticData: { title: "Set up" },
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(setupStatusQueryOptions);
    if (status.initialized) throw redirect({ to: "/login" });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
  staticData: { title: "Sign in" },
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(setupStatusQueryOptions);
    if (!status.initialized) throw redirect({ to: "/setup" });
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);
    if (session?.user) throw redirect({ to: "/collections" });
  },
});

// Authenticated shell. All protected routes hang off this.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(setupStatusQueryOptions);
    if (!status.initialized) throw redirect({ to: "/setup" });
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);
    if (!session?.user) throw redirect({ to: "/login" });
  },
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/collections" });
  },
});

const collectionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/collections",
  component: CollectionsListPage,
  staticData: { title: "Collections" },
});

const collectionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/collections/$slug",
  component: CollectionPage,
  staticData: { title: "Collection" },
});

const collectionSchemaRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/collections/$slug/schema",
  component: SchemaBuilderPage,
  staticData: { title: "Schema" },
});

const newEntryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/collections/$slug/entries/new",
  component: NewEntryPage,
  staticData: { title: "New entry" },
});

const editEntryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/collections/$slug/entries/$id",
  component: EditEntryPage,
  staticData: { title: "Edit entry" },
});

const mediaRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/media",
  component: MediaPage,
  staticData: { title: "Media" },
});

const contactFormsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contact-forms",
  component: ContactFormsPage,
  staticData: { title: "Contact forms" },
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsLayout,
  staticData: { title: "Settings" },
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/general" });
  },
});

const generalSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "general",
  component: GeneralSettingsPage,
});

const usersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "users",
  component: UsersPage,
});

const apiKeysRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "api-keys",
  component: ApiKeysPage,
});

const importExportRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "import-export",
  component: ImportExportPage,
});

const deployRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "deploy",
  component: DeploySettingsPage,
});

export const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    collectionsRoute,
    collectionRoute,
    collectionSchemaRoute,
    newEntryRoute,
    editEntryRoute,
    contactFormsRoute,
    mediaRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      generalSettingsRoute,
      usersRoute,
      apiKeysRoute,
      importExportRoute,
      deployRoute,
    ]),
  ]),
]);
