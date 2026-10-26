/**
 * Ships a reviewed game-video commit to the release checkout (ops-private/
 * game-video-release.md), in order, stopping at the first failure. The
 * Director runs it (Nil, 2026-10-26: speed up the edits). It never pushes,
 * commits or merges, and never touches main.
 *
 *   node scripts/game-video/daily/crew.mjs ship --to <hash>
 *
 * It runs from the release checkout (~/nil/wallgame-release, detached): the
 * game-video app and the kit sync run from there, and the editors work in
 * their own worktrees. A commit reaches main only by
 * `git -C ~/nil/wallgame merge --ff-only video/<name>`, so "on main" means
 * reviewed and landed.
 *
 *   1. move     the checkout goes to <hash>: only a hash on main, and only
 *               from a detached checkout with no change at all
 *   2. kit      sync-render-kit.sh to the 4090
 *   3. hashes   each kit file on the 4090 has this checkout's sha256
 *   4. help     the 4090's renderer prints its usage line (its imports load)
 *   5. restart  the app restarts (refused while a render is queued or runs,
 *               or a post runs)
 *   6. page     /daily answers 200
 *   7. state    the day's cycle is the one from before the restart
 *
 * The 4090 is the box the app renders on: WALLGAME_GPU_HOST, from the
 * environment or the app's registered command line. The repo is public, so
 * the host is never written here.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, KIT_ENTRIES, renderKitFiles } from "../render-kit.mjs";

/**
 * The kit's files that are not code: what sync-render-kit.sh copies besides
 * the renderer's imports. A test holds this list to the script's rsync.
 */
export const KIT_DATA = [
  "scripts/game-video/stage.html",
  "frontend/public/audio/pawn.wav",
  "frontend/public/audio/wall.wav",
  "frontend/public/audio/game_start.mp3",
  "frontend/public/audio/game_end.mp3",
  "frontend/public/audio/songs",
  "assets/audio/pixel_game_essentials",
  "assets/stings",
  "assets/meme-sounds",
];

const KIT_DIR = "nil/wallgame-video";
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
/** How long the app may take to answer /daily after a restart. */
const PAGE_WAIT_MS = 60_000;

/** An ssh target: user@host characters only, and no leading "-" (an option to ssh). */
export const isHost = (value) =>
  typeof value === "string" && /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/.test(value);

/**
 * The 4090 that the app renders on: WALLGAME_GPU_HOST from `env`, or else
 * from the app's command line (`env WALLGAME_GPU_HOST=u@h node ...`).
 * Undefined unless it is a plain ssh target.
 */
export const gpuHostOf = (env, command) => {
  const host =
    env.WALLGAME_GPU_HOST ??
    /(?:^|\s)WALLGAME_GPU_HOST=(\S+)/.exec(command ?? "")?.[1];
  return isHost(host) ? host : undefined;
};

/**
 * Every file of the kit, repo-relative: the code and each file under KIT_DATA.
 * @returns {string[]}
 */
export const kitFiles = (repo = REPO) => {
  const walk = (path) =>
    statSync(join(repo, path)).isDirectory()
      ? readdirSync(join(repo, path))
          .sort()
          .flatMap((name) => walk(`${path}/${name}`))
      : [path];
  return [...renderKitFiles(KIT_ENTRIES, repo), ...KIT_DATA.flatMap(walk)];
};

/** `sha256sum -c` input for `files`, as this tree has them. */
export const checksums = (files, repo = REPO) =>
  files
    .map(
      (f) =>
        `${createHash("sha256")
          .update(readFileSync(join(repo, f)))
          .digest("hex")}  ${f}`,
    )
    .join("\n") + "\n";

const gitIn =
  (repo) =>
  (...args) =>
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

/**
 * Where the checkout at `repo` would move for `to`, or why it must not. Only
 * a commit on main ships, and only a detached checkout with no change moves:
 * a checkout on a branch is someone's work tree (main is checked out in
 * ~/nil/wallgame).
 */
