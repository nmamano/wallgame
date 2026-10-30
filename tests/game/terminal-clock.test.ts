import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import type {
  GameAction,
  GameConfiguration,
} from "../../shared/domain/game-types";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";

const CONFIG: GameConfiguration = {
  boardHeight: 9,
  boardWidth: 9,
  rated: false,
  variant: "standard",
  randomStart: false,
  timeControl: { initialSeconds: 60, incrementSeconds: 0 },
  variantConfig: buildStandardInitialState(9, 9),
};

/** Two wall moves at t=0 and t=10 s: P1 is on turn with 60 s, P2 has 50 s. */
const afterTwoMoves = (): GameState =>
  new GameState(CONFIG, 0)
    .applyGameAction({
      kind: "move",
      playerId: 1,
      move: {
        actions: [
          { type: "wall", target: [4, 4], wallOrientation: "vertical" },
        ],
      },
      timestamp: 0,
    })
    .applyGameAction({
      kind: "move",
      playerId: 2,
      move: {
        actions: [
          { type: "wall", target: [2, 2], wallOrientation: "vertical" },
        ],
      },
      timestamp: 10_000,
    });

describe("the clock when a game ends without a move", () => {
  // The final clock is what a replay shows on its last frame, so the side on
  // turn must pay for the time it used, whoever ended the game.
  const endings: GameAction[] = [
    { kind: "timeout", playerId: 1, timestamp: 75_000 },
    { kind: "resign", playerId: 2, timestamp: 25_000 },
    { kind: "draw", timestamp: 25_000 },
  ];

  it.each(endings)("charges the side on turn on $kind", (action) => {
    const ended = afterTwoMoves().applyGameAction(action);
    expect(ended.status).toBe("finished");
    const expectedP1 = Math.max(0, 60 - (action.timestamp - 10_000) / 1000);
    expect(ended.timeLeft).toEqual({ 1: expectedP1, 2: 50 });
  });

  it("charges nothing when the game ends before the first move", () => {
    const ended = new GameState(CONFIG, 0).applyGameAction({
      kind: "resign",
      playerId: 1,
      timestamp: 99_000,
    });
    expect(ended.timeLeft).toEqual({ 1: 60, 2: 60 });
  });
});
