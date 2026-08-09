import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { puzzlesRoute } from "./routes/puzzles";
import { authRoute } from "./routes/auth";
import { settingsRoute } from "./routes/settings";
import { gamesRoute, botsRoute } from "./routes/games";
import { rankingRoute } from "./routes/ranking";
import { campaignRoute } from "./routes/campaign";
import { registerGameSocketRoute } from "./routes/game-socket";
import { registerCustomBotSocketRoute } from "./routes/custom-bot-socket";
import { registerEvalSocketRoute } from "./routes/eval-socket";
import { registerSeoRoutes } from "./routes/seo";
import {
  loadHtmlShell,
  registerHtmlShell,
  type HtmlShell,
} from "./routes/html-shell";

/**
 * `htmlShell` is absent in tests and in vite-backed development, where this
 * process never serves HTML. File I/O to obtain it stays in the caller.
 */
export function createApp({ htmlShell }: { htmlShell?: HtmlShell } = {}) {
  const app = new Hono();
  app.use(logger());

  // Redirect blog to external site
  app.get("/blog", (c) => {
    return c.redirect("https://nilmamano.com/blog/category/wallgame", 301);
  });
  app.get("/blog/*", (c) => {
    return c.redirect("https://nilmamano.com/blog/category/wallgame", 301);
  });

  // Must precede the catch-alls at the bottom, which would otherwise answer
  // both of these with the SPA shell and a 200.
  registerSeoRoutes(app);

  const apiRoutes = app
    .basePath("/api")
    .route("/puzzles", puzzlesRoute)
    .route("/settings", settingsRoute)
    .route("/games", gamesRoute)
    .route("/bots", botsRoute)
    .route("/ranking", rankingRoute)
    .route("/campaign", campaignRoute)
    .route("/", authRoute); // /api/login, /api/register, etc.

  const websocket = registerGameSocketRoute(app);
  registerCustomBotSocketRoute(app);
  registerEvalSocketRoute(app);

  // Anything under /api that no route above claimed. Without this the catch-alls
  // below answer a mistyped or removed endpoint with the SPA shell and a 200, so
  // a caller has to parse HTML to discover that it failed.
  //
  // Registered on `app` rather than on the /api chain: that chain's type is
  // ApiRoutes, which the frontend's RPC client is generic over, and a wildcard
  // route in it would widen the paths the client believes exist. Order is what
  // makes it a fallback - Hono runs matching handlers in registration order and
  // stops at the first response, so every real route above still wins. `all`
  // rather than `get` so a wrong method on a real path answers the same way; it
  // was already a 404, but Hono's default one, in text/plain.
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // When users go to the main website (or any route that doesn't match an API
  // route), serve the frontend.
  // Ahead of the static handlers, and it defers to them for anything that
  // looks like a file. It cannot sit after them: the static handler resolves
  // "/" to dist/index.html as a directory index, so the homepage would never
  // reach this and would keep the template's generic title.
  if (htmlShell) registerHtmlShell(app, htmlShell);
  app.get("*", serveStatic({ root: "./frontend/dist" }));
  app.get("*", serveStatic({ path: "./frontend/dist/index.html" }));

  return { app, websocket, apiRoutes };
}

// Only when this file is the process being run, never when a test imports it
// for createApp: loading the shell throws if the frontend was not built, and
// the test suite runs before the build.
const { app, websocket } = createApp(
  import.meta.main ? { htmlShell: loadHtmlShell() } : {},
);

console.log("Server is running");

export default {
  fetch: app.fetch,
  websocket,
};
export type ApiRoutes = ReturnType<typeof createApp>["apiRoutes"];