export const releasePlan = (repo, to) => {
  const git = gitIn(repo);
  const hash = git("rev-parse", "--verify", "--quiet", `${to}^{commit}`);
  if (hash.status !== 0) return { ok: false, reason: `${to} is no commit` };
  const target = hash.stdout.trim();
  if (git("merge-base", "--is-ancestor", target, "main").status !== 0) {
    return {
      ok: false,
      reason: `${to} is not on main; land it with git -C ~/nil/wallgame merge --ff-only first`,
    };
  }
  if (git("symbolic-ref", "--quiet", "HEAD").status === 0) {
    return {
      ok: false,
      reason: `${repo} is on a branch; ship moves only the detached release checkout`,
    };
  }
  const status = git("status", "--porcelain", "--untracked-files=all");
  if (status.status !== 0 || status.stdout.trim()) {
    const first =
      status.status !== 0
        ? "git status failed"
        : status.stdout.trim().split("\n")[0];
    return {
      ok: false,
      reason: `${repo} has changes (${first}); the release checkout must have none`,
    };
  }
  return { ok: true, from: git("rev-parse", "HEAD").stdout.trim(), to: target };
};

/**
 * The commits between the plan's two points, one `git log --oneline` line
 * each: shipped when it moves forward, rolled back when it moves back.
 */
export const commitsOf = (repo, { from, to }) => {
  const git = gitIn(repo);
  const back = git("merge-base", "--is-ancestor", to, from).status === 0;
  const range = back ? `${to}..${from}` : `${from}..${to}`;
  const lines = git("log", "--oneline", range).stdout.trim();
  return { back, lines: lines ? lines.split("\n") : [] };
};

/** releasePlan, then the checkout. */
export const moveRelease = (repo, to) => {
  const plan = releasePlan(repo, to);
  if (!plan.ok) return plan;
  const moved = gitIn(repo)("checkout", "--quiet", "--detach", plan.to);
  if (moved.status !== 0) {
    return { ok: false, reason: `git checkout: ${moved.stderr.trim()}` };
  }
  return plan;
};

/**
 * Runs the steps on the checkout at `repo`. `office(method, path)` is
 * crew.mjs's office client and `appBase` the app's address; `say` prints one
 * line. Returns true when every step passed; on a failure it prints
 * `ship FAILED at <step>: <reason>` and stops.
 */
