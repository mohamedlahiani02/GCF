import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "../../web/src/styles/app.css";
import "./styles/portal.css";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { ApiError } from "./api/client";
import { PortalProvider } from "./auth/session";
import { I18nProvider } from "./i18n/i18n";
import { router } from "./App";

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    // A session that expired while the page was open: forget the member so the sign-in guard takes over.
    onError: (error, query) => {
      if (error instanceof ApiError && error.status === 401 && query.queryKey[0] !== "session") queryClient.setQueryData(["session"], null);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Client errors (validation, permission, not found) are answers, not outages: retrying them only delays the message.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <PortalProvider>
          <RouterProvider router={router} />
        </PortalProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
