/**
 * Serves the BUILT frontend (`frontend/dist`) with a stubbed API, so the
 * bundle under test is the one that ships while the answers behind it are
 * whatever the question needs — a logged-out visitor, a slow endpoint, a
 * failing one, progress that changes between reads.
 *
 * There is no backend on this box, so this is what makes browser-driving
 * possible at all. It is deliberately dumb: no database, no auth, no
 * validation. Anything it cannot answer returns 501, loudly, rather than
 * pretending.
 *
 * Every /api request is recorded and readable at GET /__log, which is how
 * you tell "the page re-read on navigation" from "the page looked right by
 * luck".
 */

import { join } from "node:path";

const DIST = join(import.meta.dir, "../../frontend/dist");

export interface StubScenario {
  /**
   * Path (no query string) to a handler. Return a value to send as JSON, or
   * a Response for full control. `undefined` falls through to a 501.
   */
  routes: Record<string, (req: Request) => unknown>;
  /** Artificial delay on every /api call, to make load order visible. */
  latencyMs?: number;
  port?: number;
}

export const startStubServer = (scenario: StubScenario) => {
  const log: string[] = [];
  const port = scenario.port ?? 5180;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;

      if (path === "/__log") return json({ log });

      if (path.startsWith("/api/")) {
        log.push(`${req.method} ${path}`);
        if (scenario.latencyMs) await Bun.sleep(scenario.latencyMs);
        const handler = scenario.routes[path];
        if (!handler) {
          return json({ error: `stub has no handler for ${path}` }, 501);
        }
        const result = handler(req);
        return result instanceof Response ? result : json(result);
      }

      // Static assets, then the SPA fallback for client-side routes.
      const file = Bun.file(DIST + path);
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(DIST + "/index.html"), {
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${port}`,
    /** Everything the page asked for, in order. */
    log: () => [...log],
    stop: () => server.stop(true),
  };
};

/** A logged-in user, shaped like /api/me's response. */
export const loggedIn = () => ({
  user: { id: "stub-user", given_name: "Nil" },
});
/** What /api/me returns for a visitor with no session. */
export const loggedOut = () => ({ user: null });
