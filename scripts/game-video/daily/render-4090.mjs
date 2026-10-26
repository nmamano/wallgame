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
 *   The list picks the music (edl.music); with none the renderer picks a
 *   track at random and RESULT names it.
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
 * WALLGAME_GPU_HOST is an env var only because the repo is public; the value
 * is in ops-private/wallgamer-agent-notes.md (the same variable the step-1
 * candidate script reads). The app gets it on its registered command line.
 *
 * Prints, as its own last line, RESULT {"mp4": <local path>, "sheet": {"png":
 * <local path>, ...}, ...} for the app.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
/** Worker 2's figure for one render: 4 threads and 4 GB are enough. */
const THREADS = "4";
const MEMORY = "4G";
const DESKTOP_RUN = join(homedir(), "nil/infra/bin/desktop-run");

const POLL_MS = 10_000;
const COPY_ATTEMPTS = 3;

const JOB_ID = /^[A-Za-z0-9_-]{8,80}$/;
/** A preview's window of plies, as the renderer's --plies takes it (edl.mjs). */
const PLIES = /^(\d{1,4})\.\.(\d{1,4})$/;
/** The renderer's rule for a game id, which names its cache folder. */
const GAME_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** The sheet's file name in the remote job folder, as the renderer gives it. */
const SHEET_NAME = /^[A-Za-z0-9._-]{1,80}\.png$/;
const DESKTOP_JOB = /^started job-([0-9TZ]+-wg-video-[0-9a-f]{12})$/m;
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];

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