export const ship = async ({
  office,
  appBase,
  appName,
  to,
  repo = REPO,
  say,
}) => {
  const steps = 7;
  let n = 0;
  const ok = (name, note) => say(`ship ${++n}/${steps} ${name}: ok - ${note}`);
  const fail = (name, reason) => {
    say(`ship FAILED at ${n + 1}/${steps} ${name}: ${reason}`);
    return false;
  };
  const run = (cmd, args, input) =>
    spawnSync(cmd, args, { cwd: repo, input, encoding: "utf8" });
  const appGet = async (path) => {
    const res = await fetch(`${appBase}${path}`);
    const type = res.headers.get("content-type") ?? "";
    return {
      ok: res.ok,
      status: res.status,
      json: type.includes("json") ? await res.json() : null,
    };
  };

  // 1. move. The app must run from this checkout: else the kit would come
  // from one tree and the restarted app from another.
  const registered = await office("GET", `/api/apps/${appName}`);
  if (registered.status !== 200) {
    return fail("move", `GET /api/apps/${appName}: HTTP ${registered.status}`);
  }
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  if (real(registered.body.cwd) !== real(repo)) {
    return fail(
      "move",
      `the app runs from ${registered.body.cwd}, not from this checkout ${repo}`,
    );
  }
  const host = gpuHostOf(process.env, registered.body.command);
  if (!host) {
    return fail(
      "move",
      "no plain WALLGAME_GPU_HOST in the environment or the app's command line",
    );
  }
  const plan = releasePlan(repo, to);
  if (!plan.ok) return fail("move", plan.reason);
  const { back, lines } = commitsOf(repo, plan);
  say(
    `ship ${back ? "rolls back" : "ships"} ${lines.length} commit${lines.length === 1 ? "" : "s"}:`,
  );
  for (const line of lines) say(`  ${line}`);
  const move = moveRelease(repo, to);
  if (!move.ok) return fail("move", move.reason);
  ok(
    "move",
    move.from === move.to
      ? `already at ${move.to.slice(0, 8)}`
      : `${move.from.slice(0, 8)} -> ${move.to.slice(0, 8)}`,
  );

  // 2. kit
  const log = join(tmpdir(), `kitsync-${Date.now()}.log`);
  const sync = run("bash", ["scripts/game-video/sync-render-kit.sh", host]);
  writeFileSync(log, `${sync.stdout ?? ""}${sync.stderr ?? ""}`);
  if (sync.status !== 0) {
    const last = `${sync.stderr ?? ""}${sync.stdout ?? ""}`
      .trim()
      .split("\n")
      .at(-1);
    return fail(
      "kit",
      `sync-render-kit.sh exit ${sync.status}: ${last} (log ${log})`,
    );
  }
  ok("kit", `synced (log ${log})`);

  // 3. hashes. sha256sum --quiet prints only the files that differ, and the
  // ssh link stalls above about 1 KB of stdout, so at most 5 lines come back.
  const files = kitFiles(repo);
  const check = run(
    "ssh",
    [
      ...SSH_OPTIONS,
      host,
      `cd ${KIT_DIR} && out=$(sha256sum -c --quiet - 2>&1); s=$?; printf '%s\\n' "$out" | head -5; exit $s`,
    ],
    checksums(files, repo),
  );
  if (check.status !== 0) {
    return fail(
      "hashes",
      `the 4090 kit differs: ${(check.stdout || check.stderr).trim().split("\n").join("; ")}`,
    );
  }
  ok("hashes", `${files.length} kit files match`);

  // 4. help
  const help = run("ssh", [
    ...SSH_OPTIONS,
    host,
    `cd ${KIT_DIR} && ~/.bun/bin/bun scripts/game-video/render-game-video.mjs --help 2>&1 | head -1`,
  ]);
  const usage = (help.stdout ?? "").trim();
  if (!usage.startsWith("usage: render-game-video.mjs")) {
    return fail(
      "help",
      `the 4090 renderer did not print its usage: ${usage || help.stderr?.trim()}`,
    );
  }
  ok("help", "the 4090 renderer loads");

  // 5. restart. A restart kills a render in flight, and each render costs a
  // view of the real game.
  const noAnswer = () => ({ ok: false, status: "no answer", json: null });
  const before = await appGet("/api/daily/state").catch(noAnswer);
  if (!before.ok || !before.json) {
    return fail("restart", `GET /api/daily/state: HTTP ${before.status}`);
  }
  const cycle = before.json.cycle;
  if (cycle?.state === "rendering") {
    return fail(
      "restart",
      `the ${cycle.day} cycle is rendering; wait until it ends`,
    );
  }
  // Every render queued or running and a post in flight. An app older than
  // GET /api/daily/busy answers 404; then only the day's cycle is checked.
  const busy = await appGet("/api/daily/busy").catch(noAnswer);
  if (busy.ok && busy.json) {
    const { renders, posting } = busy.json;
    if (renders.length > 0) {
      return fail(
        "restart",
        `the app has renders: ${renders.map((r) => `${r.day} ${r.state}`).join(", ")}; wait until they end`,
      );
    }
    if (posting) {
      return fail("restart", "a post is running; wait until it ends");
    }
  } else if (busy.status === 404) {
    say(
      "ship: the running app has no /api/daily/busy yet, so only the day's cycle was checked for a render",
    );
  } else {
    return fail("restart", `GET /api/daily/busy: HTTP ${busy.status}`);
  }
  const restart = await office("POST", `/api/apps/${appName}/restart`);
  if (restart.status !== 200 && restart.status !== 204) {
    return fail(
      "restart",
      `POST /api/apps/${appName}/restart: HTTP ${restart.status}`,
    );
  }
  ok("restart", `${appName} restarted`);

  // 6. page
  const until = Date.now() + PAGE_WAIT_MS;
  let page = 0;
  while (Date.now() < until) {
    page = await appGet("/daily")
      .then((r) => r.status)
      .catch(() => 0);
    if (page === 200) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (page !== 200) {
    return fail(
      "page",
      `/daily did not answer 200 within ${PAGE_WAIT_MS / 1000} s (last ${page || "no answer"})`,
    );
  }
  ok("page", "/daily 200");

  // 7. state
  const after = await appGet("/api/daily/state").catch(noAnswer);
  const same = (c) => (c ? `${c.day} ${c.state} ${c.updatedAt}` : "none");
  if (!after.ok || !after.json) {
    return fail("state", `GET /api/daily/state: HTTP ${after.status}`);
  }
  if (same(after.json.cycle) !== same(cycle)) {
    return fail(
      "state",
      `the day's cycle changed: before ${same(cycle)}, after ${same(after.json.cycle)}`,
    );
  }
  ok(
    "state",
    cycle ? `${cycle.day} still ${cycle.state}` : "no cycle, as before",
  );
  return true;
};
