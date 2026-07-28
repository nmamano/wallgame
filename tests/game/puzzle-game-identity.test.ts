import { describe, expect, it, beforeAll } from "bun:test";
import type { PlayerId } from "../../shared/domain/game-types";
import type { PartialGameConfiguration } from "../../server/games/store";

/**
 * S-ID: a game launched as a saved puzzle carries that puzzle's identity from
 * creation to persistence, and nothing else does.
 *
 * The session is the only carrier between the server-authoritative launch and
 * `persistCompletedGame`, so these tests pin its boundaries: set on a puzzle
 * launch, absent on an ordinary game, and dropped by a rematch (a rematch
 * swaps seats and is a different game, so crediting it as a solve of the
 * original puzzle would be wrong — and the server accepts a rematch offer even
 * where the UI suppresses one for puzzles).
 *
 * The write into the games row cannot be asserted here: auntie has no
 * database, and faking that coverage would be worse than not having it. It is
 * covered by a production read-back after deploy.
 *
 * As in the neighbouring session tests, a dummy DATABASE_URL is enough —
 * `store.ts` reaches the db module transitively, which reads the variable at
 * import time, but nothing here issues a query.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

// Bound after DATABASE_URL is set, following the pattern in tests/integration.
let createGameSession: typeof import("../../server/games/store").createGameSession;
let createRematchSession: typeof import("../../server/games/store").createRematchSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let resignGame: typeof import("../../server/games/store").resignGame;

beforeAll(async () => {
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  createRematchSession = store.createRematchSession;
  joinGameSession = store.joinGameSession;
  applyPlayerMove = store.applyPlayerMove;
  resignGame = store.resignGame;
});

const CONFIG: PartialGameConfiguration = {
  boardHeight: 8,
  boardWidth: 8,
  rated: false,
  variant: "standard",
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
};

const PUZZLE_ID = "saved-puzzle-under-test";

const startedSession = (puzzleId?: string) => {
  const { session } = createGameSession({
    config: CONFIG,
    matchType: "friend",
    hostDisplayName: "Host",
    hostIsPlayer1: true,
    joinerConfig: { type: "bot", displayName: "PuzzleBot" },
    puzzleId,
  });
  joinGameSession({ id: session.id, displayName: "PuzzleBot" });
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

describe("puzzle identity on a game session", () => {
  it("is carried by a session created for a saved-puzzle launch", () => {
    expect(startedSession(PUZZLE_ID).puzzleId).toBe(PUZZLE_ID);
  });

  it("is absent from an ordinary bot game", () => {
    expect(startedSession().puzzleId).toBeUndefined();
  });

  it("is not inherited by a rematch of a puzzle game", () => {
    const session = startedSession(PUZZLE_ID);
    playTurn(session.id, 1, 0);
    playTurn(session.id, 2, 2);
    resignGame({ id: session.id, playerId: 1, timestamp: Date.now() });

    const { newSession } = createRematchSession(session.id);

    expect(session.puzzleId).toBe(PUZZLE_ID);
    expect(newSession.puzzleId).toBeUndefined();
  });
});
