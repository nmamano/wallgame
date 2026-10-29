import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  STRIP_MOST,
  audio,
  boardMoved,
  cellBox,
  crop,
  cropBox,
  feedGain,
  fullcheck,
  gridOf,
  lastFrameAt,
  loudnessAb,
  loudnessSummary,
  metadataSeries,
  scan,
  scanPlan,
  shortTermPerSecond,
  silences,
  strip,
  stripTimes,
} from "./tools.mjs";

describe("the plans", () => {
  test("a scan: a tile every S s, 7 a row", () => {
    expect(scanPlan(47.2, 1.5)).toMatchObject({
      count: 32,
      columns: 7,
      rows: 5,
    });
    expect(scanPlan(3, 1.5)).toMatchObject({ count: 2, columns: 2, rows: 1 });
    expect(scanPlan(47.2, 1.5).times.slice(0, 3)).toEqual([0, 1.5, 3]);
    expect(() => scanPlan(10, 0)).toThrow("--every must be over 0");
  });

  test("a strip: F frames a second, never more than the most, cut at the end", () => {
    expect(stripTimes(19, 1, 4, 47.1)).toEqual([19, 19.25, 19.5, 19.75]);
    expect(stripTimes(47, 1, 4, 47.1)).toEqual([47]);
    expect(() => stripTimes(0, 10, 4, 47.1)).toThrow(`${STRIP_MOST} at most`);
    expect(() => stripTimes(-1, 1, 4, 47.1)).toThrow(
      "--from must be in 0..47.1 s",
    );
    expect(() => stripTimes(48, 1, 4, 47.1)).toThrow(
      "--from must be in 0..47.1 s, got 48",
    );
  });

  test("a crop box is whole pixels inside the frame", () => {
    const frame = { width: 1080, height: 1920 };
    expect(cropBox("81,380,918,852", frame)).toEqual({
      x: 81,
      y: 380,
      w: 918,
      h: 852,
    });
    expect(() => cropBox("1000,0,100,100", frame)).toThrow(
      "is not inside the 1080x1920 frame",
    );
    expect(() => cropBox("1,2,3", frame)).toThrow("X,Y,W,H in whole pixels");
  });

  test("the last frame a seek finds: a frame and a half before the end", () => {
    expect(lastFrameAt({ duration: 47.2, fps: 15 })).toBe(47.1);
    expect(lastFrameAt({ duration: 30, fps: 30 })).toBe(29.95);
  });

  test("the gain to the feed's -14 LUFS", () => {
    expect(feedGain(-25)).toBe(11);
    expect(feedGain(-12.34)).toBe(-1.7);
  });
});

describe("the parsers of ffmpeg's output", () => {
  test("ametadata's pairs, with -inf for digital silence", () => {
    const stderr = [
      "[Parsed_ametadata_2 @ 0x1] frame:0    pts:0       pts_time:0",
      "[Parsed_ametadata_2 @ 0x1] lavfi.astats.Overall.Peak_level=-10.233898",
      "[Parsed_ametadata_2 @ 0x1] frame:1    pts:4410    pts_time:0.1",
      "[Parsed_ametadata_2 @ 0x1] lavfi.astats.Overall.Peak_level=-inf",
    ].join("\n");
    expect(metadataSeries(stderr, "lavfi.astats.Overall.Peak_level")).toEqual([
      [0, -10.233898],
      [0.1, -Infinity],
    ]);
  });

  test("silences, and one still open at the end", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 0",
      "[silencedetect @ 0x1] silence_end: 0.897256 | silence_duration: 0.897256",
      "[silencedetect @ 0x1] silence_start: 46.35",
    ].join("\n");
    expect(silences(stderr, 47.2)).toEqual([
      { start: 0, end: 0.9, seconds: 0.9 },
      { start: 46.35, end: 47.2, seconds: 0.85 },
    ]);
  });

  test("the summary: integrated loudness and true peak", () => {
    const stderr = [
      "[Parsed_ebur128_1 @ 0x1] Summary:",
      "  Integrated loudness:",
      "    I:         -25.0 LUFS",
      "  True peak:",
      "    Peak:      -10.2 dBFS",
    ].join("\n");
    expect(loudnessSummary(stderr)).toEqual({ lufs: -25, truePeak: -10.2 });
  });

  test("short-term loudness: one a second, from 3 s", () => {
    expect(
      shortTermPerSecond([
        [0.1, -120.7],
        [2.9, -120.7],
        [3.0, -32.4],
        [3.1, -31],
        [4.0, -30],
      ]),
    ).toEqual([
      [3, -32.4],
      [4, -30],
    ]);
  });
});

