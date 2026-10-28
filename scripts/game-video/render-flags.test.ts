import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RENDERER = join(import.meta.dir, "render-game-video.mjs");

/** The renderer's exit code and stderr for a command line. */
const run = (...args: string[]) => {
  const r = spawnSync("bun", [RENDERER, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: r.status, stderr: r.stderr };
};

describe("the renderer's flags", () => {
  test("a word that is not its flag stops it before the browser", () => {
    // An old kit without --from-cache captured live: a real view.
    const bogus = run("--edl", "x.json", "--from-cach");
    expect(bogus.status).toBe(2);
    expect(bogus.stderr).toContain(
      "--from-cach is not a flag of this renderer",
    );
    expect(bogus.stderr).toMatch(/Known: .*--from-cache /);
    expect(run("stray").stderr).toContain("stray is not a flag");
    // A switch takes no value.
    expect(run("--from-cache", "x").stderr).toContain("x is not a flag");
  });

  test("--help prints the usage line that ship checks, and stops", () => {
    // daily/ship.mjs (step "help") runs `--help 2>&1 | head -1` on the
    // 4090 and needs this start; the release runbook does the same.
    const r = spawnSync("bun", [RENDERER, "--help", "--edl", "none.json"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n")[0]).toStartWith("usage: render-game-video.mjs");
  });

  test("a flag that takes a value needs one", () => {
    const r = run("--from-cache", "--plies");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--plies needs a value");
    expect(run("--edl", "--from-cache").stderr).toContain(
      "--edl needs a value",
    );
  });

  test("every name the renderer reads is in FLAGS", () => {
    // Some readers run only on some paths, so read the source, not a run.
    const source = readFileSync(RENDERER, "utf8");
    const block = /const FLAGS = \{([^}]*)\}/.exec(source)![1];
    const flags = new Set(
      [...block.matchAll(/"?([a-z0-9-]+)"?:\s*"(value|switch)"/g)].map(
        (m) => m[1],
      ),
    );
    const read = new Set(
      [...source.matchAll(/\b(?:cliArg|arg|flag)\(\s*"([a-z0-9-]+)"/g)].map(
        (m) => m[1],
      ),
    );
    expect(read.size).toBeGreaterThan(15);
    expect([...read].filter((n) => !flags.has(n))).toEqual([]);
    // And no listed flag is dead.
    expect([...flags].filter((n) => !read.has(n))).toEqual([]);
  });
});
