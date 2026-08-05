import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import {
  boardPawns,
  clonePawns,
  hasPawn,
  isMovablePawnType,
  pawnCell,
  pawnFamilyForVariant,
  requirePawnCell,
  withPawnCell,
} from "../../shared/domain/pawns";
import type {
  Cell,
  GameConfiguration,
  GameInitialState,
  PawnFamily,
  Variant,
} from "../../shared/domain/game-types";

/**
 * Live pawn state is shaped per variant, so every slot in it is real.
 *
 * Before this shape existed, two variants lied to fit a single
 * `Record<PlayerId, { cat, mouse }>`: classic stored each player's home in the
 * `mouse` slot, and survival parked its two unused pawns on board corners. The
 * tests below are mostly here to keep those lies from coming back, because
 * nothing else in the suite would notice - a sentinel reads as a real cell to
 * every caller, which is exactly what made it dangerous.
 */

const config = (
  variant: Variant,
  variantConfig: GameInitialState,
): GameConfiguration => ({
  boardHeight: 9,
  boardWidth: 9,
  rated: false,
  variant,
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
  variantConfig,
});

const standardConfig = () =>
  config("standard", {
    pawns: {
      p1: { cat: [0, 0], mouse: [8, 8] },
      p2: { cat: [0, 8], mouse: [8, 0] },
    },
    walls: [],
  });

const classicConfig = () =>
  config("classic", {
    pawns: {
      p1: { cat: [0, 0], home: [8, 8] },
      p2: { cat: [0, 8], home: [8, 0] },
    },
    walls: [],
  });

const survivalConfig = () =>
  config("survival", {
    cat: [0, 0],
    mouse: [8, 8],
    turnsToSurvive: 10,
    mouseCanMove: false,
    walls: [],
  });

describe("pawnFamilyForVariant", () => {
  /**
   * Every member of `Variant`, as a Record so the type checker - not a
   * reviewer - is what notices when a variant is added. A new member without an
   * entry here fails to compile, which is the point: the constructor picks its
   * pawn shape from this mapping, so drift between the two would silently give
   * a new variant the wrong live state.
   */
  const expected: Record<Variant, PawnFamily> = {
    standard: "standard",
    freestyle: "standard",
    "custom-setup-standard": "standard",
    classic: "classic",
    "custom-setup-classic": "classic",
    survival: "survival",
  };

  it("maps every variant to a pawn family", () => {
    for (const [variant, family] of Object.entries(expected)) {
      expect(pawnFamilyForVariant(variant as Variant)).toBe(family);
    }
  });

  it("covers both custom-setup variants, which share their parent's shape", () => {
    expect(pawnFamilyForVariant("custom-setup-standard")).toBe(
      pawnFamilyForVariant("standard"),
    );
    expect(pawnFamilyForVariant("custom-setup-classic")).toBe(
      pawnFamilyForVariant("classic"),
    );
  });
});

describe("boardPawns", () => {
  it("gives standard four pawns: a cat and a mouse each", () => {
    const pawns = boardPawns(new GameState(standardConfig(), 0).pawns);
    expect(pawns.map((p) => `${p.playerId}:${p.type}`)).toEqual([
      "1:cat",
      "1:mouse",
      "2:cat",
      "2:mouse",
    ]);
  });

  it("gives classic four entries, with homes typed home rather than mouse", () => {
    const pawns = boardPawns(new GameState(classicConfig(), 0).pawns);
    // Four, because the board draws the homes. Typed honestly, so no caller
    // has to remap a "mouse" into a house.
    expect(pawns.map((p) => `${p.playerId}:${p.type}`)).toEqual([
      "1:cat",
      "1:home",
      "2:cat",
      "2:home",
    ]);
    expect(pawns.some((p) => p.type === "mouse")).toBe(false);
  });

  it("gives survival only the two pawns that are actually on the board", () => {
    const pawns = boardPawns(new GameState(survivalConfig(), 0).pawns);
    expect(pawns.map((p) => `${p.playerId}:${p.type}`)).toEqual([
      "1:cat",
      "2:mouse",
    ]);
  });
});

describe("the sentinels that used to fill unused slots", () => {
  it("classic has no mouse for either player", () => {
    const { pawns } = new GameState(classicConfig(), 0);
    expect(pawnCell(pawns, 1, "mouse")).toBeUndefined();
    expect(pawnCell(pawns, 2, "mouse")).toBeUndefined();
    expect(hasPawn(pawns, 1, "home")).toBe(true);
  });

  it("survival has no player 1 mouse and no player 2 cat", () => {
    const { pawns } = new GameState(survivalConfig(), 0);
    expect(pawnCell(pawns, 1, "mouse")).toBeUndefined();
    expect(pawnCell(pawns, 2, "cat")).toBeUndefined();
    expect(pawnCell(pawns, 1, "cat")).toEqual([0, 0]);
    expect(pawnCell(pawns, 2, "mouse")).toEqual([8, 8]);
  });

  it("standard has no home", () => {
    const { pawns } = new GameState(standardConfig(), 0);
    expect(pawnCell(pawns, 1, "home")).toBeUndefined();
  });
});