/**
 * An 8x8 board as RESULT.layout.grid gives it (css px of the 1080x1920
 * frame): cells of 80 px, a gap of 10, so a cell line u is at 175 + 90u.
 */
const GRID = {
  clip: { x: 170, y: 490, width: 740, height: 740 },
  first: { x: 180, y: 500, width: 80, height: 80 },
  last: { x: 810, y: 1130, width: 80, height: 80 },
  cols: 8,
  rows: 8,
};

/**
 * Zooms on plies 5 and 10 (the last, landing at 20 s), a trap on ply 6, a
 * freeze on ply 7 and a blunder on ply 8.
 */
const TIMELINE = {
  moves: [
    { ply: 0, at: 2 },
    { ply: 6, at: 12 },
    { ply: 10, at: 20 },
  ],
  events: [
    { index: 0, ply: 5, kind: "zoom", start: 8, end: 11 },
    { index: 1, ply: 6, kind: "trap", start: 12, end: 13 },
    { index: 2, ply: 7, kind: "freeze", start: 13.2, end: 14.5 },
    { index: 3, ply: 8, kind: "blunder", start: 15, end: 16.2 },
    { index: 4, ply: 10, kind: "zoom", start: 19, end: 21 },
  ],
  sounds: [],
};

describe("crop --cell", () => {
  test("the grid is kept whole, or not at all", () => {
    expect(gridOf({ ...GRID, extra: 1 })).toEqual(GRID);
    expect(gridOf(null)).toBeNull();
    expect(gridOf({ ...GRID, cols: 1 })).toBeNull();
    expect(gridOf({ ...GRID, first: { x: 1, y: 2 } })).toBeNull();
  });

  test("a cell and its radius, cut at the board's edge, in the video's pixels", () => {
    const frame = { width: 1080, height: 1920 };
    // a8 is the top left cell; row 1 is at the bottom.
    expect(cellBox("a8", 0, GRID, frame)).toEqual({
      x: 175,
      y: 495,
      w: 90,
      h: 90,
    });
    expect(cellBox("e7", 1, GRID, frame)).toEqual({
      x: 445,
      y: 495,
      w: 270,
      h: 270,
    });
    expect(cellBox("h1", 2, GRID, frame)).toEqual({
      x: 625,
      y: 945,
      w: 270,
      h: 270,
    });
    // A draft (540x960) is the frame at half size.
    expect(cellBox("e7", 1, GRID, { width: 540, height: 960 })).toEqual({
      x: 222,
      y: 247,
      w: 136,
      h: 136,
    });
    expect(() => cellBox("i1", 0, GRID, frame)).toThrow(
      "--cell is a cell of the 8x8 board, a1 to h8, got i1",
    );
    expect(() => cellBox("a9", 0, GRID, frame)).toThrow("got a9");
    expect(() => cellBox("a1", -1, GRID, frame)).toThrow(
      "--radius is a whole number of cells, got -1",
    );
    expect(() => cellBox("a1", 0, GRID, { width: 1080, height: 1080 })).toThrow(
      "is not 1080x1920 or a scale of it",
    );
  });

  test("only at rest: not in a zoom, a freeze or a blunder, not in the ending, not in a cold open", () => {
    const rest = { coldOpen: false };
    expect(boardMoved(TIMELINE, 9, rest)).toBe(
      "9 s is inside the zoom on ply 5 (8-11 s)",
    );
    expect(boardMoved(TIMELINE, 12.5, rest)).toBeNull();
    // A freeze pushes the camera in; a blunder shakes the board.
    expect(boardMoved(TIMELINE, 13.5, rest)).toBe(
      "13.5 s is inside the freeze on ply 7 (13.2-14.5 s)",
    );
    expect(boardMoved(TIMELINE, 15.1, rest)).toBe(
      "15.1 s is inside the blunder on ply 8 (15-16.2 s)",
    );
    expect(boardMoved(TIMELINE, 16.5, rest)).toBeNull();
    // The last ply's lead zoom starts before its move lands.
    expect(boardMoved(TIMELINE, 19.5, rest)).toBe(
      "19.5 s is inside the zoom on ply 10 (19-21 s)",
    );
    // The ending, with or without a zoom on the last ply.
    expect(boardMoved(TIMELINE, 25, rest)).toBe(
      "25 s is at or after the last move (20 s): the ending moves the board",
    );
    const noZoom = {
      ...TIMELINE,
      events: TIMELINE.events.filter((e) => e.ply !== 10),
    };
    expect(boardMoved(noZoom, 20, rest)).toBe(
      "20 s is at or after the last move (20 s): the ending moves the board",
    );
    expect(boardMoved(noZoom, 19.9, rest)).toBeNull();
    expect(boardMoved(TIMELINE, 1, rest)).toBeNull();
    expect(boardMoved(TIMELINE, 1, { coldOpen: true })).toBe(
      "1 s is before the first move (2 s), and the list has a cold open (a zoom)",
    );
  });
});

