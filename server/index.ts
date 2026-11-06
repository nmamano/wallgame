/**
 * The process entrypoint: build the app, hand it to Bun, bind a port.
 *
 * The app itself lives in app.ts. Keeping the name index.ts is what confines
 * the split to this repo: package.json's `start` and `dev` still name this
 * file, and the Dockerfile runs `start`.
 */

import { createApp } from "./app";
import { loadHtmlShell } from "./routes/html-shell";
import { startSessionMaintenance } from "./games/session-maintenance";
import { hasGameConnections } from "./routes/game-socket";
import { startBgsJanitor } from "./routes/bgs-janitor";

// Unconditional, where this was gated on `import.meta.main` to keep it away
// from tests. Nothing imports this file for its exports now, and dev is
// unaffected: loadHtmlShell() returns undefined when FRONTEND_URL is set.
// A backstop: Bun ends the process on an uncaught error or an unhandled
// rejection, and with it every game in memory. One bad request must cost at
// most its own socket, so these log and keep serving. The handlers that can
// fail catch their own errors first; a line here is a bug to fix.
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandled rejection", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[process] uncaught exception", error);
});

const { app, websocket } = createApp({ htmlShell: loadHtmlShell() });
startSessionMaintenance(hasGameConnections);
startBgsJanitor();

console.log("Server is running");

export default {
  fetch: app.fetch,
  websocket,
};
