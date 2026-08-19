import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import {
  moveFromStandardNotation,
  moveToStandardNotation,
} from "../../shared/domain/standard-notation";
import type {
  AnimalCycleInitialState,
  Cell,
  GameConfiguration,
  GamePawnType,
  Move,
  PlayerId,
} from "../../shared/domain/game-types";
import { pawnCell } from "../../shared/domain/pawns";

/**
 * Notation must keep the ORDER the turn was played in, not a fixed animal order.
 *
 * A turn holds two actions, so one player can move a pawn out of a cell and then
 * move the other pawn into it. `moveToStandardNotation` kept one destination per
 * pawn and then wrote the terms as Dog, Cat, Mouse, Elephant, walls - so
 * "elephant leaves f4, cat enters f4" came out as "Cf4.Eg4", the two terms
 * swapped.
 *
 * Both readers of that string apply the terms IN SEQUENCE, so the swap is not
 * cosmetic:
 *
 * - The engine resolves each term against the board as it stands at that term
 *   (`parse_move_notation`, deep-wallwars/src/engine_adapter.cpp). The cat has
 *   nowhere to go while the elephant still stands there, `apply_move` fails, and
 *   the server forfeits the bot with `bgs-update-failed-after-human-move`.
 * - The replay path feeds the same string through `GameState`, which refuses the
 *   cat with "Animal Cycle teammates cannot share a cell", so the stored game
 *   cannot be watched later.
 *
 * Production game qYrQ6B1I, diagnosed 2026-08-19.
 *
 * A turn is at most two actions (`actionsRemaining` is 1 | 2), so a pawn cannot
 * move, wait for the other pawn, and move again. One term per pawn plus the true
 * order therefore keeps everything; collapsing stays safe.
 *
 * Walls keep their place in that order too. Only their order among THEMSELVES is
 * canonical (sorted), because walls are interchangeable with each other: a wall
 * only removes paths, so any order of the same set is equally legal. A wall may
 * not move past a pawn, and the reason is the capture: `applyMove` stops the
 * moment a pawn action makes a winner (game-state.ts:580-582), so a term written
 * after the capturing pawn is never reached. Walls-last dropped a wall the
 * player really placed first from the replayed board.
 */

const config = (
  pawns: AnimalCycleInitialState["pawns"],
): GameConfiguration => ({
  variant: "animal-cycle",
  randomStart: false,
  boardWidth: 8,
  boardHeight: 8,
  rated: false,
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
  variantConfig: { pawns, walls: [] },
});

const to = (type: GamePawnType, target: Cell) => ({ type, target }) as const;

const ROWS = 8;

/** A fresh state, with `playerId` to move. */
const start = (
  pawns: AnimalCycleInitialState["pawns"],
  playerId: PlayerId,
): GameState => {
  const state = new GameState(config(pawns), 0);
  state.turn = playerId;
  return state;
};

const play = (
  state: GameState,
  playerId: PlayerId,
  actions: Move["actions"],
): GameState =>
  state.applyGameAction({
    kind: "move",
    move: { actions },
    playerId,
    timestamp: 1_000,
  });

/**
 * The production loop in one helper: play the turn, write it the way
 * `persistence.ts` does, and read it back the way the replay path does.
 *
 * The re-application is the assertion that matters. A string comparison alone
 * would pass for any order we happened to choose; only replaying the string
 * shows whether the order we chose is one the rules permit.
 */
const writeThenRead = (
  pawns: AnimalCycleInitialState["pawns"],
  playerId: PlayerId,
  actions: Move["actions"],
) => {
  const played = play(start(pawns, playerId), playerId, actions);
  const notation = moveToStandardNotation(played.history[0].move, ROWS);
  const parsed = moveFromStandardNotation(notation, ROWS);
  const replayed = play(start(pawns, playerId), playerId, parsed.actions);
  return { played, notation, parsed, replayed };
};

