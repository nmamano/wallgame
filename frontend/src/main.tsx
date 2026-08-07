import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { installNavigationReporting, browserReporter } from "./lib/analytics";
import { resetStalePreferences } from "./lib/preference-reset";
import { RESETTABLE_GAME_SETUP_KEYS } from "./hooks/use-settings";

/**
 * Retire a stored game setup that predates the current defaults, once per
 * browser. GUESTS only - a signed-in player's setup lives in the database and
 * is untouched by this; see `preference-reset.ts` for why that scope is
 * deliberate.
 *
 * Here, at module scope, because it has to happen BEFORE anything reads those
 * keys - `useLocalStorageState` seeds itself from storage in its initializer,
 * so a reset inside a component or an effect would arrive after the value it
 * was meant to replace had already been read.
 *
 * Storage can be unreadable in some privacy modes, which the function reports
 * rather than throws; there is nothing to do about it here beyond not caring.
 */
resetStalePreferences(
  (() => {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  })(),
  RESETTABLE_GAME_SETUP_KEYS,
);

// From https://tanstack.com/query/latest/docs/framework/react/quick-start
const queryClient = new QueryClient();

// From https://tanstack.com/router/latest/docs/framework/react/quick-start
const router = createRouter({ routeTree, context: { queryClient } });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/**
 * Analytics only sees full document loads on its own, so every in-app
 * navigation is reported here. Installed at module scope rather than in an
 * effect: StrictMode double-invokes effects, and two subscriptions would mean
 * two events per navigation. Module initialisation happens once.
 *
 * Hot reloading is the other way to accumulate subscriptions, so development
 * disposes of it explicitly.
 */
const stopNavigationReporting = installNavigationReporting(
  router,
  browserReporter,
  window.location.origin,
);
import.meta.hot?.dispose(() => {
  stopNavigationReporting();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
