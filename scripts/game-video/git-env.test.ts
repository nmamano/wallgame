import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FALLBACK_LOCAL_VARS, GIT_LOCAL_VARS, gitEnv } from "./git-env.mjs";
import { REPO } from "./render-kit.mjs";
import { testTmp } from "./test-tmp";

/** This file's temp dirs, removed after its tests (cb84d862). */
const TEST_TMP = testTmp();

/** Every file under `dir` with the sha256 of its bytes, by its path. */
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        out[relative(dir, path)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
    }
  };
  walk(dir);
  return out;
};

describe("git commands never follow a hook's GIT_DIR (task 8d8bf577)", () => {
  test("gitEnv drops every variable git calls local to a repository", () => {
    const env = gitEnv({
      PATH: "/bin",
      HOME: "/h",
      GIT_DIR: "/x/.git",
      GIT_WORK_TREE: "/x",
      GIT_INDEX_FILE: "/x/.git/index",
      GIT_COMMON_DIR: "/x/.git",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_AUTHOR_NAME: "kept: not about which repository",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      GIT_AUTHOR_NAME: "kept: not about which repository",
    });
    // The list is git's own; the fallback has each name git gives today.
    expect(GIT_LOCAL_VARS).toContain("GIT_DIR");
    expect(
      GIT_LOCAL_VARS.filter((v) => !FALLBACK_LOCAL_VARS.includes(v)),
    ).toEqual([]);
  });

  test("the fixture tests, run with GIT_DIR on a decoy repository as a hook runs them, leave the decoy as it was", () => {
    const decoy = TEST_TMP.dir("git-env-decoy-");
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", decoy, ...args], {
        encoding: "utf8",
        env: gitEnv(),
      });
    git("init", "-q", "-b", "main");
    writeFileSync(join(decoy, "f.txt"), "decoy");
    git("add", "f.txt");
    git(
      "-c",
      "user.name=d",
      "-c",
      "user.email=d@d",
      "commit",
      "-q",
      "-m",
      "decoy",
    );
    const before = snapshot(decoy);

    const run = (file: string, only: string) =>
      spawnSync(process.execPath, ["test", file, "-t", only], {
        cwd: REPO,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: join(decoy, ".git"),
          GIT_WORK_TREE: decoy,
          GIT_INDEX_FILE: join(decoy, ".git", "index"),
        },
      });
    const ship = run(
      "scripts/game-video/daily/ship.test.ts",
      "release checkout moves|the steps",
    );
    expect(ship.status, ship.stderr.slice(-2000)).toBe(0);
    expect(ship.stderr).toMatch(/[1-9]\d* pass/);
    const daily = run(
      "scripts/game-video/daily/daily.test.ts",
      "script drafts the file",
    );
    expect(daily.status, daily.stderr.slice(-2000)).toBe(0);
    expect(daily.stderr).toMatch(/[1-9]\d* pass/);

    expect(snapshot(decoy)).toEqual(before);
  }, 120_000);
});
