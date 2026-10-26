/**
 * The per-game capture cache (item B; Wall Game Director, 2026-10-26).
 *
 * Every load of a game's replay page adds a view to a real player's game, so
 * a daily render saves what it took from that page here, and a later render
 * with --from-cache reads it back and never opens the page: the replay record
 * (as the server sent it, before the seat colours are forced), the board
 * screenshot of every position, the two portraits, and the measurements
 * (board box, cell rects, seat cards, accents, pawn and wall spots).
 *
 * One cache serves every daily list of a game: the start ply, pace, events
 * and aspect change only the composition. What changes the captured pixels
 * is `inputs` (the forced seat colours, the grey start walls, the board
 * theme, the browser, the capture scale), and a read refuses a cache whose
 * inputs differ. Each file is stored with its sha256 and checked on read.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/**
 * The format version. A cache of an older version is refused, with the
 * reason when one is known (OLD_VERSIONS).
 */
const VERSION = 2;
const OLD_VERSIONS = {
  // 2026-10-26: version 1 holds no walls on the boards after a walls-only move.
  1: "written before the walls-only fix",
};
const sha256Of = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * A saved capture, as the renderer holds it. File paths are absolute.
 *
 * @typedef {{
 *   inputs: Record<string, unknown>,
 *   capturedAt: string,
 *   replay: unknown,
 *   cards: unknown[],
 *   accents: Record<string, number[]>,
 *   portraits: Record<string, string>,
 *   boardBox: unknown,
 *   cellRects: unknown,
 *   capture: {
 *     records: { expectedPly: number, committedPly: number, file: string, sha256: string }[],
 *     expected: unknown, committed: unknown, omissions: unknown[],
 *     duplicates: unknown[], reordered: boolean, mismatches: unknown[],
 *   },
 *   pawnSpots: Map<number, unknown>,
 *   wallSpots: Map<number, unknown>,
 * }} Capture
 */

/**
 * Save a capture under `dir`, replacing any older one. The files are written
 * to a sibling folder first and moved in at the end, so a reader never sees
 * half a cache.
 *
 * @param {string} dir
 * @param {Capture} c
 */
export function writeCaptureCache(dir, c) {
  const staging = `${dir}.writing`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const files = {};
  const keep = (from) => {
    const name = basename(from);
    copyFileSync(from, join(staging, name));
    files[name] = sha256Of(from);
    return name;
  };
  const meta = {
    version: VERSION,
    inputs: c.inputs,
    capturedAt: c.capturedAt,
    replay: c.replay,
    cards: c.cards,
    accents: c.accents,
    portraits: Object.fromEntries(
      Object.entries(c.portraits).map(([id, file]) => [id, keep(file)]),
    ),
    boardBox: c.boardBox,
    cellRects: c.cellRects,
    capture: {
      ...c.capture,
      records: c.capture.records.map((r) => ({ ...r, file: keep(r.file) })),
    },
    pawnSpots: [...c.pawnSpots],
    wallSpots: [...c.wallSpots],
    files,
  };
  writeFileSync(join(staging, "capture.json"), JSON.stringify(meta));
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
}

/**
 * Read the capture under `dir` for a render with `inputs`. Throws, with a
 * line a person can act on, when there is no cache, when it was made with
 * other inputs, or when a file is missing or changed. File paths come back
 * absolute; the spots come back as Maps keyed by board index.
 *
 * @param {string} dir
 * @param {Record<string, unknown>} inputs
 * @returns {Capture}
 */
export function readCaptureCache(dir, inputs) {
  const metaFile = join(dir, "capture.json");
  if (!existsSync(metaFile)) {
    throw new Error(
      `no capture cache at ${dir}: a daily render of this game writes one`,
    );
  }
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  if (meta.version !== VERSION) {
    throw new Error(
      `the capture cache at ${dir} is version ${meta.version}, not ${VERSION}` +
        (OLD_VERSIONS[meta.version] ? ` (${OLD_VERSIONS[meta.version]})` : "") +
        ": re-capture it from a live render (once without --from-cache)",
    );
  }
  for (const key of new Set([
    ...Object.keys(inputs),
    ...Object.keys(meta.inputs),
  ])) {
    if (meta.inputs[key] !== inputs[key]) {
      throw new Error(
        `the capture cache at ${dir} was made with ${key}=${JSON.stringify(meta.inputs[key])}, and this render needs ${JSON.stringify(inputs[key])}`,
      );
    }
  }
  for (const [name, sha] of Object.entries(meta.files)) {
    const file = join(dir, name);
    if (!existsSync(file) || sha256Of(file) !== sha) {
      throw new Error(
        `the capture cache at ${dir} has a missing or changed file: ${name}`,
      );
    }
  }
  return {
    ...meta,
    portraits: Object.fromEntries(
      Object.entries(meta.portraits).map(([id, name]) => [id, join(dir, name)]),
    ),
    capture: {
      ...meta.capture,
      records: meta.capture.records.map((r) => ({
        ...r,
        file: join(dir, r.file),
      })),
    },
    pawnSpots: new Map(meta.pawnSpots),
    wallSpots: new Map(meta.wallSpots),
  };
}

/**
 * Keep the `keep` newest game caches under `root` and delete the others, so
 * a daily render a day does not fill the disk (a game's boards are about
 * 10-20 MB). Newest by the time its capture.json was written. Returns the
 * names it deleted.
 *
 * @param {string} root
 * @param {number} keep
 * @returns {string[]}
 */
export function pruneCaptureCaches(root, keep) {
  const games = readdirSync(root, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && existsSync(join(root, d.name, "capture.json")),
    )
    .map((d) => ({
      name: d.name,
      at: statSync(join(root, d.name, "capture.json")).mtimeMs,
    }))
    .sort((a, b) => b.at - a.at);
  const old = games.slice(keep).map((g) => g.name);
  for (const name of old)
    rmSync(join(root, name), { recursive: true, force: true });
  return old;
}
