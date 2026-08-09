/**
 * The process entrypoint: build the app, hand it to Bun, bind a port.
 *
 * The app itself lives in app.ts. Keeping the name index.ts is what confines
 * the split to this repo: package.json's `start` and `dev` still name this
 * file, and the Dockerfile runs `start`.
 */

import { createApp } from "./app";
import { loadHtmlShell } from "./routes/html-shell";

// Unconditional, where this was gated on `import.meta.main` to keep it away
// from tests. Nothing imports this file for its exports now, and dev is
// unaffected: loadHtmlShell() returns undefined when FRONTEND_URL is set.
const { app, websocket } = createApp({ htmlShell: loadHtmlShell() });

console.log("Server is running");

export default {
  fetch: app.fetch,
  websocket,
};
