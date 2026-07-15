import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { type AnyRouter, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";

import { routeTree } from "./router";
import { createQueryClient } from "./api/query-client";
import { startDocumentHeadSync } from "./lib/document-head";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./lib/theme";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import "./styles.css";

// queryClient ↔ router are mutually referential: the 401 handler navigates via the
// router, and the router reads queryClient from its context. Resolve with a late ref.
const routerHolder: { current?: AnyRouter } = {};
const queryClient = createQueryClient(() => {
  void routerHolder.current?.navigate({ to: "/login" });
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  scrollRestoration: true,
});
routerHolder.current = router;

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Keep the browser tab title ("Dito - {projectName}") and favicon (the brand logo, when uploaded)
// in sync with project settings. Reads the settings query cache, so no fetch is forced on the
// unauthenticated login/setup pages.
startDocumentHeadSync(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={200}>
            <RouterProvider router={router} />
            <Toaster position="bottom-right" closeButton richColors />
          </TooltipProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