describe("Animal Cycle vacate-then-follow notation", () => {
  // P1 owns the cat and the elephant. The fixed order wrote the cat first, so
  // this direction - the elephant vacating for the cat - is the broken one.
  const catFollowsElephant: AnimalCycleInitialState["pawns"] = {
    p1: { cat: [4, 4], elephant: [4, 5] },
    p2: { mouse: [0, 0], dog: [7, 0] },
  };

  it("writes the elephant before the cat that takes its cell", () => {
    const { notation, parsed } = writeThenRead(catFollowsElephant, 1, [
      to("elephant", [4, 6]),
      to("cat", [4, 5]),
    ]);

    expect(notation).toBe("Eg4.Cf4");
    // The round trip keeps the order the game applied, not just the destinations.
    expect(parsed.actions.map((a) => a.type)).toEqual(["elephant", "cat"]);
  });

  it("replays that turn to the same position", () => {
    const { played, replayed } = writeThenRead(catFollowsElephant, 1, [
      to("elephant", [4, 6]),
      to("cat", [4, 5]),
    ]);

    expect(pawnCell(replayed.pawns, 1, "cat")).toEqual([4, 5]);
    expect(pawnCell(replayed.pawns, 1, "elephant")).toEqual([4, 6]);
    expect(replayed.pawns).toEqual(played.pawns);
    expect(replayed.status).toBe("playing");
  });

  // The other direction of the same pair: the cat vacates and the elephant
  // follows. The fixed order happened to agree with the played order here, so
  // this turn was already correct. It must stay correct.
  const elephantFollowsCat: AnimalCycleInitialState["pawns"] = {
    p1: { cat: [4, 5], elephant: [4, 6] },
    p2: { mouse: [0, 0], dog: [7, 0] },
  };

  it("keeps the cat before the elephant that takes its cell", () => {
    const { notation, parsed, played, replayed } = writeThenRead(
      elephantFollowsCat,
      1,
      [to("cat", [4, 4]), to("elephant", [4, 5])],
    );

    expect(notation).toBe("Ce4.Ef4");
    expect(parsed.actions.map((a) => a.type)).toEqual(["cat", "elephant"]);
    expect(replayed.pawns).toEqual(played.pawns);
  });

  // P2 owns the dog and the mouse, and the fixed order wrote the dog first. So
  // for this player the broken direction is the mouse vacating for the dog.
  const dogFollowsMouse: AnimalCycleInitialState["pawns"] = {
    p1: { cat: [7, 7], elephant: [7, 6] },
    p2: { mouse: [0, 0], dog: [0, 1] },
  };

  it("writes the mouse before the dog that takes its cell", () => {
    const { notation, parsed, played, replayed } = writeThenRead(
      dogFollowsMouse,
      2,
      [to("mouse", [1, 0]), to("dog", [0, 0])],
    );

    expect(notation).toBe("Ma7.Da8");
    expect(parsed.actions.map((a) => a.type)).toEqual(["mouse", "dog"]);
    expect(pawnCell(replayed.pawns, 2, "dog")).toEqual([0, 0]);
    expect(pawnCell(replayed.pawns, 2, "mouse")).toEqual([1, 0]);
    expect(replayed.pawns).toEqual(played.pawns);
  });

  it("keeps the dog before the mouse that takes its cell", () => {
    const { notation, parsed, played, replayed } = writeThenRead(
      dogFollowsMouse,
      2,
      [to("dog", [0, 2]), to("mouse", [0, 1])],
    );

    expect(notation).toBe("Dc8.Mb8");
    expect(parsed.actions.map((a) => a.type)).toEqual(["dog", "mouse"]);
    expect(replayed.pawns).toEqual(played.pawns);
  });

  it("keeps a wall that was played before the winning capture", () => {
    // A capture ENDS the move: `applyMove` breaks out of the action loop as
    // soon as a pawn action makes a winner (game-state.ts:580-582). So a term
    // written after the capturing pawn is never reached on replay. A wall the
    // player really placed FIRST must therefore stay in front of that pawn, or
    // the replayed board loses it.
    const pawns: AnimalCycleInitialState["pawns"] = {
      p1: { cat: [4, 4], elephant: [7, 7] },
      p2: { mouse: [4, 3], dog: [0, 7] },
    };
    const { notation, played, replayed } = writeThenRead(pawns, 1, [
      { type: "wall", target: [0, 0], wallOrientation: "vertical" },
      to("cat", [4, 3]),
    ]);

    // The BOARD first, deliberately. The harm is a lost wall, not a string in
    // the wrong order, and a test that trips on the string never gets far
    // enough to show what it costs.
    expect(played.result).toEqual({ winner: 1, reason: "capture" });
    expect(replayed.grid.getWalls()).toEqual(played.grid.getWalls());
    expect(replayed.grid.getWalls()).toHaveLength(1);
    expect(replayed.result).toEqual({ winner: 1, reason: "capture" });
    expect(notation).toBe(">a8.Cd4");
  });

  it("writes a wall played FIRST in front of the pawn", () => {
    // The wall goes down on the cell the cat then leaves, so the two terms are
    // about the same square and their order is visible in the result.
    const pawns: AnimalCycleInitialState["pawns"] = {
      p1: { cat: [4, 4], elephant: [1, 1] },
      p2: { mouse: [0, 0], dog: [7, 0] },
    };
    const { notation, parsed, played, replayed } = writeThenRead(pawns, 1, [
      { type: "wall", target: [4, 4], wallOrientation: "vertical" },
      to("cat", [5, 4]),
    ]);

    expect(notation).toBe(">e4.Ce3");
    expect(parsed.actions.map((a) => a.type)).toEqual(["wall", "cat"]);
    expect(pawnCell(replayed.pawns, 1, "cat")).toEqual([5, 4]);
    expect(replayed.grid.getWalls()).toEqual(played.grid.getWalls());
    expect(replayed.pawns).toEqual(played.pawns);
  });

  it("writes a wall played AFTER the pawn behind it", () => {
    const pawns: AnimalCycleInitialState["pawns"] = {
      p1: { cat: [4, 4], elephant: [1, 1] },
      p2: { mouse: [0, 0], dog: [7, 0] },
    };
    const { notation, parsed, played, replayed } = writeThenRead(pawns, 1, [
      to("cat", [5, 4]),
      { type: "wall", target: [4, 4], wallOrientation: "vertical" },
    ]);

    expect(notation).toBe("Ce3.>e4");
    expect(parsed.actions.map((a) => a.type)).toEqual(["cat", "wall"]);
    expect(replayed.grid.getWalls()).toEqual(played.grid.getWalls());
    expect(replayed.pawns).toEqual(played.pawns);
  });
});
