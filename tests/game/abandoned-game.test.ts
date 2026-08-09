import { describe, expect, it, beforeAll, jest } from "bun:test";
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

/**
 * Bun has had fake timers since well before the version this repo runs, but the
 * pinned `bun-types` (1.2.2, against a 1.3 runtime) still declares a `Jest`
 * interface without them. Naming the three methods here is the whole of the
 * gap - drop this once the types catch up.
 */
const timers = jest as typeof jest & {
  useFakeTimers(): void;
  advanceTimersByTime(ms: number): void;
  useRealTimers(): void;
};

// Bound after DATABASE_URL is set, following the pattern in tests/integration.
let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let updateConnectionState: typeof import("../../server/games/store").updateConnectionState;
let findAbandonedSeat: typeof import("../../server/games/store").findAbandonedSeat;
let findIdleSeat: typeof import("../../server/games/store").findIdleSeat;
let setBotCompositeId: typeof import("../../server/games/store").setBotCompositeId;
let resignGame: typeof import("../../server/games/store").resignGame;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let listLiveGames: typeof import("../../server/games/store").listLiveGames;
let getSession: typeof import("../../server/games/store").getSession;

beforeAll(async () => {
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  updateConnectionState = store.updateConnectionState;
  findAbandonedSeat = store.findAbandonedSeat;
  findIdleSeat = store.findIdleSeat;
  setBotCompositeId = store.setBotCompositeId;
  resignGame = store.resignGame;
  applyPlayerMove = store.applyPlayerMove;
  listLiveGames = store.listLiveGames;
  getSession = store.getSession;
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

/**
 * A timed game whose clock outlasts the idle timeout.
 *
 * Needed to observe "a timed game is never governed by the idle timer" end to
 * end: with a blitz clock the game is over in three minutes, so advancing two
 * hours proves nothing about which mechanism ended it. Four hours of clock is
 * the only way to let the idle deadline pass while the game is legitimately
 * still running. `isUnlimitedTimeControl` reads the preset alone, so this is a
 * timed game by exactly the test the policy applies.
 */
const LONG_TIMED: PartialGameConfiguration = {
  ...UNLIMITED,
  timeControl: {
    initialSeconds: 4 * 60 * 60,
    incrementSeconds: 0,
    preset: "classical",
  },
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

/** Plays `count` alternating turns, starting with player 1. */
const playMoves = (id: string, count: number) => {
  const order: PlayerId[] = [1, 2];
  for (let index = 0; index < count; index++) {
    playTurn(id, order[index % 2], index);
  }
};

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

/**
 * The half-open socket the idle timer exists for: both seats look connected,
 * because a locked phone never sends the close the server would otherwise need
 * in order to know. Connecting both also disarms the abandonment timer, so a
 * test that runs the clock out measures the idle policy and nothing else.
 */
const bothSeatsLookConnected = (session: ReturnType<typeof startedSession>) => {
  setConnected(session, "host", true);
  setConnected(session, "joiner", true);
};

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

/**
 * A seat can vanish without the server ever hearing about it. A phone that
 * locks, or a lid that closes, leaves the websocket OPEN and silent, so the
 * close handler never runs, `connected` stays true, and `findAbandonedSeat`
 * above correctly answers null - there is no seat it knows to be gone. An
 * untimed game has no clock either, so nothing ends it at all.
 *
 * Reproduced against unfixed code through real sockets on 2026-08-09: both
 * seats connected, zero timers armed, the game still in /api/games/live in
 * status "playing". Seven such games sat for 60-78 minutes on 2026-08-06.
 *
 * So the second question is not "has a seat gone" but "has anybody moved", and
 * `findIdleSeat` is where it is asked. Its boundary is deliberately narrower
 * than the abandonment policy's and the two are not interchangeable.
 */
describe("a game nobody is moving in", () => {
  it("names the seat whose turn it is", () => {
    const session = startedSession(UNLIMITED);
    bothSeatsLookConnected(session);
    playMoves(session.id, 2);

    // Two completed moves, so it is player 1's turn again.
    expect(getSession(session.id).gameState.turn).toBe(1);
    expect(findIdleSeat(session.id)?.role).toBe("host");
  });

  it("charges the seat on turn, not the seat that disconnected", () => {
    // The two policies deliberately disagree here, and each is right about its
    // own question. Merging them would silently pick one.
    const session = startedSession(UNLIMITED);
    bothSeatsLookConnected(session);
    playMoves(session.id, 2);
    setConnected(session, "joiner", false);

    expect(findAbandonedSeat(session.id)?.role).toBe("joiner");
    expect(findIdleSeat(session.id)?.role).toBe("host");
  });

  it("leaves a timed game alone once it is under way", () => {
    const session = startedSession(TIMED);
    bothSeatsLookConnected(session);
    playMoves(session.id, 2);

    expect(findIdleSeat(session.id)).toBeNull();
  });

  it("leaves a timed game alone before anybody has moved", () => {
    // The abandonment policy DOES claim this game when a seat is known gone.
    // The idle policy never does, at any move count - the manager's boundary.
    const session = startedSession(TIMED);
    bothSeatsLookConnected(session);

    expect(findIdleSeat(session.id)).toBeNull();
  });

  it("leaves an untimed game nobody has started alone", () => {
    const session = startedSession(UNLIMITED);
    bothSeatsLookConnected(session);

    expect(getSession(session.id).gameState.moveCount).toBe(0);
    expect(findIdleSeat(session.id)).toBeNull();
  });

  it("ignores a game that has already finished", () => {
    const session = startedSession(UNLIMITED);
    bothSeatsLookConnected(session);
    playMoves(session.id, 2);
    resignGame({ id: session.id, playerId: 1, timestamp: Date.now() });

    expect(findIdleSeat(session.id)).toBeNull();
  });

  /**
   * A bot seat is NOT exempt here, unlike in `findAbandonedSeat`. A bot that
   * has not answered for two hours is exactly as dead as a human who walked
   * away, and the point of charging the clock to whoever must act is that the
   * waiting side never pays for it.
   */
  it("charges a bot that owns the turn, never the human waiting on it", () => {
    const session = startedSession(UNLIMITED);
    setBotCompositeId(session.id, "joiner", "client-1:superhuman");
    setConnected(session, "host", true);
    playMoves(session.id, 3);

    expect(getSession(session.id).gameState.turn).toBe(2);
    expect(findIdleSeat(session.id)?.role).toBe("joiner");
  });

  it("charges the human in a bot game when the human owns the turn", () => {
    const session = startedSession(UNLIMITED);
    setBotCompositeId(session.id, "joiner", "client-1:superhuman");
    setConnected(session, "host", true);
    playMoves(session.id, 2);

    expect(getSession(session.id).gameState.turn).toBe(1);
    expect(findIdleSeat(session.id)?.role).toBe("host");
  });
});

/**
 * The tests above pin the policy; this one pins that the policy is ever asked.
 *
 * Arming the abandonment timer used to hang off a player's connection
 * *changing*, and a session is born with nobody connected - so a game whose
 * player never got as far as opening a socket never started a clock and sat in
 * the live-games list for good. Four of them were visible on wallgame.io on
 * 2026-08-01, all with `createdAt === updatedAt`, which is what says no socket
 * ever reached them.
 *
 * This drives the real timer, so it needs fake ones. Everything else in this
 * file runs on real timers, so the switch is scoped to the test and this block
 * is last: advancing the clock fires every pending timer, including any armed
 * by earlier tests.
 */
describe("a game nobody ever opened", () => {
  const ABANDON_TIMEOUT_MS = 30 * 60 * 1000;

  it("is on the clock from the moment it is created", () => {
    timers.useFakeTimers();
    try {
      const session = startedSession(UNLIMITED);
      expect(listLiveGames().some((game) => game.id === session.id)).toBe(true);

      timers.advanceTimersByTime(ABANDON_TIMEOUT_MS + 1);

      expect(listLiveGames().some((game) => game.id === session.id)).toBe(
        false,
      );
      // Nobody moved, so it is an abort rather than a loss for the absent seat.
      expect(getSession(session.id).gameState.result).toEqual({
        reason: "aborted",
      });
    } finally {
      timers.useRealTimers();
    }
  });
});

/**
 * The idle timer actually running.
 *
 * Same fake-timer caveat as the block above, and the same reason it sits last:
 * advancing the clock fires every pending timer, including any armed earlier.
 * Every test here connects both seats first, so the 30-minute abandonment timer
 * is disarmed and anything that happens is the idle timer's doing.
 *
 * Two hours cannot be waited out against a real server, so the boundary is
 * proven here while the half-open socket that motivates it was reproduced
 * separately through real websockets against unfixed code.
 */
describe("the idle timeout ending a game", () => {
  const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
  const ABANDON_TIMEOUT_MS = 30 * 60 * 1000;

  const withFakeTimers = (body: () => void) => {
    timers.useFakeTimers();
    try {
      body();
    } finally {
      timers.useRealTimers();
    }
  };

  it("ends an untimed game under way, charging the seat on turn", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      bothSeatsLookConnected(session);
      playMoves(session.id, 2);
      expect(getSession(session.id).gameState.turn).toBe(1);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS + 1);

      expect(listLiveGames().some((game) => game.id === session.id)).toBe(
        false,
      );
      // Player 1 was on turn, so player 2 wins. This is the vanished player
      // losing, which is the whole of b0b6ee79 once the game is a counted one.
      expect(getSession(session.id).gameState.result).toEqual({
        winner: 2,
        reason: "resignation",
      });
    });
  });

  it("leaves the game alone right up to the deadline", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      bothSeatsLookConnected(session);
      playMoves(session.id, 2);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);

      expect(listLiveGames().some((game) => game.id === session.id)).toBe(true);
      expect(getSession(session.id).gameState.status).toBe("playing");
    });
  });

  it("starts counting again from each move", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      bothSeatsLookConnected(session);
      playMoves(session.id, 2);

      timers.advanceTimersByTime(90 * 60 * 1000);
      playTurn(session.id, 1, 5);
      timers.advanceTimersByTime(90 * 60 * 1000);

      // Three hours have passed in total, so a timer armed once and never
      // rearmed would have ended this game an hour ago.
      expect(listLiveGames().some((game) => game.id === session.id)).toBe(true);
      expect(getSession(session.id).gameState.status).toBe("playing");
    });
  });

  /**
   * The manager's ruling on the moveCount=1 case, verbatim: "At moveCount < 2,
   * the idle timeout ends the game through the EXISTING abort semantics
   * ({reason: aborted}, no loser, no rating change)."
   *
   * Worth pinning both sides, because the two differ by a single move and the
   * reproduced real-socket case landed on the abort side of the line.
   */
  it("aborts rather than convicting when only one move was ever played", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      bothSeatsLookConnected(session);
      playMoves(session.id, 1);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS + 1);

      expect(listLiveGames().some((game) => game.id === session.id)).toBe(
        false,
      );
      expect(getSession(session.id).gameState.result).toEqual({
        reason: "aborted",
      });
    });
  });

  it("never touches an untimed game nobody has started", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      bothSeatsLookConnected(session);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS + 1);

      expect(listLiveGames().some((game) => game.id === session.id)).toBe(true);
      expect(getSession(session.id).gameState.status).toBe("playing");
    });
  });

  it("never touches a timed game that is under way", () => {
    withFakeTimers(() => {
      const session = startedSession(LONG_TIMED);
      bothSeatsLookConnected(session);
      playMoves(session.id, 2);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS + 1);

      // Two hours idle, and two hours of clock still to run. Only the idle
      // timer could have ended this, so its silence is the assertion.
      expect(listLiveGames().some((game) => game.id === session.id)).toBe(true);
      expect(getSession(session.id).gameState.status).toBe("playing");
    });
  });

  it("never touches a timed game nobody has started", () => {
    withFakeTimers(() => {
      const session = startedSession(TIMED);
      bothSeatsLookConnected(session);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS + 1);

      expect(listLiveGames().some((game) => game.id === session.id)).toBe(true);
      expect(getSession(session.id).gameState.status).toBe("playing");
    });
  });

  it("lets a bot lose rather than the human waiting on it", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      setBotCompositeId(session.id, "joiner", "client-1:superhuman");
      setConnected(session, "host", true);
      playMoves(session.id, 3);
      expect(getSession(session.id).gameState.turn).toBe(2);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS + 1);

      // The human is player 1. They were waiting, so they win; the requirement
      // is that they cannot be the one charged for the wait.
      expect(getSession(session.id).gameState.result).toEqual({
        winner: 1,
        reason: "resignation",
      });
    });
  });

  /**
   * The disconnect path is untouched and still fires first, on its own clock
   * and against its own seat. Player 1 is on turn here while the JOINER is the
   * one who left, so the two mechanisms name different losers - which is what
   * makes this fail if they are ever merged.
   */
  it("leaves the 30-minute disconnect path in charge of a seat that left", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      bothSeatsLookConnected(session);
      playMoves(session.id, 2);
      setConnected(session, "joiner", false);

      timers.advanceTimersByTime(ABANDON_TIMEOUT_MS + 1);

      expect(getSession(session.id).gameState.result).toEqual({
        winner: 1,
        reason: "resignation",
      });
    });
  });
});
