/**
 * The office box's half of a daily render: send one job to the 4090, run the
 * renderer there, and bring the MP4 back.
 *
 * Board task e8d26610, step 3. ALL RENDERING RUNS ON THE 4090 (Nil,
 * 2026-10-25). This file renders nothing; the renderer is step 2's (Wall Game
 * Worker 2). The contract, agreed with Worker 2 on 2026-10-26:
 *
 *   edl.json  the director's edit decision list (scripts/game-video/edl.mjs,
 *             Worker 2's contract v1 of 2026-10-26): game, caption, ending,
 *             pace and events. It is the whole job.
 *   The renderer runs from the render kit on the 4090 (RENDER_KIT, which
 *   scripts/game-video/sync-render-kit.sh fills), under desktop-run, as
 *     bun <kit>/scripts/game-video/render-game-video.mjs --edl <edl.json>
 *       --out <out.mp4> --log <render.log> --encoder nvenc
 *   With --log its stdout is one line,
 *     RESULT {"mp4","bytes","sha256","durationSeconds","effect","sound",
 *             "music","ending","edlSha256","sheet":{"png","sha256","stills"}}
 *   The list picks the music (edl.music, a cue list); with none the
 *   renderer picks one track that may play at random. RESULT.music is the
 *   cue list it played, each cue with `at` (its second in the video).
 *   The sheet is the contact sheet from the same capture: one still per
 *   event of the list. It comes back with the MP4.
 *   which desktop-run appends to the job's log. desktop-run appends exit=N to
 *   the job's meta file when the render ends.
 *
 * WHY IT IS SHAPED LIKE THIS.
 * - The job travels as a FILE on ssh's stdin. The caption and the player names
 *   are untrusted text, and a file never passes through a remote shell's
 *   parser. Only paths built from a job id that matched JOB_ID reach a command
 *   line.
 * - ssh to the 4090 stalls above about 1 KB of stdout (Wall Game PM,
 *   2026-08-21), so every remote read here is one short line. The MP4 comes
 *   back by scp, and its sha256 must match the RESULT line.
 * - ONE RENDER IS ONE PRODUCTION VIEW: the renderer loads the game's replay
 *   page once (Worker 2, 2026-10-26). A failed copy is therefore retried
 *   here, and never answered with a second render.
 * - desktop-run (~/nil/infra/DESKTOP-COMPUTE.md) caps CPU and memory, runs at
 *   nice 10, and keeps going if ssh drops. If the app stops this adapter (its
 *   deadline), the adapter stops the remote unit too, so no render outlives
 *   the record that waits for it.
 * - The finished file is moved into place in one step, and the remote job
 *   folders are removed only after a verified copy.
 *
 *   WALLGAME_GPU_HOST=<user@host> node scripts/game-video/daily/render-4090.mjs \
 *     --edl <edl.json> --job-id <id> --out <out.mp4>
 *
 * A PREVIEW (--plies FROM..TO) renders only those plies of the list, from the
 * game's capture cache on the 4090, which the game's first full render
 * wrote. It never opens the replay page, so it adds no view, and it is
 * refused when the 4090 has no capture of the game. Only the MP4 comes back:
 *
 *   WALLGAME_GPU_HOST=<user@host> node scripts/game-video/daily/render-4090.mjs \
 *     --edl <edl.json> --job-id <id> --out <out.mp4> --plies FROM..TO
 *
 * A FULL RENDER FROM THE CACHE (--from-cache, no --plies) renders the whole
 * list from the capture, with no view either; the renderer's output is the
 * same bytes as a live render of the same list (renderer editor,
 * 2026-10-27). Without --from-cache a full render captures live, which adds
 * one view and saves the capture. The app chooses, before it counts the
 * view, and the RESULT must agree (fromCache):
 *
 *   WALLGAME_GPU_HOST=<user@host> node scripts/game-video/daily/render-4090.mjs \
 *     --edl <edl.json> --job-id <id> --out <out.mp4> --from-cache
 *
 * A cache that the renderer cannot use (an old version, other capture
 * inputs, a changed file) fails the render with the renderer's line; it is
 * never captured again silently, as that would be a view nobody counted.
 * A renderer older than --from-cache ignores the flag and captures live:
 * this then prints a WARNING on stderr and still exits 0 with RESULT, so
 * that the app counts the view. Run by hand, read the WARNING: that
 * render was one view of the game that nothing counted.
 *
 * A QUICK LOOK (--draft, with --plies or --from-cache) is composed exactly
 * as the render (the same timeline, sound and seconds), then encoded at
 * 15 fps and 540x960 and not checked frame by frame (renderer R2,
 * 2026-10-29). It always reads the capture, and only the MP4 comes back,
 * also for the whole list: a quick look is never an item's video, and a
 * clean one is not a clean render. RESULT.draft must be what the job asked
 * for:
 *
 *   WALLGAME_GPU_HOST=<user@host> node scripts/game-video/daily/render-4090.mjs \
 *     --edl <edl.json> --job-id <id> --out <out.mp4> --from-cache --draft
 *
 * The app asks first, so a preview of a game with no capture is refused
 * before it is queued. This prints "cached", "cached-no-pawn-art" or "none"
 * (homeAndCapture) and exits 0, or
 * fails when it cannot look:
 *
 *   WALLGAME_GPU_HOST=<user@host> node scripts/game-video/daily/render-4090.mjs \
 *     --has-capture <gameId>
 *
 * The lint (Wall Game Director's R1, 2026-10-29): the renderer composes the
 * list from the capture and stops before the shoot pass, so it makes no
 * image, no MP4 and no view. One worker; RESULT {lint: {faults, notes,
 * counts}, timings}; exit 0 with faults or not:
 *
 *   WALLGAME_GPU_HOST=<user@host> node scripts/game-video/daily/render-4090.mjs \
 *     --lint --edl <edl.json> --job-id <id>
 *
 * The app also asks how many workers the other users' jobs on the 4090 take
 * (desktop-run's meta files), to keep the budget for all jobs together.
 * This prints the sum, or fails when a job has no meta file:
 *
 *   WALLGAME_GPU_HOST=<user@host> node scripts/game-video/daily/render-4090.mjs \
 *     --threads-of <job id>,<job id>...
 *
 * WALLGAME_GPU_HOST is an env var only because the repo is public; the value
 * is in ops-private/wallgamer-agent-notes.md (the same variable the step-1
 * candidate script reads). The app gets it on its registered command line.
 *
 * Prints, as its own last line, RESULT {"mp4": <local path>, "sheet": {"png":
 * <local path>, ...}, ...} for the app.
 */
