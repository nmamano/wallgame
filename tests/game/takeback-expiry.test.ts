import { describe, expect, it, beforeAll } from "bun:test";
import type { PartialGameConfiguration } from "../../server/games/store";
import type { PlayerId } from "../../shared/domain/game-types";

/**
 * A takeback offer is about one position - "let me retake the turn I just
 * played". The server used to hold no record of the offer at all: the socket
 * layer forwarded it to the opponent, and an accept, whenever it arrived, undid
 * whatever the last turn happened to be by then. Answered a few turns later
 * that is a different turn, belonging to a player who never offered it, and
 * with the history now two turns shorter than either player expected.
 *
 * These tests drive the store directly, because that is where the offer's
 * lifetime lives. The socket layer only forwards.
 *
 * As in `abandoned-game.test.ts`, a dummy DATABASE_URL is enough because
 * nothing here issues a query.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let offerTakeback: typeof import("../../server/games/store").offerTakeback;
let giveTime: typeof import("../../server/games/store").giveTime;
let acceptTakeback: typeof import("../../server/games/store").acceptTakeback;
let rejectTakeback: typeof import("../../server/games/store").rejectTakeback;
let getSession: typeof import("../../server/games/store").getSession;

beforeAll(async () => {
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  applyPlayerMove = store.applyPlayerMove;
  offerTakeback = store.offerTakeback;
  giveTime = store.giveTime;
  acceptTakeback = store.acceptTakeback;
  rejectTakeback = store.rejectTakeback;
  getSession = store.getSession;
});

const CONFIG: PartialGameConfiguration = {
  boardHeight: 8,
  boardWidth: 8,
  rated: false,
  variant: "standard",
  timeControl: { initialSeconds: 0, incrementSeconds: 0, preset: "unlimited" },
};

const startedGame = () => {
  const { session } = createGameSession({
    config: CONFIG,
    matchType: "friend",
    hostDisplayName: "Host",
    hostIsPlayer1: true,
  });
  joinGameSession({ id: session.id, displayName: "Friend" });
  return session.id;
};

/** Any legal turn: two walls in a column nobody has built in yet. */
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

const historyLength = (id: string) => getSession(id).gameState.history.length;

describe("a takeback offer", () => {
  it("undoes the offered turn when the answer comes straight back", () => {
    const id = startedGame();
    playTurn(id, 1, 0);
    expect(historyLength(id)).toBe(1);

    offerTakeback({ id, playerId: 1 });
    const state = acceptTakeback({ id, playerId: 2 });

    expect(state).not.toBeNull();
    expect(historyLength(id)).toBe(0);
  });

  it("is refused once the game has moved on", () => {
    const id = startedGame();
    playTurn(id, 1, 0);
    offerTakeback({ id, playerId: 1 });

    // The opponent plays instead of answering, so the position the offer was
    // about is gone.
    playTurn(id, 2, 1);
    expect(historyLength(id)).toBe(2);

    // Before the fix this undid two turns - the opponent's own last turn, and
    // the one the offer was about - leaving a one-turn history.
    expect(acceptTakeback({ id, playerId: 2 })).toBeNull();
    expect(historyLength(id)).toBe(2);
  });

  it("is used up by the accept that answers it", () => {
    const id = startedGame();
    playTurn(id, 1, 0);
    playTurn(id, 2, 1);
    playTurn(id, 1, 2);

    offerTakeback({ id, playerId: 1 });
    expect(acceptTakeback({ id, playerId: 2 })).not.toBeNull();
    expect(historyLength(id)).toBe(2);

    // A second accept has nothing left to answer. Left standing, the offer
    // would undo two more turns here - it is the same one-line rule that
    // retires it when a move lands.
    expect(acceptTakeback({ id, playerId: 2 })).toBeNull();
    expect(historyLength(id)).toBe(2);
  });

  it("survives a gift of time, which moves no position", () => {
    // The client keeps its prompt on screen here, because it watches the
    // history length and a gift of time does not change it. The server has to
    // reach the same answer or the Accept button would sit there doing nothing.
    const id = startedGame();
    playTurn(id, 1, 0);
    offerTakeback({ id, playerId: 1 });

    giveTime({ id, playerId: 1, seconds: 60 });
    giveTime({ id, playerId: 2, seconds: 60 });

    expect(acceptTakeback({ id, playerId: 2 })).not.toBeNull();
    expect(historyLength(id)).toBe(0);
  });

  it("is refused after it was declined", () => {
    const id = startedGame();
    playTurn(id, 1, 0);
    offerTakeback({ id, playerId: 1 });
    rejectTakeback({ id, playerId: 2 });

    expect(acceptTakeback({ id, playerId: 2 })).toBeNull();
    expect(historyLength(id)).toBe(1);
  });

  it("cannot be accepted by the player who asked for it", () => {
    const id = startedGame();
    playTurn(id, 1, 0);
    offerTakeback({ id, playerId: 1 });

    expect(acceptTakeback({ id, playerId: 1 })).toBeNull();
    expect(historyLength(id)).toBe(1);
  });

  it("is refused when nobody offered anything", () => {
    const id = startedGame();
    playTurn(id, 1, 0);

    expect(acceptTakeback({ id, playerId: 2 })).toBeNull();
    expect(historyLength(id)).toBe(1);
  });
});
