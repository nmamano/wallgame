import { describe, expect, test } from "bun:test";
import {
  checkEdlAgainstGame,
  dailySeatColors,
  dailySeatName,
  DEFAULT_FREEZE_HOLD_SECONDS,
  DEFAULT_PATH_HOLD_SECONDS,
  DEFAULT_SLOT_SOUNDS,
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
} from "./edl.mjs";
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

  test("is optional, null when absent, and a list of cues of site tracks", () => {
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
    expect(ok([])).toBe(false);
    expect(ok([cue(0, "darude")])).toBe(false);
    expect(ok([{ ...cue(0, "a-legend"), volume: 1 }])).toBe(false);
  });

  test("refuses the string form of before cues with the cue to write", () => {
    expect(
      validateEdl({ ...base, startPly: 2, music: "deja-vus" }).errors,
    ).toEqual([
      'music is a cue list now: [{ "fromPly": 2, "track": "deja-vus" }]',
    ]);
  });

  test("opens at startPly, then changes the track at later plies", () => {
    expect(ok([cue(4, "deja-vus")], { startPly: 4 })).toBe(true);
    expect(ok([cue(0, "deja-vus")], { startPly: 4 })).toBe(false);
    expect(ok([cue(1, "deja-vus")])).toBe(false);
    expect(ok([cue(0, "deja-vus"), cue(0, "a-legend")])).toBe(false);
    expect(ok([cue(4, "deja-vus"), cue(3, "a-legend")], { startPly: 4 })).toBe(
      false,
    );
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
});

describe("startPly and coldOpenPly", () => {
  test("default to 0 and none, and hold events and pace to the start", () => {
    expect(accept(base)).toMatchObject({ startPly: 0, coldOpenPly: null });
    expect(validateEdl({ ...base, startPly: -1 }).ok).toBe(false);
    expect(validateEdl({ ...base, coldOpenPly: 1.5 }).ok).toBe(false);
    expect(validateEdl({ ...base, startPly: 2, coldOpenPly: 1 }).ok).toBe(
      false,
    );
    const game = {
      notations: ["Ce7", "Cf7", "^a4.^h4"],
      cols: 8,
      rows: 8,
      initialState: START_8,
    };
    const late = accept({
      ...base,
      startPly: 1,
      coldOpenPly: 2,
      pace: [{ fromPly: 0, toPly: 2, secondsPerMove: 1 }],
      events: [
        { ply: 0, kind: "sound", sound: "shotgun-2" },
        { ply: 2, kind: "zoom", frame: ["^h4"] },
      ],
    });
    expect(checkEdlAgainstGame(late, game)).toEqual([
      "pace[0] starts at ply 0, before startPly 1",
      "events[0] is on ply 0, before startPly 1",
    ]);
    expect(
      checkEdlAgainstGame(accept({ ...base, coldOpenPly: 3 }), game),
    ).toHaveLength(1);
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
    expect(refused({ startPly: 5, payoff })).toBe(false);
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

describe("dailySeatName", () => {
  test("shows a bot's or a guest's name, and no signed-in person's", () => {
    const seat = (configType: string, displayName: string) => ({
      configType,
      displayName,
    });
    expect(dailySeatName(seat("bot", "Normal Bot"))).toBe("Normal Bot");
    expect(dailySeatName(seat("human", "Guest Ibex"))).toBe("Guest Ibex");
    expect(dailySeatName(seat("human", "Guest Ibex 2"))).toBe("Guest Ibex 2");
    expect(dailySeatName(seat("human", "nilmamano"))).toBe("Human");
    expect(dailySeatName(seat("human", "Guestbook Fan"))).toBe("Human");
    expect(dailySeatName(seat("human", "Guest ibex"))).toBe("Human");
    expect(dailySeatName(seat("custom", "Guest Ibex"))).toBe("Human");
    expect(dailySeatName({})).toBe("Human");
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
    expect(accept(overlay(toast)).events[0]).toMatchObject({ seconds: 1.8 });
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

  test("takes text where its asset does, with the seats' names only", () => {
    expect(errorsOf(overlay({ ...toast, text: undefined }))).toEqual([
      'events[0]: chat-toast needs "text"',
    ]);
    expect(
      errorsOf(overlay({ form: "panel", asset: "path-compare", text: "x" })),
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

  test("in a fast-forward, one panel on its first ply that lasts the range", () => {
    const ff = (fromPly: number, toPly: number) => [
      { fromPly, toPly, secondsPerMove: 0.2, fastForward: true },
    ];
    const panel = { form: "panel", asset: "do-something" };
    expect(accept(overlay(panel, ff(3, 8))).events[0]).toMatchObject({
      seconds: null,
    });
    expect(errorsOf(overlay(panel, ff(2, 8)))[0]).toContain(
      "only one panel on its first ply",
    );
    expect(errorsOf(overlay(toast, ff(3, 8)))[0]).toContain(
      "only one panel on its first ply",
    );
    expect(errorsOf(overlay({ ...panel, seconds: 2 }, ff(3, 8)))[0]).toContain(
      "lasts the range",
    );
    expect(
      errorsOf(
        overlay({ form: "panel", asset: "capture-loading" }, ff(3, 8)),
      )[0],
    ).toContain("lasts the range");
    expect(errorsOf(overlay(panel, ff(3, 6)))).toEqual([
      "events[0]: the fastForward range 3-6 is on screen 0.80 s; a panel needs 1 s to be read",
    ]);
    const two = {
      ...overlay(panel, ff(3, 8)),
      events: [
        { ply: 3, kind: "overlay", ...panel },
        { ply: 3, kind: "overlay", form: "panel", asset: "do-something" },
      ],
    };
    expect(errorsOf(two)).toEqual([
      "events[1]: the fastForward range 3-8 has a panel already; it shows one",
    ]);
  });
});

describe("the overlay event's seat", () => {
  const ev = (more: object) => ({
    ...base,
    events: [{ ply: 3, kind: "overlay", form: "clip", ...more }],
  });
  test("names the portrait's seat, on an asset that shows one", () => {
    expect(
      accept(ev({ asset: "reactor-shock", seat: "red", text: "brain cell" }))
        .events[0],
    ).toMatchObject({ seat: "red", seconds: 1.4 });
    expect(
      validateEdl(ev({ asset: "reactor-laugh", seat: "green" })).errors,
    ).toEqual(['events[0]: seat must be "red" or "blue"']);
    expect(
      validateEdl(ev({ asset: "chat-toast", text: "hi", seat: "red" })).errors,
    ).toEqual(["events[0]: chat-toast shows no seat"]);
  });
});
