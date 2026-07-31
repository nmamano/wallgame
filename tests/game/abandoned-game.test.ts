import { describe, expect, it, beforeAll } from "bun:test";
import type { PartialGameConfiguration } from "../../server/games/store";
import type { PlayerId } from "../../shared/domain/game-types";

/**
 * A game with no clock whose player closed the tab used to stay in progress
 * forever. Nothing would ever end it - there is no clock to run out and the
 * server runs no periodic work - and while it sat there it held a session on
 * the bot engine, which caps at 256 per engine process and then refuses every
 * new game until the client restarts.
 *
 * The server now ends such a game after a wait. That wait is 30 minutes, so
 * these tests drive the policy rather than the timer: `findAbandonedSeat` is
 * the single question that both arming the timer and re-checking at expiry
 * ask, so pinning it pins the behaviour.
 *
 * As in `aborted-game-session.test.ts`, a dummy DATABASE_URL is enough because
 * nothing here issues a query.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

// Bound after DATABASE_URL is set, following the pattern in tests/integration.
let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let updateConnectionState: typeof import("../../server/games/store").updateConnectionState;
let findAbandonedSeat: typeof import("../../server/games/store").findAbandonedSeat;
let setBotCompositeId: typeof import("../../server/games/store").setBotCompositeId;
let resignGame: typeof import("../../server/games/store").resignGame;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;

beforeAll(async () => {
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  updateConnectionState = store.updateConnectionState;
  findAbandonedSeat = store.findAbandonedSeat;
  setBotCompositeId = store.setBotCompositeId;
  resignGame = store.resignGame;
  applyPlayerMove = store.applyPlayerMove;
});

const UNLIMITED: PartialGameConfiguration = {
  boardHeight: 8,
  boardWidth: 8,
  rated: false,
  variant: "standard",
  timeControl: { initialSeconds: 0, incrementSeconds: 0, preset: "unlimited" },
};

const TIMED: PartialGameConfiguration = {
  ...UNLIMITED,
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
};

const startedSession = (config: PartialGameConfiguration) => {
  const { session } = createGameSession({
    config,
    matchType: "friend",
    hostDisplayName: "Host",
    hostIsPlayer1: true,
  });
  joinGameSession({ id: session.id, displayName: "Friend" });
  return session;
};

/** Any legal turn, purely to get the game past its first move. */
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

/** Mirrors what game-socket.ts does when a player's websocket opens/closes. */
const setConnected = (
  session: ReturnType<typeof startedSession>,
  role: "host" | "joiner",
  connected: boolean,
) =>
  updateConnectionState({
    id: session.id,
    socketToken: session.players[role].socketToken,
    connected,
  });

describe("a game whose player walked away", () => {
  it("names the seat that left a game with no clock", () => {
    const session = startedSession(UNLIMITED);
    setConnected(session, "host", true);
    setConnected(session, "joiner", true);
    expect(findAbandonedSeat(session.id)).toBeNull();

    setConnected(session, "host", false);
    expect(findAbandonedSeat(session.id)?.role).toBe("host");
  });

  it("leaves a timed game under way alone, because its clock ends it", () => {
    const session = startedSession(TIMED);
    setConnected(session, "host", true);
    setConnected(session, "joiner", true);
    playTurn(session.id, 1, 0);
    setConnected(session, "host", false);

    expect(findAbandonedSeat(session.id)).toBeNull();
  });

  it("still claims a timed game nobody has moved in", () => {
    // A clock does not start until the first move, so before then a timed game
    // is no better protected than an untimed one.
    const session = startedSession(TIMED);
    setConnected(session, "host", true);
    setConnected(session, "joiner", true);
    setConnected(session, "host", false);

    expect(findAbandonedSeat(session.id)?.role).toBe("host");
  });

  it("stands down once the clock starts running", () => {
    const session = startedSession(TIMED);
    setConnected(session, "host", true);
    setConnected(session, "joiner", true);
    setConnected(session, "host", false);
    expect(findAbandonedSeat(session.id)).not.toBeNull();

    // The timer armed above re-asks this same question when it fires, so a
    // first move landing in the meantime disarms it without any extra wiring.
    playTurn(session.id, 1, 0);
    expect(findAbandonedSeat(session.id)).toBeNull();
  });

  it("stands down once the player comes back", () => {
    const session = startedSession(UNLIMITED);
    setConnected(session, "host", true);
    setConnected(session, "joiner", true);
    setConnected(session, "host", false);
    expect(findAbandonedSeat(session.id)).not.toBeNull();

    setConnected(session, "host", true);
    expect(findAbandonedSeat(session.id)).toBeNull();
  });

  it("ignores a bot seat, which has its own disconnect grace", () => {
    const session = startedSession(UNLIMITED);
    setBotCompositeId(session.id, "joiner", "client-1:superhuman");
    setConnected(session, "host", true);

    // The bot seat never opens a game socket, so it reads as disconnected -
    // that must not be mistaken for a human who walked away.
    expect(session.players.joiner.connected).toBe(false);
    expect(findAbandonedSeat(session.id)).toBeNull();
  });

  it("ignores a game that has already finished", () => {
    const session = startedSession(UNLIMITED);
    setConnected(session, "host", true);
    setConnected(session, "joiner", true);
    resignGame({ id: session.id, playerId: 1, timestamp: Date.now() });

    setConnected(session, "host", false);
    expect(findAbandonedSeat(session.id)).toBeNull();
  });
});
