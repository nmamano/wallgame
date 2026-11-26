// First: a module below parses a schema while it loads (zod-jitless.ts).
import "./lib/zod-jitless";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { installNavigationReporting, browserReporter } from "./lib/analytics";
import { browserStorage } from "./lib/browser-storage";
import { rememberVideoItem } from "./lib/puzzle-events";
import { resetStalePreferences } from "./lib/preference-reset";
import { RESETTABLE_GAME_SETUP_KEYS } from "./hooks/use-settings";
import { isEmbedded, markEmbeddedDocument } from "./lib/embedded-mode";

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

// Before the first render, so a portal frame never paints a selectable page.
markEmbeddedDocument(isEmbedded(), document.body);

// From https://tanstack.com/query/latest/docs/framework/react/quick-start
const queryClient = new QueryClient();

// From https://tanstack.com/router/latest/docs/framework/react/quick-start
// Route code is split per page (vite.config.ts). "intent": a link loads its
// page's code on hover or touch, so the click seldom waits for it.
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
});
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

/**
 * A daily video's /go/<n> link lands here with the video's item in the query
 * (shared/domain/video-puzzles.ts). Kept for this tab, so the puzzle events
 * can name the video after Solve it has replaced the landing URL.
 */
rememberVideoItem(window.location.search, browserStorage("session"));

/**
 * Once the first page shows, the other pages' code loads in idle time, so a
 * later click does not wait for it on a slow connection (board task
 * f23b28a4). The first page needs only its own code before it can show; the
 * total download stays about the same (508 kB gzip after idle against 483 kB
 * as one file, 2026-11-06), in a different order.
 *
 * Except the game page's code (the largest chunk, with the game's sounds):
 * it loads in idle time only on a page that starts a game, where the next
 * click is likely to open one (task 42c3ae3a, Wall Game PM 2026-11-26). The
 * home page and the other pages load no game code until a game opens.
 */
type RouteId = keyof typeof router.routesById;
// Typed by the router's own ids, so a renamed route is a compile error here.
const GAME_ROUTE: RouteId = "/game/$id";
const GAME_STARTING_ROUTES: readonly RouteId[] = [
  "/play",
  "/puzzles/",
  "/puzzles/$id",
  "/puzzle/game/$gameId/$ply",
];
const idle = (task: () => void) => {
  if ("requestIdleCallback" in window) window.requestIdleCallback(task);
  else setTimeout(task, 1);
};
// A chunk that a later deploy removed fails here and again when its page
// opens; there the router reloads the tab once to get the new build
// (lazyRouteComponent), so a preload drops the error.
const preloadChunk = (id: RouteId) => {
  router.loadRouteChunk(router.routesById[id])?.catch(() => undefined);
};
const stopPreloadWatch = router.subscribe("onResolved", () => {
  stopPreloadWatch();
  idle(() => {
    for (const id of Object.keys(router.routesById) as RouteId[]) {
      if (id !== GAME_ROUTE) preloadChunk(id);
    }
  });
});
const stopGamePreloadWatch = router.subscribe("onResolved", () => {
  const onGameStartingPage = router.state.matches.some((match) =>
    GAME_STARTING_ROUTES.includes(match.routeId),
  );
  if (!onGameStartingPage) return;
  stopGamePreloadWatch();
  idle(() => preloadChunk(GAME_ROUTE));
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
