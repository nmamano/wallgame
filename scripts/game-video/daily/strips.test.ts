import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripPlan, timelineOf, writeStrips } from "./strips.mjs";

/**
 * Part of a real RESULT.timeline (VoSWbMDd, the renderer's test render of
 * 2026-10-26): the zoom and laugh of the save at ply 34, and the lead zoom
 * of the escape at ply 39, whose seeya plays on the landing frame.
 */
const TIMELINE = {
  moves: [
    { ply: 34, at: 18.4 },
    { ply: 39, at: 26.97 },
  ],
  events: [
    { index: 1, ply: 34, kind: "zoom", start: 18.7, end: 19.8 },
    { index: 2, ply: 34, kind: "laugh", start: 19.8, end: 21.1 },
    { index: 4, ply: 39, kind: "zoom", start: 26.6, end: 27.93 },
  ],
  sounds: [
    { name: "wall", role: "move", start: 18.4, event: null },
    { name: "fuahhh-1", role: "event", start: 18.7, event: 1 },
    { name: "laugh-2", role: "event", start: 19.8, event: 2 },
    { name: "wall", role: "move", start: 26.97, event: null },
    { name: "seeya-3", role: "event", start: 26.97, event: 4 },
    { name: "letsgo-1", role: "finish", start: 40.33, event: null },
  ],
};

describe("event strips", () => {
  test("a timeline is kept only in its shape, and only its fields", () => {
    expect(timelineOf(TIMELINE)).toEqual(TIMELINE);
    const extra = {
      ...TIMELINE,
      moves: [{ ply: 1, at: 2, note: "x" }],
    };
    expect(timelineOf(extra)?.moves).toEqual([{ ply: 1, at: 2 }]);
    expect(timelineOf(undefined)).toBeNull();
    expect(timelineOf({ moves: [], events: [] })).toBeNull();
    // A name or kind is drawn on the strips, so only plain names pass.
    expect(
      timelineOf({
        ...TIMELINE,
        sounds: [{ name: "<b>", role: "event", start: 1, event: 0 }],
      }),
    ).toBeNull();
    // The site fallback cues (no VS or win sound file) have an underscore.
    const fallback = {
      ...TIMELINE,
      sounds: [{ name: "game_start", role: "vs", start: 0, event: null }],
    };
    expect(timelineOf(fallback)).toEqual(fallback);
    expect(timelineOf({ ...TIMELINE, moves: [{ ply: 1, at: -1 }] })).toBeNull();
  });

  test("each event gets four frames in time order and its sounds against the landing", () => {
    const plan = stripPlan(TIMELINE, 42.73);
    expect(plan.map((r) => r.index)).toEqual([1, 2, 4]);
    // The lead zoom starts before its move; the seeya lands with it.
    const lead = plan[2];
    expect(lead.frames.map((f) => f.t)).toEqual([26.47, 26.6, 26.97, 27.1]);
    expect(lead.frames.map((f) => f.label)).toEqual([
      "26.47 s 0.5 s before the move",
      "26.60 s event starts",
      "26.97 s move lands",
      "27.10 s 0.5 s after the event starts",
    ]);
    expect(lead.lines).toEqual([
      "event 4: ply 39 zoom, 26.60-27.93 s; the move lands 26.97 s",
      "sounds: wall (move) starts 26.97 s, +0.00 s from the landing; seeya-3 (event) starts 26.97 s, +0.00 s from the landing",
    ]);
    // A laugh after the zoom: its sound comes 1.40 s after the landing.
    expect(plan[1].lines[1]).toContain(
      "laugh-2 (event) starts 19.80 s, +1.40 s from the landing",
    );
  });

  test("times are held inside the video, and a ply with no move says so", () => {
    const plan = stripPlan(
      {
        moves: [],
        events: [{ index: 0, ply: 3, kind: "freeze", start: 0.2, end: 1 }],
        sounds: [{ name: "boom-1", role: "event", start: 0.2, event: 0 }],
      },
      0.9,
    );
    expect(plan[0].frames.map((f) => f.t)).toEqual([0, 0.2, 0.7, 0.86]);
    expect(plan[0].lines).toEqual([
      "event 0: ply 3 freeze, 0.20-1.00 s; no move in the video for this ply",
      "sounds: boom-1 (event) starts 0.20 s",
    ]);
  });

  const CHROME = "/usr/bin/google-chrome";
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  test.skipIf(!existsSync(CHROME) || !hasFfmpeg)(
    "the strips are one PNG with a row per event",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "strips-test-"));
      const mp4 = join(dir, "v.mp4");
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=360x640:rate=30:duration=3",
        "-pix_fmt",
        "yuv420p",
        mp4,
      ]);
      const plan = stripPlan(
        {
          moves: [{ ply: 0, at: 1 }],
          events: [
            { index: 0, ply: 0, kind: "zoom", start: 0.8, end: 2 },
            { index: 1, ply: 0, kind: "laugh", start: 2, end: 3 },
          ],
          sounds: [],
        },
        3,
      );
      const out = join(dir, "strips.png");
      await writeStrips({ mp4, plan, out });
      const png = readFileSync(out);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      // Four 270-wide frames side by side, two rows of 480-high frames.
      expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(4 * 270);
      expect(png.readUInt32BE(20)).toBeGreaterThan(2 * 480);
      rmSync(dir, { recursive: true });
    },
    30_000,
  );
});
