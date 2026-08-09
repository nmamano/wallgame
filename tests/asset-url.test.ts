import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { joinAssetPath } from "../frontend/src/lib/asset-url";

/**
 * `joinAssetPath` is the part of `assetUrl` that does not read
 * `import.meta.env.BASE_URL`, so it can be tested outside Vite. `assetUrl` itself
 * is one line on top of it.
 *
 * The scan below is the gate that matters. Vite rewrites the asset paths it can
 * see - ES imports and `index.html` - but not a string the app builds at runtime,
 * and a leading-slash string is only correct while the app is served from the
 * root of its origin. Measured 2026-08-09 at ca390c8, serving `frontend/dist`
 * under `/embed/wall-game/`: the logo, six sound effects and the music all 404.
 */

const SRC = join(import.meta.dir, "../frontend/src");

/** Every path prefix that names a file in `frontend/public/`. */
const ASSET_PREFIXES = [
  "/audio/",
  "/pawns/",
  "/time_control_icons/",
  "/logo.png",
  "/board-coordinates.png",
  "/starting-position.png",
  "/og-image.png",
  "/favicon/",
  "/replays/",
];

/** The helper itself is where the literal "/" base legitimately lives. */
const EXEMPT = ["lib/asset-url.ts"];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe("joinAssetPath", () => {
  test("is a no-op shape at the root, where the site actually runs", () => {
    expect(joinAssetPath("/", "/logo.png")).toBe("/logo.png");
  });

  test("prefixes a subdirectory mount", () => {
    expect(joinAssetPath("/embed/wall-game/", "/audio/pawn.wav")).toBe(
      "/embed/wall-game/audio/pawn.wav",
    );
  });

  test("handles a relative base without doubling the slash", () => {
    expect(joinAssetPath("./", "/logo.png")).toBe("./logo.png");
  });

  test("accepts a path with or without its leading slash", () => {
    expect(joinAssetPath("/base/", "logo.png")).toBe("/base/logo.png");
    expect(joinAssetPath("/base/", "/logo.png")).toBe("/base/logo.png");
  });

  test("tolerates a base that forgot its trailing slash", () => {
    expect(joinAssetPath("/base", "/logo.png")).toBe("/base/logo.png");
  });
});

describe("no source file builds a root-absolute asset path", () => {
  const violations: string[] = [];

  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (EXEMPT.includes(rel.replaceAll("\\", "/"))) continue;
    const text = readFileSync(file, "utf8");

    for (const prefix of ASSET_PREFIXES) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(prefix, from);
        if (at === -1) break;
        from = at + 1;
        const before = text.slice(Math.max(0, at - 24), at);
        // Only a path that STARTS a string literal is a URL the app will
        // request; the same characters inside prose are just a comment naming
        // a directory.
        if (!/["'`]$/.test(before)) continue;
        // And it is fine as long as it is being handed to assetUrl().
        if (/assetUrl\(\s*["'`]$/.test(before)) continue;
        const line = text.slice(0, at).split("\n").length;
        violations.push(`${rel}:${String(line)} ${prefix}`);
      }
    }
  }

  test("every one of them goes through assetUrl", () => {
    expect(violations).toEqual([]);
  });
});
