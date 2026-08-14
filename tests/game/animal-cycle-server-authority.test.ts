import { beforeAll, describe, expect, it } from "bun:test";
import type { AnimalCycleInitialState } from "../../shared/domain/game-types";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;

beforeAll(async () => {
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  applyPlayerMove = store.applyPlayerMove;
});

const start = (initialState: AnimalCycleInitialState) => {
  const { session } = createGameSession({
    config: {
      variant: "animal-cycle",
      randomStart: false,
      boardWidth: 8,
      boardHeight: 8,
      rated: false,
      timeControl: { initialSeconds: 180, incrementSeconds: 0 },
      variantConfig: initialState,
    },
    matchType: "friend",
    hostDisplayName: "Host",
    hostIsPlayer1: true,
  });
  joinGameSession({ id: session.id, displayName: "Friend" });
  return session;
};

describe("Animal Cycle server authority and stored history", () => {
  it("refuses a teammate-crossing frame without changing turn, pawns, or history", () => {
    const session = start({
      pawns: {
        p1: { dog: [2, 1], mouse: [2, 2] },
        p2: { cat: [0, 7], elephant: [7, 7] },
      },
      walls: [],
    });
    const before = JSON.stringify({
      turn: session.gameState.turn,
      pawns: session.gameState.pawns,
      history: session.gameState.history,
    });
    expect(() =>
      applyPlayerMove({
        id: session.id,
        playerId: 1,
        move: { actions: [{ type: "dog", target: [2, 3] }] },
        timestamp: Date.now(),
      }),
    ).toThrow("Invalid double move: blocked or no path");
    expect(
      JSON.stringify({
        turn: session.gameState.turn,
        pawns: session.gameState.pawns,
        history: session.gameState.history,
      }),
    ).toBe(before);
    expect(session.gameState.history).toHaveLength(0);
  });

  it("stores an accepted atomic opponent crossing and a later pass exactly", () => {
    const session = start({
      pawns: {
        p1: { dog: [2, 1], mouse: [7, 0] },
        p2: { cat: [2, 2], elephant: [7, 7] },
      },
      walls: [],
    });
    const afterCrossing = applyPlayerMove({
      id: session.id,
      playerId: 1,
      move: { actions: [{ type: "dog", target: [2, 3] }] },
      timestamp: Date.now(),
    });
    expect(afterCrossing.status).toBe("playing");
    expect(afterCrossing.history[0].move.actions).toEqual([
      { type: "dog", target: [2, 3] },
    ]);

    const afterPass = applyPlayerMove({
      id: session.id,
      playerId: 2,
      move: { actions: [] },
      timestamp: Date.now(),
    });
    expect(afterPass.history[1].move.actions).toEqual([]);
    expect(afterPass.turn).toBe(1);
  });
});