import { isMain } from "../is-main.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUDGET, desktopName, memoryFor } from "./desktop-budget.mjs";
import { PAWN_ART_PROBE } from "../capture-cache.mjs";

/** Relative to the 4090 user's home. Each job gets its own folder here. */
export const REMOTE_JOBS = "nil/wallgame-video-jobs";
/** The render kit on the 4090 (Worker 2's sync-render-kit.sh). */
export const RENDER_KIT = "nil/wallgame-video";
/**
 * The capture cache in the kit (capture-cache.mjs), one folder per game. A
 * full render writes it and a preview reads it; both get it as --cache.
 */
export const CAPTURE_CACHE = `${RENDER_KIT}/tmp/game-video/capture-cache`;
const RENDERER = "scripts/game-video/render-game-video.mjs";
const BUN = ".bun/bin/bun";
/**
 * The renderer's Chromium workers for the shoot, and the threads desktop-run
 * gives the job, when the app gives no --workers (a run by hand). The app
 * gives each job its share of the 4090's budget (desktop-budget.mjs); the
 * shoot takes about half of a render, and 8 workers shoot about twice as
 * fast as 4 (Wall Game Director, 2026-10-26: 28.9 -> 56.7 fps).
 */
export const WORKERS = 8;
const DESKTOP_RUN = join(homedir(), "nil/infra/bin/desktop-run");

