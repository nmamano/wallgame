import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { puzzlesRoute } from "./routes/puzzles";
const app = new Hono();
app.use(logger());

app.use("/blog", serveStatic({ root: "./blog/_site" }));
app.get("/blog", serveStatic({ path: "./blog/_site" }));
app.use("/blog/", serveStatic({ root: "./blog/_site" }));
app.get("/blog/", serveStatic({ path: "./blog/_site" }));
app.use("/posts/*", serveStatic({ root: "./blog/_site" }));
app.get("/posts/*", serveStatic({ path: "./blog/_site" }));

app.get("/", (c) => {
  return c.html(`
    <h1>Hello! Wall Game is under construction.</h1>
    <p>Visit the <a href="/blog">blog</a>.</p>
  `);
});

app.route("/api/puzzles", puzzlesRoute);

console.log("Server is running");
export default app;
