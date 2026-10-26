import { describe, expect, test } from "bun:test";
import {
  checkEdlAgainstGame,
  DEFAULT_ZOOM_SCALE,
  validateEdl,
} from "./edl.mjs";

const base = {
  version: 1,
  gameId: "eeFSMEmL",
  caption: "the bot was 97% winning 💀",
  ending: "replay",
};

describe("validateEdl", () => {
  test("fills the defaults of a minimal EDL", () => {
    const r = validateEdl({
      ...base,
      events: [{ ply: 15, kind: "zoom", frame: ["^h4", "g4"] }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edl.pace).toEqual([]);
    expect(r.edl.events[0]).toMatchObject({ scale: DEFAULT_ZOOM_SCALE });
  });

  test("counts an emoji as one character, and holds the caption to 6 words and 32", () => {
    expect(validateEdl(base).ok).toBe(true);
    const seven = validateEdl({ ...base, caption: "a b c d e f g" });
    expect(seven.ok).toBe(false);
    const long = validateEdl({
      ...base,
      caption: "unbelievably extraordinarily long caption",
    });
    expect(long.ok).toBe(false);
    expect(validateEdl({ ...base, caption: "two\nlines" }).ok).toBe(false);
  });

  test("requires the ending and rejects unknown fields and sounds", () => {
    expect(validateEdl({ ...base, ending: undefined }).ok).toBe(false);
    expect(validateEdl({ ...base, swings: [] }).ok).toBe(false);
    const r = validateEdl({
      ...base,
      events: [{ ply: 3, kind: "sound", sound: "airhorn-9" }],
    });
    expect(r.ok).toBe(false);
    expect(
      validateEdl({
        ...base,
        events: [{ ply: 3, kind: "scared", cell: "g4", colour: "red" }],
      }).ok,
    ).toBe(false);
  });

  test("rejects overlapping pace ranges", () => {
    const r = validateEdl({
      ...base,
      pace: [
        { fromPly: 0, toPly: 5, secondsPerMove: 0.6 },
        { fromPly: 5, toPly: 8, secondsPerMove: 1.2 },
      ],
    });
    expect(r.ok).toBe(false);
  });
});

describe("checkEdlAgainstGame", () => {
  const notations = ["Ce7", "Cf7", "^a4.^h4"];
  test("accepts a wall placed by that ply and rejects one placed later or never", () => {
    const ok = validateEdl({
      ...base,
      events: [{ ply: 2, kind: "zoom", frame: ["^h4", "g4"] }],
    });
    if (!ok.ok) throw new Error(ok.errors.join("; "));
    expect(
      checkEdlAgainstGame(ok.edl, { notations, cols: 8, rows: 8 }),
    ).toEqual([]);
    const early = validateEdl({
      ...base,
      events: [{ ply: 1, kind: "zoom", frame: [">h4"] }],
    });
    if (!early.ok) throw new Error(early.errors.join("; "));
    expect(
      checkEdlAgainstGame(early.edl, { notations, cols: 8, rows: 8 }),
    ).toHaveLength(1);
  });

  test("rejects a ply past the last move and a cell off the board", () => {
    const r = validateEdl({
      ...base,
      events: [{ ply: 3, kind: "laugh", cell: "z9" }],
    });
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(
      checkEdlAgainstGame(r.edl, { notations, cols: 8, rows: 8 }),
    ).toHaveLength(2);
  });
});

describe("music", () => {
  test("is optional, null when absent, and only a site track", () => {
    const absent = validateEdl(base);
    expect(absent.ok && absent.edl.music).toBe(null);
    expect(validateEdl({ ...base, music: "a-legend" }).ok).toBe(true);
    expect(validateEdl({ ...base, music: "darude" }).ok).toBe(false);
  });
});
