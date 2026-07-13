import {
  createRootRouteWithContext,
  createRoute,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import { sessionQueryOptions } from "./api/session";
import { setupStatusQueryOptions } from "./api/system";
import { projectSettingsQueryOptions } from "./api/settings";
import { AppShell } from "./components/layout/app-shell";
import { LoginPage } from "./features/auth/login-page";
import { SetupPage } from "./features/auth/setup-page";
import { CollectionsListPage } from "./features/collections/collections-list-page";
import { SchemaBuilderPage } from "./features/collections/builder/schema-builder-page";
import { CollectionPage } from "./features/entries/collection-page";
import { NewEntryPage, EditEntryPage } from "./features/entries/entry-editor-page";
import { ContactFormsPage } from "./features/contact-forms/contact-forms-page";
import { MediaPage } from "./features/media/media-page";
import { StoreLayout } from "./features/store/store-layout";
import { ProductsListPage } from "./features/store/products-list-page";
import { CategoriesPage } from "./features/store/categories-page";
import { ProductSchemaPage } from "./features/store/product-schema-page";
import { NewProductPage, EditProductPage } from "./features/store/product-editor-page";
import { SettingsLayout } from "./features/settings/settings-layout";
import { GeneralSettingsPage } from "./features/settings/general-page";
import { UsersPage } from "./features/settings/users-page";
import { ApiKeysPage } from "./features/settings/api-keys-page";
import { AgentsPage } from "./features/settings/agents-page";
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

// Forms gate: the contact-forms section is hidden unless the module is enabled.
const ensureFormsEnabled = async ({
  context,
}: {
  context: RouterContext;
}): Promise<void> => {
  const settings = await context.queryClient.ensureQueryData(projectSettingsQueryOptions);
  if (!settings.formsEnabled) throw redirect({ to: "/collections" });
};

const contactFormsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/contact-forms",
  component: ContactFormsPage,
  staticData: { title: "Contact forms" },
  beforeLoad: ensureFormsEnabled,
});

// Commerce gate: the whole Store section is hidden unless the module is enabled.
const ensureCommerceEnabled = async ({
  context,
}: {
  context: RouterContext;
}): Promise<void> => {
  const settings = await context.queryClient.ensureQueryData(projectSettingsQueryOptions);
  if (!settings.commerceEnabled) throw redirect({ to: "/collections" });
};

const storeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/store",
  component: StoreLayout,
  staticData: { title: "Store" },
  beforeLoad: ensureCommerceEnabled,
});

const storeIndexRoute = createRoute({
  getParentRoute: () => storeRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/store/products" });
  },
});

const storeProductsRoute = createRoute({
  getParentRoute: () => storeRoute,
  path: "products",
  component: ProductsListPage,
});

const storeCategoriesRoute = createRoute({
  getParentRoute: () => storeRoute,
  path: "categories",
  component: CategoriesPage,
});

const storeSchemaRoute = createRoute({
  getParentRoute: () => storeRoute,
  path: "schema",
  component: ProductSchemaPage,
});

// The product editor is a full page (outside the tabbed Store shell).
const newProductRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/store/products/new",
  component: NewProductPage,
  staticData: { title: "New product" },
  beforeLoad: ensureCommerceEnabled,
});

const editProductRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/store/products/$slug",
  component: EditProductPage,
  staticData: { title: "Product" },
  beforeLoad: ensureCommerceEnabled,
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

const agentsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "agents",
  component: AgentsPage,
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
    storeRoute.addChildren([
      storeIndexRoute,
      storeProductsRoute,
      storeCategoriesRoute,
      storeSchemaRoute,
    ]),
    newProductRoute,
    editProductRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      generalSettingsRoute,
      usersRoute,
      apiKeysRoute,
      agentsRoute,
      importExportRoute,
      deployRoute,
    ]),
  ]),
]);