/** desktop-run's NAME allows a-z, 0-9 and -; game ids are mixed case. */
export const desktopName = (jobId) =>
  `wg-video-${createHash("sha256").update(jobId).digest("hex").slice(0, 12)}`;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const tail = (text) => text.trim().split("\n").slice(-10).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const edlPath = arg("edl");
  const jobId = arg("job-id");
  const out = arg("out");
  const plies = arg("plies");
  const host = process.env.WALLGAME_GPU_HOST;
  if (!edlPath || !jobId || !out) {
    fail(
      "usage: render-4090.mjs --edl <edl.json> --job-id <id> --out <out.mp4>",
    );
  }
  if (!host) {
    fail(
      "WALLGAME_GPU_HOST is not set (see ops-private/wallgamer-agent-notes.md)",
    );
  }
  if (!existsSync(DESKTOP_RUN)) fail(`${DESKTOP_RUN} is missing`);

  if (!JOB_ID.test(jobId)) fail(`not a job id: ${jobId}`);
  const span = plies === undefined ? null : PLIES.exec(plies);
  if (plies !== undefined && !span)
    fail(`--plies must be FROM..TO, got ${plies}`);
  const ssh = (command) => run("ssh", [...SSH_OPTIONS, host, command]);

  const home = (await ssh('printf %s "$HOME"')).stdout.trim();
  if (!home.startsWith("/")) fail("could not read the 4090's home folder");
  const dir = `${home}/${REMOTE_JOBS}/${jobId}`;
  const cache = `${home}/${CAPTURE_CACHE}`;

  // A preview needs the game's capture; without it the renderer would fail
  // after desktop-run started it. One short line comes back.
  if (span) {
    const gameId = JSON.parse(readFileSync(edlPath, "utf8")).gameId;
    if (!GAME_ID.test(String(gameId))) fail(`not a game id: ${gameId}`);
    const probe = await ssh(
      `if test -f ${cache}/${gameId}/capture.json; then echo cached; else echo none; fi`,
    );
    const answer = probe.stdout.trim();
    if (answer === "none") {
      fail(
        `the 4090 has no capture of game ${gameId} yet: a preview reads the capture that the game's full render saves, so render the day's video first`,
      );
    }
    if (answer !== "cached") {
      fail(
        `could not look for the game's capture on the 4090: ${tail(probe.stderr)}`,
      );
    }
  }

  console.log("[render] sending the job to the 4090");
  const sent = await run(
    "ssh",
    [...SSH_OPTIONS, host, `mkdir -p ${dir} && cat > ${dir}/edl.json`],
    edlPath,
  );
  if (sent.code !== 0) fail(`could not send the job: ${tail(sent.stderr)}`);

  console.log("[render] starting the render on the 4090");
  const started = await run(DESKTOP_RUN, [
    desktopName(jobId),
    THREADS,
    MEMORY,
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
    "--cache",
    cache,
    ...(span ? ["--from-cache", "--plies", plies] : []),
  ]);
  const unit = DESKTOP_JOB.exec(started.stdout)?.[1];
  if (started.code !== 0 || !unit) {
    fail(
      `desktop-run did not start the render: ${tail(started.stderr || started.stdout)}`,
    );
  }
  const jobs = `${home}/jobs/${unit}`;

  // The app's deadline arrives as SIGTERM. Stop the remote render with it.
  process.on("SIGTERM", () => {
    void ssh(`systemctl --user stop job-${unit}`).then(() => process.exit(1));
  });

  console.log(`[render] rendering on the 4090 (job-${unit})`);
  let exit = null;
  for (;;) {
    await sleep(POLL_MS);
    const meta = await ssh(`tail -n 1 ${jobs}/meta`);
    const m = /^exit=(\d+)$/.exec(meta.stdout.trim());
    if (m) {
      exit = Number(m[1]);
      break;
    }
  }
  /** scp one remote file to `local`, with retries; the scp result. */
  const scpBack = async (remote, local) => {
    let copied = null;
    for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt++) {
      copied = await run("scp", [
        ...SSH_OPTIONS,
        "-q",
        `${host}:${remote}`,
        local,
      ]);
      if (copied.code === 0) break;
      await sleep(POLL_MS);
    }
    return copied;
  };

  // The unit log also takes the renderer's stderr, so RESULT need not be
  // last. The line grows with the contact sheet's stills (edl.mjs allows 40
  // events), and ssh stalls above about 1 KB of stdout, so the line goes into
  // a file on the 4090 and comes back by scp, which has no such limit.
  // A dropped ssh here would turn a finished render into "no RESULT line",
  // so the write is retried with the copy.
  const resultLocal = `${out}.result`;
  let result = null;
  for (let attempt = 1; exit === 0 && !result; attempt++) {
    const wrote = await ssh(
      `grep '^RESULT ' ${jobs}/log | tail -n 1 > ${dir}/result.line`,
    );
    if (wrote.code === 0) {
      const fetched = await scpBack(`${dir}/result.line`, resultLocal);
      if (fetched.code === 0) {
        result = parseResult(readFileSync(resultLocal, "utf8"));
      }
      if (existsSync(resultLocal)) unlinkSync(resultLocal);
    }
    if (result || attempt === COPY_ATTEMPTS) break;
    await sleep(POLL_MS);
  }
  if (exit !== 0 || !result) {
    const why = await ssh(`tail -n 5 ${dir}/render.log | cut -c1-180`);
    fail(
      `the 4090 render failed (exit ${exit}): ${tail(why.stdout) || "no RESULT line"}`,
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
    fail(`the 4090 render is not the preview of plies ${plies} from the cache`);
  }

  // The sheet must sit in this job's folder, the only place cleaned below.
  const sheetName = String(result.sheet?.png ?? "")
    .split("/")
    .pop();
  if (
    !span &&
    (!SHEET_NAME.test(sheetName) || result.sheet.png !== `${dir}/${sheetName}`)
  ) {
    fail(`the render gave no contact sheet in ${dir}`);
  }

  /** Copy one remote file to `local`, checked against the 4090's hash. */
  const copyBack = async (remote, local, want) => {
    const scratch = `${local}.part`;
    const copied = await scpBack(remote, scratch);
    if (copied.code !== 0) {
      fail(
        `could not copy ${remote} back after ${COPY_ATTEMPTS} tries; it stays on the 4090: ${tail(copied.stderr)}`,
      );
    }
    const bytes = readFileSync(scratch);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      sha256 !== want.sha256 ||
      (want.bytes !== undefined && bytes.length !== want.bytes)
    ) {
      unlinkSync(scratch);
      fail(
        `the copy of ${remote} does not match the 4090's file (${bytes.length} bytes, ${sha256.slice(0, 12)} vs ${String(want.sha256).slice(0, 12)}); it stays on the 4090`,
      );
    }
    renameSync(scratch, local);
    return sha256;
  };

  console.log(
    span
      ? "[render] copying the preview back"
      : "[render] copying the video and the contact sheet back",
  );
  const sha256 = await copyBack(`${dir}/out.mp4`, out, result);
  // A preview's sheet (its window's events) stays out: the check reads
  // only the full render's.
  const sheetPng = `${out}-sheet.png`;
  if (!span) await copyBack(result.sheet.png, sheetPng, result.sheet);
  // The render log is small and is the only record of what the render did.
  await run("scp", [
    ...SSH_OPTIONS,
    "-q",
    `${host}:${dir}/render.log`,
    join(dirname(out), "render.log"),
  ]);
  await ssh(`rm -rf ${dir} ${jobs}`);
  console.log(
    `RESULT ${JSON.stringify({ ...result, mp4: out, bytes: statSync(out).size, sha256, sheet: span ? null : { ...result.sheet, png: sheetPng } })}`,
  );
};

if (import.meta.main) {
  await main();
}
