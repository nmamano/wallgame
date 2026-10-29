/**
 * The 4090's render budget, read in the background (Wall Game Director,
 * 2026-10-29, with the Warden's budget of the same day in
 * ~/nil/infra/DESKTOP-COMPUTE.md). The budget is the TOTAL of Chromium
 * workers of all render jobs that run on the desktop at one time: up to 20
 * when Nil's screen is locked, up to 12 when it is not. The limits are not
 * enforced on the desktop (cgroup v1), so the worker count that the app
 * gives each job is the real limit.
 *
 * desktop-status takes about 10 s, so the app reads it in the background
 * and a job start uses the last reading, at most MAX_AGE_MS old. A job
 * waits (it stays queued and does not fail) on budget=WAIT, on a WSL with
 * less than 6 GB available, on less than 4 GB of free VRAM (the bots come
 * first), on a reading that is too old, and while the budget is in use.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const BUDGET = {
  lockedThreads: 20,
  unlockedThreads: 12,
  /** The renderer takes 1 to 16 workers (render-game-video.mjs). */
  perJob: 16,
  /** Fewer workers than this is not worth a start: wait for more. */
  minPerJob: 4,
  minWslFreeGb: 6,
  minVramFreeMib: 4096,
};
export const MAX_AGE_MS = 60_000;
/**
 * desktop-run's memory label for a job of `workers` (a label only, as the
 * desktop does not enforce it): two jobs of 6 stay inside the 12 GB that
 * all render jobs may use together. 2 jobs of 8 workers used about 4.7 GB
 * (Warden, 2026-10-29).
 */
export const memoryFor = (workers) => (workers <= 6 ? "6G" : "8G");
export const READ_EVERY_MS = 20_000;
/**
 * The minutes of the UTC day that the 4090 keeps free for the Wall Game
 * backup mirror (~/nil/infra/DESKTOP-COMPUTE.md: "Keep 10:15-10:50 UTC
 * free"). A job that started before it may run into it.
 */
export const BACKUP_WINDOW = { from: 10 * 60 + 15, to: 10 * 60 + 50 };

/**
 * A job's desktop-run NAME: desktop-run allows a-z, 0-9 and -, and game
 * ids are mixed case. Its unit is job-<UTC time>-<NAME>.
 */
export const desktopName = (jobId) =>
  `wg-video-${createHash("sha256").update(jobId).digest("hex").slice(0, 12)}`;

/**
 * desktop-status's output as facts. `jobs` are the running job units of
 * every user of the desktop, by id (the folder name under ~/jobs).
 * @param {string} text
 */
export const parseStatus = (text) => {
  const value = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1];
  const budget = value("budget") ?? "";
  const gpu = /^(\d+) %, (\d+) MiB, (\d+) MiB$/.exec(value("gpu") ?? "");
  const free = /^(\d+) of/.exec(value("wsl_free_ram_gb") ?? "");
  const jobs = [...text.matchAll(/^ {2}job-(\S+)\.service running$/gm)].map(
    (m) => m[1],
  );
  return {
    locked: value("win_locked") === "True",
    wait: budget.startsWith("WAIT") ? budget : null,
    unknown: budget === "" || budget.startsWith("UNKNOWN"),
    maxThreads: Number(/^max (\d+) threads/.exec(budget)?.[1] ?? 0),
    wslFreeGb: free ? Number(free[1]) : null,
    vramFreeMib: gpu ? Number(gpu[3]) - Number(gpu[2]) : null,
    jobs,
  };
};

/**
 * What the head of the queue may do now: {workers} or {wait}.
 * `reading` is {at, status, others, error}: `others` is the threads of the
 * running jobs that are not the app's. `ownThreads` is what the app's
 * running jobs use, and `behind` how many jobs wait after this one.
 * `backupWindow` null is for a test that runs at any time of day. `want`
 * is a fixed worker count (a lint asks for 1).
 */
