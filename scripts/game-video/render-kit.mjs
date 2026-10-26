/**
 * The code files of the 4090 render kit (sync-render-kit.sh), derived from
 * the renderer's imports so that a new module cannot be left behind (Wall
 * Game PM, 2026-10-26: stamp-spot.mjs was missing from the hand-kept list,
 * and a sync without it would have broken every render).
 *
 * From each entry, every relative import (static, re-export or a literal
 * dynamic import) is followed through the whole graph. Paths are relative
 * to the repo root, sorted.
 *
 *   bun scripts/game-video/render-kit.mjs   prints them, one per line
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The files the kit runs: the renderer, and make-stings.mjs, which the
 * renderer starts as its own process when the riser is not built yet.
 */
export const KIT_ENTRIES = [
  "scripts/game-video/render-game-video.mjs",
  "scripts/game-video/make-stings.mjs",
];

const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
const EXTENSIONS = ["", ".ts", ".mjs", ".js", "/index.ts", "/index.mjs"];

/** The relative imports of one file, as absolute paths. Throws on one that resolves to no file. */
const importsOf = (file) => {
  const out = [];
  for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
    const base = resolve(dirname(file), m[1]);
    const hit = EXTENSIONS.map((e) => base + e).find(
      (p) => existsSync(p) && !p.endsWith("/"),
    );
    if (!hit) {
      throw new Error(
        `${relative(REPO, file)} imports ${m[1]}, which is no file`,
      );
    }
    out.push(hit);
  }
  return out;
};

/** Every code file the kit needs, repo-relative and sorted. */
export const renderKitFiles = (entries = KIT_ENTRIES, repo = REPO) => {
  const seen = new Set();
  const todo = entries.map((e) => join(repo, e));
  while (todo.length > 0) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    todo.push(...importsOf(file));
  }
  return [...seen].map((f) => relative(repo, f)).sort();
};

if (import.meta.main) {
  console.log(renderKitFiles().join("\n"));
}
