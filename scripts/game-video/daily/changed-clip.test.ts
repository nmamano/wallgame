import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIP_LEAD_IN,
  changedProblem,
  changedSpan,
  clipPath,
  cutClip,
  parseChanged,
} from "./changed-clip.mjs";

/** -8's timeline (render mvxy88al, 2026-11-01), its last plies. */
const TIMELINE = {
  moves: [
    { ply: 17, at: 20.2 },
    { ply: 18, at: 22 },
    { ply: 19, at: 25.23 },
    { ply: 20, at: 28.6 },
  ],
  events: [
    { index: 4, ply: 17, start: 20.5, end: 21.7 },
    { index: 5, ply: 18, start: 22.3, end: 23.1 },
    { index: 6, ply: 18, start: 22, end: 25.23 },
    { index: 7, ply: 20, start: 26.13, end: 32.57 },
    { index: 8, ply: 20, start: 28.6, end: 30.47 },
    { index: 9, ply: 20, start: 31.37, end: 34.23 },
    { index: 10, ply: 20, start: 34.23, end: 36.8 },
    { index: 11, ply: 20, start: 36.8, end: 41.37 },
  ],
};
const DURATION = 41.867;
/** -8's list, its events in order (the timeline's `index`). */
const EVENTS = [
  { ply: 4, kind: "scared" },
  { ply: 6, kind: "overlay", asset: "reactor-shock", sound: "ooh-1" },
  { ply: 7, kind: "race" },
  { ply: 7, kind: "laugh" },
  { ply: 17, kind: "blunder" },
  { ply: 18, kind: "race" },
  { ply: 18, kind: "overlay", asset: "gs-jjj-laugh" },
  { ply: 20, kind: "explain" },
  { ply: 20, kind: "overlay", asset: "gs-fire", sound: "boom-4" },
  { ply: 20, kind: "overlay", asset: "gs-laugh-cry" },
  { ply: 20, kind: "overlay", asset: "resign-flag" },
  { ply: 20, kind: "overlay", form: "bar", asset: "ending-caption" },
];

