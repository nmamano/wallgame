import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import type {
  GameConfiguration,
  PlayerId,
  Move,
} from "../../shared/domain/game-types";
import {
  MIN_MOVES_FOR_A_COUNTED_GAME,
  endedBeforeBothPlayersMoved,
  isCountedResult,
} from "../../shared/domain/game-utils";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";

/**
 * A game does not count until both players have had a turn. Quitting before
 * that aborts the game instead of losing it: no winner, and every downstream
 * consumer (ratings, win/loss records, match score, past games) skips it.
 *
 * The threshold used to live only in the persistence layer, which let a rated
 * game move both players' ratings while never appearing in past games. These
 * tests pin the rule down in the domain layer, where all consumers read it.
 */

const TEST_CONFIG: GameConfiguration = {
  boardHeight: 9,
  boardWidth: 9,
  rated: true,
  variant: "standard",
  timeControl: {
    initialSeconds: 180,
    incrementSeconds: 2,
    preset: "blitz",
  },
  variantConfig: buildStandardInitialState(9, 9),
};

const buildState = () => new GameState(TEST_CONFIG, 0);

// A wall placement is the simplest legal turn that does not depend on where
// the pawns happen to start. Each turn gets its own column so successive turns
// never try to reuse an occupied wall slot.
const wallTurn = (col: number): Move["actions"] => [
  { type: "wall", target: [0, col], wallOrientation: "vertical" },
  { type: "wall", target: [2, col], wallOrientation: "vertical" },
];

const playTurn = (state: GameState, playerId: PlayerId, col: number) =>
  state.applyGameAction({
    kind: "move",
    move: { actions: wallTurn(col) },
    playerId,
    timestamp: Date.now(),
  });

/** Plays `count` complete turns, alternating players. */
const playTurns = (count: number): GameState => {
  let state = buildState();
  for (let i = 0; i < count; i++) {
    state = playTurn(state, state.turn, i * 2);
  }
  return state;
};

const resign = (state: GameState, playerId: PlayerId) =>
  state.applyGameAction({ kind: "resign", playerId, timestamp: Date.now() });

describe("endedBeforeBothPlayersMoved", () => {
  it("is true below the threshold and false at or above it", () => {
    expect(MIN_MOVES_FOR_A_COUNTED_GAME).toBe(2);
    expect(endedBeforeBothPlayersMoved(0)).toBe(true);
    expect(endedBeforeBothPlayersMoved(1)).toBe(true);
    expect(endedBeforeBothPlayersMoved(2)).toBe(false);
    expect(endedBeforeBothPlayersMoved(3)).toBe(false);
  });
});

describe("resigning before both players have moved", () => {
  it("aborts when nobody has moved", () => {
    const state = resign(buildState(), 1);
    expect(state.status).toBe("finished");
    expect(state.result?.reason).toBe("aborted");
    expect(state.result?.winner).toBeUndefined();
  });

  it("aborts when only the first player has moved", () => {
    const afterOne = playTurns(1);
    expect(afterOne.moveCount).toBe(1);
    const state = resign(afterOne, 2);
    expect(state.result?.reason).toBe("aborted");
    expect(state.result?.winner).toBeUndefined();
  });

  it("is a normal loss once both players have moved", () => {
    const afterTwo = playTurns(2);
    expect(afterTwo.moveCount).toBe(2);
    const state = resign(afterTwo, 1);
    expect(state.result?.reason).toBe("resignation");
    expect(state.result?.winner).toBe(2);
  });
});

describe("other ways of quitting early", () => {
  it("aborts on a timeout before both players have moved", () => {
    const state = buildState().applyGameAction({
      kind: "timeout",
      playerId: 1,
      timestamp: Date.now(),
    });
    expect(state.result?.reason).toBe("aborted");
    expect(state.result?.winner).toBeUndefined();
  });

  it("still awards a timeout once the game is under way", () => {
    const state = playTurns(2).applyGameAction({
      kind: "timeout",
      playerId: 1,
      timestamp: Date.now(),
    });
    expect(state.result?.reason).toBe("timeout");
    expect(state.result?.winner).toBe(2);
  });

  it("aborts on a draw agreement before both players have moved", () => {
    const state = buildState().applyGameAction({
      kind: "draw",
      playerId: 1,
      timestamp: Date.now(),
    });
    expect(state.result?.reason).toBe("aborted");
  });

  it("still records a draw agreement once the game is under way", () => {
    const state = playTurns(2).applyGameAction({
      kind: "draw",
      playerId: 1,
      timestamp: Date.now(),
    });
    expect(state.result?.reason).toBe("draw-agreement");
  });
});

describe("isCountedResult", () => {
  it("rejects aborted games so they never reach ratings or records", () => {
    expect(isCountedResult(resign(buildState(), 1).result)).toBe(false);
    expect(isCountedResult(resign(playTurns(2), 1).result)).toBe(true);
  });

  it("treats a real draw as countable but a missing result as not", () => {
    expect(isCountedResult({ reason: "draw-agreement" })).toBe(true);
    expect(isCountedResult(null)).toBe(false);
    expect(isCountedResult(undefined)).toBe(false);
  });
});
