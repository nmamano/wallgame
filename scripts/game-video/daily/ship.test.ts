import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "../render-kit.mjs";
import {
  KIT_DATA,
  checksums,
  commitsOf,
  gpuHostOf,
  kitFiles,
  moveRelease,
} from "./ship.mjs";

describe("ship", () => {
  test("the release checkout moves only to a commit on main, and only when clean and detached", () => {
    // main with two commits; the release checkout detached at the first; an
    // editor branch with a commit that is not on main yet.
    const root = mkdtempSync(join(tmpdir(), "ship-test-"));
    const main = join(root, "main");
    const release = join(root, "release");
    const git = (dir: string, ...args: string[]) => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    spawnSync("git", ["init", "-q", "-b", "main", main]);
    git(main, "config", "user.email", "t@t");
    git(main, "config", "user.name", "t");
    const commit = (text: string) => {
      writeFileSync(join(main, "f.txt"), text);
      git(main, "add", "f.txt");
      git(main, "commit", "-q", "-m", text);
      return git(main, "rev-parse", "HEAD");
    };
    const first = commit("one");
    const second = commit("two");
    git(main, "worktree", "add", "-q", "--detach", release, first);
    git(main, "checkout", "-q", "-b", "video/x");
    const unlanded = commit("three");
    git(main, "checkout", "-q", "main");

    const refused = (dir: string, to: string) => {
      const r = moveRelease(dir, to) as { ok: boolean; reason?: string };
      expect(r.ok).toBe(false);
      return r.reason ?? "";
    };
    expect(refused(release, unlanded)).toMatch(/is not on main/);
    expect(refused(release, "nope")).toMatch(/nope is no commit/);
    // main itself is on a branch: ship never moves it.
    expect(refused(main, first)).toMatch(/is on a branch/);
    writeFileSync(join(release, "new.txt"), "x");
    expect(refused(release, second)).toMatch(/has changes \(\?\? new.txt\)/);
    rmSync(join(release, "new.txt"));

    // The commits it ships, and back again.
    expect(commitsOf(release, { from: first, to: second })).toEqual({
      back: false,
      lines: [`${second.slice(0, 7)} two`],
    });
    expect(commitsOf(release, { from: second, to: first })).toEqual({
      back: true,
      lines: [`${second.slice(0, 7)} two`],
    });
    expect(commitsOf(release, { from: first, to: first }).lines).toEqual([]);

    expect(moveRelease(release, second.slice(0, 8))).toEqual({
      ok: true,
      from: first,
      to: second,
    });
    expect(git(release, "rev-parse", "HEAD")).toBe(second);
    expect(readFileSync(join(release, "f.txt"), "utf8")).toBe("two");
    // main and its files did not move.
    expect(git(main, "rev-parse", "HEAD")).toBe(second);
    expect(git(main, "status", "--porcelain")).toBe("");
    // An older commit of main is allowed (a rollback is a ship too).
    expect(moveRelease(release, first)).toMatchObject({ ok: true, to: first });
    rmSync(root, { recursive: true });
  });

  test("the GPU host is a plain ssh target, from the env or the app's command line", () => {
    const command = "env WALLGAME_GPU_HOST=nilo@box-1 node scripts/x.mjs";
    expect(gpuHostOf({}, command)).toBe("nilo@box-1");
    expect(gpuHostOf({ WALLGAME_GPU_HOST: "me@other" }, command)).toBe(
      "me@other",
    );
    // A value a shell or ssh would read as more than a host is refused, from
    // either place.
    expect(
      gpuHostOf({}, "env WALLGAME_GPU_HOST=a@b;rm node x"),
    ).toBeUndefined();
    expect(
      gpuHostOf({}, "env WALLGAME_GPU_HOST=-oProxyCommand=x node"),
    ).toBeUndefined();
    expect(gpuHostOf({ WALLGAME_GPU_HOST: "-oX" }, command)).toBeUndefined();
    expect(gpuHostOf({}, "node x")).toBeUndefined();
    expect(gpuHostOf({}, undefined)).toBeUndefined();
  });

  test("KIT_DATA is what sync-render-kit.sh copies besides the code", () => {
    const script = readFileSync(
      join(REPO, "scripts/game-video/sync-render-kit.sh"),
      "utf8",
    );
    const rsync = script.slice(
      script.indexOf("rsync -a --relative"),
      script.indexOf('"$host:$kit/"'),
    );
    const copied = rsync
      .split("\n")
      .slice(1)
      .map((line) => line.trim().replace(/\s*\\$/, ""))
      .filter((arg) => arg && arg !== '"${code_files[@]}"');
    expect(copied).toEqual(KIT_DATA);
  });

  test("the checksums pass sha256sum -c on this tree", () => {
    const files = kitFiles();
    expect(files).toContain("scripts/game-video/render-game-video.mjs");
    expect(files).toContain("scripts/game-video/stage.html");
    const sample = files.filter((f) => f.endsWith(".mjs")).slice(0, 5);
    const check = spawnSync("sha256sum", ["-c", "--quiet", "-"], {
      cwd: REPO,
      input: checksums(sample),
      encoding: "utf8",
    });
    expect(check.status).toBe(0);
    expect(check.stdout).toBe("");
  });
});