describe("a revision's clip (Nil, 2026-11-01, C54)", () => {
  test("--changed reads plies, the end card, or all", () => {
    expect(parseChanged("20")).toEqual({ plies: [20], beats: [], end: false });
    expect(parseChanged("20, 18,end,18")).toEqual({
      plies: [18, 20],
      beats: [],
      end: true,
    });
    expect(parseChanged("end")).toEqual({ plies: [], beats: [], end: true });
    expect(parseChanged("all")).toEqual({ plies: "all" });
    expect(parseChanged("20:resign-flag,end")).toEqual({
      plies: [],
      beats: [{ ply: 20, name: "resign-flag" }],
      end: true,
    });
    expect(() => parseChanged("all,20")).toThrow("not a ply");
    expect(() => parseChanged("twenty")).toThrow("not a ply");
    expect(() => parseChanged(" , ")).toThrow("names nothing");
  });

  test("a changed list needs one line of what, and the game's plies", () => {
    const ok = {
      plies: [20],
      beats: [],
      end: false,
      what: "both pawns wave flags",
    };
    expect(changedProblem(ok, 20, EVENTS)).toBeNull();
    expect(
      changedProblem({ plies: "all", what: "the caption" }, 20, EVENTS),
    ).toBeNull();
    expect(changedProblem(undefined, 20, EVENTS)).toBe("changed is missing");
    expect(changedProblem({ ...ok, what: " " }, 20, EVENTS)).toContain(
      "needs `what`",
    );
    expect(changedProblem({ ...ok, what: "a\nb" }, 20, EVENTS)).toContain(
      "needs `what`",
    );
    expect(
      changedProblem({ ...ok, what: "x".repeat(201) }, 20, EVENTS),
    ).toContain("at most 200");
    expect(changedProblem({ ...ok, plies: [21] }, 20, EVENTS)).toContain(
      "plies are 0 to 20",
    );
    expect(
      changedProblem({ ...ok, plies: [], end: false }, 20, EVENTS),
    ).toContain("names no ply");
  });

  test("a beat names an event of the list on its ply", () => {
    const beat = (ply: number, name: string) => ({
      plies: [],
      beats: [{ ply, name }],
      end: false,
      what: "flags",
    });
    expect(changedProblem(beat(20, "resign-flag"), 20, EVENTS)).toBeNull();
    expect(changedProblem(beat(20, "boom-4"), 20, EVENTS)).toBeNull();
    expect(changedProblem(beat(18, "resign-flag"), 20, EVENTS)).toContain(
      "the list has no resign-flag on ply 18",
    );
  });

  test("a beat's clip is that beat only, not the rest of its ply", () => {
    // The flags (34.23-36.8 s), the Director's C54 example.
    const flags = {
      plies: [],
      beats: [{ ply: 20, name: "resign-flag" }],
      end: false,
    };
    expect(changedSpan(TIMELINE, flags, DURATION, EVENTS)).toEqual({
      from: 32.2,
      to: 36.8,
    });
    const fire = {
      plies: [],
      beats: [{ ply: 20, name: "boom-4" }],
      end: false,
    };
    expect(changedSpan(TIMELINE, fire, DURATION, EVENTS)).toEqual({
      from: 26.6,
      to: 30.5,
    });
  });

  test("the span starts before the changed beat and ends with it, not with later beats", () => {
    // Ply 18: its move at 22 s, its overlay to 25.23 s; ply 20's later
    // beats are not in it.
    expect(
      changedSpan(
        TIMELINE,
        { plies: [18], beats: [], end: false },
        DURATION,
        EVENTS,
      ),
    ).toEqual({ from: 22 - CLIP_LEAD_IN, to: 25.3 });
    // A ply with no event ends at the next move.
    expect(
      changedSpan(
        TIMELINE,
        { plies: [19], beats: [], end: false },
        DURATION,
        EVENTS,
      ),
    ).toEqual({ from: 23.2, to: 28.6 });
  });

  test("the last ply and the end card run to the video's end; an explain's build-up is in the lead-in; the end card starts at its bar", () => {
    // Ply 20's explain starts at 26.13 s, before its move lands at 28.6 s.
    expect(
      changedSpan(
        TIMELINE,
        { plies: [20], beats: [], end: false },
        DURATION,
        EVENTS,
      ),
    ).toEqual({ from: 24.1, to: 41.9 });
    expect(
      changedSpan(
        TIMELINE,
        { plies: [], beats: [], end: true },
        DURATION,
        EVENTS,
      ),
    ).toEqual({
      // The end card opens with the ending's bar (36.8 s), not at the
      // last move (Wall Game Director, 2026-11-01).
      from: 34.8,
      to: 41.9,
    });
    expect(
      changedSpan(
        TIMELINE,
        { plies: [17, 18], beats: [], end: false },
        DURATION,
        EVENTS,
      ),
    ).toEqual({ from: 18.2, to: 25.3 });
    expect(
      changedSpan(TIMELINE, { plies: "all" }, DURATION, EVENTS),
    ).toBeNull();
  });

  test("the whole video when the clip would start in the intro or run over half of it (BIn, Nil 2026-11-06)", () => {
    // BIn's timeline (2026-11-06): ply 0 lands at 2.47 s after the intro.
    const moves = Array.from({ length: 45 }, (_, ply) => ({
      ply,
      at: 2.47 + ply * 0.9,
    }));
    const bin = { moves, events: [] };
    const plies = (list: number[]) => ({ plies: list, beats: [], end: false });
    // Plies 0-38, BIn's Revise: its clip ran 0.4-29.7 s and cut the intro.
    expect(
      changedSpan(
        bin,
        plies(Array.from({ length: 39 }, (_, p) => p)),
        44.7,
        [],
      ),
    ).toBeNull();
    // Ply 0 alone: its lead-in reaches into the intro.
    expect(changedSpan(bin, plies([0]), 44.7, [])).toBeNull();
    // Plies 10-35: past the intro, but 23.4 s of 44.7 s.
    expect(
      changedSpan(
        bin,
        plies(Array.from({ length: 26 }, (_, p) => p + 10)),
        44.7,
        [],
      ),
    ).toBeNull();
    // One ply past the intro: a clip.
    expect(changedSpan(bin, plies([20]), 44.7, [])).toEqual({
      from: 18.4,
      to: 21.4,
    });
  });

  test("the clip is cut once, frame-exact, next to the video", () => {
    const dir = mkdtempSync(join(tmpdir(), "changed-clip-"));
    const video = join(dir, "v.mp4");
    const made = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x284:rate=30:duration=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      video,
    ]);
    expect(made.status).toBe(0);
    const span = { from: 1, to: 2.5 };
    const out = cutClip(video, span);
    expect(out).toBe(clipPath(video, span));
    expect(out).toEndWith("v-changed-1.0-2.5.mp4");
    const seconds = Number(
      spawnSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "csv=p=0",
          out,
        ],
        { encoding: "utf8" },
      ).stdout,
    );
    expect(seconds).toBeGreaterThan(1.4);
    expect(seconds).toBeLessThan(1.6);
    expect(existsSync(out.replace(/\.mp4$/, ".part.mp4"))).toBe(false);
    // A second sync finds it.
    expect(cutClip(video, span)).toBe(out);
  });
});
