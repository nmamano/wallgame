import { describe, expect, test } from "bun:test";
import {
  MAX_AGE_MS,
  createBudgetReader,
  desktopName,
  memoryFor,
  parseStatus,
  planJob,
} from "./desktop-budget.mjs";

// desktop-status as it printed on 2026-10-29, with the renderer's proof
// job and one of the app's own running.
const FREE = `win_cpu_pct=2
win_locked=False
win_logged_in=True
win_free_ram_gb=14.9
wsl_load=0.37/0.98/1.47 (28 threads)
wsl_free_ram_gb=20 of 24
gpu=0 %, 3270 MiB, 24564 MiB
jobs:
  job-20261029T023345Z-cap1.service running
  job-20261029T024001Z-wg-video-0123456789ab.service running
budget=max 12 threads. Nil may use the PC (screen unlocked).
`;

const status = (text: string) => parseStatus(text);
const now = 1_000_000;
const plan = (
  text: string,
  {
    others = 0,
    ownThreads = 0,
    ownJobs = 0,
    behind = 0,
    age = 0,
  }: Partial<Record<string, number>> = {},
) =>
  planJob({
    reading: { at: now - age, status: status(text), others },
    ownThreads,
    ownJobs,
    behind,
    now,
  });

describe("the 4090's budget (desktop-budget.mjs)", () => {
  test("desktop-status as facts", () => {
    expect(status(FREE)).toEqual({
      locked: false,
      wait: null,
      unknown: false,
      maxThreads: 12,
      wslFreeGb: 20,
      vramFreeMib: 24564 - 3270,
      jobs: ["20261029T023345Z-cap1", "20261029T024001Z-wg-video-0123456789ab"],
    });
    const wait = FREE.replace(
      /^budget=.*$/m,
      "budget=WAIT: Windows CPU 75%. Wait, or ask Infra & Security.",
    );
    expect(status(wait).wait).toBe(
      "WAIT: Windows CPU 75%. Wait, or ask Infra & Security.",
    );
    expect(
      status("budget=UNKNOWN (Windows did not answer). Do not start a job.")
        .unknown,
    ).toBe(true);
  });

  test("alone, a job takes the whole budget: 12 workers unlocked, 16 locked", () => {
    expect(plan(FREE)).toEqual({ workers: 12 });
    const locked = FREE.replace("win_locked=False", "win_locked=True").replace(
      "max 12 threads",
      "max 20 threads",
    );
    expect(plan(locked)).toEqual({ workers: 16 });
    // With company, half, so that two run side by side.
    expect(plan(locked, { behind: 1 })).toEqual({ workers: 10 });
    expect(plan(locked, { ownThreads: 10, ownJobs: 1 })).toEqual({
      workers: 10,
    });
    expect(plan(locked, { ownThreads: 20, ownJobs: 2 })).toEqual({
      wait: "the 4090's budget is in use: 20 of 20 workers (screen locked)",
    });
  });

  test("two at a time unlocked, and the other users' jobs count", () => {
    expect(plan(FREE, { behind: 2 })).toEqual({ workers: 6 });
    expect(plan(FREE, { ownThreads: 6, ownJobs: 1, behind: 1 })).toEqual({
      workers: 6,
    });
    expect(plan(FREE, { ownThreads: 12, ownJobs: 2 })).toEqual({
      wait: "the 4090's budget is in use: 12 of 12 workers (Nil may use the PC)",
    });
    // The renderer's 8-worker proof leaves 4.
    expect(plan(FREE, { others: 8 })).toEqual({ workers: 4 });
    expect(plan(FREE, { others: 10 })).toEqual({
      wait: "the 4090's budget is in use: 10 of 12 workers (Nil may use the PC)",
    });
  });

  test("a job waits on WAIT, low WSL memory, low VRAM, and an old or missing reading", () => {
    expect(
      plan(FREE.replace(/^budget=.*$/m, "budget=WAIT: Windows CPU 75%.")),
    ).toEqual({ wait: "desktop-status says WAIT: Windows CPU 75%." });
    expect(plan(FREE.replace("20 of 24", "5 of 24"))).toEqual({
      wait: "the WSL has 5 GB available, under 6 GB",
    });
    expect(plan(FREE.replace("3270 MiB", "21000 MiB"))).toEqual({
      wait: "the GPU has 3564 MiB free, under 4096 MiB (the bots come first)",
    });
    expect(plan(FREE, { age: MAX_AGE_MS + 1000 })).toEqual({
      wait: "the 4090's last status is 61 s old",
    });
    expect(
      planJob({ reading: null, ownThreads: 0, ownJobs: 0, behind: 0, now }),
    ).toEqual({ wait: "the 4090's status is not known (not read yet)" });
    expect(
      planJob({
        reading: { at: now, error: "desktop-status gave no budget (exit 255)" },
        ownThreads: 0,
        ownJobs: 0,
        behind: 0,
        now,
      }),
    ).toEqual({
      wait: "the 4090's status is not known (desktop-status gave no budget (exit 255))",
    });
  });

  test("the 4090 is kept free for the backup mirror, 10:15-10:50 UTC", () => {
    const at = (hhmm: string) => Date.parse(`2026-10-29T${hhmm}:00Z`);
    const reading = (t: number) => ({ at: t, status: status(FREE), others: 0 });
    const planAt = (hhmm: string) =>
      planJob({
        reading: reading(at(hhmm)),
        ownThreads: 0,
        ownJobs: 0,
        behind: 0,
        now: at(hhmm),
      });
    expect(planAt("10:14")).toEqual({ workers: 12 });
    expect(planAt("10:15")).toEqual({
      wait: "the 4090 is kept free for the backup mirror, 10:15-10:50 UTC",
    });
    expect(planAt("10:49").wait).toContain("backup mirror");
    expect(planAt("10:50")).toEqual({ workers: 12 });
  });

  test("the reader: one reading a period, the app's own units apart, and it stops", async () => {
    const ours = desktopName("v-2026-10-29-1-GAME-p1");
    // A hand run of render-4090.mjs has a wg-video unit too, but not ours.
    const text = FREE.replace(
      "  job-20261029T024001Z-wg-video-0123456789ab.service running",
      `  job-20261029T024001Z-${ours}.service running\n  job-20261029T024002Z-${desktopName("by hand")}.service running`,
    );
    const asked: string[][] = [];
    let readings = 0;
    const reader = createBudgetReader({
      statusCommand: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(text)})`,
      ],
      threadsOf: (ids: string[]) => {
        asked.push(ids);
        return Promise.resolve(ids.length * 8);
      },
      ownNames: () => [ours],
      wanted: () => true,
      everyMs: 300,
      // As the app's pump does: it wakes the reader after each reading.
      onReading: () => {
        readings += 1;
        reader.wake();
      },
    });
    reader.wake();
    await Bun.sleep(1100);
    // Without the fix, each wake started another read at once (VR2).
    expect(readings).toBeGreaterThanOrEqual(2);
    expect(readings).toBeLessThanOrEqual(4);
    expect(asked[0]).toEqual([
      "20261029T023345Z-cap1",
      `20261029T024002Z-${desktopName("by hand")}`,
    ]);
    expect(reader.latest()?.others).toBe(16);
    reader.stop();
    const stoppedAt = readings;
    await Bun.sleep(700);
    expect(readings).toBe(stoppedAt);
  });

  test("two jobs of 6 stay inside the 12 GB of all render jobs", () => {
    expect(memoryFor(6)).toBe("6G");
    expect(memoryFor(12)).toBe("8G");
  });
});