/** Between two tries of a remote step that failed (ssh dropped). */
const RETRY_MS = 5_000;
const COPY_ATTEMPTS = 3;
/**
 * One remote wait for the job's end: it checks the meta file every 0.25 s
 * for up to 60 s, then answers "running" (one short line, as ssh needs).
 */
const WAIT_CHECKS = 240;

const JOB_ID = /^[A-Za-z0-9_-]{8,80}$/;
/** A desktop-run job's folder name: <UTC time>-<NAME>. */
const DESKTOP_JOB_DIR = /^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,40}$/;
/** A preview's window of plies, as the renderer's --plies takes it (edl.mjs). */
const PLIES = /^(\d{1,4})\.\.(\d{1,4})$/;
/** The renderer's rule for a game id, which names its cache folder. */
const GAME_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** The sheet's file name in the remote job folder, as the renderer gives it. */
const SHEET_NAME = /^[A-Za-z0-9._-]{1,80}\.png$/;
const DESKTOP_JOB = /^started job-([0-9TZ]+-wg-video-[0-9a-f]{12})$/m;
/**
 * The keepalives let ssh see a 4090 that goes away silently (Windows sleep,
 * a WSL network reset): the shared connection closes within about 30 s and
 * the next call opens a new one. Without them, a call waits for TCP's own
 * keepalive (2 h), and the job hangs until its deadline.
 */
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=20",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=3",
];

/**
 * ONE ssh CONNECTION FOR THE JOB (OpenSSH ControlMaster): the first ssh or
 * scp opens it, and each later one takes about 0.4 s, not 1.6 s (measured
 * 2026-10-29; a job makes about 10 of them). The socket is in a folder that
 * only this user can open; when the folder is not that, each call opens
 * its own connection, as before.
 */
const connectionOptions = () => {
  const dir = join(tmpdir(), `wg-video-ssh-${process.getuid?.() ?? "u"}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = statSync(dir);
    if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) return [];
  } catch {
    return [];
  }
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${dir}/%C`,
    "-o",
    "ControlPersist=60",
  ];
};

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

/** Run a command; resolve {code, stdout, stderr}. stdin is a path or null. */
const run = (cmd, args, stdinPath = null) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => done({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => done({ code, stdout, stderr }));
    if (stdinPath) createReadStream(stdinPath).pipe(child.stdin);
    else child.stdin.end();
  });

/** The last RESULT line's object, or null. */
export const parseResult = (stdout) => {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("RESULT "));
  if (!line) return null;
  try {
    return JSON.parse(line.slice("RESULT ".length));
  } catch {
    return null;
  }
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const tail = (text) => text.trim().split("\n").slice(-10).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The 4090's home folder and, for `gameId`, "cached", "cached-no-pawn-art"
 * (a capture from before the board's pawn art was kept: a reactor's pawn
 * needs a new one) or "none": whether it has the game's capture. One ssh call, two short lines; it fails when it
 * cannot look. ssh starts in the home folder, so the cache path is relative.
 */
const homeAndCapture = async (ssh, gameId) => {
  if (gameId !== null && !GAME_ID.test(String(gameId))) {
    fail(`not a game id: ${gameId}`);
  }
  const probe = await ssh(
    `printf '%s\\n' "$HOME"${gameId === null ? "" : `; f=${CAPTURE_CACHE}/${gameId}/capture.json; if ! test -f $f; then echo none; elif grep -qF '${PAWN_ART_PROBE}' $f; then echo cached; else echo cached-no-pawn-art; fi`}`,
  );
  const [home, capture = null] = probe.stdout.trim().split("\n");
  if (!home?.startsWith("/")) fail("could not read the 4090's home folder");
  if (
    gameId !== null &&
    !["cached", "cached-no-pawn-art", "none"].includes(capture)
  ) {
    fail(
      `could not look for the game's capture on the 4090: ${tail(probe.stderr)}`,
    );
  }
  return { home, capture };
};

