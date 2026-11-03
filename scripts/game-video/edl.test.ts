import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  checkEdlAgainstGame,
  dailySeatColors,
  dailySeatNames,
  DEFAULT_FREEZE_HOLD_SECONDS,
  DEFAULT_PATH_HOLD_SECONDS,
  DEFAULT_SLOT_SOUNDS,
  edlSoundUses,
  DEFAULT_TRAP_TEXT,
  DEFAULT_ZOOM_SCALE,
  fastForwardTag,
  FRAME,
  parsePlyWindow,
  pawnMovesOf,
  SAFE_AREA,
  STRIP_AREA,
  areaOf,
  validateEdl,
  eventSoundKeys,
} from "./edl.mjs";
import { OVERLAYS } from "./overlays.mjs";
import { goalSentenceFor } from "../../shared/domain/variant-rules";
import { pawnCell } from "../../shared/domain/pawns";
import { cellToStandardNotation } from "../../shared/domain/standard-notation";
import type { CustomSetupStandardInitialState } from "../../shared/domain/game-types";
import { replayDistances } from "./race-replay.ts";

const base = {
  version: 1,
  gameId: "eeFSMEmL",
  caption: "the bot was 97% winning 💀",
  ending: "replay",
};

// edl.mjs is plain JS, so tsc widens `ok` to boolean and cannot narrow on
// it. The test narrows on `edl` itself and fails with the validator's errors.
/**
 * The list validateEdl makes of `raw`, and a check that the list passes
 * again unchanged: the app writes this normalized copy for the 4090, and
 * the renderer validates it once more (2026-10-28: an overlay's
 * "seconds": null was refused there, and the first render on the release
 * failed).
 */