export const planJob = ({
  reading,
  ownThreads,
  ownJobs,
  behind,
  now,
  backupWindow = BACKUP_WINDOW,
  want = /** @type {number | undefined} */ (undefined),
}) => {
  const d = new Date(now);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (backupWindow && minute >= backupWindow.from && minute < backupWindow.to) {
    return {
      wait: "the 4090 is kept free for the backup mirror, 10:15-10:50 UTC",
    };
  }
  if (!reading || reading.error) {
    return {
      wait: `the 4090's status is not known (${reading?.error ?? "not read yet"})`,
    };
  }
  const age = now - reading.at;
  if (age > MAX_AGE_MS) {
    return {
      wait: `the 4090's last status is ${Math.round(age / 1000)} s old`,
    };
  }
  const s = reading.status;
  if (s.unknown) return { wait: "the 4090's status is not known (Windows)" };
  if (s.wait) return { wait: `desktop-status says ${s.wait}` };
  if (s.wslFreeGb === null || s.wslFreeGb < BUDGET.minWslFreeGb) {
    return {
      wait: `the WSL has ${s.wslFreeGb ?? "?"} GB available, under ${BUDGET.minWslFreeGb} GB`,
    };
  }
  if (s.vramFreeMib === null || s.vramFreeMib < BUDGET.minVramFreeMib) {
    return {
      wait: `the GPU has ${s.vramFreeMib ?? "?"} MiB free, under ${BUDGET.minVramFreeMib} MiB (the bots come first)`,
    };
  }
  const total = Math.min(
    s.locked ? BUDGET.lockedThreads : BUDGET.unlockedThreads,
    s.maxThreads,
  );
  const used = ownThreads + reading.others;
  const free = total - used;
  // A job that asks for a number (a lint: 1, it has no shoot) takes it
  // whenever that much is free.
  if (want !== undefined) {
    return free >= want
      ? { workers: want }
      : {
          wait: `the 4090's budget is in use: ${used} of ${total} workers (${s.locked ? "screen locked" : "Nil may use the PC"})`,
        };
  }
  // Alone, a job takes all it can; with company (running or waiting),
  // half, so that two run side by side.
  const share =
    ownJobs === 0 && behind === 0 && reading.others === 0
      ? Math.min(BUDGET.perJob, total)
      : Math.floor(total / 2);
  const workers = Math.min(share, free, BUDGET.perJob);
  if (workers < BUDGET.minPerJob) {
    return {
      wait: `the 4090's budget is in use: ${used} of ${total} workers (${s.locked ? "screen locked" : "Nil may use the PC"})`,
    };
  }
  return { workers };
};

/** Run a command; resolve {code, stdout, stderr}. */
const runCommand = (cmd, args, timeoutMs) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });

/**
 * Reads desktop-status (`statusCommand`, [command, ...args]) every
 * READ_EVERY_MS while `wanted()` is true, and the threads of every other
 * running job from its desktop-run meta file (`threadsOf`, one ssh call).
 * The app's own are the units of the jobs it runs now (`ownNames`, their
 * desktopName); a hand run of render-4090.mjs or another app counts as
 * another user's job. Calls `onReading` after each reading.
 */
export const createBudgetReader = ({
  statusCommand,
  threadsOf,
  ownNames,
  wanted,
  onReading,
  everyMs = READ_EVERY_MS,
}) => {
  /**
   * @type {{ at: number, status?: ReturnType<typeof parseStatus>,
   *   others?: number, error?: string } | null}
   */
  let reading = null;
  let busy = null;
  let timer = null;
  let stopped = false;
  const read = async () => {
    const [cmd, ...args] = statusCommand;
    const out = await runCommand(cmd, args, 30_000);
    const at = Date.now();
    // exit 1 is budget=UNKNOWN, exit 2 budget=WAIT: both still print.
    if (!/^budget=/m.test(out.stdout)) {
      return {
        at,
        error: `desktop-status gave no budget (exit ${out.code})${out.stderr.trim() ? `: ${out.stderr.trim().split("\n").at(-1)}` : ""}`,
      };
    }
    const status = parseStatus(out.stdout);
    const own = ownNames();
    const foreign = status.jobs.filter(
      (id) => !own.some((name) => id.endsWith(`-${name}`)),
    );
    let others = 0;
    if (foreign.length > 0) {
      const threads = await threadsOf(foreign);
      if (threads === null) {
        return { at, error: "could not read the other jobs' threads" };
      }
      others = threads;
    }
    return { at, status, others };
  };
  const tick = async () => {
    timer = null;
    if (stopped || !wanted()) return;
    busy ??= read().finally(() => (busy = null));
    reading = await busy;
    if (stopped) return;
    // The next tick is set before onReading, whose pump calls wake(): one
    // reading a period, not two.
    timer = setTimeout(tick, everyMs);
    timer.unref?.();
    onReading();
  };
  return {
    latest: () => reading,
    /** Start reading when the queue gets work; a no-op while it reads. */
    wake: () => {
      if (!stopped && timer === null && busy === null) void tick();
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
};
