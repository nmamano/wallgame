import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import { pawnCell } from "../../shared/domain/pawns";
import type {
  Cell,
  GameConfiguration,
  Move,
  PlayerId,
  StandardInitialState,
} from "../../shared/domain/game-types";

/**
 * A capture counts only when a TURN ENDS, never at the midpoint of one. A pawn may therefore step
 * onto the cell where it would be taken and walk out the other side inside a single turn - in both
 * directions, a mouse past a cat and a cat over a mouse.
 *
 * Nothing pinned this before. The C++ engine judged the bare position after every individual action
 * instead, so a human mouse walking past the bot's cat ended the game inside the engine while this
 * code played on; the bot session froze mid-turn and the server forfeited it (board task 8911a6d5).
 * These cases are the reference the engine is now written against - see
 * `Board::winner(Turn)` in deep-wallwars/src/gamestate.cpp.
 */

const buildConfig = (
  pawns: StandardInitialState["pawns"],
): GameConfiguration => ({
  boardHeight: 9,
  boardWidth: 9,
  rated: false,
  variant: "standard",
  randomStart: false,
  timeControl: {
    initialSeconds: 180,
    incrementSeconds: 2,
    preset: "blitz",
  },
  variantConfig: { pawns, walls: [] },
});

// applyGameAction is immutable: it returns the next state rather than mutating this one.
const move = (
  state: GameState,
  playerId: PlayerId,
  actions: Move["actions"],
): GameState =>
  state.applyGameAction({
    kind: "move",
    move: { actions },
    playerId,
    timestamp: Date.now(),
  });

const mouseTo = (target: Cell) => ({ type: "mouse", target }) as const;
const catTo = (target: Cell) => ({ type: "cat", target }) as const;

describe("capture timing", () => {
  it("lets a mouse walk through the opponent's cat and out the other side", () => {
    // P1's mouse on [4,4] with P2's cat directly to its left on [4,3].
    const state = new GameState(
      buildConfig({
        p1: { cat: [8, 0], mouse: [4, 4] },
        p2: { cat: [4, 3], mouse: [0, 8] },
      }),
      0,
    );

    const next = move(state, 1, [mouseTo([4, 3]), mouseTo([4, 2])]);

    expect(next.status).not.toBe("finished");
    expect(next.result).toBeUndefined();
    expect(pawnCell(next.pawns, 1, "mouse")).toEqual([4, 2]);
    // The turn passed normally, which is the part the engine used to get wrong.
    expect(next.turn).toBe(2);
  });

  it("lets a cat walk over the opponent's mouse and out the other side", () => {
    // The mirror case: P1's cat routes through the cell P2's mouse is standing on.
    const state = new GameState(
      buildConfig({
        p1: { cat: [4, 4], mouse: [8, 0] },
        p2: { cat: [0, 8], mouse: [4, 3] },
      }),
      0,
    );

    const next = move(state, 1, [catTo([4, 3]), catTo([4, 2])]);

    expect(next.status).not.toBe("finished");
    expect(next.result).toBeUndefined();
    expect(pawnCell(next.pawns, 1, "cat")).toEqual([4, 2]);
    expect(next.turn).toBe(2);
  });

  it("awards the capture when the cat is still on the mouse as the turn ends", () => {
    const state = new GameState(
      buildConfig({
        p1: { cat: [4, 5], mouse: [8, 0] },
        p2: { cat: [0, 8], mouse: [4, 3] },
      }),
      0,
    );

    const next = move(state, 1, [catTo([4, 4]), catTo([4, 3])]);

    expect(next.status).toBe("finished");
    expect(next.result).toEqual({ winner: 1, reason: "capture" });
  });

  it("loses the game when a mouse is still on the enemy cat as the turn ends", () => {
    const state = new GameState(
      buildConfig({
        p1: { cat: [8, 0], mouse: [4, 5] },
        p2: { cat: [4, 3], mouse: [0, 8] },
      }),
      0,
    );

    const next = move(state, 1, [mouseTo([4, 4]), mouseTo([4, 3])]);

    expect(next.status).toBe("finished");
    expect(next.result).toEqual({ winner: 2, reason: "capture" });
  });
});
