import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memeLoudness, memeOverBed, parseMomentary } from "./mix-loudness.mjs";

const parts = (series: [number, number][]) => ({
  windows: series.map(([t, m]) => ({ t, m })),
  truePeakDbtp: -12,
});

describe("memeOverBed", () => {
  test("compares the meme's loudest window with the bed's window at the same t", () => {
    const meme = parts([
      [1.0, -40],
      [1.1, -21],
      [1.2, -25],
    ]);
    const bed = parts([
      [1.0, -20],
      [1.1, -31],
      [1.2, -20],
    ]);
    expect(memeOverBed({ key: "fuahhh-1", at: 0.8 }, meme, bed)).toEqual({
      key: "fuahhh-1",
      at: 0.8,
      loudestAt: 0.7,
      memeLufs: -21,
      bedLufs: -31,
      overLU: 10,
      truePeakDbtp: -12,
    });
  });

  test("a silent bed, or none, gives no overLU", () => {
    const meme = parts([[1.1, -21]]);
    const silent = parts([[1.1, -120.7]]);
    expect(memeOverBed({ key: "boom-1", at: 1 }, meme, silent).overLU).toBe(
      null,
    );
    expect(memeOverBed({ key: "boom-1", at: 1 }, meme, null).bedLufs).toBe(
      null,
    );
  });

  test("a silent meme sound is an error, not a pass", () => {
    expect(() =>
      memeOverBed({ key: "boom-1", at: 1 }, parts([[1.1, -120]]), null),
    ).toThrow(/silent/);
  });
});

test("parseMomentary reads the windows and the true peak of ffmpeg's log", () => {
  const log = [
    "[Parsed_ebur128_0 @ 0x1] t: 0.1  TARGET:-23 LUFS    M: -120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -inf dBFS  TPK: -inf dBFS",
    "[Parsed_ebur128_0 @ 0x1] t: 0.2  TARGET:-23 LUFS    M: -21.4 S:-120.7     I: -21.4 LUFS       LRA:   0.0 LU",
    "[Parsed_ebur128_0 @ 0x1] Summary:",
    "  True peak:",
    "    Peak:       -9.8 dBFS",
  ].join("\n");
  expect(parseMomentary(log)).toEqual({
    windows: [
      { t: 0.1, m: -120.7 },
      { t: 0.2, m: -21.4 },
    ],
    truePeakDbtp: -9.8,
  });
  expect(() => parseMomentary("no audio")).toThrow(/no loudness windows/);
});

test("memeLoudness rebuilds the meme alone and the bed, and measures each", () => {
  // Two 1 kHz tones, so the K-weighting is the same for both: the meme is
  // 12 dB over the music bed, and a click elsewhere is part of the bed.
  const dir = mkdtempSync(join(tmpdir(), "mix-loudness-"));
  const tone = (name: string, seconds: number, volume: number) => {
    const file = join(dir, `${name}.wav`);
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=1000:duration=${seconds}:sample_rate=44100`,
      "-af",
      `volume=${volume}`,
      "-ac",
      "2",
      file,
    ]);
    return file;
  };
  const music = tone("music", 4, 0.05);
  const meme = tone("meme", 1, 0.2);
  const click = tone("click", 0.05, 0.3);
  const r = memeLoudness({
    ffmpeg: "ffmpeg",
    cues: [
      { file: click, gain: 1, at: 0.2, rate: 1, meme: null },
      { file: meme, gain: 1, at: 2, rate: 1, meme: "boom-1" },
    ],
    totalSeconds: 4,
    music: {
      file: music,
      start: 0,
      endAt: 4,
      bed: 1,
      volume: 1,
      fadeIn: 0.01,
      fadeOut: 0.01,
    },
  });
  expect(r.memes).toHaveLength(1);
  const [m] = r.memes;
  expect(m.key).toBe("boom-1");
  expect(m.at).toBe(2);
  expect(m.overLU).toBeCloseTo(20 * Math.log10(0.2 / 0.05), 0);
});
