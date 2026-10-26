/**
 * The office box's half of a daily render: send one job to the 4090, run the
 * renderer there, and bring the MP4 back.
 *
 * Board task e8d26610, step 3. ALL RENDERING RUNS ON THE 4090 (Nil,
 * 2026-10-25). This file renders nothing; the renderer is step 2's (Wall Game
 * Worker 2). The contract, agreed with Worker 2 on 2026-10-26:
 *
 *   job.json  {jobId, gameId, swings:[{ply, ...}], caption, style, aspect}
 *             The renderer reads gameId, caption, style, aspect, swings[].ply.
 *   The renderer runs from the render kit on the 4090 (RENDER_KIT, which
 *   scripts/game-video/sync-render-kit.sh fills), under desktop-run, as
 *     bun <kit>/scripts/game-video/render-game-video.mjs --job <job.json>
 *       --out <out.mp4> --log <render.log> --encoder nvenc
 *   With --log its stdout is one line,
 *     RESULT {"mp4","bytes","sha256","durationSeconds","effect","sound"}
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
 *     --job <job.json> --out <out.mp4>
 *
 * WALLGAME_GPU_HOST is an env var only because the repo is public; the value
 * is in ops-private/wallgamer-agent-notes.md (the same variable the step-1
 * candidate script reads). The app gets it on its registered command line.
 *
 * Prints, as its own last line, RESULT {"mp4": <local path>, ...} for the app.
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
const RENDERER = "scripts/game-video/render-game-video.mjs";
const BUN = ".bun/bin/bun";
/** Worker 2's figure for one render: 4 threads and 4 GB are enough. */
const THREADS = "4";
const MEMORY = "4G";
const DESKTOP_RUN = join(homedir(), "nil/infra/bin/desktop-run");

const POLL_MS = 10_000;
const COPY_ATTEMPTS = 3;

const JOB_ID = /^[A-Za-z0-9_-]{8,80}$/;
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
  const jobPath = arg("job");
  const out = arg("out");
  const host = process.env.WALLGAME_GPU_HOST;
  if (!jobPath || !out) {
    fail("usage: render-4090.mjs --job <job.json> --out <out.mp4>");
  }
  if (!host) {
    fail(
      "WALLGAME_GPU_HOST is not set (see ops-private/wallgamer-agent-notes.md)",
    );
  }
  if (!existsSync(DESKTOP_RUN)) fail(`${DESKTOP_RUN} is missing`);

  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  if (!JOB_ID.test(job.jobId ?? "")) fail(`not a job id: ${job.jobId}`);
  const ssh = (command) => run("ssh", [...SSH_OPTIONS, host, command]);

  const home = (await ssh('printf %s "$HOME"')).stdout.trim();
  if (!home.startsWith("/")) fail("could not read the 4090's home folder");
  const dir = `${home}/${REMOTE_JOBS}/${job.jobId}`;

  console.log("[render] sending the job to the 4090");
  const sent = await run(
    "ssh",
    [...SSH_OPTIONS, host, `mkdir -p ${dir} && cat > ${dir}/job.json`],
    jobPath,
  );
  if (sent.code !== 0) fail(`could not send the job: ${tail(sent.stderr)}`);

  console.log("[render] starting the render on the 4090");
  const started = await run(DESKTOP_RUN, [
    desktopName(job.jobId),
    THREADS,
    MEMORY,
    "--",
    `${home}/${BUN}`,
    `${home}/${RENDER_KIT}/${RENDERER}`,
    "--job",
    `${dir}/job.json`,
    "--out",
    `${dir}/out.mp4`,
    "--log",
    `${dir}/render.log`,
    "--encoder",
    "nvenc",
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
  // The unit log also takes the renderer's stderr, so RESULT need not be last.
  const last = await ssh(
    `grep '^RESULT ' ${jobs}/log | tail -n 1 | cut -c1-600`,
  );
  const result = parseResult(last.stdout);
  if (exit !== 0 || !result) {
    const why = await ssh(`tail -n 5 ${dir}/render.log | cut -c1-180`);
    fail(
      `the 4090 render failed (exit ${exit}): ${tail(why.stdout) || "no RESULT line"}`,
    );
  }

  console.log("[render] copying the video back");
  const scratch = `${out}.part`;
  let copied = null;
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt++) {
    copied = await run("scp", [
      ...SSH_OPTIONS,
      "-q",
      `${host}:${dir}/out.mp4`,
      scratch,
    ]);
    if (copied.code === 0) break;
    await sleep(POLL_MS);
  }
  if (copied.code !== 0) {
    fail(
      `could not copy the video back after ${COPY_ATTEMPTS} tries; it stays on the 4090 at ${dir}/out.mp4: ${tail(copied.stderr)}`,
    );
  }

  const bytes = readFileSync(scratch);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== result.sha256 || bytes.length !== result.bytes) {
    unlinkSync(scratch);
    fail(
      `the copy does not match the 4090's file (${bytes.length} bytes, ${sha256.slice(0, 12)} vs ${result.bytes} bytes, ${String(result.sha256).slice(0, 12)}); it stays on the 4090 at ${dir}/out.mp4`,
    );
  }
  renameSync(scratch, out);
  // The render log is small and is the only record of what the render did.
  await run("scp", [
    ...SSH_OPTIONS,
    "-q",
    `${host}:${dir}/render.log`,
    join(dirname(out), "render.log"),
  ]);
  await ssh(`rm -rf ${dir} ${jobs}`);
  console.log(
    `RESULT ${JSON.stringify({ ...result, mp4: out, bytes: statSync(out).size, sha256 })}`,
  );
};

if (import.meta.main) {
  await main();
}