describe("accessors refuse to invent a pawn", () => {
  it("requirePawnCell throws for a pawn the variant lacks", () => {
    const { pawns } = new GameState(classicConfig(), 0);
    expect(() => requirePawnCell(pawns, 1, "mouse")).toThrow(
      "Player 1 has no mouse pawn in a classic game",
    );
  });

  it("withPawnCell throws rather than silently doing nothing", () => {
    const { pawns } = new GameState(survivalConfig(), 0);
    expect(() => withPawnCell(pawns, 2, "cat", [1, 1])).toThrow();
  });

  it("withPawnCell leaves the original untouched", () => {
    const { pawns } = new GameState(standardConfig(), 0);
    const moved = withPawnCell(pawns, 1, "cat", [5, 5]);
    expect(pawnCell(moved, 1, "cat")).toEqual([5, 5]);
    expect(pawnCell(pawns, 1, "cat")).toEqual([0, 0]);
  });
});

describe("a home is never movable", () => {
  it("classifies pawn types by whether a player can move them", () => {
    expect(isMovablePawnType("cat")).toBe(true);
    expect(isMovablePawnType("mouse")).toBe(true);
    expect(isMovablePawnType("home")).toBe(false);
  });

  it("never moves a classic home, even from a hand-built action", () => {
    const state = new GameState(classicConfig(), 0);
    // "home" is not a GamePawnType, so typed code cannot build this; the cast
    // stands in for a malformed or replayed action. applyMove handles "cat",
    // "mouse" and "wall" and ignores anything else, so this is a no-op rather
    // than a throw - long-standing behaviour, unchanged here. What matters is
    // that the home does not move.
    const next = state.applyGameAction({
      kind: "move",
      move: { actions: [{ type: "home" as "cat", target: [1, 1] }] },
      playerId: 1,
      timestamp: 0,
    });
    expect(requirePawnCell(next.pawns, 1, "home")).toEqual([8, 8]);
  });
});

describe("snapshots never share cells with the live state", () => {
  const mutate = (cell: Cell) => {
    (cell as number[])[0] = 99;
  };

  it("clonePawns copies the cells, not just the record", () => {
    const { pawns } = new GameState(standardConfig(), 0);
    const copy = clonePawns(pawns);
    mutate(requirePawnCell(pawns, 1, "cat"));
    expect(requirePawnCell(copy, 1, "cat")).toEqual([0, 0]);
  });

  it("mutating a clone does not reach the original", () => {
    const { pawns } = new GameState(standardConfig(), 0);
    const copy = clonePawns(pawns);
    mutate(requirePawnCell(copy, 1, "cat"));
    expect(requirePawnCell(pawns, 1, "cat")).toEqual([0, 0]);
  });

  it("a history entry does not move when the live state does", () => {
    const state = new GameState(standardConfig(), 0);
    const next = state.applyGameAction({
      kind: "move",
      move: { actions: [{ type: "cat", target: [0, 1] }] },
      playerId: 1,
      timestamp: 0,
    });
    const recorded = next.history[next.history.length - 1];
    expect(requirePawnCell(recorded.pawns, 1, "cat")).toEqual([0, 1]);

    mutate(requirePawnCell(next.pawns, 1, "cat"));
    expect(requirePawnCell(recorded.pawns, 1, "cat")).toEqual([0, 1]);
  });

  it("an undo hands back a copy, not a reference into the history it kept", () => {
    // Restoring `this.pawns = last.pawns` by reference happens to be harmless
    // today, because applyMove always replaces the record rather than mutating
    // it. That is a property of the write path, not of the snapshot, and a
    // future in-place write would corrupt history silently. This pins the copy.
    let state = new GameState(standardConfig(), 0);
    state = state.applyGameAction({
      kind: "move",
      move: { actions: [{ type: "cat", target: [0, 1] }] },
      playerId: 1,
      timestamp: 0,
    });
    state = state.applyGameAction({
      kind: "move",
      move: { actions: [{ type: "cat", target: [0, 7] }] },
      playerId: 2,
      timestamp: 0,
    });

    const undone = state.applyGameAction({
      kind: "takeback",
      playerId: 1,
      timestamp: 0,
    });
    const survivingEntry = undone.history[undone.history.length - 1];
    expect(survivingEntry).toBeDefined();

    mutate(requirePawnCell(undone.pawns, 1, "cat"));
    expect(requirePawnCell(survivingEntry.pawns, 1, "cat")).toEqual([0, 1]);
  });
});

describe("takeback restores the variant's own shape", () => {
  it("puts a classic cat back without disturbing its home", () => {
    const state = new GameState(classicConfig(), 0);
    const moved = state.applyGameAction({
      kind: "move",
      move: { actions: [{ type: "cat", target: [0, 1] }] },
      playerId: 1,
      timestamp: 0,
    });
    expect(requirePawnCell(moved.pawns, 1, "cat")).toEqual([0, 1]);

    const undone = moved.applyGameAction({
      kind: "takeback",
      playerId: 2,
      timestamp: 0,
    });
    expect(requirePawnCell(undone.pawns, 1, "cat")).toEqual([0, 0]);
    expect(requirePawnCell(undone.pawns, 1, "home")).toEqual([8, 8]);
    expect(undone.pawns.kind).toBe("classic");
  });

  it("keeps survival's single cat and mouse across an undo", () => {
    const state = new GameState(survivalConfig(), 0);
    const moved = state.applyGameAction({
      kind: "move",
      move: { actions: [{ type: "cat", target: [0, 1] }] },
      playerId: 1,
      timestamp: 0,
    });
    const undone = moved.applyGameAction({
      kind: "takeback",
      playerId: 2,
      timestamp: 0,
    });
    expect(requirePawnCell(undone.pawns, 1, "cat")).toEqual([0, 0]);
    expect(pawnCell(undone.pawns, 2, "cat")).toBeUndefined();
    expect(undone.pawns.kind).toBe("survival");
  });
});
