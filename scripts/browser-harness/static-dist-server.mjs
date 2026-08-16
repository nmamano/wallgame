/**
 * Serves the BUILT frontend (`frontend/dist`) over plain node, with the SPA
 * fallback a client-side router needs and a stubbed /api.
 *
 * `stub-server.ts` does the same job for the Bun-run harness scripts. This is
 * the node twin, because the `.mjs` instruments in this directory are run with
 * `node`, and reaching for `Bun.serve` in one of them makes it a bun script
 * that only looks like its neighbours - and trips `no-undef` for everyone
 * sharing the checkout, since eslint lints this directory for the whole repo.
 *
 * Deliberately dumb: no database, no auth, no validation. Anything under /api
 * that is not explicitly answered returns 501 rather than pretending.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/**
 * @param dist absolute path to the built frontend
 * @param routes exact /api paths to answer, each returning a JSON-able value
 * @returns {{ url: string, stop: () => Promise<void> }}
 */
export const startStaticDistServer = async (dist, { port, routes = {} }) => {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;

    const send = (status, type, body) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };

    if (path.startsWith("/api/")) {
      const handler = routes[path];
      if (!handler) {
        return send(501, "application/json", JSON.stringify({ error: path }));
      }
      return send(200, "application/json", JSON.stringify(handler()));
    }

    readFile(join(dist, path))
      .then((body) =>
        send(200, TYPES[extname(path)] ?? "application/octet-stream", body),
      )
      // Any miss is a client-side route: hand back the shell.
      .catch(() =>
        readFile(join(dist, "index.html")).then((body) =>
          send(200, "text/html", body),
        ),
      );
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
};
