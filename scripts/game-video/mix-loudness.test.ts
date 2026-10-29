import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  memeLoudness,
  memeOverBed,
  mixGraph,
  parseMomentary,
} from "./mix-loudness.mjs";

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

test("a window of digital silence (M: nan) is silence, not a missing window", () => {
  // ffmpeg's log under a bed of pure silence: a list with its music off,
  // the finish sound over nothing (VX, 2026-10-29).
  const log = [
    "[Parsed_ebur128_357 @ 0x1] t: 37.1       TARGET:-23 LUFS    M:   nan S: -44.4     I: -34.2 LUFS       LRA:  10.9 LU  FTPK:  -inf  -inf dBFS  TPK: -15.2 -15.2 dBFS",
    "[Parsed_ebur128_357 @ 0x1] t: 37.2       TARGET:-23 LUFS    M:   nan S: -44.4     I: -34.2 LUFS       LRA:  11.2 LU  FTPK:  -inf  -inf dBFS  TPK: -15.2 -15.2 dBFS",
    "[Parsed_ebur128_357 @ 0x1] Summary:",
    "  True peak:",
    "    Peak:      -15.2 dBFS",
  ].join("\n");
  const bed = parseMomentary(log);
  expect(bed.windows).toEqual([
    { t: 37.1, m: -Infinity },
    { t: 37.2, m: -Infinity },
  ]);
  // A meme over it stands over nothing: no overLU, no error.
  const r = memeOverBed(
    { key: "trombone-2", at: 35.8 },
    parts([[37.2, -18]]),
    bed,
  );
  expect([r.bedLufs, r.overLU]).toEqual([null, null]);
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
    music: [
      {
        file: music,
        start: 0,
        endAt: 4,
        bed: 1,
        volume: 1,
        fadeIn: 0.01,
        fadeOut: 0.01,
      },
    ],
  });
  expect(r.memes).toHaveLength(1);
  const [m] = r.memes;
  expect(m.key).toBe("boom-1");
  expect(m.at).toBe(2);
  expect(m.overLU).toBeCloseTo(20 * Math.log10(0.2 / 0.05), 0);
});

describe("mixGraph", () => {
  const FORMAT =
    "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
  const cues = [{ file: "/a/pawn.wav", gain: 0.5, at: 2, rate: 1, meme: null }];
  const part = {
    file: "/s/song1.mp3",
    start: 1.25,
    endAt: 30.5,
    bed: 0.35,
    volume: 0.3,
    fadeIn: 1.6,
    fadeOut: 2,
  };

  test("one music part gives the graph of the renders before music cues", () => {
    // The chains of 2026-10-28 main (d4b3e30e): a one-cue EDL renders the
    // same MP4 as the string "music" did.
    expect(mixGraph({ cues, totalSeconds: 33, music: [part] }).chains).toEqual([
      `[0:a]${FORMAT},adelay=2000:all=1,volume=0.5[a0]`,
      "[a0]amix=inputs=1:normalize=0:dropout_transition=0,apad,atrim=0:33.000[fx]",
      `[1:a]${FORMAT},atrim=0:31.750,afade=t=in:st=0:d=1.6,volume='if(lt(t,27.250),1,if(lt(t,29.250),1-(1-0.35)*(t-27.250)/2,0.35))':eval=frame,volume=0.3,adelay=1250:all=1[mus]`,
      "[fx][mus]amix=inputs=2:normalize=0:dropout_transition=0[mix]",
    ]);
  });

  test("several parts each start at their own second and add up under the effects", () => {
    const second = { ...part, file: "/s/song5.mp3", start: 12, fadeIn: 0.25 };
    const first = { ...part, endAt: 13, bed: 0, fadeOut: 1 };
    const { inputs, chains } = mixGraph({
      cues,
      totalSeconds: 33,
      music: [first, second],
    });
    expect(inputs).toEqual([
      "-i",
      "/a/pawn.wav",
      "-i",
      "/s/song1.mp3",
      "-i",
      "/s/song5.mp3",
    ]);
    expect(chains.slice(2)).toEqual([
      `[1:a]${FORMAT},atrim=0:31.750,afade=t=in:st=0:d=1.6,afade=t=out:st=10.750:d=1,volume=0.3,adelay=1250:all=1[m0]`,
      `[2:a]${FORMAT},atrim=0:21.000,afade=t=in:st=0:d=0.25,volume='if(lt(t,16.500),1,if(lt(t,18.500),1-(1-0.35)*(t-16.500)/2,0.35))':eval=frame,volume=0.3,adelay=12000:all=1[m1]`,
      "[m0][m1]amix=inputs=2:normalize=0:dropout_transition=0[mus]",
      "[fx][mus]amix=inputs=2:normalize=0:dropout_transition=0[mix]",
    ]);
  });

  test("music with no cues ends the music bus at [mix]", () => {
    const { chains } = mixGraph({
      cues: [],
      totalSeconds: 33,
      music: [part, { ...part, start: 12 }],
    });
    expect(chains.at(-1)).toBe(
      "[m0][m1]amix=inputs=2:normalize=0:dropout_transition=0,apad,atrim=0:33.000[mix]",
    );
    expect(() => mixGraph({ cues: [], totalSeconds: 33, music: [] })).toThrow(
      "nothing to mix",
    );
  });
});
