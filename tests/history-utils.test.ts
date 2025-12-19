import { describe, expect, it } from "bun:test";
import { GameState } from "../shared/domain/game-state";
import type {
  GameConfiguration,
  Move,
  PlayerId,
} from "../shared/domain/game-types";
import { buildHistoryState } from "../frontend/src/lib/history-utils";

const TEST_CONFIG: GameConfiguration = {
  boardHeight: 9,
  boardWidth: 9,
  rated: false,
  variant: "standard",
  timeControl: {
    initialSeconds: 180,
    incrementSeconds: 2,
    preset: "blitz",
  },
};

const catAdvance: Move = {
  actions: [{ type: "cat", target: [1, 0] }],
};

const opposingCatAdvance: Move = {
  actions: [{ type: "cat", target: [1, 8] }],
};

const verticalWall: Move = {
  actions: [{ type: "wall", target: [4, 4], wallOrientation: "vertical" }],
};

function stateAfterMoves(
  moves: { playerId: PlayerId; move: Move }[],
): GameState {
  let state = new GameState(TEST_CONFIG, 0);
  moves.forEach(({ playerId, move }, index) => {
    state = state.applyGameAction({
      kind: "move",
      move,
      playerId,
      timestamp: index,
    });
  });
  return state;
}

describe("buildHistoryState", () => {
  const baseState = stateAfterMoves([
    { playerId: 1, move: catAdvance },
    { playerId: 2, move: opposingCatAdvance },
    { playerId: 1, move: verticalWall },
  ]);
  const historyEntries = baseState.history;

  it("returns the initial state when cursor is -1", () => {
    const snapshot = buildHistoryState({
      config: TEST_CONFIG,
      historyEntries,
      cursor: -1,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.history.length).toBe(0);
    expect(snapshot?.turn).toBe(1);
    expect(snapshot?.pawns[1].cat).toEqual([0, 0]);
    expect(snapshot?.pawns[2].mouse).toEqual([8, 8]);
  });

  it("reconstructs board state for a specific ply", () => {
    const cursor = 1;
    const snapshot = buildHistoryState({
      config: TEST_CONFIG,
      historyEntries,
      cursor,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.pawns[1].cat).toEqual(historyEntries[cursor].catPos[0]);
    expect(snapshot?.pawns[2].cat).toEqual(historyEntries[cursor].catPos[1]);
    expect(snapshot?.turn).toBe(1);
    expect(snapshot?.history.length).toBe(cursor + 1);
  });

  it("preserves wall placements from the selected entry", () => {
    const cursor = 2;
    const snapshot = buildHistoryState({
      config: TEST_CONFIG,
      historyEntries,
      cursor,
    });
    expect(snapshot).not.toBeNull();
    expect(
      snapshot?.grid.hasWall({ cell: [4, 4], orientation: "vertical" }),
    ).toBe(true);
    expect(snapshot?.turn).toBe(2);
  });

  it("returns null when cursor exceeds available entries", () => {
    const snapshot = buildHistoryState({
      config: TEST_CONFIG,
      historyEntries,
      cursor: historyEntries.length + 1,
    });
    expect(snapshot).toBeNull();
  });
});
