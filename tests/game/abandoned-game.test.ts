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
 * `findIdleSeat` is where it is asked.
 *
 * The two policies overlap and name DIFFERENT seats, so one has to give way.
 * Clause 3, verbatim: "when the server knows which seat disconnected, the
 * disconnect path owns the ending (charges the seat that left). The idle path
 * only ends a game when there is no known-disconnected seat to charge."
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

  it("stands down when the server knows which seat left", () => {
    // The joiner left, but the host is on turn, so the two policies disagree.
    const session = startedSession(UNLIMITED);
    bothSeatsLookConnected(session);
    playMoves(session.id, 2);
    setConnected(session, "joiner", false);

    expect(findAbandonedSeat(session.id)?.role).toBe("joiner");
    expect(findIdleSeat(session.id)).toBeNull();
  });

  it("takes the game back once that seat returns", () => {
    // Standing down must not be permanent.
    const session = startedSession(UNLIMITED);
    bothSeatsLookConnected(session);
    playMoves(session.id, 2);
    setConnected(session, "joiner", false);
    expect(findIdleSeat(session.id)).toBeNull();

    setConnected(session, "joiner", true);
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

  it("claims an untimed game nobody has started", () => {
    // The move-count floor is gone. Both seats connected and both silent is
    // the one shape neither policy used to reach.
    const session = startedSession(UNLIMITED);
    bothSeatsLookConnected(session);

    expect(getSession(session.id).gameState.moveCount).toBe(0);
    expect(findIdleSeat(session.id)?.role).toBe("host");
  });

  it("leaves a game nobody is connected to to the disconnect path", () => {
    // Nobody has moved and nobody is watching, so clause 3 hands this to the
    // abandonment policy - and with it the five-minute deadline.
    const session = startedSession(UNLIMITED);

    expect(findAbandonedSeat(session.id)?.role).toBe("host");
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
 * The three deadlines, restated rather than imported: an imported constant
 * would agree with the source by construction, and these tests exist to pin
 * the NUMBERS that were ruled on. A source change not made here reddens the
 * boundary pairs.
 */
const ABANDON_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const UNWATCHED_TIMEOUT_MS = 5 * 60 * 1000;
const BOT_GAME_DISCONNECT_GRACE_MS = 60 * 1000;

/**
 * Everything below drives real timers, so it needs fake ones. Everything above
 * runs on real timers, so the switch is scoped to a test and these blocks are
 * last: advancing the clock fires every pending timer, including any armed by
 * earlier tests.
 */
const withFakeTimers = (body: () => void) => {
  timers.useFakeTimers();
  try {
    body();
  } finally {
    timers.useRealTimers();
  }
};

const isLive = (id: string) => listLiveGames().some((game) => game.id === id);

/**
 * The five-minute band, and the guard on it.
 *
 * A game whose player never got as far as opening a socket used to sit in the
 * live-games list for good; arming at registration fixed that at thirty
 * minutes, and the ruling of 2026-08-09 cuts the wait to five.
 *
 * Clause 1, verbatim: "the 5-minute abort band applies only to UNTIMED games
 * with moveCount < 2 AND no human seat connected. A game with any human seat
 * connected (puzzle, bot game, waiting friend-link host) follows the 30-minute
 * rules instead." Clause 4: "the 5-minute band is untimed-only."
 *
 * The tests from the friend link onwards are that guard. Each asserts both
 * sides of the deadline it claims, since a game that merely ends eventually
 * would satisfy a much weaker rule than the one ruled on.
 */
describe("a game nobody ever opened", () => {
  it("is aborted five minutes after it is created", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(UNWATCHED_TIMEOUT_MS + 1);

      expect(isLive(session.id)).toBe(false);
      // Nobody moved, so it is an abort rather than a loss for the absent seat.
      expect(getSession(session.id).gameState.result).toEqual({
        reason: "aborted",
      });
    });
  });

  /**
   * Was "aborts the bot game of board 916af5bd in five minutes", advancing five
   * minutes and asserting the game was gone. Under the sixty-second bot band
   * that test STAYS GREEN while pinning nothing - a game that ended at 60 s is
   * also gone at 5 min - so it is restated on the deadline it now has, with both
   * sides asserted.
   */
  it("aborts the bot game of board 916af5bd in sixty seconds", () => {
    // The incident shape: a bot game whose browser never opened its websocket.
    // A bot seat never opens a game socket either, so what decides this is
    // that no HUMAN is there.
    //
    // This is also the test that pins the re-arm in `setBotCompositeId`. The
    // session is registered - and its timer armed - by `startedSession` above,
    // BEFORE the bot identity exists, exactly as routes/games.ts does it. With
    // no re-arm the game is still on the five-minute band here and survives.
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      setBotCompositeId(session.id, "joiner", "client-1:superhuman");

      timers.advanceTimersByTime(BOT_GAME_DISCONNECT_GRACE_MS - 1);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(2);
      expect(isLive(session.id)).toBe(false);
      expect(getSession(session.id).gameState.result).toEqual({
        reason: "aborted",
      });
    });
  });

  it("is left alone right up to the five-minute deadline", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);

      timers.advanceTimersByTime(UNWATCHED_TIMEOUT_MS - 1);

      expect(isLive(session.id)).toBe(true);
      expect(getSession(session.id).gameState.status).toBe("playing");
    });
  });

  it("counts the five minutes from the moment the last human leaves", () => {
    // Every connection change re-arms, so a host who opens the board and then
    // closes it starts the five minutes over rather than inheriting the
    // deadline from creation.
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      timers.advanceTimersByTime(3 * 60 * 1000);
      setConnected(session, "host", true);
      setConnected(session, "host", false);

      timers.advanceTimersByTime(UNWATCHED_TIMEOUT_MS - 1);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(2);
      expect(isLive(session.id)).toBe(false);
    });
  });

  it("gives a waiting friend-link host the full thirty minutes", () => {
    // The host is on the waiting screen while the guest opens the link from a
    // chat app. Killing this at five minutes was the hazard that sent the
    // literal rule back for a ruling. Connecting re-arms, so the thirty
    // minutes run from there.
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      setConnected(session, "host", true);

      timers.advanceTimersByTime(UNWATCHED_TIMEOUT_MS + 1);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(ABANDON_TIMEOUT_MS - UNWATCHED_TIMEOUT_MS - 2);
      expect(isLive(session.id)).toBe(true);
      expect(getSession(session.id).gameState.status).toBe("playing");

      timers.advanceTimersByTime(2);
      expect(isLive(session.id)).toBe(false);
      expect(getSession(session.id).gameState.result).toEqual({
        reason: "aborted",
      });
    });
  });

  it("gives a human thinking about their first move the full thirty minutes", () => {
    // The puzzle and bot-game shape: the human seat is connected and on turn,
    // the opponent is a bot, and no move has been played yet.
    //
    // What spares this is structural rather than the connected-seat clause -
    // nobody is disconnected, so no abandonment timer is armed and the short
    // band is never consulted. That structure is the reason the five minutes
    // live in the abandonment path: the same wait in the idle path would abort
    // a puzzle mid-thought.
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      setBotCompositeId(session.id, "joiner", "client-1:superhuman");
      setConnected(session, "host", true);
      expect(getSession(session.id).gameState.moveCount).toBe(0);

      timers.advanceTimersByTime(UNWATCHED_TIMEOUT_MS + 1);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS - UNWATCHED_TIMEOUT_MS - 2);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(2);
      expect(isLive(session.id)).toBe(false);
      expect(getSession(session.id).gameState.result).toEqual({
        reason: "aborted",
      });
    });
  });

  it("never puts a timed game in the five-minute band", () => {
    // Clause 4. A timed game nobody opened is still claimed by the
    // abandonment policy - no clock runs before the first move - but on the
    // thirty-minute deadline it has always had.
    withFakeTimers(() => {
      const session = startedSession(TIMED);

      timers.advanceTimersByTime(ABANDON_TIMEOUT_MS - 1);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(2);
      expect(isLive(session.id)).toBe(false);
    });
  });
});

