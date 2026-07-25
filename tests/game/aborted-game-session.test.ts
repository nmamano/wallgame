import { describe, expect, it, beforeAll } from "bun:test";
import type { PlayerId } from "../../shared/domain/game-types";
import type { PartialGameConfiguration } from "../../server/games/store";

/**
 * Session-level consequences of an aborted game: the series score must not
 * move, not even by the half point a draw would award.
 *
 * See `abort-threshold.test.ts` for the domain rule itself. As there, a dummy
 * DATABASE_URL is enough because nothing here issues a query.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

// Bound after DATABASE_URL is set, following the pattern in tests/integration.
let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let resignGame: typeof import("../../server/games/store").resignGame;
let getSessionSnapshot: typeof import("../../server/games/store").getSessionSnapshot;

beforeAll(async () => {
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  applyPlayerMove = store.applyPlayerMove;
  resignGame = store.resignGame;
  getSessionSnapshot = store.getSessionSnapshot;
});

const CONFIG: PartialGameConfiguration = {
  boardHeight: 8,
  boardWidth: 8,
  rated: false,
  variant: "standard",
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
};

const startedSession = () => {
  const { session } = createGameSession({
    config: CONFIG,
    matchType: "friend",
    hostDisplayName: "Host",
    hostIsPlayer1: true,
  });
  joinGameSession({ id: session.id, displayName: "Friend" });
  return session;
};

const playTurn = (id: string, playerId: PlayerId, col: number) =>
  applyPlayerMove({
    id,
    playerId,
    move: {
      actions: [
        { type: "wall", target: [0, col], wallOrientation: "vertical" },
        { type: "wall", target: [2, col], wallOrientation: "vertical" },
      ],
    },
    timestamp: Date.now(),
  });

describe("match score after an aborted game", () => {
  it("is unchanged when a player resigns before both have moved", () => {
    const session = startedSession();

    const state = resignGame({
      id: session.id,
      playerId: 1,
      timestamp: Date.now(),
    });

    expect(state.result?.reason).toBe("aborted");
    expect(getSessionSnapshot(session.id).matchScore).toEqual({
      1: 0,
      2: 0,
    });
  });

  it("awards the win once both players have moved", () => {
    const session = startedSession();
    playTurn(session.id, 1, 0);
    playTurn(session.id, 2, 2);

    const state = resignGame({
      id: session.id,
      playerId: 1,
      timestamp: Date.now(),
    });

    expect(state.result?.reason).toBe("resignation");
    expect(getSessionSnapshot(session.id).matchScore).toEqual({
      1: 0,
      2: 1,
    });
  });
});
