import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  STRIP_MOST,
  audio,
  crop,
  cropBox,
  feedGain,
  fullcheck,
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
