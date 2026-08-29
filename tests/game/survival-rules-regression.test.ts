import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import type {
  GameConfiguration,
  Move,
  PlayerId,
} from "../../shared/domain/game-types";

const survivalConfig = ({
  cat = [0, 0],
  mouse = [4, 4],
  mouseCanMove = false,
  turnsToSurvive = 10,
}: {
  cat?: readonly [number, number];
  mouse?: readonly [number, number];
  mouseCanMove?: boolean;
  turnsToSurvive?: number;
} = {}): GameConfiguration => ({
  boardHeight: 5,
  boardWidth: 5,
  rated: false,
  variant: "survival",
  randomStart: false,
  timeControl: { initialSeconds: 180, incrementSeconds: 0, preset: "blitz" },
  variantConfig: { cat, mouse, mouseCanMove, turnsToSurvive, walls: [] },
});

const move = (state: GameState, playerId: PlayerId, actions: Move["actions"]) =>
  state.applyGameAction({
    kind: "move",
    move: { actions },
    playerId,
    timestamp: state.lastMoveTime + 1,
  });

describe("Survival executable-rule regressions", () => {
  it("keeps the mouse as both players' wall-path target", () => {
    const state = new GameState(survivalConfig(), 0);
    expect(state.goalCell(1)).toEqual([4, 4]);
    expect(state.goalCell(2)).toEqual([4, 4]);
  });

  it("keeps a cat capture terminal with no one-move draw", () => {
    let state = new GameState(
      survivalConfig({ cat: [0, 0], mouse: [0, 1] }),
      0,
    );
    state = move(state, 1, [{ type: "cat", target: [0, 1] }]);
    expect(state.status).toBe("finished");
    expect(state.result).toEqual({ winner: 1, reason: "capture" });
  });

  it("keeps mouse movement controlled by the Survival setting", () => {
    let fixedMouse = new GameState(survivalConfig(), 0);
    fixedMouse = move(fixedMouse, 1, [{ type: "cat", target: [1, 0] }]);
    expect(() =>
      move(fixedMouse, 2, [{ type: "mouse", target: [4, 3] }]),
    ).toThrow("Mouse cannot move in survival variant");

    let movingMouse = new GameState(survivalConfig({ mouseCanMove: true }), 0);
    movingMouse = move(movingMouse, 1, [{ type: "cat", target: [1, 0] }]);
    movingMouse = move(movingMouse, 2, [{ type: "mouse", target: [4, 3] }]);
    expect(movingMouse.pawns).toMatchObject({
      kind: "survival",
      mouse: [4, 3],
    });
  });

  it("keeps the turn-survival win", () => {
    let state = new GameState(survivalConfig({ turnsToSurvive: 1 }), 0);
    state = move(state, 1, [{ type: "cat", target: [1, 0] }]);
    expect(state.result).toEqual({ winner: 2, reason: "survival" });
  });
});