/**
 * The sixty-second band for a bot game whose human seat left.
 *
 * Nil's ruling of 2026-08-16, for the live-games page: a browser that leaves a
 * bot game used to hold it for the full thirty minutes, and one zombie per
 * quitter was most of what the page showed. Measured that day, all four live
 * games were a guest against an official bot at move zero.
 *
 * Every test asserts BOTH sides of the deadline it claims. A game that merely
 * ends eventually satisfies a much weaker rule than the one ruled on, and the
 * old five-minute bot test proved exactly that by staying green when the answer
 * changed to sixty seconds.
 */
describe("a bot game whose human seat left", () => {
  it("ends sixty seconds after the human disconnects, charging the absent seat", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      setBotCompositeId(session.id, "joiner", "client-1:superhuman");
      setConnected(session, "host", true);
      playMoves(session.id, 2);
      setConnected(session, "host", false);

      timers.advanceTimersByTime(BOT_GAME_DISCONNECT_GRACE_MS - 1);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(2);
      expect(isLive(session.id)).toBe(false);
      // Two moves played, so this is a counted game and the seat that walked
      // away loses it. The human is player 1, so the bot wins.
      expect(getSession(session.id).gameState.result).toEqual({
        winner: 2,
        reason: "resignation",
      });
    });
  });

  it("keeps the game when the human comes back inside the grace period", () => {
    // Reconnecting must CANCEL the grace, not postpone it.
    //
    // The check lands at t=61 s rather than a further thirty minutes on
    // purpose: the idle timer is a separate mechanism with its own deadline
    // running from the last move, and it can legitimately end this game thirty
    // minutes after that move. Asserting survival that far out would be
    // asserting the absence of a policy this test is not about.
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      setBotCompositeId(session.id, "joiner", "client-1:superhuman");
      setConnected(session, "host", true);
      playMoves(session.id, 2);
      setConnected(session, "host", false);

      timers.advanceTimersByTime(30 * 1000);
      setConnected(session, "host", true);

      timers.advanceTimersByTime(BOT_GAME_DISCONNECT_GRACE_MS + 1);
      expect(isLive(session.id)).toBe(true);
      expect(getSession(session.id).gameState.status).toBe("playing");
    });
  });

  it("leaves a human-vs-human game on its thirty minutes", () => {
    // The control. The short band must not leak out of bot games: here a real
    // opponent is sitting at the board, which is what the thirty minutes are
    // for.
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      setConnected(session, "host", true);
      setConnected(session, "joiner", true);
      playMoves(session.id, 2);
      setConnected(session, "joiner", false);

      timers.advanceTimersByTime(BOT_GAME_DISCONNECT_GRACE_MS + 1);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(
        ABANDON_TIMEOUT_MS - BOT_GAME_DISCONNECT_GRACE_MS - 2,
      );
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(2);
      expect(isLive(session.id)).toBe(false);
    });
  });

  it("leaves a human thinking about their first move against a bot alone", () => {
    // Puzzle safety, and the reason the short bands live in the abandonment
    // path rather than the idle one. Nobody is disconnected here, so no
    // abandonment timer is armed at all and the sixty seconds are never
    // consulted; the game belongs to the idle policy at thirty minutes.
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      setBotCompositeId(session.id, "joiner", "client-1:superhuman");
      setConnected(session, "host", true);

      timers.advanceTimersByTime(BOT_GAME_DISCONNECT_GRACE_MS + 1);
      expect(isLive(session.id)).toBe(true);
      expect(getSession(session.id).gameState.status).toBe("playing");
    });
  });

  it("leaves a timed bot game under way to its clock", () => {
    // `findAbandonedSeat` stands down once a clock is running, so the sixty
    // seconds never reach this game. LONG_TIMED, so the clock cannot be what
    // ends it inside the window and the silence is the assertion.
    withFakeTimers(() => {
      const session = startedSession(LONG_TIMED);
      setBotCompositeId(session.id, "joiner", "client-1:superhuman");
      setConnected(session, "host", true);
      playMoves(session.id, 2);
      setConnected(session, "host", false);

      timers.advanceTimersByTime(BOT_GAME_DISCONNECT_GRACE_MS + 1);
      expect(isLive(session.id)).toBe(true);
      expect(getSession(session.id).gameState.status).toBe("playing");
    });
  });
});