const main = async () => {
  const edlPath = arg("edl");
  const jobId = arg("job-id");
  const out = arg("out");
  const plies = arg("plies");
  const hasCapture = arg("has-capture");
  const threadsOf = arg("threads-of");
  const lint = process.argv.includes("--lint");
  const draft = process.argv.includes("--draft");
  const workers = Number(arg("workers") ?? WORKERS);
  const host = process.env.WALLGAME_GPU_HOST;
  if (
    hasCapture === undefined &&
    threadsOf === undefined &&
    (!edlPath || !jobId || (!out && !lint))
  ) {
    fail(
      "usage: render-4090.mjs --edl <edl.json> --job-id <id> --out <out.mp4> [--from-cache | --plies FROM..TO] [--draft] [--workers N], or --lint --edl <edl.json> --job-id <id>, or --has-capture <gameId>, or --threads-of <job id>,...",
    );
  }
  if (!Number.isInteger(workers) || workers < 1 || workers > BUDGET.perJob) {
    fail(`--workers must be 1 to ${BUDGET.perJob}, got ${arg("workers")}`);
  }
  if (!host) {
    fail(
      "WALLGAME_GPU_HOST is not set (see ops-private/wallgamer-agent-notes.md)",
    );
  }
  const options = [...SSH_OPTIONS, ...connectionOptions()];
  const ssh = (command) => run("ssh", [...options, host, command]);
  /** scp remote files of the job's host into `localDir`, with retries. */
  const scpBack = async (remotes, localDir) => {
    let copied = null;
    for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt++) {
      copied = await run("scp", [
        ...options,
        "-q",
        ...remotes.map((r) => `${host}:${r}`),
        `${localDir}/`,
      ]);
      if (copied.code === 0) break;
      await sleep(RETRY_MS);
    }
    return copied;
  };

  if (hasCapture !== undefined) {
    console.log((await homeAndCapture(ssh, hasCapture)).capture);
    return;
  }
  if (threadsOf !== undefined) {
    const ids = threadsOf.split(",");
    if (!ids.every((id) => DESKTOP_JOB_DIR.test(id))) {
      fail(`not desktop-run job ids: ${threadsOf}`);
    }
    // One line per job: its threads, or "none" for a job with no meta.
    const read = await ssh(
      `for id in ${ids.join(" ")}; do t=$(sed -n 's/^started=.* threads=\\([0-9]*\\) .*/\\1/p' ~/jobs/$id/meta 2>/dev/null); echo "\${t:-none}"; done`,
    );
    const lines = read.stdout.trim().split("\n");
    if (
      read.code !== 0 ||
      lines.length !== ids.length ||
      !lines.every((l) => /^\d+$/.test(l))
    ) {
      fail(
        `could not read the threads of ${threadsOf}: ${tail(read.stderr) || lines.join(" ")}`,
      );
    }
    console.log(lines.reduce((sum, l) => sum + Number(l), 0));
    return;
  }

  // The time of each step, in seconds, for RESULT.timings (Wall Game
  // Director, 2026-10-29: measure first).
  const started = Date.now();
  let mark = started;
  const timings = {};
  const step = (name) => {
    const now = Date.now();
    timings[name] = Math.round((now - mark) / 100) / 10;
    mark = now;
  };

  if (!existsSync(DESKTOP_RUN)) fail(`${DESKTOP_RUN} is missing`);
  if (!JOB_ID.test(jobId)) fail(`not a job id: ${jobId}`);
  const span = plies === undefined ? null : PLIES.exec(plies);
  if (plies !== undefined && !span)
    fail(`--plies must be FROM..TO, got ${plies}`);
  // A preview always reads the cache; a full render reads it when asked.
  const fullFromCache = process.argv.includes("--from-cache");
  if (span && fullFromCache) fail("--plies reads the cache already");
  if (lint && (span || fullFromCache || out)) {
    fail(
      "--lint reads the cache and makes no video: no --plies, --from-cache or --out",
    );
  }
  // A live capture is one view of the game: never for a quick look.
  if (draft && !span && !fullFromCache) {
    fail("--draft reads the capture: give --plies or --from-cache");
  }
  // Only the MP4 comes back from a preview or a quick look.
  const mp4Only = Boolean(span || draft);

  // The app asked already (--has-capture), but this adapter also runs by
  // hand, and without the capture the renderer would fail after desktop-run
  // started it.
  const needsCapture = Boolean(span || fullFromCache || lint);
  const gameId = needsCapture
    ? JSON.parse(readFileSync(edlPath, "utf8")).gameId
    : null;
  const { home, capture } = await homeAndCapture(ssh, gameId);
  if (needsCapture && capture === "none") {
    fail(
      `the 4090 has no capture of game ${gameId} yet: render from the cache needs the capture that a live render of the game saves`,
    );
  }
  const dir = `${home}/${REMOTE_JOBS}/${jobId}`;
  const cache = `${home}/${CAPTURE_CACHE}`;
  step("check");

  // This job's own folders on the 4090: its job folder from the send on and,
  // once desktop-run starts it, its unit folder, whose tmp/ can hold a GB.
  // Every end of the job deletes them, success or failure, for a full
  // render, a preview, a quick look and a lint alike: by 2026-11-06 failed
  // jobs had left 7.1 GB in 30 unit folders (board task f240d1e4). Only the
  // names this job made or desktop-run gave it, never a pattern.
  const remoteFolders = [dir];
  /** Delete this job's folders on the 4090; `keepDir` keeps the job folder. */
  const cleanRemote = async ({ keepDir = false } = {}) => {
    const folders = remoteFolders.filter((f) => !(keepDir && f === dir));
    const gone = await ssh(`rm -rf ${folders.join(" ")}`);
    if (gone.code !== 0) {
      console.error(
        `WARNING: could not delete this job's folders on the 4090 (${folders.join(" ")}): ${tail(gone.stderr)}`,
      );
    }
  };
  /** fail(), once this job's folders on the 4090 are gone. */
  const failCleaned = async (message, options) => {
    await cleanRemote(options);
    fail(message);
  };

  console.log("[render] sending the job to the 4090");
  const sent = await run(
    "ssh",
    [...options, host, `mkdir -p ${dir} && cat > ${dir}/edl.json`],
    edlPath,
  );
  if (sent.code !== 0) {
    await failCleaned(`could not send the job: ${tail(sent.stderr)}`);
  }
  step("send");

  console.log("[render] starting the render on the 4090");
  const desktop = await run(DESKTOP_RUN, [
    desktopName(jobId),
    String(workers),
    memoryFor(workers),
    "--",
    `${home}/${BUN}`,
    `${home}/${RENDER_KIT}/${RENDERER}`,
    "--edl",
    `${dir}/edl.json`,
    "--out",
    `${dir}/out.mp4`,
    "--log",
    `${dir}/render.log`,
    "--encoder",
    "nvenc",
    "--workers",
    String(workers),
    "--cache",
    cache,
    ...(span ? ["--from-cache", "--plies", plies] : []),
    ...(fullFromCache ? ["--from-cache"] : []),
    ...(lint ? ["--from-cache", "--lint"] : []),
    ...(draft ? ["--draft"] : []),
  ]);
  const unit = DESKTOP_JOB.exec(desktop.stdout)?.[1];
  if (desktop.code !== 0 || !unit) {
    await failCleaned(
      `desktop-run did not start the render: ${tail(desktop.stderr || desktop.stdout)}`,
    );
  }
  const jobs = `${home}/jobs/${unit}`;
  remoteFolders.push(jobs);
  step("start");

  // The app's deadline arrives as SIGTERM. Stop the remote render with it,
  // then delete the job's folders.
  process.on("SIGTERM", () => {
    void ssh(`systemctl --user stop job-${unit}`)
      .then(() => cleanRemote())
      .then(() => process.exit(1));
  });

  console.log(
    `[render] ${lint ? "linting" : "rendering"} on the 4090 (job-${unit}), ${needsCapture ? "from the game's capture: no view" : "with a live capture: one view of the game"}`,
  );
  // One remote call waits for the end, then writes the RESULT line into a
  // file: the unit log also takes the renderer's stderr, so RESULT need not
  // be last, and the line grows with the contact sheet's stills, so it
  // comes back by scp (ssh stalls above about 1 KB of stdout). After 60 s
  // the call answers "running" and the next one waits on; a dropped ssh
  // only means another call.
  const waitForEnd = [
    `for i in $(seq 1 ${WAIT_CHECKS}); do`,
    `l=$(tail -n 1 ${jobs}/meta 2>/dev/null);`,
    `case "$l" in exit=*) grep '^RESULT ' ${jobs}/log | tail -n 1 > ${dir}/result.line; echo "$l"; exit 0;; esac;`,
    "sleep 0.25; done; echo running",
  ].join(" ");
  let exit = null;
  while (exit === null) {
    const waited = await ssh(waitForEnd);
    const m = /^exit=(\d+)$/.exec(waited.stdout.trim());
    if (m) exit = Number(m[1]);
    else if (waited.code !== 0) await sleep(RETRY_MS);
  }
  step("render");

  // The RESULT line and the render log, in one copy, into a folder of this
  // job: jobs run side by side, and two with their --out in one folder
  // must not take each other's RESULT. The render log is small and is the
  // only record of what the render did; it stays as <out>-render.log. The
  // renderer writes the log (--log) before it exits, so with exit 0 both
  // are there.
  // A lint has no --out: its log goes next to its list, as <edl>-render.log.
  const base = out ?? edlPath;
  const outDir = dirname(base);
  const resultDir = join(outDir, `.result-${jobId}`);
  mkdirSync(resultDir, { recursive: true });
  const resultLocal = join(resultDir, "result.line");
  const logLocal = join(resultDir, "render.log");
  // A failed render's log comes back too: the 4090's folder is deleted below.
  let result = null;
  const fetched = await scpBack(
    exit === 0
      ? [`${dir}/result.line`, `${dir}/render.log`]
      : [`${dir}/render.log`],
    resultDir,
  );
  if (fetched.code !== 0) {
    console.error(
      `WARNING: could not copy the render log back; this job's folders on the 4090 are deleted anyway: ${tail(fetched.stderr)}`,
    );
  }
  if (exit === 0 && fetched.code === 0 && existsSync(resultLocal)) {
    result = parseResult(readFileSync(resultLocal, "utf8"));
  }
  if (existsSync(logLocal)) renameSync(logLocal, `${base}-render.log`);
  rmSync(resultDir, { recursive: true, force: true });
  if (exit !== 0 || !result) {
    const why = await ssh(`tail -n 5 ${dir}/render.log | cut -c1-180`);
    // Exit 4 also has other causes, so the renderer's line says which.
    const hint =
      fullFromCache && exit === 4
        ? "; if the capture cannot be used, render again live (one view of the game)"
        : "";
    await failCleaned(
      `the 4090 render failed (exit ${exit}): ${tail(why.stdout) || "no RESULT line"}${hint}`,
    );
  }

  if (lint) {
    if (!Array.isArray(result.lint?.faults)) {
      await failCleaned(
        "the 4090 gave no lint: the render kit may be older than --lint, so sync it",
      );
    }
    step("fetch");
    await cleanRemote();
    step("cleanup");
    timings.total = Math.round((Date.now() - started) / 100) / 10;
    console.log(
      `RESULT ${JSON.stringify({
        lint: result.lint,
        timings: { ...timings, workers, renderer: result.timings ?? null },
      })}`,
    );
    return;
  }

  // A quick look is never a video to post, so it must say what it is.
  if ((result.draft === true) !== draft) {
    await failCleaned(
      draft
        ? "the 4090 gave a full render, not a quick look: the render kit may be older than --draft, so sync it"
        : "the 4090 gave a quick look (RESULT.draft), not the render this job asked for",
    );
  }
  // A preview reports its window and no list hash (render-game-video.mjs),
  // so it can never pass for the day's render.
  if (
    span &&
    (result.preview?.from !== Number(span[1]) ||
      result.preview?.to !== Number(span[2]) ||
      result.fromCache !== true ||
      result.edlSha256 !== null)
  ) {
    await failCleaned(
      `the 4090 render is not the preview of plies ${plies} from the cache`,
    );
  }
  // A renderer older than --from-cache ignores it and captures live: a
  // view happened. RESULT still comes back, so that the app can count the
  // view and fail the job; a run by hand sees this warning.
  if (!span && (result.fromCache === true) !== fullFromCache) {
    console.error(
      `WARNING: the 4090 render was ${result.fromCache === true ? "" : "not "}from the cache, but this job asked for ${fullFromCache ? "the cache: a live capture added one view of the game" : "a live capture"}`,
    );
  }

  // The sheet must sit in this job's folder, the only place cleaned below.
  const sheetName = String(result.sheet?.png ?? "")
    .split("/")
    .pop();
  if (
    !mp4Only &&
    (!SHEET_NAME.test(sheetName) || result.sheet.png !== `${dir}/${sheetName}`)
  ) {
    await failCleaned(`the render gave no contact sheet in ${dir}`);
  }

  console.log(
    mp4Only
      ? "[render] copying the preview back"
      : "[render] copying the video and the contact sheet back",
  );
  // The video and the sheet in one copy, into a folder of this job; then
  // each is checked against the 4090's hash and moved into place. A
  // preview's sheet (its window's events) stays out: the check reads only
  // the full render's.
  const fetchDir = join(outDir, `.fetch-${jobId}`);
  mkdirSync(fetchDir, { recursive: true });
  const copied = await scpBack(
    [`${dir}/out.mp4`, ...(mp4Only ? [] : [result.sheet.png])],
    fetchDir,
  );
  if (copied.code !== 0) {
    rmSync(fetchDir, { recursive: true, force: true });
    // The render worked: its video stays in the job folder for a copy by
    // hand. The unit folder (the large tmp/) still goes.
    await failCleaned(
      `could not copy the video back after ${COPY_ATTEMPTS} tries; it stays on the 4090 in ${dir}: ${tail(copied.stderr)}`,
      { keepDir: true },
    );
  }
  /** Move one fetched file to `local`, checked against the 4090's hash. */
  const take = async (name, local, want) => {
    const scratch = join(fetchDir, name);
    const bytes = readFileSync(scratch);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      sha256 !== want.sha256 ||
      (want.bytes !== undefined && bytes.length !== want.bytes)
    ) {
      rmSync(fetchDir, { recursive: true, force: true });
      await failCleaned(
        `the copy of ${name} does not match the 4090's file (${bytes.length} bytes, ${sha256.slice(0, 12)} vs ${String(want.sha256).slice(0, 12)}); it stays on the 4090 in ${dir}`,
        { keepDir: true },
      );
    }
    renameSync(scratch, local);
    return sha256;
  };
  const sha256 = await take("out.mp4", out, result);
  const sheetPng = `${out}-sheet.png`;
  if (!mp4Only) await take(sheetName, sheetPng, result.sheet);
  rmSync(fetchDir, { recursive: true, force: true });
  step("fetch");
  await cleanRemote();
  step("cleanup");
  timings.total = Math.round((Date.now() - started) / 100) / 10;
  console.log(
    `RESULT ${JSON.stringify({
      ...result,
      mp4: out,
      bytes: statSync(out).size,
      sha256,
      sheet: mp4Only ? null : { ...result.sheet, png: sheetPng },
      // The adapter's steps, and the renderer's own when it gives them.
      timings: {
        ...timings,
        workers,
        renderer: result.timings ?? null,
      },
    })}`,
  );
};

if (isMain(import.meta)) {
  await main();
}