describe("the tools on a real video", () => {
  // 4 s, 30 fps, 320x568: a tone, then silence from 1.5 s to 3 s.
  const dir = mkdtempSync(join(tmpdir(), "tools-test-"));
  const video = join(dir, "v.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x568:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4:sample_rate=44100",
    "-af",
    "volume=enable='between(t,1.5,3)':volume=0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    video,
  ]);
  const pathOf = (lines: string[]) => lines[0].split(": ")[1].split(" ")[0];

  test("scan, strip, crop and fullcheck write their PNG", () => {
    expect(existsSync(pathOf(scan({ video, name: "t", every: 1 })))).toBe(true);
    expect(
      existsSync(
        pathOf(strip({ video, name: "t", from: 1, seconds: 1, fps: 4 })),
      ),
    ).toBe(true);
    expect(
      existsSync(pathOf(crop({ video, name: "t", at: 2, box: "0,0,100,50" }))),
    ).toBe(true);
    // Around a cell: the 320x568 video is the frame at about 0.3.
    const cell = { cell: "e7", radius: 1, grid: GRID, coldOpen: false };
    const around = crop({
      video,
      name: "t",
      at: 2,
      cell: { ...cell, timeline: { ...TIMELINE, events: [] } },
    });
    expect(existsSync(pathOf(around))).toBe(true);
    expect(around[1]).toContain("(e7, radius 1; --box 131,146,81,81)");
    expect(() =>
      crop({
        video,
        name: "t",
        at: 2,
        cell: {
          ...cell,
          timeline: {
            ...TIMELINE,
            events: [{ index: 0, ply: 5, kind: "zoom", start: 1, end: 3 }],
          },
        },
      }),
    ).toThrow(
      "2 s is inside the zoom on ply 5 (1-3 s): --cell holds only at rest; use --box",
    );
    // Past the end: the frames that exist, or a refusal; never no file.
    const late = strip({ video, name: "t", from: 3.5, seconds: 2, fps: 4 });
    expect(existsSync(pathOf(late))).toBe(true);
    expect(late[1]).toBe("  2 frames at 3.5 3.75 s (the video ends there)");
    expect(() =>
      strip({ video, name: "t", from: 5, seconds: 1, fps: 4 }),
    ).toThrow("--from must be in 0..3.95 s, got 5");
    expect(() => crop({ video, name: "t", at: 3.99, box: "0,0,1,1" })).toThrow(
      "--at must be in 0..3.95 s",
    );
    const check = fullcheck({ video, name: "t" });
    expect(check[0]).toBe(
      "fullcheck: h264 320x568 at 30 fps, 4 s, audio aac 44100 Hz",
    );
    expect(existsSync(check[1].split(": ")[1])).toBe(true);
    expect(check[3]).toMatch(/from 3 s .*: 3s:-\d+$/);
  });

  test("audio finds the gap, and a range gives each 0.1 s", () => {
    const whole = audio({ video });
    expect(whole[2]).toMatch(/silence .*: 1\.\d+-3\.\d+ \(1\.\d+ s\)/);
    const ranged = audio({ video, from: 1, seconds: 1 });
    expect(ranged[0]).toBe("audio of 1-2 s:");
    const peaks = ranged[3].split(": ")[1].split(" ");
    expect(peaks).toHaveLength(10);
    // The tone until 1.5 s, then digital silence.
    expect(Number(peaks[0])).toBeGreaterThan(-20);
    expect(peaks.at(-1)).toBe("-inf");
  });

  test("loudness-ab: a copy at about -14 LUFS", () => {
    const lines = loudnessAb({ video, name: "t" });
    expect(existsSync(pathOf(lines))).toBe(true);
    const after = Number(/limiter: ([-\d.]+) LUFS/.exec(lines[2])![1]);
    expect(Math.abs(after - -14)).toBeLessThan(1.5);
  });

  test("crew: a tool needs exactly one video", () => {
    const crew = (...args: string[]) =>
      spawnSync(
        "node",
        [resolve(import.meta.dir, "crew.mjs"), ...args, "--app", "http://x"],
        { encoding: "utf8" },
      );
    expect(crew("scan").stderr).toContain(
      "name one video: --item ID, --preview ID or --video FILE",
    );
    const r = crew("strip", "--video", video, "--from", "0", "--seconds", "1");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("4 frames at 0 0.25 0.5 0.75 s");
  });
});