/**
 * The idle timer actually running.
 *
 * Every test here connects both seats first. That disarms the abandonment
 * timer, so anything that happens is the idle timer's doing - which matters
 * more now that the two deadlines are equal, since clause 3 would otherwise
 * hand the ending to the other mechanism.
 *
 * Thirty minutes cannot be waited out against a real server, so the boundary is
 * proven here while the half-open socket that motivates it was reproduced
 * separately through real websockets against unfixed code.
 */
describe("the idle timeout ending a game", () => {
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

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
      playTurn(session.id, 1, 5);
      timers.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);

      // Nearly two full timeouts have passed, so a timer armed once and never
      // rearmed would have ended this game a timeout ago.
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

  /**
   * The hole this task closes, and the only shape neither mechanism reached
   * before it: two seats both connected, both silent, no move ever played.
   * The abandonment policy sees nobody gone and the idle policy used to stop
   * at the move-count floor, so nothing ended these at all.
   *
   * Both seats are connected, so clause 1 keeps this out of the five-minute
   * band and on the thirty-minute one.
   */
  it("ends an untimed game nobody has started, as an abort", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      bothSeatsLookConnected(session);

      timers.advanceTimersByTime(UNWATCHED_TIMEOUT_MS + 1);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS - UNWATCHED_TIMEOUT_MS - 2);
      expect(isLive(session.id)).toBe(true);

      timers.advanceTimersByTime(2);
      expect(isLive(session.id)).toBe(false);
      expect(getSession(session.id).gameState.result).toEqual({
        reason: "aborted",
      });
    });
  });

  it("never touches a timed game that is under way", () => {
    withFakeTimers(() => {
      const session = startedSession(LONG_TIMED);
      bothSeatsLookConnected(session);
      playMoves(session.id, 2);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS + 1);

      // Thirty minutes idle, and hours of clock still to run. Only the idle
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
   * Clause 3, end to end, and the reason it had to be ruled on at all.
   *
   * Player 1 is on turn here while the JOINER is the one who left, so the two
   * mechanisms name different losers. At two hours against thirty minutes they
   * never raced and the disconnect path always won. At thirty against thirty
   * the idle deadline is the earlier one - it runs from the last move, and a
   * disconnect cannot come before the move that preceded it - so without the
   * stand-down this ends as `winner: 2`, convicting the player who is still
   * sitting there of the absence of the one who left.
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

  /**
   * The other half of clause 3: standing down is not a retirement.
   *
   * What carries this is NOT the re-arm in `updateConnectionState` - the timer
   * armed by the last MOVE survives a disconnect and re-asks the policy when
   * it fires, by which time the seat is back. The re-arm matters where no move
   * ever armed anything, which is the two move-count-0 cases above.
   */
  it("takes the game back over when the disconnected seat returns", () => {
    withFakeTimers(() => {
      const session = startedSession(UNLIMITED);
      bothSeatsLookConnected(session);
      playMoves(session.id, 2);
      setConnected(session, "joiner", false);
      setConnected(session, "joiner", true);

      timers.advanceTimersByTime(IDLE_TIMEOUT_MS + 1);

      // Player 1 is on turn, so the idle policy charges the host once more.
      expect(getSession(session.id).gameState.result).toEqual({
        winner: 2,
        reason: "resignation",
      });
    });
  });
});
