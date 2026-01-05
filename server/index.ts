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
export function createApp() {
  const app = new Hono();
  app.use(logger());

  // Redirect blog to external site
  app.get("/blog", (c) => {
    return c.redirect("https://nilmamano.com/blog/category/wallgame", 301);
  });
  app.get("/blog/*", (c) => {
    return c.redirect("https://nilmamano.com/blog/category/wallgame", 301);
  });

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

  // When users go to the main website (or any route that doesn't match an API
  // route), serve the frontend.
  app.get("*", serveStatic({ root: "./frontend/dist" }));
  app.get("*", serveStatic({ path: "./frontend/dist/index.html" }));

  return { app, websocket, apiRoutes };
}

const { app, websocket } = createApp();

console.log("Server is running");

export default {
  fetch: app.fetch,
  websocket,
};
export type ApiRoutes = ReturnType<typeof createApp>["apiRoutes"];
