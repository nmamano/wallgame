import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { puzzlesRoute } from "./routes/puzzles";
import { authRoute } from "./routes/auth";
const app = new Hono();
app.use(logger());

// The blog is generated with an SSR, so we serve it as static files.
app.use("/blog", serveStatic({ root: "./blog/_site" }));
app.get("/blog", serveStatic({ path: "./blog/_site" }));
app.use("/blog/", serveStatic({ root: "./blog/_site" }));
app.get("/blog/", serveStatic({ path: "./blog/_site" }));
app.use("/posts/*", serveStatic({ root: "./blog/_site" }));
app.get("/posts/*", serveStatic({ path: "./blog/_site" }));

const apiRoutes = app
  .basePath("/api")
  .route("/puzzles", puzzlesRoute)
  .route("/", authRoute); // /api/login, /api/register, etc.

// When users go to the main website (or any route that doesn't match an API
// route), serve the frontend.
app.get("*", serveStatic({ root: "./frontend/dist" }));
app.get("*", serveStatic({ path: "./frontend/dist/index.html" }));

console.log("Server is running");

export default app;
export type ApiRoutes = typeof apiRoutes;