const accept = (raw: object) => {
  const r = validateEdl(raw);
  if (!r.edl) throw new Error((r.errors ?? []).join("; "));
  const again = validateEdl(JSON.parse(JSON.stringify(r.edl)));
  if (!again.edl) {
    throw new Error(
      `its own normalized copy is refused: ${(again.errors ?? []).join("; ")}`,
    );
  }
  expect(again.edl).toEqual(r.edl);
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

  test("a ply holds up to 4 s, for a long sound that must finish on it", () => {
    const pace = (secondsPerMove: number) =>
      validateEdl({
        ...base,
        pace: [{ fromPly: 2, toPly: 2, secondsPerMove }],
      });
    expect(pace(3.7).ok).toBe(true);
    expect(pace(4).ok).toBe(true);
    expect(pace(4.1).errors).toEqual([
      "pace[0]: secondsPerMove must be 0.2..4",
    ]);
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
    // The counter's numbers come from the game, never from the EDL.
    expect(one({ ply: 1, kind: "race", plies: 2 })).toBe(false);
    expect(one({ ply: 1, kind: "freeze", cell: "g4" })).toBe(false);
  });

  test("hold the trap to walls and a stamp word, the freeze to its range", () => {
    const one = (ev: object) => validateEdl({ ...base, events: [ev] }).ok;
    expect(one({ ply: 1, kind: "trap", walls: ["g4"] })).toBe(false);
    expect(one({ ply: 1, kind: "trap", walls: [] })).toBe(false);
    expect(one({ ply: 1, kind: "trap", walls: ["^g4"], text: "boxed" })).toBe(
      false,
    );
    expect(
      one({ ply: 1, kind: "trap", walls: ["^g4"], text: "BOXED IN" }),
    ).toBe(true);
    expect(one({ ply: 1, kind: "freeze", holdSeconds: 5 })).toBe(false);
  });

  test("an explain names its hunter and the script's facts, and is its ply's only explanation", () => {
    const explain = {
      ply: 12,
      kind: "explain",
      hunter: "blue",
      label: "detour",
      expect: { walls: ["^a1", "^b1"], before: 2, after: 16 },
    };
    const edl = accept({
      ...base,
      events: [explain, { ply: 12, kind: "zoom", frame: ["^a1", "b1"] }],
    });
    expect(edl.events[0]).toMatchObject({ hunter: "blue", label: "detour" });
    expect(
      accept({ ...base, events: [{ ply: 12, kind: "explain" }] }).events[0],
    ).toMatchObject({ hunter: null, label: null, expect: null });
    const errors = (ev: object) =>
      (validateEdl({ ...base, events: [ev] }).errors ?? []) as string[];
    expect(errors({ ...explain, hunter: "green" })).toContain(
      'events[0]: hunter must be "red" or "blue"',
    );
    expect(errors({ ...explain, label: "Near Catch" })).toContain(
      "events[0]: label must be a kebab-case word (near-catch)",
    );
    expect(errors({ ...explain, expect: { walls: ["a1"] } })).toContain(
      "events[0]: expect.walls must list walls (^h4, >h4)",
    );
    expect(errors({ ...explain, expect: { before: 2.5 } })).toContain(
      "events[0]: expect.before must be a whole number of steps",
    );
    expect(errors({ ...explain, expect: { steps: 2 } }).length).toBe(1);
    for (const [other, said] of [
      [{ ply: 12, kind: "freeze" }, "a freeze"],
      [{ ply: 12, kind: "path", cell: "b1" }, "a path"],
      [{ ply: 12, kind: "zoom", frame: ["b1"], lead: true }, "a lead zoom"],
      [{ ply: 12, kind: "explain" }, "another explain"],
    ] as const) {
      expect(
        validateEdl({ ...base, events: [explain, other] }).errors,
      ).toContain(
        `ply 12 has an explain and ${said}; the explain is the ply's explanation, so use it alone`,
      );
    }
  });

  test("a callback explain names an old wall and expects its two walks; a plant names a wall", () => {
    const callback = {
      ply: 37,
      kind: "explain",
      hunter: "red",
      callback: { wall: ">b2" },
      expect: { without: 1, with: 5 },
    };
    expect(accept({ ...base, events: [callback] }).events[0]).toMatchObject({
      callback: { wall: ">b2" },
      expect: { without: 1, with: 5 },
    });
    // A plain explain stores no callback field: the same bytes as before.
    expect(
      "callback" in
        accept({ ...base, events: [{ ply: 3, kind: "explain" }] }).events[0],
    ).toBe(false);
    const errors = (ev: object) =>
      (validateEdl({ ...base, events: [ev] }).errors ?? []) as string[];
    expect(errors({ ...callback, callback: { wall: "b2" } })).toContain(
      "events[0]: callback must be { wall } (^h4, >h4)",
    );
    expect(
      errors({ ...callback, callback: { wall: ">b2", ply: 7 } }),
    ).toContain('events[0].callback: unknown field "ply"');
    expect(errors({ ...callback, expect: { before: 1 } })).toContain(
      'events[0].expect: unknown field "before"',
    );
    expect(errors({ ...callback, expect: { with: 1.5 } })).toContain(
      "events[0]: expect.with must be a whole number of steps",
    );
    expect(
      accept({ ...base, events: [{ ply: 7, kind: "plant", wall: ">b2" }] })
        .events[0],
    ).toMatchObject({ wall: ">b2" });
    expect(errors({ ply: 7, kind: "plant", wall: "b2" })).toContain(
      "events[0]: wall must be a wall (^h4, >h4)",
    );
  });

  test("an explain's build-up zoom, and overlays timed inside the explain (Nil, 2026-11-01)", () => {
    const explain = { ply: 12, kind: "explain", hunter: "blue" };
    const fire = {
      ply: 12,
      kind: "overlay",
      form: "cover",
      asset: "gs-fire",
      sound: "boom-4",
      at: "land",
    };
    const shock = {
      ply: 12,
      kind: "overlay",
      form: "clip",
      asset: "reactor-shock",
      seat: "blue",
      at: "walk",
    };
    const edl = accept({
      ...base,
      events: [{ ...explain, buildUp: { frame: ["b3", "^b3"] } }, fire, shock],
    });
    expect(edl.events[0]).toMatchObject({
      buildUp: { frame: ["b3", "^b3"], seconds: 1, scale: 1.5 },
    });
    expect(edl.events.slice(1).map((e: { at?: string }) => e.at)).toEqual([
      "land",
      "walk",
    ]);
    // Absent, a list stores no buildUp and no at: the same bytes as before.
    const plain = accept({ ...base, events: [explain] }).events[0] as object;
    expect("buildUp" in plain).toBe(false);
    const errors = (events: object[]) =>
      (validateEdl({ ...base, events }).errors ?? []) as string[];
    expect(
      errors([{ ...explain, buildUp: { frame: ["b3"], seconds: 3 } }]),
    ).toContain("events[0]: buildUp.seconds must be 0.5..2");
    expect(errors([{ ...explain, buildUp: { frame: [] } }])).toContain(
      "events[0]: buildUp.frame must list 1..6 cells (g4) or walls (^h4, >h4)",
    );
    expect(
      errors([
        {
          ...explain,
          callback: { wall: ">b2" },
          buildUp: { frame: ["b3"] },
        },
      ]),
    ).toContain("events[0]: a callback has no buildUp (its move lands first)");
    expect(errors([{ ...shock, at: "later" }])).toContain(
      'events[0]: at must be one of land, walk (inside its ply\'s explain), got "later"',
    );
    expect(errors([shock])).toContain(
      "the reactor-shock overlay on ply 12 opens at its explain's new walk, but ply 12 has no explain",
    );
    expect(errors([explain, shock, { ...shock, seat: "red" }])).toContain(
      'ply 12 has two overlays at "walk"; one of each',
    );
  });

  test("an evaluation strip lists one value a position, each -1..1, and is off when absent", () => {
    expect("evalStrip" in accept(base)).toBe(false);
    expect(accept({ ...base, evalStrip: [-0.3, 0.1, 1] }).evalStrip).toEqual([
      -0.3, 0.1, 1,
    ]);
    for (const bad of [[0.2], [0, 1.2], "0.1", [0, null]]) {
      expect(validateEdl({ ...base, evalStrip: bad }).errors).toContain(
        "evalStrip must list the game's evaluationsP1, one a position, each -1..1",
      );
    }
  });

  test("freeze a move once", () => {
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

/** An 8x8 start for the games below: each cat and mouse in a corner. */
const START_8 = {
  pawns: {
    p1: { cat: [0, 0], mouse: [7, 0] },
    p2: { cat: [0, 7], mouse: [7, 7] },
  },
  walls: [],
};

describe("checkEdlAgainstGame", () => {
  const notations = ["Ce7", "Cf7", "^a4.^h4"];
  test("accepts a wall placed by that ply and rejects one placed later or never", () => {
    const ok = accept({
      ...base,
      events: [{ ply: 2, kind: "zoom", frame: ["^h4", "g4"] }],
    });
    expect(
      checkEdlAgainstGame(ok, {
        notations,
        cols: 8,
        rows: 8,
        initialState: START_8,
      }),
    ).toEqual([]);
    const early = accept({
      ...base,
      events: [{ ply: 1, kind: "zoom", frame: [">h4"] }],
    });
    expect(
      checkEdlAgainstGame(early, {
        notations,
        cols: 8,
        rows: 8,
        initialState: START_8,
      }),
    ).toHaveLength(1);
  });

  test("holds a trap's walls to the board by its ply, like a zoom's", () => {
    const trap = (ply: number) =>
      accept({ ...base, events: [{ ply, kind: "trap", walls: ["^h4"] }] });
    expect(
      checkEdlAgainstGame(trap(2), {
        notations,
        cols: 8,
        rows: 8,
        initialState: START_8,
      }),
    ).toEqual([]);
    expect(
      checkEdlAgainstGame(trap(1), {
        notations,
        cols: 8,
        rows: 8,
        initialState: START_8,
      }),
    ).toHaveLength(1);
  });

  test("a plant lights its own move's wall, a callback an earlier move's, and the strip has one value a position", () => {
    const check = (raw: object) =>
      checkEdlAgainstGame(accept({ ...base, ...raw }), {
        notations,
        cols: 8,
        rows: 8,
        initialState: START_8,
      });
    const plant = (ply: number) => ({
      events: [{ ply, kind: "plant", wall: "^h4" }],
    });
    expect(check(plant(2))).toEqual([]);
    expect(check(plant(1))).toEqual([
      "events[0]: a plant lights its own move's wall, and ply 1 (Cf7) does not place ^h4",
    ]);
    const callback = (wall: string) => ({
      events: [{ ply: 2, kind: "explain", callback: { wall } }],
    });
    expect(check(callback("^h4"))).toEqual([
      "events[0]: a callback takes away a wall an earlier move placed, and no move before ply 2 places ^h4",
    ]);
    expect(check({ evalStrip: [0, 0.1, 0.2, 0.3] })).toEqual([]);
    expect(check({ evalStrip: [0, 0.1, 0.2] })).toEqual([
      "evalStrip lists 3 values, and the game's 3 moves have 4 positions",
    ]);
  });

  test("a flashback goes back to the move that built its wall: fields, its ply alone, its sounds", () => {
    const errorsOf = (raw: object): string[] =>
      (validateEdl(raw).errors as string[] | undefined) ?? [];
    const games = ["Ce7", "^h4", "Cf7", "Ce6"];
    const check = (raw: object) =>
      checkEdlAgainstGame(accept({ ...base, ...raw }), {
        notations: games,
        cols: 8,
        rows: 8,
        initialState: START_8,
      });
    const fb = (over: object = {}) => ({
      ply: 3,
      kind: "flashback",
      toPly: 1,
      wall: "^h4",
      sound: "rewind-1",
      forwardSound: "forward-1",
      nowSound: "clang-1",
      ...over,
    });
    expect(check({ events: [fb()] })).toEqual([]);
    expect(check({ events: [fb({ toPly: 0 })] })).toEqual([
      "events[0]: a flashback goes back to the move that built its wall, and ply 0 (Ce7) does not place ^h4",
    ]);
    expect(errorsOf({ ...base, events: [fb({ toPly: 3 })] })).toEqual([
      "events[0]: toPly must be a ply before 3",
    ]);
    expect(errorsOf({ ...base, events: [fb({ nowSound: "nope-1" })] })).toEqual(
      ['events[0]: nowSound "nope-1" is not known'],
    );
    expect(
      errorsOf({ ...base, events: [fb({ forwardSound: "nope-1" })] }),
    ).toEqual(['events[0]: forwardSound "nope-1" is not known']);
    expect(
      errorsOf({
        ...base,
        events: [fb(), { ply: 3, kind: "freeze" }],
      }),
    ).toEqual([
      "ply 3 has a flashback and a freeze; the flashback is the ply's explanation, so use it alone",
    ]);
    // Every reader of a list's sounds sees both of its sounds.
    expect(eventSoundKeys(fb())).toEqual(["rewind-1", "forward-1", "clang-1"]);
    expect(eventSoundKeys({ sound: "slam-1" })).toEqual(["slam-1"]);
  });

  test("rejects a ply past the last move and a cell off the board", () => {
    const edl = accept({
      ...base,
      events: [{ ply: 3, kind: "laugh", cell: "z9" }],
    });
    expect(
      checkEdlAgainstGame(edl, {
        notations,
        cols: 8,
        rows: 8,
        initialState: START_8,
      }),
    ).toHaveLength(2);
  });
});

describe("music", () => {
  const cue = (fromPly: number, track: string) => ({ fromPly, track });
  const ok = (music: unknown, more = {}) =>
    validateEdl({ ...base, ...more, music }).ok;

  test("is optional, null when absent, [] for none, and a list of cues of site tracks", () => {
    expect(accept(base).music).toBe(null);
    expect(accept({ ...base, music: [cue(0, "a-legend")] }).music).toEqual([
      cue(0, "a-legend"),
    ]);
    expect(ok([cue(0, "deja-vus"), cue(9, "a-legend")])).toBe(true);
    // A track may come back; a third different one has no credit line.
    expect(
      ok([cue(0, "deja-vus"), cue(9, "a-legend"), cue(20, "deja-vus")]),
    ).toBe(true);
    expect(
      ok([cue(0, "deja-vus"), cue(9, "a-legend"), cue(20, "skippy")]),
    ).toBe(false);
    expect(
      ok([
        cue(0, "deja-vus"),
        cue(9, "a-legend"),
        cue(20, "deja-vus"),
        cue(25, "a-legend"),
      ]),
    ).toBe(false);
    // [] is no music at all (Nil, 2026-10-28: "maybe just try without?").
    expect(accept({ ...base, music: [] }).music).toEqual([]);
    expect(ok([cue(0, "darude")])).toBe(false);
    expect(ok([{ ...cue(0, "a-legend"), volume: 1 }])).toBe(false);
  });

  test("refuses the string form of before cues with the cue to write", () => {
    expect(validateEdl({ ...base, music: "deja-vus" }).errors).toEqual([
      'music is a cue list now: [{ "fromPly": 0, "track": "deja-vus" }]',
    ]);
  });

  test("opens at ply 0, then changes the track at later plies", () => {
    expect(ok([cue(0, "deja-vus")])).toBe(true);
    expect(ok([cue(1, "deja-vus")])).toBe(false);
    expect(ok([cue(0, "deja-vus"), cue(0, "a-legend")])).toBe(false);
    expect(
      ok([cue(0, "deja-vus"), cue(4, "a-legend"), cue(3, "deja-vus")]),
    ).toBe(false);
    expect(ok([cue(0, "deja-vus"), cue(9, "deja-vus")])).toBe(false);
    expect(ok([cue(0, "deja-vus"), cue(1.5, "a-legend")])).toBe(false);
  });

  test("a cue past the last move fails against the game", () => {
    const game = { notations: ["Ce7", "Cf7", "^a4.^h4"], cols: 8, rows: 8 };
    const at = (ply: number) =>
      checkEdlAgainstGame(
        accept({ ...base, music: [cue(0, "deja-vus"), cue(ply, "a-legend")] }),
        { ...game, initialState: START_8 },
      );
    expect(at(2)).toEqual([]);
    expect(at(3)).toEqual([
      "ply 3 is past the last move (the game has 3 plies, 0-based)",
    ]);
  });
});

describe("the VS and finish sounds", () => {
  test("default to DEFAULT_SLOT_SOUNDS, and take only a known sound", () => {
    expect(accept(base)).toMatchObject(DEFAULT_SLOT_SOUNDS);
    expect(DEFAULT_SLOT_SOUNDS.finishSound).not.toBe("shotgun-1");
    expect(
      accept({ ...base, vsSound: "shotgun-3", finishSound: "fuahhh-1" }),
    ).toMatchObject({ vsSound: "shotgun-3", finishSound: "fuahhh-1" });
    expect(validateEdl({ ...base, finishSound: "airhorn-9" }).ok).toBe(false);
    expect(validateEdl({ ...base, vsSound: "toString" }).ok).toBe(false);
  });

  test("edlSoundUses names the slots, then each event with a sound", () => {
    const edl = accept({
      ...base,
      finishSound: "bell-2",
      events: [
        { ply: 15, kind: "zoom", frame: ["^h4", "g4"] },
        { ply: 16, kind: "scared", cell: "e7", sound: "pointing-2" },
      ],
    });
    expect(edlSoundUses(edl)).toEqual([
      ["vsSound", DEFAULT_SLOT_SOUNDS.vsSound],
      ["finishSound", "bell-2"],
      ["ply 16", "pointing-2"],
    ]);
  });
});

describe("startPly and coldOpenPly", () => {
  test("startPly is 0: a daily video shows the full story", () => {
    expect(accept(base)).toMatchObject({ startPly: 0, coldOpenPly: null });
    expect(accept({ ...base, startPly: 0 })).toMatchObject({ startPly: 0 });
    // Nil, 2026-10-28: "i noticed you start videos in the middle of a
    // game. i would avoid this."
    expect(validateEdl({ ...base, startPly: 6 }).errors).toEqual([
      "startPly is 6; a daily video shows the full story of the game, so it starts at 0 (a quiet stretch can be a fastForward range)",
    ]);
    expect(validateEdl({ ...base, startPly: -1 }).ok).toBe(false);
  });

  test("a cold open is a ply of the game", () => {
    expect(validateEdl({ ...base, coldOpenPly: 1.5 }).ok).toBe(false);
    const game = {
      notations: ["Ce7", "Cf7", "^a4.^h4"],
      cols: 8,
      rows: 8,
      initialState: START_8,
    };
    expect(
      checkEdlAgainstGame(accept({ ...base, coldOpenPly: 2 }), game),
    ).toEqual([]);
    expect(
      checkEdlAgainstGame(accept({ ...base, coldOpenPly: 3 }), game),
    ).toHaveLength(1);
  });
});

describe("introPaths", () => {
  test("is on by default, may be turned off, and is a boolean", () => {
    // Nil, 2026-10-28: the intro must explain the gist of the game.
    expect(accept(base)).toMatchObject({ introPaths: true });
    expect(accept({ ...base, introPaths: false })).toMatchObject({
      introPaths: false,
    });
    expect(validateEdl({ ...base, introPaths: "yes" }).errors).toEqual([
      "introPaths must be true or false",
    ]);
  });
});

describe("variety", () => {
  // Nil, 2026-10-28: "the exclamation mark and sweat is overused. 3 times.
  // add a rule that variety is important."
  const scared = (ply: number) => ({ ply, kind: "scared", cell: "e7" });
  test("a moment kind, or an overlay asset, at most twice", () => {
    expect(validateEdl({ ...base, events: [scared(8), scared(11)] }).ok).toBe(
      true,
    );
    expect(
      validateEdl({ ...base, events: [scared(8), scared(11), scared(14)] })
        .errors,
    ).toEqual([
      "scared is used 3 times (plies 8, 11, 14); at most 2 in a video: vary the moments",
    ]);
    const toast = (ply: number) => ({
      ply,
      kind: "overlay",
      form: "clip",
      asset: "chat-toast",
      text: "gg",
    });
    expect(
      validateEdl({ ...base, events: [toast(3), toast(9), toast(15)] }).errors,
    ).toEqual([
      "the overlay chat-toast is used 3 times (plies 3, 9, 15); at most 2 in a video: vary the moments",
    ]);
  });

  test("zoom, path and sound are not counted", () => {
    const zoom = (ply: number) => ({ ply, kind: "zoom", frame: ["e7"] });
    const sound = (ply: number) => ({ ply, kind: "sound", sound: "boom-4" });
    const path = (ply: number) => ({ ply, kind: "path", cell: "e7" });
    expect(
      validateEdl({
        ...base,
        events: [1, 5, 9].flatMap((p) => [zoom(p), path(p), sound(p)]),
      }).ok,
    ).toBe(true);
  });
});

describe("the payoff caption beat", () => {
  test("defaults to none, and holds the caption's limits", () => {
    expect(accept(base)).toMatchObject({ payoff: null });
    const payoff = { ply: 4, text: "now it's 19 💀" };
    expect(accept({ ...base, payoff })).toMatchObject({ payoff });
    const refused = (raw: object) => validateEdl({ ...base, ...raw }).ok;
    expect(refused({ payoff: { ply: 4, text: "" } })).toBe(false);
    expect(refused({ payoff: { ply: 4, text: "a b c d e f g" } })).toBe(false);
    expect(refused({ payoff: { ply: 4 } })).toBe(false);
    expect(refused({ payoff: { ply: 4, text: "ok", at: 1 } })).toBe(false);
    expect(refused({ caption: "", payoff })).toBe(false);
  });

  test("is on a ply the game has", () => {
    const game = {
      notations: ["Ce7", "Cf7", "^a4.^h4"],
      cols: 8,
      rows: 8,
      initialState: START_8,
    };
    const at = (ply: number) =>
      checkEdlAgainstGame(
        accept({ ...base, payoff: { ply, text: "now" } }),
        game,
      );
    expect(at(2)).toEqual([]);
    expect(at(3)).toHaveLength(1);
  });
});

describe("fastForward pace ranges", () => {
  const ff = { fromPly: 1, toPly: 3, secondsPerMove: 0.2, fastForward: true };
  test("run at 0.2-0.3 s a move, tagged by how much faster they are", () => {
    expect(accept({ ...base, pace: [ff] }).pace).toEqual([ff]);
    const plain = { fromPly: 0, toPly: 1, secondsPerMove: 1 };
    expect(accept({ ...base, pace: [plain] }).pace).toEqual([
      { ...plain, fastForward: false },
    ]);
    const refused = (raw: object) => validateEdl({ ...base, ...raw }).ok;
    expect(refused({ pace: [{ ...ff, secondsPerMove: 0.4 }] })).toBe(false);
    expect(refused({ pace: [{ ...ff, fastForward: "yes" }] })).toBe(false);
    expect(fastForwardTag(0.2)).toBe("x4");
    expect(fastForwardTag(0.3)).toBe("x3");
  });

  test("hold no moment and no cold open, and end before the last move", () => {
    const refused = (raw: object) => validateEdl({ ...base, ...raw }).ok;
    expect(
      refused({
        pace: [ff],
        events: [{ ply: 2, kind: "stamp", text: "NOPE" }],
      }),
    ).toBe(false);
    expect(refused({ pace: [ff], coldOpenPly: 3 })).toBe(false);
    expect(
      refused({ pace: [ff], events: [{ ply: 4, kind: "stamp", text: "OK" }] }),
    ).toBe(true);
    const game = {
      notations: ["Ce7", "Cf7", "Ce6", "Cf6", "^a4.^h4"],
      cols: 8,
      rows: 8,
      initialState: START_8,
    };
    expect(checkEdlAgainstGame(accept({ ...base, pace: [ff] }), game)).toEqual(
      [],
    );
    expect(
      checkEdlAgainstGame(
        accept({ ...base, pace: [{ ...ff, toPly: 4 }] }),
        game,
      ),
    ).toEqual([
      "pace[0] fast-forwards to ply 4; a fastForward range ends before the last move (4)",
    ]);
  });
});

describe("the VS card's goal line", () => {
  test("is the rules guide's sentence, and absent for a variant with no guide", () => {
    expect(goalSentenceFor("classic")).toBe(
      "The first cat to reach home wins.",
    );
    expect(goalSentenceFor("standard")).toBe(
      "Cat captures the opponent's mouse.",
    );
    expect(goalSentenceFor("survival")).toBeNull();
  });
});

describe("SAFE_AREA", () => {
  test("is the Reels spec's 6% sides, 14% top and 35% bottom of the frame", () => {
    expect(FRAME).toEqual({ w: 1080, h: 1920 });
    // info/daily-video-quality.md item 3: x 65-1015, y 269-1248.
    expect(SAFE_AREA).toEqual({ x: 65, y: 269, w: 950, h: 979 });
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

describe("lead zoom", () => {
  // 4x4, as in daily-candidates.test.ts: P1 cat a4, mouse d1; P2 cat a1,
  // mouse d4. "Cc4", ">c4.>c3", "Cc3": P1's cat, P2's walls, P1's cat.
  const start: CustomSetupStandardInitialState = {
    pawns: {
      p1: { cat: [0, 0], mouse: [3, 3] },
      p2: { cat: [3, 0], mouse: [0, 3] },
    },
    walls: [],
    turn: { playerId: 1, actionsTaken: [] },
  };
  const moves = ["Cc4", ">c4.>c3", "Cc3"];
  const game = { notations: moves, cols: 4, rows: 4, initialState: start };
  const lead = (ply: number, frame: string[]) =>
    accept({ ...base, events: [{ ply, kind: "zoom", frame, lead: true }] });

  test("is off unless asked for, and is true or false", () => {
    expect(
      (
        accept({ ...base, events: [{ ply: 2, kind: "zoom", frame: ["c3"] }] })
          .events[0] as { lead: boolean }
      ).lead,
    ).toBe(false);
    expect((lead(2, ["c4", "c3"]).events[0] as { lead: boolean }).lead).toBe(
      true,
    );
    expect(
      validateEdl({
        ...base,
        events: [{ ply: 2, kind: "zoom", frame: ["c3"], lead: "yes" }],
      }).errors,
    ).toContain("events[0]: lead must be true or false");
  });

  test("a move plays one freeze or one lead zoom before it lands", () => {
    const zoom = { ply: 4, kind: "zoom", frame: ["c3"], lead: true };
    for (const events of [
      [zoom, { ply: 4, kind: "freeze" }],
      [zoom, { ...zoom, frame: ["c4"] }],
    ]) {
      expect(validateEdl({ ...base, events }).errors).toContain(
        "ply 4 has more than one freeze or lead zoom; a move plays one of them before it lands",
      );
    }
    // A lead zoom and a landing zoom on one ply are fine.
    expect(
      validateEdl({
        ...base,
        events: [zoom, { ply: 4, kind: "zoom", frame: ["c4"] }],
      }).ok,
    ).toBe(true);
  });

  test("pawnMovesOf follows GameState's replay, whichever side starts", () => {
    const check = (
      initialState: CustomSetupStandardInitialState,
      notations: string[],
    ) => {
      const { states } = replayDistances({
        variant: "standard",
        boardWidth: 4,
        boardHeight: 4,
        initialState,
        moves: notations,
      });
      const cells = (state: (typeof states)[number]) => {
        const out: Record<string, string> = {};
        for (const player of [1, 2] as const) {
          for (const type of ["cat", "mouse"] as const) {
            const c = pawnCell(state.pawns, player, type);
            if (c) out[`${player}-${type}`] = cellToStandardNotation(c, 4);
          }
        }
        return out;
      };
      const moved = pawnMovesOf({ initialState, notations, rows: 4 });
      expect(moved).toHaveLength(notations.length);
      moved.forEach((ms, ply) => {
        const before = cells(states[ply]);
        const after = cells(states[ply + 1]);
        const changed = Object.keys(after)
          .filter((k) => before[k] !== after[k])
          .map((k) => ({ from: before[k], to: after[k] }));
        expect(ms).toEqual(changed);
      });
    };
    check(start, moves);
    check({ ...start, turn: { playerId: 2, actionsTaken: [] } }, [
      "Mc4",
      "Md2",
      ">b4.>b3",
      "Ca3",
    ]);
  });

  test("the frame must hold the move's start and end cells", () => {
    expect(checkEdlAgainstGame(lead(2, ["c4", "c3"]), game)).toEqual([]);
    // A frame box holds the cells between its terms too.
    expect(checkEdlAgainstGame(lead(2, ["b4", "d2"]), game)).toEqual([]);
    expect(checkEdlAgainstGame(lead(2, ["c3", "d3"]), game)).toEqual([
      "events[0]: the lead zoom's frame must hold the move c4 -> c3 of ply 2; add c4 to frame",
    ]);
    expect(checkEdlAgainstGame(lead(1, [">c4"]), game)).toEqual([
      "events[0]: a lead zoom plays a pawn's move, and ply 1 (>c4.>c3) moves no pawn",
    ]);
  });

  test("an older report with no start position refuses a lead zoom", () => {
    const noStart = { ...game, initialState: null };
    expect(checkEdlAgainstGame(lead(2, ["c4", "c3"]), noStart)).toEqual([
      "a lead zoom needs the start position, and this game has none (an older report); make a new report",
    ]);
    expect(checkEdlAgainstGame(accept(base), noStart)).toEqual([]);
  });
});

describe("parsePlyWindow", () => {
  test("reads FROM..TO, both inclusive, at startPly or later", () => {
    expect(parsePlyWindow("12..18", 10)).toEqual({
      ok: true,
      from: 12,
      to: 18,
    });
    expect(parsePlyWindow("10..10", 10)).toEqual({
      ok: true,
      from: 10,
      to: 10,
    });
  });

  test("refuses a window the video cannot show or a malformed one", () => {
    expect(parsePlyWindow("9..18", 10).ok).toBe(false);
    expect(parsePlyWindow("18..12", 0).ok).toBe(false);
    for (const bad of ["12-18", "12..", "..18", "-1..4", "1.5..4", ""]) {
      expect(parsePlyWindow(bad, 0).ok).toBe(false);
    }
  });
});

describe("dailySeatNames (Nil, 2026-10-29: Bot and Human, never a name)", () => {
  const bot = { configType: "bot", displayName: "Normal Bot" };
  const human = { configType: "human", displayName: "Guest Ibex" };
  test("a bot and a human: Bot and Human", () => {
    expect(dailySeatNames({ red: bot, blue: human })).toEqual({
      red: "Bot",
      blue: "Human",
    });
    expect(dailySeatNames({ red: human, blue: bot })).toEqual({
      red: "Human",
      blue: "Bot",
    });
  });
  test("two bots: Red Bot and Blue Bot", () => {
    expect(dailySeatNames({ red: bot, blue: bot })).toEqual({
      red: "Red Bot",
      blue: "Blue Bot",
    });
  });
  test("two humans, guests or signed in: only Red and Blue (Nil, 2026-10-30, C16)", () => {
    expect(
      dailySeatNames({
        red: human,
        blue: { configType: "human", displayName: "nilmamano" },
      }),
    ).toEqual({ red: "Red", blue: "Blue" });
  });
  test("a seat with no kind is refused, never named Human (VR1, review 79)", () => {
    expect(() => dailySeatNames({ red: {}, blue: bot })).toThrow(/no kind/);
    expect(() =>
      dailySeatNames({ red: human, blue: { configType: "robot" } }),
    ).toThrow(/no kind/);
  });
});

describe("STRIP_AREA", () => {
  test("runs from SAFE_AREA's bottom to above every organic overlay", () => {
    expect(STRIP_AREA).toEqual({ x: 140, y: 1248, w: 800, h: 188 });
    expect(STRIP_AREA.y).toBe(SAFE_AREA.y + SAFE_AREA.h);
    // The caption, user and sound start 484 px above the frame's bottom,
    // and the buttons take the right 140 px (presets read 2026-10-28).
    expect(STRIP_AREA.y + STRIP_AREA.h).toBe(FRAME.h - 484);
    expect(STRIP_AREA.x + STRIP_AREA.w).toBe(FRAME.w - 140);
  });

  test("holds the strip box, and every other box to SAFE_AREA", () => {
    expect(areaOf("strip")).toBe(STRIP_AREA);
    expect(areaOf("board")).toBe(SAFE_AREA);
    expect(areaOf("credit")).toBe(SAFE_AREA);
  });
});

describe("the path event", () => {
  const path = (more: object) => ({
    ...base,
    events: [{ ply: 0, kind: "path", cell: "e7", ...more }],
  });

  test("names a cell, and fills compare and holdSeconds", () => {
    expect(accept(path({})).events[0]).toMatchObject({
      compare: false,
      holdSeconds: DEFAULT_PATH_HOLD_SECONDS,
    });
    expect(
      accept(path({ compare: true, holdSeconds: 1.2 })).events[0],
    ).toMatchObject({
      compare: true,
      holdSeconds: 1.2,
    });
    expect(validateEdl(path({ cell: undefined })).ok).toBe(false);
    expect(validateEdl(path({ compare: "yes" })).ok).toBe(false);
    expect(validateEdl(path({ holdSeconds: 5 })).ok).toBe(false);
    expect(validateEdl(path({ frame: ["e7"] })).ok).toBe(false);
  });

  test("may name its hunter's seat, for two cats on one cell; stored only when set", () => {
    expect(accept(path({ hunter: "blue" })).events[0]).toMatchObject({
      hunter: "blue",
    });
    expect("hunter" in accept(path({})).events[0]).toBe(false);
    const green = validateEdl(path({ hunter: "green" }));
    expect(green.ok ? [] : green.errors).toEqual([
      'events[0]: hunter must be "red" or "blue"',
    ]);
  });

  test("needs a pawn on its cell after the move", () => {
    const game = {
      notations: ["Ce7", "Cf7", "^a4.^h4"],
      cols: 8,
      rows: 8,
      initialState: START_8,
    };
    // Ply 0 moves player 1's cat from a8 to e7.
    expect(checkEdlAgainstGame(accept(path({})), game)).toEqual([]);
    expect(checkEdlAgainstGame(accept(path({ cell: "a8" })), game)).toEqual([
      "events[0]: a path starts from a hunter, and no pawn stands on a8 after ply 0",
    ]);
    expect(
      checkEdlAgainstGame(accept(path({})), { ...game, initialState: null }),
    ).toEqual([
      "a path needs the start position, and this game has none (an older report); make a new report",
    ]);
  });
});

describe("the overlay event", () => {
  const overlay = (more: object, pace: object[] = []) => ({
    ...base,
    pace,
    events: [{ ply: 3, kind: "overlay", ...more }],
  });
  const toast = { form: "clip", asset: "chat-toast", text: "{blue} left" };
  const errorsOf = (raw: object): string[] =>
    (validateEdl(raw).errors as string[] | undefined) ?? [];

  test("names an asset of its form, and fills the asset's seconds", () => {
    // "{blue} left": a name (2 words) and 1 word read in 2.1 s, more than
    // the asset's 1.8.
    expect(accept(overlay(toast)).events[0]).toMatchObject({ seconds: 2.1 });
    expect(
      accept(overlay({ form: "panel", asset: "capture-loading" })).events[0],
    ).toMatchObject({ seconds: null });
    expect(errorsOf(overlay({ ...toast, form: "panel" }))).toEqual([
      'events[0]: chat-toast is a clip; form must be "clip"',
    ]);
    expect(errorsOf(overlay({ ...toast, asset: "nope" }))[0]).toContain(
      "asset must be one of",
    );
    expect(errorsOf(overlay({ ...toast, seconds: 9 }))).toEqual([
      "events[0]: seconds must be 0.6..4",
    ]);
    expect(
      errorsOf(
        overlay({ form: "panel", asset: "capture-loading", seconds: 2 }),
      ),
    ).toEqual([
      "events[0]: capture-loading lasts as long as its moment; it takes no seconds",
    ]);
  });

  test("shows its words at least their reading time", () => {
    // Nil, 2026-10-28: the compare card "goes away before i can read it".
    // path-compare draws 5 words ("2 12 STEPS TO CATCH"): 1.2 + 5 x 0.3.
    expect(
      accept(overlay({ form: "clip", asset: "path-compare" })).events[0],
    ).toMatchObject({ seconds: 2.7 });
    expect(
      errorsOf(overlay({ form: "clip", asset: "path-compare", seconds: 1.6 })),
    ).toEqual([
      "events[0]: 1.6 s is too short to read its 5 words: it needs 2.7 s (1.2 s + 0.3 s a word)",
    ]);
    // An emoji is no word; a longer seconds stays.
    expect(
      accept(overlay({ ...toast, text: "gg 💀💀", seconds: 3 })).events[0],
    ).toMatchObject({ seconds: 3 });
    // 10 words do not fit in 4 s.
    expect(
      errorsOf(
        overlay({
          ...toast,
          text: "a b c d e f g h i j",
        }),
      ),
    ).toEqual([
      "events[0]: its 10 words take 4.2 s to read (1.2 s + 0.3 s a word); at most 9 fit in 4 s",
    ]);
  });

  test("takes text where its asset does, with the seats' names only", () => {
    expect(errorsOf(overlay({ ...toast, text: undefined }))).toEqual([
      'events[0]: chat-toast needs "text"',
    ]);
    expect(
      errorsOf(overlay({ form: "clip", asset: "path-compare", text: "x" })),
    ).toEqual(["events[0]: path-compare shows no text"]);
    expect(errorsOf(overlay({ ...toast, text: "{me}{red}{red}" }))).toEqual([
      "events[0]: {me} is not a name; use {red} or {blue}",
      "events[0]: {red} may show once",
    ]);
    // A name counts as 12 characters: 29 + 12 = 41.
    expect(
      errorsOf(
        overlay({ ...toast, text: "{red} has left the game, sadly, ok" }),
      ),
    ).toEqual([
      "events[0]: text is 41 characters long (a name counts as 12); at most 40 are allowed",
    ]);
  });

  test("in a fast-forward, one overlay on its first ply that lasts the range", () => {
    const ff = (fromPly: number, toPly: number) => [
      { fromPly, toPly, secondsPerMove: 0.2, fastForward: true },
    ];
    // do-something is a cut-out clip since 2026-10-29; a clip or a panel
    // may cover the range.
    const clip = { form: "clip", asset: "do-something", seat: "blue" };
    // Its line reads in 2.1 s, fully shown: with its pop and fade, 2.45 s,
    // so 13 plies at 0.2 s.
    expect(accept(overlay(clip, ff(3, 15))).events[0]).toMatchObject({
      seconds: null,
    });
    expect(accept(overlay(toast, ff(3, 15))).events[0]).toMatchObject({
      seconds: null,
    });
    expect(errorsOf(overlay(clip, ff(3, 8)))).toEqual([
      "events[0]: the fastForward range 3-8 is on screen 1.20 s; do-something needs 2.45 s (2.1 s to be read, 0.35 s to come in and go out)",
    ]);
    // On screen as long as its reading time alone: the render would show it
    // fully for less, so the list is refused here (Video Reviewer 1, review
    // 55).
    expect(errorsOf(overlay(clip, ff(3, 13)))).toEqual([
      "events[0]: the fastForward range 3-13 is on screen 2.20 s; do-something needs 2.45 s (2.1 s to be read, 0.35 s to come in and go out)",
    ]);
    expect(errorsOf(overlay(clip, ff(2, 8)))[0]).toContain(
      "only one overlay on its first ply",
    );
    expect(
      errorsOf({
        ...base,
        pace: ff(3, 8),
        events: [{ ply: 3, kind: "scared", cell: "e7" }],
      })[0],
    ).toContain("only one overlay on its first ply");
    expect(errorsOf(overlay({ ...clip, seconds: 3 }, ff(3, 13)))[0]).toContain(
      "lasts the range",
    );
    expect(
      errorsOf(
        overlay({ form: "panel", asset: "capture-loading" }, ff(3, 8)),
      )[0],
    ).toContain("lasts the range");
    const two = {
      ...overlay(clip, ff(3, 15)),
      events: [
        { ply: 3, kind: "overlay", ...clip },
        { ply: 3, kind: "overlay", ...toast },
      ],
    };
    expect(errorsOf(two)).toEqual([
      "events[1]: the fastForward range 3-15 has an overlay already; it shows one",
    ]);
  });

  test("cuts a clip shorter, never holds it longer", () => {
    // A fixture asset: the registry has no clip yet (Nil rates them first).
    OVERLAYS["test-clip"] = {
      form: "clip",
      draw: "sequence",
      text: "none",
      seconds: 1.5,
      size: { w: 0.4, h: 0.4 },
      sequence: { dir: "test-clip", fps: 30, frames: 45, sha256: "0" },
      source: "test",
      claim: "None",
      likeness: "None",
      rating: null,
    };
    try {
      const clip = { form: "clip", asset: "test-clip" };
      expect(accept(overlay(clip)).events[0]).toMatchObject({ seconds: 1.5 });
      expect(
        accept(overlay({ ...clip, seconds: 0.9 })).events[0],
      ).toMatchObject({ seconds: 0.9 });
      expect(errorsOf(overlay({ ...clip, seconds: 2 }))).toEqual([
        "events[0]: test-clip is a 1.5 s clip; seconds may be at most that",
      ]);
    } finally {
      delete OVERLAYS["test-clip"];
    }
  });
});

describe("the overlay event's seat", () => {
  const ev = (more: object) => ({
    ...base,
    events: [{ ply: 3, kind: "overlay", form: "clip", ...more }],
  });
  test("names the portrait's seat, required on an asset that shows one", () => {
    expect(
      accept(ev({ asset: "reactor-shock", seat: "red", text: "brain cell" }))
        .events[0],
    ).toMatchObject({ seat: "red", seconds: 1.8 });
    expect(
      validateEdl(ev({ asset: "reactor-laugh", seat: "green" })).errors,
    ).toEqual([
      'events[0]: reactor-laugh shows a seat\'s portrait; seat must be "red" or "blue" (who reacts)',
    ]);
    expect(validateEdl(ev({ asset: "reactor-stare" })).errors).toEqual([
      'events[0]: reactor-stare shows a seat\'s portrait; seat must be "red" or "blue" (who reacts)',
    ]);
    // A reactor's label is one line: 28 characters, a name counting 12.
    expect(
      validateEdl(
        ev({
          asset: "reactor-shock",
          seat: "blue",
          text: "{blue}'s last brain cell",
        }),
      ).errors,
    ).toEqual([
      "events[0]: text is 30 characters long (a name counts as 12); at most 28 are allowed",
    ]);
    expect(
      validateEdl(ev({ asset: "chat-toast", text: "hi", seat: "red" })).errors,
    ).toEqual(["events[0]: chat-toast shows no seat"]);
  });
});

describe("the overlay event's pawn (Nil, 2026-10-30, C20: who emotes)", () => {
  const ev = (more: object, pace?: object[]) => ({
    ...base,
    ...(pace ? { pace } : {}),
    // A picture opens with a sound (C23); a test of no sound removes it.
    events: [
      { ply: 3, kind: "overlay", form: "clip", sound: "scared-2", ...more },
    ],
  });
  test("names the seat and piece, required on a picture a pawn emotes", () => {
    expect(
      accept(ev({ asset: "the-scream", pawn: "blue mouse" })).events[0],
    ).toMatchObject({ pawn: "blue mouse" });
    expect(
      accept(ev({ asset: "this-is-fine-mouse", pawn: "red mouse" })).events[0],
    ).toMatchObject({ pawn: "red mouse", seconds: 2.4 });
    for (const pawn of [undefined, "g1", "green mouse", "red rat"]) {
      expect(validateEdl(ev({ asset: "the-scream", pawn })).errors).toEqual([
        'events[0]: the-scream shows who emotes it; pawn must be a seat and a piece, as "red mouse" or "blue cat"',
      ]);
    }
    // A meme drawn for a mouse takes a mouse.
    expect(
      validateEdl(ev({ asset: "scream-mouse", pawn: "red cat" })).errors,
    ).toEqual(["events[0]: scream-mouse is drawn for a mouse, not a cat"]);
    expect(
      validateEdl(ev({ asset: "chat-toast", text: "hi", pawn: "red cat" }))
        .errors,
    ).toEqual(["events[0]: chat-toast is tied to no pawn"]);
  });
  test("opens with a sound (Nil, 2026-10-30, C23)", () => {
    expect(
      validateEdl(
        ev({ asset: "the-scream", pawn: "red mouse", sound: undefined }),
      ).errors,
    ).toEqual([
      'events[0]: the-scream is a picture a pawn emotes; it needs a "sound" as it opens',
    ]);
  });
  test("the resign card needs no meme sound: the finish slot plays as it opens", () => {
    expect(
      accept(ev({ asset: "resign-flag", pawn: "red mouse", sound: undefined }))
        .events[0],
    ).toMatchObject({ asset: "resign-flag", pawn: "red mouse" });
  });
  test("a clip that plays its own sound needs no meme sound; muted, it does", () => {
    const jjj = (o: object) =>
      ev({ asset: "gs-jjj-laugh", pawn: "red cat", sound: undefined, ...o });
    expect(accept(jjj({ audio: "own" })).events[0]).toMatchObject({
      asset: "gs-jjj-laugh",
      audio: "own",
    });
    expect(validateEdl(jjj({ audio: "muted" })).errors).toEqual([
      'events[0]: gs-jjj-laugh is a picture a pawn emotes; it needs a "sound" as it opens',
    ]);
    // A silent clip has no sound of its own to play.
    expect(
      validateEdl(
        ev({ asset: "gs-terio-ooh", pawn: "red cat", sound: undefined }),
      ).errors,
    ).toEqual([
      'events[0]: gs-terio-ooh is a picture a pawn emotes; it needs a "sound" as it opens',
    ]);
  });
  test("may name its place, one of the pawn places, on a pawn picture only", () => {
    expect(
      accept(ev({ asset: "the-scream", pawn: "red mouse", place: "top-left" }))
        .events[0],
    ).toMatchObject({ place: "top-left" });
    expect(
      validateEdl(
        ev({ asset: "the-scream", pawn: "red mouse", place: "middle" }),
      ).errors,
    ).toEqual([
      'events[0]: place must be one of bottom-right, bottom-left, top-right, top-left, bottom-middle, top-middle, right-middle, left-middle, got "middle"',
    ]);
    // A cage round its pawn has one place (overlays.mjs `around`).
    expect(
      validateEdl(
        ev({
          asset: "gs-jail-bars",
          pawn: "red mouse",
          sound: "slam-1",
          place: "top-left",
        }),
      ).errors,
    ).toEqual([
      "events[0]: gs-jail-bars goes round the red mouse; it has one place and takes no place",
    ]);
    expect(
      validateEdl(ev({ asset: "chat-toast", text: "hi", place: "top-left" }))
        .errors,
    ).toEqual([
      "events[0]: chat-toast is tied to no pawn; only a picture a pawn emotes takes a place",
    ]);
  });
  test("never in a fast-forward: it holds its ply", () => {
    expect(
      validateEdl(
        ev({ asset: "the-scream", pawn: "red mouse" }, [
          { fromPly: 3, toPly: 15, secondsPerMove: 0.2, fastForward: true },
        ]),
      ).errors,
    ).toEqual([
      "events[0]: the-scream holds its ply until it closes, and a fast-forward holds none; put it on a ply outside the range",
    ]);
  });
});

describe("the ending's caption bar", () => {
  test("is on the last move only, with a line and no seconds", () => {
    const ev = (more: object) => ({
      ...base,
      events: [
        { kind: "overlay", form: "bar", asset: "ending-caption", ...more },
      ],
    });
    const game = {
      notations: ["a1", "a2", "a3"],
      cols: 8,
      rows: 8,
      initialState: null,
    };
    expect(
      checkEdlAgainstGame(accept(ev({ ply: 2, text: "gg" })), game),
    ).toEqual([]);
    expect(
      checkEdlAgainstGame(accept(ev({ ply: 1, text: "gg" })), game),
    ).toEqual([
      "events[0]: ending-caption captions the ending, so it is on the last move (ply 2), not ply 1",
    ]);
    expect(validateEdl(ev({ ply: 2 })).errors).toEqual([
      'events[0]: ending-caption needs "text"',
    ]);
    expect(validateEdl(ev({ ply: 2, text: "gg", seconds: 2 })).errors).toEqual([
      "events[0]: ending-caption lasts as long as its moment; it takes no seconds",
    ]);
  });

  test("never with the ko ending: its thrown pawn crosses every place (a4wv, 2026-10-30)", () => {
    const bar = {
      ply: 2,
      kind: "overlay",
      form: "bar",
      asset: "ending-caption",
      text: "gg",
    };
    expect(
      validateEdl({ ...base, ending: "ko", events: [bar] }).errors,
    ).toEqual([
      'the ko ending takes no ending bar: its thrown pawn and banner cover every place the bar can take; use ending "gg" or "replay" with a bar, or drop the bar',
    ]);
    expect(accept({ ...base, ending: "gg", events: [bar] }).ending).toBe("gg");
    expect(accept({ ...base, ending: "ko", events: [] }).ending).toBe("ko");
  });
});

describe("the meme pack's clips", () => {
  const withEvent = (ev: object, more: object = {}) => ({
    ...base,
    ...more,
    events: [{ ply: 3, kind: "overlay", ...ev }],
  });
  const errorsOf = (raw: object): string[] =>
    (validateEdl(raw).errors as string[] | undefined) ?? [];
  // No registered clip keeps its sound today (the stamp's thud is muted,
  // Director Rewriter's source check, 2026-10-31): a test clip that does.
  const SOUNDED = "test-sounded-clip";
  beforeAll(() => {
    // Tied to no pawn, so these tests see only its sound.
    const stamp = OVERLAYS["stupid-stamp"];
    (OVERLAYS as Record<string, unknown>)[SOUNDED] = {
      ...stamp,
      pawn: false,
      sequence: { ...stamp.sequence, audio: true },
    };
  });
  afterAll(() => {
    delete (OVERLAYS as Record<string, unknown>)[SOUNDED];
  });
  const sounded = { form: "clip", asset: SOUNDED };

  test("a clip with its own sound says whether it plays", () => {
    expect(
      accept(withEvent({ ...sounded, audio: "own" })).events[0],
    ).toMatchObject({ audio: "own" });
    expect(
      accept(withEvent({ ...sounded, audio: "muted", sound: "slam-1" }))
        .events[0],
    ).toMatchObject({ audio: "muted", sound: "slam-1" });
    expect(errorsOf(withEvent(sounded))).toEqual([
      `events[0]: ${SOUNDED} has its own sound; audio must be "own" (it plays) or "muted"`,
    ]);
    expect(
      errorsOf(withEvent({ ...sounded, audio: "own", sound: "slam-1" })),
    ).toEqual([
      `events[0]: ${SOUNDED} plays its own sound; give no "sound", or make it "muted"`,
    ]);
    // A clip that keeps no sound takes no "audio".
    expect(
      errorsOf(
        withEvent({
          form: "clip",
          asset: "stupid-stamp",
          pawn: "red mouse",
          sound: "slam-1",
          audio: "muted",
        }),
      ),
    ).toEqual([
      'events[0]: stupid-stamp has no sound of its own; give no "audio"',
    ]);
    expect(
      accept(
        withEvent({
          form: "clip",
          asset: "stupid-stamp",
          pawn: "red mouse",
          sound: "slam-1",
        }),
      ).events[0],
    ).toMatchObject({ seconds: 1.533, sound: "slam-1", pawn: "red mouse" });
    // It goes beside the mover's pawn (meme-list.md), so it names it.
    expect(
      errorsOf(
        withEvent({ form: "clip", asset: "stupid-stamp", sound: "slam-1" }),
      ),
    ).toEqual([
      'events[0]: stupid-stamp shows who emotes it; pawn must be a seat and a piece, as "red mouse" or "blue cat"',
    ]);
  });

  test("a cover clip is cut shorter, never held longer", () => {
    expect(
      accept(withEvent({ form: "cover", asset: "confetti", seconds: 1.2 }))
        .events[0],
    ).toMatchObject({ seconds: 1.2 });
    expect(
      errorsOf(withEvent({ form: "cover", asset: "confetti", seconds: 2.5 })),
    ).toEqual([
      "events[0]: confetti is a 2 s clip; seconds may be at most that",
    ]);
  });

  test("the call to action: one line, at most 30 chars, names wallgame.io; stored only when set", () => {
    expect(accept({ ...base, cta: "play free at wallgame.io" }).cta).toBe(
      "play free at wallgame.io",
    );
    expect("cta" in accept(base)).toBe(false);
    expect(errorsOf({ ...base, cta: "play free now" })).toEqual([
      'cta must name wallgame.io (e.g. "play free at wallgame.io")',
    ]);
    expect(errorsOf({ ...base, cta: "play\nwallgame.io" })).toEqual([
      "cta must be one line",
    ]);
    expect(
      errorsOf({ ...base, cta: "your move: play free at wallgame.io" }),
    ).toEqual(["cta has 35 characters; at most 30"]);
    expect(errorsOf({ ...base, cta: "" })).toEqual([
      "cta must be a line of text",
    ]);
  });

  test("the opening is a cover clip, stored only when set", () => {
    expect(accept({ ...base, opening: "curtain-open" }).opening).toBe(
      "curtain-open",
    );
    expect("opening" in accept(base)).toBe(false);
    expect(errorsOf({ ...base, opening: "stupid-stamp" })).toEqual([
      'opening must be a cover clip (curtain-open, gs-fire, gs-math, gs-tumbleweed, confetti, curtain-open-pack, confetti-pack, rec-frame), or absent for none; got "stupid-stamp"',
    ]);
  });
});
