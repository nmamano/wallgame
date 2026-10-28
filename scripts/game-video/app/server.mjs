/**
 * The game-video app: Nil's review of the daily videos, and the routes the
 * director's crew.mjs, Wall Game Growth and the slot poster use.
 *
 * Opening the app (/) shows the review page (../daily/review.mjs): the
 * videos that wait for Nil. Everything else lives in ../daily/routes.mjs:
 * /review, /api/review/*, /daily, /daily/sounds, /daily/connect and
 * /api/daily/*. Its renders run on the 4090, not here.
 *
 * Until 2026-10-28 "/" was a page that rendered a pasted game link on this
 * box (board task f89e649f). Nil had not used it since 2026-08-20 and asked
 * for it to go ("you can nuke it", via the Wall Game Director): it went with
 * its routes /api/render, /api/status and /api/video. Its old renders stay
 * in the app's data folder (renders/, work/).
 *
 * Run it through isomux, which allocates the port and keeps it alive:
 *   cwd     /home/nil/nil/wallgame
 *   command node scripts/game-video/app/server.mjs
 *
 * It never picks a port: PORT comes from isomux, and the app refuses to
 * start without it rather than guess one and collide with something.
 */
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaily } from "../daily/routes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * PLUMBING, for the tests rather than for a person: daily.test.ts points
 * --daily-renderer at a stub 4090 step and shortens its deadline.
 */
const plumbing = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 ? process.argv[at + 1] : undefined;
};

const PORT = Number(process.env.PORT);
if (!Number.isFinite(PORT) || PORT <= 0) {
  console.error(
    "PORT is not set. This app is meant to be registered with isomux, which " +
      "allocates the port:\n" +
      '  curl -s -X POST localhost:4000/api/apps ... -d \'{"name":"game-video",' +
      '"command":"node scripts/game-video/app/server.mjs","cwd":"~/nil/wallgame"}\'',
  );
  process.exit(2);
}

/**
 * Where the app keeps its data. Isomux supplies a directory that survives
 * restarts; the local fallback exists so the app can be run by hand while
 * developing.
 */
const DATA_DIR = process.env.ISOMUX_APP_DATA_DIR
  ? resolve(process.env.ISOMUX_APP_DATA_DIR)
  : resolve(HERE, "app-data");
if (!process.env.ISOMUX_APP_DATA_DIR) {
  console.warn(`ISOMUX_APP_DATA_DIR is not set; keeping data in ${DATA_DIR}`);
}

const daily = createDaily({
  dataDir: DATA_DIR,
  ...(plumbing("daily-renderer") && {
    renderer: resolve(plumbing("daily-renderer")),
  }),
  ...(plumbing("daily-deadline-ms") && {
    deadlineMs: Number(plumbing("daily-deadline-ms")),
  }),
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (await daily.handle(req, res, url)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "no such path" }));
});

// A daily render runs in its own process group; stop it with the app, so its
// adapter can stop the render on the 4090 rather than leave it running.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    daily.stop();
    setTimeout(() => process.exit(0), 2000);
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`game-video app listening on ${PORT}`);
});
