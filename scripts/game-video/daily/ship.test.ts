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
  ship,
} from "./ship.mjs";

const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/**
 * main with two commits; the release checkout detached at the first; an
 * editor branch with a commit that is not on main yet.
 */
const repos = () => {
  const root = mkdtempSync(join(tmpdir(), "ship-test-"));
  const main = join(root, "main");
  const release = join(root, "release");
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
  return { root, main, release, git, first, second, unlanded };
};

describe("ship", () => {
  test("the release checkout moves only to a commit on main, and only when clean and detached", () => {
    const { root, main, release, git, first, second, unlanded } = repos();

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
    // With or without -k (sync-render-kit.sh sends symlinked folders as
    // folders since Video Editor (renderer)'s review 16).
    const start = script.search(/rsync -a( -k)? --relative/);
    expect(start).toBeGreaterThan(-1);
    const rsync = script.slice(start, script.indexOf('"$host:$kit/"'));
    const copied = rsync
      .split("\n")
      .slice(1)
      .map((line) => line.trim().replace(/\s*\\$/, ""))
      .filter((arg) => arg && arg !== '"${code_files[@]}"');
    expect(copied).toEqual(KIT_DATA);
  });

  // ship runs under node, so the calls run in node; CI without node skips.
  const hasNode = spawnSync("node", ["--version"]).status === 0;
  test.skipIf(!hasNode)(
    "an app call after a long spawnSync gets an answer (the first ship, 2026-10-26)",
    async () => {
      // The app in its own process, as in production: a spawnSync in ship
      // must not also stop the app's keep-alive timer. Its keep-alive is 3 s
      // (the real app's is 5 s) and ship blocks for 4 s, as a kit sync does.
      const server = `
      import { createServer } from "node:http";
      const s = createServer((req, res) => {
        res.writeHead(req.url === "/api/daily/busy" ? 404 : 200,
          { "content-type": "application/json" });
        res.end('{"cycle":null}');
      });
      s.keepAliveTimeout = 3000;
      s.listen(0, "127.0.0.1", () => console.log(s.address().port));`;
      // ship runs under node (crew.mjs), whose fetch keeps sockets; bun's
      // fetch is another client, so the calls run in node too. "bare" is
      // the old call (a plain fetch, body read), logged for comparison.
      const client = (mode: string, port: string) => `
      import { spawnSync } from "node:child_process";
      import { appGet } from ${JSON.stringify(new URL("./ship.mjs", import.meta.url).href)};
      const base = "http://127.0.0.1:${port}";
      const get = ${JSON.stringify(mode)} === "bare"
        ? async (p) => { const r = await fetch(base + p); await r.text(); return r; }
        : (p) => appGet(base, p);
      await get("/api/daily/state");
      await get("/api/daily/busy");
      spawnSync("sleep", ["4"]);
      try { console.log((await get("/api/daily/state")).status); }
      catch (e) { console.log(e.cause?.code ?? e.message); }`;
      const node = (code: string) =>
        Bun.spawn(["node", "--input-type=module", "-e", code], {
          stdout: "pipe",
        });
      const app = node(server);
      const reader = app.stdout.getReader();
      const port = new TextDecoder().decode((await reader.read()).value).trim();
      try {
        const [fixed, bare] = await Promise.all(
          ["fixed", "bare"].map(async (mode) => {
            const p = node(client(mode, port));
            return (await new Response(p.stdout).text()).trim();
          }),
        );
        expect(fixed).toBe("200");
        // Information only: whether this node's fetch still fails the old
        // way depends on its undici and on timing, so it is not asserted.
        console.log(`ship keep-alive test: a plain fetch gave ${bare}`);
      } finally {
        app.kill();
      }
    },
    20_000,
  );

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

  describe("the steps, with a fake app and a fake 4090", () => {
    /** The app as ship sees it: its state, its busy route, its restarts. */
    const fakeApp = (cwd: string) => {
      const app = {
        cycle: {
          day: "2026-10-26",
          state: "rendered",
          updatedAt: "t1",
        } as Record<string, string> | null,
        renders: [] as { day: string; jobId: string; state: string }[],
        restarts: 0,
        hashExit: 0,
      };
      const server = Bun.serve({
        port: 0,
        fetch: (req) => {
          const path = new URL(req.url).pathname;
          if (path === "/api/daily/state") {
            return Response.json({ cycle: app.cycle });
          }
          if (path === "/api/daily/busy") {
            return Response.json({ renders: app.renders, posting: false });
          }
          if (path === "/daily") return new Response("<html>");
          return new Response("no", { status: 404 });
        },
      });
      const office = (method: string, path: string) => {
        if (method === "POST" && path.endsWith("/restart")) app.restarts++;
        return Promise.resolve({
          status: 200,
          body: { cwd, command: "env WALLGAME_GPU_HOST=u@box node x.mjs" },
        });
      };
      const calls: string[] = [];
      const run = (cmd: string, args: string[]) => {
        const last = args[args.length - 1];
        calls.push(
          cmd === "bash"
            ? "sync"
            : last.includes("sha256sum")
              ? "hashes"
              : "help",
        );
        if (cmd === "bash") return { status: 0, stdout: "ok", stderr: "" };
        if (last.includes("sha256sum")) {
          return {
            status: app.hashExit,
            stdout: app.hashExit ? "x.mjs: FAILED" : "",
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: "usage: render-game-video.mjs --game <id>",
          stderr: "",
        };
      };
      return { app, server, office, run, calls };
    };
    const go = async (
      release: string,
      to: string,
      fake: ReturnType<typeof fakeApp>,
    ) => {
      const lines: string[] = [];
      const passed = await ship({
        office: fake.office,
        appBase: `http://127.0.0.1:${fake.server.port}`,
        appName: "game-video",
        to,
        repo: release,
        say: (line: string) => lines.push(line),
        // Only status, stdout and stderr are read from a run.
        run: fake.run as unknown as Parameters<typeof ship>[0]["run"],
        listKit: () => [],
      });
      return { passed, lines };
    };

    test("a render in the app stops ship before anything moves", async () => {
      const { root, release, git, first, second } = repos();
      const fake = fakeApp(release);
      fake.app.renders = [{ day: "2026-10-26", jobId: "j", state: "queued" }];
      const { passed, lines } = await go(release, second, fake);
      expect(passed).toBe(false);
      expect(lines.at(-1)).toBe(
        "ship FAILED at 1/7 move: the app has renders: 2026-10-26 queued; wait until they end",
      );
      expect(git(release, "rev-parse", "HEAD")).toBe(first);
      expect(fake.calls).toEqual([]);
      expect(fake.app.restarts).toBe(0);
      void fake.server.stop();
      rmSync(root, { recursive: true });
    });

    test("a ship that passes moves, syncs, checks and restarts once", async () => {
      const { root, release, git, second } = repos();
      const fake = fakeApp(release);
      const { passed, lines } = await go(release, second, fake);
      expect(passed).toBe(true);
      expect(lines[0]).toBe("ship ships 1 commit:");
      expect(lines[1]).toMatch(/^ {2}[0-9a-f]{7} two$/);
      expect(lines.slice(2).map((l) => l.split(":")[0])).toEqual([
        "ship 1/7 move",
        "ship 2/7 kit",
        "ship 3/7 hashes",
        "ship 4/7 help",
        "ship 5/7 restart",
        "ship 6/7 page",
        "ship 7/7 state",
      ]);
      expect(git(release, "rev-parse", "HEAD")).toBe(second);
      expect(fake.calls).toEqual(["sync", "hashes", "help"]);
      expect(fake.app.restarts).toBe(1);
      void fake.server.stop();
      rmSync(root, { recursive: true });
    });

    test("a failure after the move says where the checkout and the app are", async () => {
      const { root, release, git, first, second } = repos();
      const fake = fakeApp(release);
      fake.app.hashExit = 1;
      const { passed, lines } = await go(release, second, fake);
      expect(passed).toBe(false);
      const [now, old] = [second.slice(0, 8), first.slice(0, 8)];
      expect(lines.at(-1)).toBe(
        `ship FAILED at 3/7 hashes: the 4090 kit differs: x.mjs: FAILED - the release checkout is now at ${now}, and the app still runs ${old} until a restart: fix it and run ship --to ${now} again, or ship --to ${old} to go back`,
      );
      expect(fake.app.restarts).toBe(0);
      // The same hash again goes on from "already at".
      fake.app.hashExit = 0;
      const again = await go(release, second, fake);
      expect(again.passed).toBe(true);
      expect(again.lines).toContain(`ship 1/7 move: ok - already at ${now}`);
      expect(again.lines.join("\n")).not.toContain("commits:");
      expect(git(release, "rev-parse", "HEAD")).toBe(second);
      void fake.server.stop();
      rmSync(root, { recursive: true });
    });

    test("a render that starts after the move stops the restart", async () => {
      const { root, release, second } = repos();
      const fake = fakeApp(release);
      const run = fake.run;
      fake.run = (cmd: string, args: string[]) => {
        if (cmd === "bash") {
          fake.app.renders = [
            { day: "2026-10-26", jobId: "j", state: "running" },
          ];
        }
        return run(cmd, args);
      };
      const { passed, lines } = await go(release, second, fake);
      expect(passed).toBe(false);
      expect(lines.at(-1)).toMatch(
        /^ship FAILED at 5\/7 restart: the app has renders: 2026-10-26 running; wait until they end - the release checkout is now at /,
      );
      expect(fake.app.restarts).toBe(0);
      void fake.server.stop();
      rmSync(root, { recursive: true });
    });

    test("a restart request that gets no answer says where the checkout is", async () => {
      const { root, release, second } = repos();
      const fake = fakeApp(release);
      const office = fake.office;
      fake.office = (method: string, path: string) =>
        method === "POST"
          ? Promise.reject(new Error("fetch failed"))
          : office(method, path);
      const { passed, lines } = await go(release, second, fake);
      expect(passed).toBe(false);
      expect(lines.at(-1)).toMatch(
        /^ship FAILED at 5\/7 restart: POST \/api\/apps\/game-video\/restart: HTTP no answer \(fetch failed\) - the release checkout is now at /,
      );
      void fake.server.stop();
      rmSync(root, { recursive: true });
    });
  });
});
