import { describe, expect, test } from "bun:test";
import {
  checkEdlAgainstGame,
  dailySeatColors,
  DEFAULT_FREEZE_HOLD_SECONDS,
  DEFAULT_RACE_PLIES,
  DEFAULT_TRAP_TEXT,
  DEFAULT_ZOOM_SCALE,
  validateEdl,
} from "./edl.mjs";

const base = {
  version: 1,
  gameId: "eeFSMEmL",
  caption: "the bot was 97% winning 💀",
  ending: "replay",
};

// edl.mjs is plain JS, so tsc widens `ok` to boolean and cannot narrow on
// it. The test narrows on `edl` itself and fails with the validator's errors.
const accept = (raw: object) => {
  const r = validateEdl(raw);
  if (!r.edl) throw new Error((r.errors ?? []).join("; "));
  return r.edl;
};

describe("validateEdl", () => {
  test("fills the defaults of a minimal EDL", () => {
    const edl = accept({
      ...base,
      events: [{ ply: 15, kind: "zoom", frame: ["^h4", "g4"] }],
    });
    expect(edl.pace).toEqual([]);
    expect(edl.events[0]).toMatchObject({ scale: DEFAULT_ZOOM_SCALE });
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

describe("the moment kinds", () => {
  test("accept each kind with its fields, sound optional, and fill the defaults", () => {
    const edl = accept({
      ...base,
      events: [
        { ply: 1, kind: "blunder", cell: "g4", sound: "scared-2" },
        { ply: 2, kind: "brilliant", cell: "e6" },
        { ply: 3, kind: "trap", walls: ["^h4", ">g4"] },
        { ply: 4, kind: "race" },
        { ply: 9, kind: "freeze" },
        { ply: 10, kind: "react", cell: "a1", emoji: "moai" },
      ],
    });
    expect(edl.events[2]).toMatchObject({ text: DEFAULT_TRAP_TEXT });
    expect(edl.events[3]).toMatchObject({ plies: DEFAULT_RACE_PLIES });
    expect(edl.events[4]).toMatchObject({
      holdSeconds: DEFAULT_FREEZE_HOLD_SECONDS,
    });
  });

  test("refuse a field of another kind, a missing cell, and an unknown emoji", () => {
    const one = (ev: object) => validateEdl({ ...base, events: [ev] }).ok;
    expect(one({ ply: 1, kind: "blunder", cell: "g4", emoji: "fire" })).toBe(
      false,
    );
    expect(one({ ply: 1, kind: "brilliant" })).toBe(false);
    expect(one({ ply: 1, kind: "react", cell: "g4", emoji: "poop" })).toBe(
      false,
    );
    expect(one({ ply: 1, kind: "react", cell: "g4" })).toBe(false);
    expect(one({ ply: 1, kind: "race", plies: 2, a: 3 })).toBe(false);
    expect(one({ ply: 1, kind: "freeze", cell: "g4" })).toBe(false);
  });

  test("hold the trap to walls and a stamp word, the race and freeze to their ranges", () => {
    const one = (ev: object) => validateEdl({ ...base, events: [ev] }).ok;
    expect(one({ ply: 1, kind: "trap", walls: ["g4"] })).toBe(false);
    expect(one({ ply: 1, kind: "trap", walls: [] })).toBe(false);
    expect(one({ ply: 1, kind: "trap", walls: ["^g4"], text: "boxed" })).toBe(
      false,
    );
    expect(
      one({ ply: 1, kind: "trap", walls: ["^g4"], text: "BOXED IN" }),
    ).toBe(true);
    expect(one({ ply: 1, kind: "race", plies: 1 })).toBe(false);
    expect(one({ ply: 1, kind: "race", plies: 2.5 })).toBe(false);
    expect(one({ ply: 1, kind: "freeze", holdSeconds: 5 })).toBe(false);
  });

  test("show one race at a time and freeze a move once", () => {
    const races = validateEdl({
      ...base,
      events: [
        { ply: 4, kind: "race", plies: 3 },
        { ply: 6, kind: "race" },
      ],
    });
    expect(races.errors?.join()).toContain("overlap");
    expect(
      validateEdl({
        ...base,
        events: [
          { ply: 4, kind: "race", plies: 3 },
          { ply: 7, kind: "race" },
        ],
      }).ok,
    ).toBe(true);
    expect(
      validateEdl({
        ...base,
        events: [
          { ply: 4, kind: "freeze" },
          { ply: 4, kind: "freeze", holdSeconds: 0.5 },
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("checkEdlAgainstGame", () => {
  const notations = ["Ce7", "Cf7", "^a4.^h4"];
  test("accepts a wall placed by that ply and rejects one placed later or never", () => {
    const ok = accept({
      ...base,
      events: [{ ply: 2, kind: "zoom", frame: ["^h4", "g4"] }],
    });
    expect(checkEdlAgainstGame(ok, { notations, cols: 8, rows: 8 })).toEqual(
      [],
    );
    const early = accept({
      ...base,
      events: [{ ply: 1, kind: "zoom", frame: [">h4"] }],
    });
    expect(
      checkEdlAgainstGame(early, { notations, cols: 8, rows: 8 }),
    ).toHaveLength(1);
  });

  test("holds a trap's walls to the board by its ply, like a zoom's", () => {
    const trap = (ply: number) =>
      accept({ ...base, events: [{ ply, kind: "trap", walls: ["^h4"] }] });
    expect(
      checkEdlAgainstGame(trap(2), { notations, cols: 8, rows: 8 }),
    ).toEqual([]);
    expect(
      checkEdlAgainstGame(trap(1), { notations, cols: 8, rows: 8 }),
    ).toHaveLength(1);
  });

  test("rejects a ply past the last move and a cell off the board", () => {
    const edl = accept({
      ...base,
      events: [{ ply: 3, kind: "laugh", cell: "z9" }],
    });
    expect(
      checkEdlAgainstGame(edl, { notations, cols: 8, rows: 8 }),
    ).toHaveLength(2);
  });
});

describe("music", () => {
  test("is optional, null when absent, and only a site track", () => {
    expect(accept(base).music).toBe(null);
    expect(validateEdl({ ...base, music: "a-legend" }).ok).toBe(true);
    expect(validateEdl({ ...base, music: "darude" }).ok).toBe(false);
  });
});

describe("dailySeatColors", () => {
  test("colours the AI red, else the first seat red, and refuses bot vs bot", () => {
    expect(dailySeatColors({ 1: false, 2: true })).toEqual({
      1: "blue",
      2: "red",
    });
    expect(dailySeatColors({ 1: true, 2: false })).toEqual({
      1: "red",
      2: "blue",
    });
    expect(dailySeatColors({ 1: false, 2: false })).toEqual({
      1: "red",
      2: "blue",
    });
    expect(() => dailySeatColors({ 1: true, 2: true })).toThrow(
      "both seats are bots",
    );
  });
});
