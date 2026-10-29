import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Script } from "node:vm";
import { dirname, join } from "node:path";
import { LINT_KINDS } from "./edl.mjs";
import { REPO, renderKitFiles } from "./render-kit.mjs";

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

describe("the lint (--lint)", () => {
  test("it never captures: without --from-cache it stops before the browser", () => {
    const r = run("--edl", "x.json", "--lint");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--lint reads the capture cache");
  });

  test("every kind the renderer reports is in edl.mjs LINT_KINDS, and none is dead", () => {
    // fault("kind", ...) and frameZoom's report("kind", ...) on every path,
    // so read the source, not a run.
    const source = readFileSync(RENDERER, "utf8");
    const used = new Set(
      [...source.matchAll(/\b(?:fault|report)\(\s*"([a-z-]+)"/g)].map(
        (m) => m[1],
      ),
    );
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((k) => !(k in LINT_KINDS))).toEqual([]);
    expect(Object.keys(LINT_KINDS).filter((k) => !used.has(k))).toEqual([]);
  });
});

describe("the stage", () => {
  test("its script parses", () => {
    // A syntax error there shows only as a missing window.__ function in
    // the middle of a render (2026-10-29).
    const html = readFileSync(join(import.meta.dir, "stage.html"), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, code] of scripts) {
      // Compiled, not run.
      expect(() => new Script(code)).not.toThrow();
    }
  });
});

describe("make-stings.mjs --check", () => {
  test("a stings.json without a time the renderer reads is out of date", () => {
    // The state of 2026-10-29: both wavs there, stings.json from before the
    // whoosh, so the whoosh's cue time was NaN.
    const kit = mkdtempSync(join(tmpdir(), "render-stings-"));
    mkdirSync(join(kit, "scripts/game-video"), { recursive: true });
    cpSync(
      join(import.meta.dir, "make-stings.mjs"),
      join(kit, "scripts/game-video/make-stings.mjs"),
    );
    const stings = join(kit, "assets/stings");
    mkdirSync(stings, { recursive: true });
    writeFileSync(join(stings, "vs-b-riser.wav"), "");
    writeFileSync(join(stings, "vs-whoosh.wav"), "");
    const check = () =>
      spawnSync(
        "bun",
        [join(kit, "scripts/game-video/make-stings.mjs"), "--check"],
        { encoding: "utf8", timeout: 30_000 },
      );
    writeFileSync(join(stings, "stings.json"), '{"vsHitSeconds": 1.6}');
    const stale = check();
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("stings.json whooshPeakSeconds");
    const script = createHash("sha256")
      .update(readFileSync(join(kit, "scripts/game-video/make-stings.mjs")))
      .digest("hex");
    const manifest = (from: string) =>
      writeFileSync(
        join(stings, "stings.json"),
        JSON.stringify({
          vsHitSeconds: 1.6,
          whooshPeakSeconds: 1,
          script: from,
        }),
      );
    manifest(script);
    expect(check().status).toBe(0);
    // Every time there, written by another script (a time changed in the
    // script, the old stings.json kept; Video Reviewer 1, review 64).
    manifest("0".repeat(64));
    const old = check();
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("from another make-stings.mjs");
  });
});

describe("an EDL's meme sounds", () => {
  test("a sound with no file here stops it before the capture, by name", () => {
    // A kit with the renderer's code and no meme sound files: the state of
    // the 4090 before the kit sync brings a new gitignored sound.
    const kit = mkdtempSync(join(tmpdir(), "render-sounds-"));
    for (const f of renderKitFiles()) {
      mkdirSync(dirname(join(kit, f)), { recursive: true });
      cpSync(join(REPO, f), join(kit, f));
    }
    symlinkSync(join(REPO, "node_modules"), join(kit, "node_modules"));
    const edl = join(kit, "edl.json");
    writeFileSync(
      edl,
      JSON.stringify({
        version: 1,
        gameId: "eeFSMEmL",
        caption: "the bot was 97% winning",
        ending: "replay",
        events: [{ ply: 15, kind: "scared", cell: "e7", sound: "bell-2" }],
      }),
    );
    const r = spawnSync(
      "bun",
      [join(kit, "scripts/game-video/render-game-video.mjs"), "--edl", edl],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("plays meme sounds whose files are not here");
    expect(r.stderr).toContain(
      `ply 15: ${join(kit, "assets/meme-sounds/bell-2.mp3")}`,
    );
    expect(r.stderr).toContain("vsSound: ");
  });
});
