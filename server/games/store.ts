import { nanoid } from "nanoid";
import { GameState } from "../../shared/domain/game-state";
import { clonePawns } from "../../shared/domain/pawns";
import { buildOrdinaryInitialState } from "../../shared/domain/game-configuration";
import {
  buildSurvivalInitialState,
  type SurvivalSetupInput,
} from "../../shared/domain/survival-setup";
import type { GameAction } from "../../shared/domain/game-types";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import {
  isUnlimitedTimeControl,
  endedBeforeBothPlayersMoved,
  isCountedResult,
  MIN_MOVES_FOR_A_COUNTED_GAME,
} from "../../shared/domain/game-utils";
import type {
  GameConfiguration,
  GameSnapshot,
  PlayerId,
  SessionStatus,
  SerializedGameState,
  GamePlayerSummary,
  PlayerAppearance,
  Move,
  MatchScore,
  GameResult,
} from "../../shared/domain/game-types";
import type {
  GameAccessWaitingReason,
  LiveGameSummary,
} from "../../shared/contracts/games";
import { applyRatingsForFinishedGame } from "../db/rating-write";
import { Outcome } from "./rating-system";
import { isBotClientConnected } from "./custom-bot-store";
import { pickGuestName } from "./guest-names";

// Match type determines how players join the game
export type MatchType = "friend" | "matchmaking";

export type PlayerConfigType =
  | "you" // Human playing locally
  | "friend" // Human friend joining via link
  | "matched-user" // Matchmaking opponent
  | "bot"; // Built-in bot (proactive bot protocol v2)

export interface SessionPlayer {
  role: "host" | "joiner";
  playerId: PlayerId;
  token: string;
  socketToken: string;
  displayName: string;
  connected: boolean;
  ready: boolean;
  lastSeenAt: number;
  appearance: PlayerAppearance;
  authUserId?: string; // Auth provider's user ID (for rating updates)
  /**
   * The browser this seat was played from. Rides the session from creation to
   * `persistCompletedGame`, because game_players rows are written at the end of
   * the game, not at the start - and because a rematch creates seats with no
   * HTTP request at all, so the seat spreads in `createRematchSession` are the
   * only thing carrying it across a rematch chain.
   */
  anonymousId?: string;
  ratingAtStart?: number; // Rating at game start, captured before updates
  elo?: number; // Looked up from DB based on authenticated user
  configType?: PlayerConfigType; // How this player seat was configured
  botCompositeId?: string; // Bot composite ID (clientId:botId) for proactive bot protocol v2
}

export interface RematchSeatCredentials {
  token: string;
  socketToken: string;
}

type SessionMatchScore = Record<SessionPlayer["role"], number>;

/**
 * What became of one attempt to open a game's websocket.
 *
 * The first four are the terminal outcomes of the socket's auth middleware
 * (`gameSocketAuth`); `authorized` means the handshake passed; `opened` and
 * `closed` are the socket itself.
 *
 * The pair that carries the diagnosis is `authorized` with no `opened` after
 * it: the server accepted the connection and it never arrived.
 */
export type SocketConnectOutcome =
  | "rejected-origin"
  | "rejected-token"
  | "game-not-found"
  | "not-spectatable"
  | "authorized"
  | "opened"
  | "closed";

export interface SocketConnectEvent {
  at: number;
  /** A connect carrying a seat token is a player; without one, a spectator. */
  role: "player" | "spectator";
  outcome: SocketConnectOutcome;
}

/**
 * How many events one game keeps.
 *
 * The FIRST N, not the last: a "the board is dead" report is about how the
 * game opened, and a client stuck in a reconnect loop would otherwise push the
 * interesting part out of a last-N window.
 */
const SOCKET_CONNECT_LOG_CAP = 20;

export interface SocketConnectRecord {
  /** Every attempt, including the ones past the cap. */
  total: number;
  /** The first `SOCKET_CONNECT_LOG_CAP` events, oldest first. */
  first: SocketConnectEvent[];
}

export interface GameSession {
  id: string;
  seriesId: string;
  rematchParentId?: string;
  rematchNumber: number;
  nextGameId?: string;
  nextGameSeatCredentials?: {
    host: RematchSeatCredentials;
    joiner: RematchSeatCredentials;
  };
  createdAt: number;
  startedAt?: number | null;
  updatedAt: number;
  config: GameConfiguration;
  /**
   * Set only by a server-authoritative saved-puzzle launch, to the id of the
   * puzzle row the server itself resolved (S-ID). Carries the puzzle's
   * identity from launch to `persistCompletedGame`, which writes it onto the
   * game record so completion can be verified server-side later.
   *
   * Deliberately NOT propagated by `createRematchSession`: a rematch is a
   * different game (seats swap, and for Random Start the layout is regenerated),
   * so crediting it as the original puzzle would be wrong.
   */
  puzzleId?: string;
  status: SessionStatus;
  matchType: MatchType;
  cancelled: boolean;
  players: {
    host: SessionPlayer;
    joiner: SessionPlayer;
  };
  matchScore: SessionMatchScore;
  gameInstanceId: number;
  lastScoredGameInstanceId: number;
  gameState: GameState;
  /**
   * The player waiting on an answer to a takeback offer, if any.
   *
   * An offer is about one position - "let me retake the turn I just played" -
   * so it stops meaning anything the moment the game moves past it, and
   * `applyActionToSession` retires it. Before this existed the server kept no
   * record of an offer at all, and an accept undid whatever the last turn
   * happened to be by the time it arrived; a few turns later that is a
   * different turn, belonging to a player who never offered it.
   */
  pendingTakebackFrom?: PlayerId;
  /**
   * Chat names for the spectators of this game, keyed by socket id.
   *
   * Seats carry their own name, so this covers the one kind of guest that has
   * no seat to carry it. Both are drawn from the same pool (`pickGuestName`) so
   * one game never shows two different guest-naming schemes at once.
   */
  spectatorGuestNames: Map<string, string>;
  /**
   * Every attempt to open this game's websocket, in order.
   *
   * `players[].connected` is current state, so it cannot tell a game nobody
   * ever opened from one whose player connected and walked away. On 2026-08-03
   * three bot games were reported dead and that question had no answer: the
   * shape they left behind (status "ready", `createdAt === updatedAt`, no
   * engine session) is produced by every failure ahead of `onOpen` alike -
   * a socket never attempted, refused, or dropped mid-handshake.
   *
   * A log line alone would not answer it either. The retained production log
   * buffer is small, and these games were reported after the fact; this record
   * lives exactly as long as the session it describes.
   *
   * Server-internal, and it must stay that way: it is in neither `GameSnapshot`
   * nor `LiveGameSummary`, and every outbound payload field-picks into one of
   * those contract types rather than serializing a session.
   */
  socketConnects: SocketConnectRecord;
}

export interface GameCreationResult {
  session: GameSession;
  hostToken: string;
  hostSocketToken: string;
}

const refreshSeatCredential = (player: SessionPlayer) => {
  player.token = nanoid();
  player.socketToken = nanoid();
  player.connected = false;
  player.lastSeenAt = Date.now();
};

/**
 * Set the bot composite ID for a player.
 * Called when creating a game against a bot.
 */
export const setBotCompositeId = (
  sessionId: string,
  role: "host" | "joiner",
  compositeId: string,
): void => {
  const session = ensureSession(sessionId);
  const player =
    role === "host" ? session.players.host : session.players.joiner;
  player.botCompositeId = compositeId;
  player.configType = "bot";
  // Learning that a seat is a bot CHANGES WHICH DEADLINE THE GAME IS ON, so it
  // is a state change like a connect or a move and asks the same question they
  // ask. Without this the sixty-second band would never reach the game that
  // needs it most: createGameSession registers the session - and arms its timer
  // - before the caller sets the bot identity (routes/games.ts:628 then :654),
  // so a bot game that nobody ever opens is armed while it still looks
  // human-vs-human and takes the five-minute band instead. That is the exact
  // shape of every live game in the 2026-08-16 sample.
  refreshAbandonTimer(sessionId);
};

/**
 * Get the bot composite ID for a player.
 */
export const getBotCompositeId = (
  sessionId: string,
  role: "host" | "joiner",
): string | undefined => {
  const session = ensureSession(sessionId);
  const player =
    role === "host" ? session.players.host : session.players.joiner;
  return player.botCompositeId;
};

export type JoinGameSessionResult =
  | {
      kind: "player";
      session: GameSession;
      player: SessionPlayer;
    }
  | {
      kind: "spectator";
      session: GameSession;
    };

const sessions = new Map<string, GameSession>();

/**
 * The invariant behind rated games: `config.rated` implies both seats are
 * authenticated. The host side is enforced when the game is created (a
 * logged-out creator cannot switch Rated on); this is the joiner side.
 *
 * Checked in exactly two places: `resolveGameAccess`, so a guest is told to
 * make an account instead of being offered a seat, and `joinGameSession`,
 * which is the only function that seats a second player.
 */
const ratedSeatRequiresLogin = (
  session: GameSession,
  authUserId?: string,
): boolean => session.config.rated && !authUserId;

export const RATED_REQUIRES_LOGIN_MESSAGE =
  "This game is rated. Create an account to join.";

// ============================================================================
// Timeout Timer Management
// ============================================================================

const TIMEOUT_FLOOR_MS = 100;

// Map of session ID to timeout timer
const timeoutTimers = new Map<string, Timer>();

// Callback to be invoked when a timeout occurs (set by game-socket.ts)
type TimeoutCallback = (
  sessionId: string,
  newState: GameState,
) => Promise<void>;
let onTimeoutCallback: TimeoutCallback | null = null;

/**
 * Register a callback to be invoked when a timeout timer fires.
 * Called by game-socket.ts on startup to handle broadcasts.
 */
export const registerTimeoutCallback = (callback: TimeoutCallback): void => {
  onTimeoutCallback = callback;
};

/**
 * Clear any existing timeout timer for a session.
 */
export const clearTimeoutTimer = (sessionId: string): void => {
  const existingTimer = timeoutTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    timeoutTimers.delete(sessionId);
  }
};

const getRemainingMs = (state: GameState, playerId: PlayerId): number => {
  const timeLeftMs = state.timeLeft[playerId] * 1000;
  const elapsedMs = Date.now() - state.lastMoveTime;
  return Math.max(0, timeLeftMs - elapsedMs);
};

const applyTimeoutToSession = (
  sessionId: string,
  session: GameSession,
): void => {
  const timedOutPlayer = session.gameState.turn;
  const newState = applyActionToSession(session, {
    kind: "timeout",
    playerId: timedOutPlayer,
    timestamp: Date.now(),
  });

  console.info("[timeout-timer] timeout applied", {
    sessionId,
    timedOutPlayer,
    result: newState.result,
  });

  // Invoke the registered callback to handle broadcasts, ratings, etc.
  if (onTimeoutCallback) {
    onTimeoutCallback(sessionId, newState).catch((err: unknown) => {
      console.error("[timeout-timer] callback error", { sessionId, err });
    });
  }
};

/**
 * Set a timeout timer for the current player's remaining time.
 * Called after moves to schedule the next potential timeout.
 */
export const scheduleTimeoutTimer = (sessionId: string): void => {
  // Clear any existing timer first
  clearTimeoutTimer(sessionId);

  const session = sessions.get(sessionId);
  if (session?.gameState.status !== "playing") {
    return;
  }

  const state = session.gameState;

  // Don't schedule timer for unlimited time control games
  if (isUnlimitedTimeControl(state.timeControl)) {
    return;
  }

  // Don't schedule timer before first move (clock doesn't run)
  if (state.moveCount === 0) {
    return;
  }

  const currentPlayer = state.turn;
  const remainingMs = getRemainingMs(state, currentPlayer);

  // Don't schedule timers for very short durations to avoid race conditions.
  // If the remaining time is already at/below the floor, time out immediately.
  if (remainingMs <= TIMEOUT_FLOOR_MS) {
    console.info(
      "[timeout-timer] immediate timeout - remaining time too short",
      {
        sessionId,
        player: currentPlayer,
        remainingMs,
      },
    );
    applyTimeoutToSession(sessionId, session);
    return;
  }

  // Schedule the timeout
  const timer = setTimeout(() => {
    timeoutTimers.delete(sessionId);

    // Re-fetch session and verify it's still valid
    const currentSession = sessions.get(sessionId);
    if (currentSession?.gameState.status !== "playing") {
      return;
    }

    const currentState = currentSession.gameState;
    const activePlayer = currentState.turn;
    const remainingMs = getRemainingMs(currentState, activePlayer);

    if (remainingMs > TIMEOUT_FLOOR_MS) {
      console.info("[timeout-timer] timer fired early - rescheduling", {
        sessionId,
        player: activePlayer,
        remainingMs,
      });
      scheduleTimeoutTimer(sessionId);
      return;
    }

    applyTimeoutToSession(sessionId, currentSession);
  }, remainingMs);

  timeoutTimers.set(sessionId, timer);

  console.info("[timeout-timer] scheduled", {
    sessionId,
    player: currentPlayer,
    remainingMs,
  });
};

// ============================================================================
// Websocket connect record
// ============================================================================

/**
 * Record one attempt to open a game's websocket, and log it.
 *
 * The single writer for both, so the stored record and the log line can never
 * disagree about what happened.
 *
 * An id with no session is logged and not stored. An attempt can name a game
 * that never existed, or one the server has already forgotten, and that is
 * itself worth seeing - `knownGame` in the line says which.
 *
 * NOT covered: a player-token connect to an unknown id, where
 * `resolveSessionForSocketToken` throws out of the middleware before anything
 * here runs. Recording it would mean turning that 500 into a handled response,
 * which is a behaviour change rather than instrumentation.
 */
export const recordSocketConnect = (
  sessionId: string,
  event: Omit<SocketConnectEvent, "at">,
): void => {
  const session = sessions.get(sessionId);
  if (session) {
    session.socketConnects.total += 1;
    if (session.socketConnects.first.length < SOCKET_CONNECT_LOG_CAP) {
      session.socketConnects.first.push({ ...event, at: Date.now() });
    }
  }
  console.info("[ws-connect]", {
    sessionId,
    outcome: event.outcome,
    role: event.role,
    knownGame: session !== undefined,
    attempt: session?.socketConnects.total ?? null,
  });
};

/**
 * A game's connect history on one line, for a log that has to survive being
 * read months later by somebody holding only a game id.
 */
export const summarizeSocketConnects = (
  record: SocketConnectRecord,
): string => {
  if (record.first.length === 0) {
    return `none (total ${record.total})`;
  }
  const sequence = record.first.map((e) => `${e.role}:${e.outcome}`).join(" ");
  return `${sequence} (total ${record.total})`;
};

// ============================================================================
// Abandonment timer
// ============================================================================

/**
 * How long a game survives with a walked-away player before the server ends it.
 *
 * Generous on purpose. The cost of waiting is one held session on the bot
 * engine, which caps at 256 per engine process and then refuses new games;
 * traffic is nowhere near that, so patience is cheap and a player who shuts a
 * laptop lid gets their game back.
 */
const ABANDON_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The same wait, cut short for a game that never got going and that nobody is
 * looking at: the browser that never opened its socket, or the one that opened
 * it and went away again before moving.
 *
 * Nil ruled on 2026-08-09 that "30 min is enough. and if <2 moves, 5 min is
 * enough". The band is guarded (clause 1): it applies only to an UNTIMED game
 * under two moves with NO human seat connected. Any game with a human seat
 * connected follows the thirty-minute rules instead. Untimed-only is clause 4.
 *
 * The guard decides one case, because reaching here already means a human seat
 * is known gone: the one where the OTHER human seat is still present, which is
 * a friend link whose host waits while the guest opens it. That wait is
 * routinely longer than five minutes and has always had thirty.
 *
 * A human thinking about their first move is spared by WHERE this lives rather
 * than by the guard - with nobody disconnected no abandonment timer is armed at
 * all, so the game belongs to the idle policy at thirty minutes. Puzzles depend
 * on that: a puzzle puts the human on turn under two moves, so the same five
 * minutes in the idle path would abort one under thought.
 */
const UNWATCHED_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The wait for a BOT game whose human seat has gone.
 *
 * Nil ruled about sixty seconds on 2026-08-16, for the live-games page: a
 * browser that leaves a bot game used to keep it alive for the full thirty
 * minutes, and one zombie per quitter is what the page mostly showed. Measured
 * that day, every live game was a guest against an official bot at move zero.
 *
 * Why a bot game earns a shorter wait than any other. The thirty minutes exist
 * to protect somebody: a human opponent mid-game, or a friend-link host waiting
 * for a guest to open the link. A bot game has neither. It cannot be rated
 * either - `processRatingUpdate` needs an `authUserId` on both seats and a bot
 * seat has none - so ending one early costs the player the game and nothing
 * else, and they can start another immediately.
 *
 * What it costs, stated rather than buried: a phone in a lift, or a lid closed
 * for two minutes, now loses a bot game that used to survive. Tab churn is not
 * exposed - `seatHasOtherSocket` in game-socket.ts already absorbs refreshes and
 * a reconnect whose new socket opens before the old close is delivered - so the
 * exposure is genuine network loss lasting more than a minute.
 *
 * A timed bot game already under way never reaches here: `findAbandonedSeat`
 * stands down once a clock is running, and the clock ends it within the absent
 * player's remaining time. Overriding that would take a classical player's
 * remaining hours away over one blip.
 */
const BOT_GAME_DISCONNECT_GRACE_MS = 60 * 1000;

/**
 * Whether either seat is played by a bot.
 *
 * Any `botCompositeId` counts, official or custom: the property the short wait
 * rests on is that no human opponent is waiting, and that holds for both.
 */
const isBotGame = (session: GameSession): boolean =>
  [session.players.host, session.players.joiner].some(
    (player) => player.botCompositeId !== undefined,
  );

const abandonTimers = new Map<string, Timer>();

const clearAbandonTimer = (sessionId: string): void => {
  const existingTimer = abandonTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    abandonTimers.delete(sessionId);
  }
};

/**
 * Whether this game's own clock will end it, so no timeout policy has to.
 *
 * ONE domain fact, used by both policies. A clock does not start until the
 * first move - `scheduleTimeoutTimer` returns early before that, and
 * `applyPlayerMove` charges time only at `moveCount > 0` - so a timed game
 * nobody has moved in is no better protected than an untimed one.
 *
 * The abandonment policy always asked exactly this. The idle policy asked the
 * cruder "is it timed", which was right while it only had to exclude STARTED
 * timed games and over-excluded the unstarted ones: a timed game at move zero
 * with both seats connected and silent was claimed by neither policy and sat in
 * the live list for good (board 62b736ca). Sharing the question is what closes
 * that hole by construction rather than by naming another special case.
 */
const clockWillEndGame = (session: GameSession): boolean =>
  !isUnlimitedTimeControl(session.gameState.timeControl) &&
  session.gameState.moveCount > 0;

/**
 * The seat that has walked away from a game nothing else would ever end, or
 * null if the game is fine.
 *
 * Two kinds of game qualify, both by `clockWillEndGame` above: untimed ones,
 * and timed ones that nobody has moved in yet. In both, an absent player would
 * otherwise sit there indefinitely.
 *
 * Bot seats never qualify: they connect over the bot-client socket and have
 * their own disconnect grace in custom-bot-socket.ts.
 *
 * This is the whole policy, in one place, so arming the timer and re-checking
 * when it fires ask exactly the same question.
 */
export const findAbandonedSeat = (sessionId: string): SessionPlayer | null => {
  const session = sessions.get(sessionId);
  if (session?.gameState.status !== "playing") {
    return null;
  }
  if (clockWillEndGame(session)) {
    return null;
  }
  for (const player of [session.players.host, session.players.joiner]) {
    if (!player.botCompositeId && !player.connected) {
      return player;
    }
  }
  return null;
};

/**
 * Whether this game gets the short wait: untimed, under two moves, and with no
 * human seat connected to it.
 *
 * "No seat connected" and "no HUMAN seat connected" are the same test here, so
 * only the first is written: `connected` is set from the game websocket alone,
 * and a bot seat never opens one, so it reads as disconnected for its whole
 * life. `findAbandonedSeat` must exclude bot seats explicitly only because it
 * tests the opposite polarity, where always-false would make every bot look
 * like a player who walked away.
 *
 * Asked at arming time rather than at expiry, which is safe because every
 * connection change re-arms: a seat that arrives moves the game onto the long
 * wait, and a seat that leaves starts the short one over.
 */
const isUnwatchedUnstartedGame = (session: GameSession): boolean =>
  isUnstartedForItsTimeControl(session) &&
  ![session.players.host, session.players.joiner].some(
    (player) => player.connected,
  );

/**
 * Whether this game has not got going, by the only measure its time control
 * allows.
 *
 * The asymmetry is real, not sloppiness. For an UNTIMED game "not got going" is
 * under two moves, which is also the abort boundary. For a TIMED game the only
 * unstarted count is ZERO: at move one the clock is already running, and from
 * there the clock owns the game (`clockWillEndGame`).
 *
 * Nil ruled on 2026-08-16 that the five-minute band extends to timed games at
 * move zero. That reverses clause 4 of the 2026-08-09 ruling ("the 5-minute
 * band is untimed-only"), which was written when a timed game at move zero was
 * believed to be somebody else's problem and turned out to be nobody's.
 */
const isUnstartedForItsTimeControl = (session: GameSession): boolean =>
  isUnlimitedTimeControl(session.gameState.timeControl)
    ? session.gameState.moveCount < MIN_MOVES_FOR_A_COUNTED_GAME
    : session.gameState.moveCount === 0;

const applyAbandonToSession = (sessionId: string, playerId: PlayerId): void => {
  // Resigning gets the abort-vs-loss distinction for free: a game abandoned
  // before both players moved is recorded as aborted and leaves ratings alone.
  const newState = resignGame({
    id: sessionId,
    playerId,
    timestamp: Date.now(),
  });

  // The connect history rides along because this is the moment a never-started
  // game becomes visible: one line says whether anybody ever tried to open it,
  // which is what a "the board was dead" report needs and cannot get from
  // `players[].connected`.
  const session = sessions.get(sessionId);
  console.info("[abandon-timer] player never came back - game ended", {
    sessionId,
    playerId,
    result: newState.result,
    socketConnects: session
      ? summarizeSocketConnects(session.socketConnects)
      : "unknown (session gone)",
  });

  // The same finish work a clock timeout does: ratings, persistence,
  // broadcasts, and the bot notification that releases the engine's session.
  if (onTimeoutCallback) {
    onTimeoutCallback(sessionId, newState).catch((err: unknown) => {
      console.error("[abandon-timer] callback error", { sessionId, err });
    });
  }
};

/**
 * Arm or disarm a session's abandonment timer, recomputed from scratch.
 *
 * Called whenever a player's connection changes. Like `scheduleTimeoutTimer`
 * this clears before it schedules, so a second disconnect restarts the
 * countdown instead of inheriting the first one's deadline - deliberately the
 * lenient direction, and it keeps the armed seat and the seat checked at expiry
 * in agreement without tracking who the timer was for.
 */
const refreshAbandonTimer = (sessionId: string): void => {
  clearAbandonTimer(sessionId);

  const abandoned = findAbandonedSeat(sessionId);
  if (!abandoned) {
    return;
  }

  // Shortest applicable band wins, so the order here is the policy. A bot game
  // that is also unwatched and unstarted takes the sixty seconds, not the five
  // minutes: both describe it, and the bot band is the tighter statement.
  const session = sessions.get(sessionId);
  const timeoutMs = !session
    ? ABANDON_TIMEOUT_MS
    : isBotGame(session)
      ? BOT_GAME_DISCONNECT_GRACE_MS
      : isUnwatchedUnstartedGame(session)
        ? UNWATCHED_TIMEOUT_MS
        : ABANDON_TIMEOUT_MS;

  const timer = setTimeout(() => {
    abandonTimers.delete(sessionId);
    // Ask again: the game may have finished, or the player may have returned.
    const stillAbandoned = findAbandonedSeat(sessionId);
    if (!stillAbandoned) {
      return;
    }
    applyAbandonToSession(sessionId, stillAbandoned.playerId);
  }, timeoutMs);
  // Neither wait is long enough to outlive whatever else is pending, and this
  // timer is never the reason to keep a process alive (as in the bot client's
  // disconnect grace).
  (timer as { unref?: () => void }).unref?.();

  abandonTimers.set(sessionId, timer);

  console.info("[abandon-timer] scheduled", {
    sessionId,
    playerId: abandoned.playerId,
    timeoutMs,
  });
};

/**
 * Puts a new session in the map and starts its abandonment clock.
 *
 * Every session is born with both seats disconnected, so a brand-new one
 * already answers `findAbandonedSeat`. Arming here is what covers the game
 * nobody ever opened: `updateConnectionState` used to be the only caller of
 * `refreshAbandonTimer`, so a session whose player never got as far as opening
 * a socket never got a timer, and sat in the live-games list forever holding an
 * engine session. Creating a session is a state change like any other, so it
 * asks the same question the other state changes ask.
 *
 * Going through here rather than calling `sessions.set` directly is the point:
 * a later creation path cannot forget the clock.
 *
 * The idle timer needs no arming here, and not by luck: every creation path
 * registers with both seats disconnected, so the abandonment policy claims the
 * session and the idle policy stands down. The first seat to connect arms it
 * through `updateConnectionState`, and a game cannot be played without one.
 */
const registerSession = (session: GameSession): void => {
  sessions.set(session.id, session);
  refreshAbandonTimer(session.id);
};

// ============================================================================
// Idle timer
// ============================================================================

/**
 * How long an untimed game that is under way survives with nobody moving.
 *
 * The abandonment timer above only fires for a seat the server *knows* has
 * gone, and it only knows that from a websocket close. A socket that stays open
 * but silent - a locked phone, a closed lid - never reaches the close handler,
 * so `connected` stays true and no abandonment timer is ever armed. An untimed
 * game has no clock either, so nothing ends it at all: seven such games were
 * observed sitting in the live list for 60-78 minutes on 2026-08-06, each
 * holding a session on the bot engine and standing in the way of a deploy.
 *
 * So this timer asks a different question from the one above - not "has a seat
 * gone" but "has anybody moved" - which is what makes it the answer to a
 * half-open socket. No liveness probe is needed to detect one.
 *
 * Thirty minutes, per Nil's ruling of 2026-08-09: "30 min is enough." It was
 * two hours on the argument that a quiet game may just be two people thinking,
 * which is true and is why this is still the last resort rather than the first.
 *
 * Equal to ABANDON_TIMEOUT_MS and deliberately NOT the same constant: the two
 * answer different questions and could be ruled on separately tomorrow. The
 * equality is what made the stand-down in `findIdleSeat` necessary.
 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The idle wait for a TIMED game that nobody has started.
 *
 * Nil ruled five minutes on 2026-08-16, extending the existing five-minute
 * band to timed games at move zero. Such a game has no clock running and,
 * with both seats connected and silent, was reached by no policy at all: it sat
 * in the live list indefinitely (board 62b736ca).
 *
 * Five minutes of thought before the first move is not a real cost here,
 * because a timed game's own clock is what would normally charge for thinking
 * and it is not running yet. Nobody is convicted either: at move zero
 * `resignGame` records an abort, so no rating moves.
 *
 * Equal to UNWATCHED_TIMEOUT_MS and deliberately NOT the same constant,
 * following the ABANDON/IDLE precedent above: the two answer different
 * questions - one about a game nobody is watching, one about a game nobody is
 * moving in - and either could be ruled on separately tomorrow.
 */
const UNSTARTED_TIMED_TIMEOUT_MS = 5 * 60 * 1000;

const idleTimers = new Map<string, Timer>();

const clearIdleTimer = (sessionId: string): void => {
  const existingTimer = idleTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    idleTimers.delete(sessionId);
  }
};

/**
 * The seat that must act in an untimed game nobody is moving in, or null if
 * this is not a game the idle timer governs.
 *
 * Timed games are left alone at every move count - the one boundary this
 * policy still has, kept by clause 4: "Timed games remain untouched by this
 * task entirely."
 *
 * The move-count floor is gone. It used to leave an untimed game nobody had
 * started to the abandonment policy, which only reaches a seat it KNOWS is
 * gone - so two seats both connected and both silent fell between the two and
 * sat in the live list indefinitely.
 *
 * WHERE THE OTHER POLICY ALREADY HAS AN ANSWER, IT WINS. Clause 3: "when the
 * server knows which seat disconnected, the disconnect path owns the ending
 * (charges the seat that left). The idle path only ends a game when there is
 * no known-disconnected seat to charge." The two name different seats, and
 * with the deadlines equal they would not merely coexist: this deadline runs
 * from the last move and the other from the disconnect, which cannot come
 * first, so left to race this one always wins and charges the player still
 * sitting there for the absence of the one who left. Standing down is not a
 * retirement - `updateConnectionState` re-arms when the seat returns.
 *
 * The seat returned is the one whose turn it is, because a move is what resets
 * this clock. That is also what keeps a human waiting on a slow bot safe: the
 * wait sits on the bot's clock. Below two moves nobody is charged at all -
 * `resignGame` records an abort whichever seat is named.
 */
export const findIdleSeat = (sessionId: string): SessionPlayer | null => {
  const session = sessions.get(sessionId);
  if (session?.gameState.status !== "playing") {
    return null;
  }
  const state = session.gameState;
  // Was a blanket "timed games are never claimed", which is clause 4 of the
  // 2026-08-09 ruling. It excluded one game too many: a timed game at move zero
  // has no clock running, so nothing else would ever end it, and with both seats
  // connected and silent the abandonment policy could not see it either. Asking
  // the same question the abandonment policy asks keeps started timed games
  // exactly as protected as clause 4 left them (board 62b736ca).
  if (clockWillEndGame(session)) {
    return null;
  }
  if (findAbandonedSeat(sessionId)) {
    return null;
  }
  return session.players.host.playerId === state.turn
    ? session.players.host
    : session.players.joiner;
};

const applyIdleTimeoutToSession = (
  sessionId: string,
  playerId: PlayerId,
): void => {
  // The same resignation the abandonment path uses, for the same reasons: the
  // abort-vs-loss distinction comes for free (a game ended before both players
  // moved is recorded as aborted and leaves ratings alone), and players and
  // spectators see an ordinary ending rather than a game that vanishes.
  const newState = resignGame({
    id: sessionId,
    playerId,
    timestamp: Date.now(),
  });

  console.info("[idle-timer] nobody moved - game ended", {
    sessionId,
    playerId,
    result: newState.result,
  });

  // The same finish work a clock timeout does: ratings, persistence,
  // broadcasts, and the bot notification that releases the engine's session.
  if (onTimeoutCallback) {
    onTimeoutCallback(sessionId, newState).catch((err: unknown) => {
      console.error("[idle-timer] callback error", { sessionId, err });
    });
  }
};

/**
 * Arm or disarm a session's idle timer, recomputed from scratch.
 *
 * The deadline is derived from `gameState.lastMoveTime` rather than from the
 * moment of arming, the way `scheduleTimeoutTimer` derives its own from the
 * clock. That makes the timer a pure function of session state, and the
 * property worth having is idempotence: a caller that re-arms more often than
 * necessary cannot push the deadline out, so re-arming after every action is
 * safe and no future action kind can quietly leave a stale deadline behind.
 *
 * Like `refreshAbandonTimer` this clears before it schedules and re-asks the
 * policy when it fires, which keeps the armed seat and the seat charged at
 * expiry in agreement without tracking who the timer was for.
 */
const refreshIdleTimer = (sessionId: string): void => {
  clearIdleTimer(sessionId);

  const idle = findIdleSeat(sessionId);
  const session = sessions.get(sessionId);
  if (!idle || !session) {
    return;
  }

  // The condition is written in full - timed AND unstarted - even though
  // `findIdleSeat` above already guarantees the second half for a timed game.
  // A deadline that rests on a caller's accident is one relaxation away from
  // silently misapplying, and spelling it out costs one clause.
  const deadlineMs =
    !isUnlimitedTimeControl(session.gameState.timeControl) &&
    isUnstartedForItsTimeControl(session)
      ? UNSTARTED_TIMED_TIMEOUT_MS
      : IDLE_TIMEOUT_MS;

  // Derived from `lastMoveTime`, which the GameState constructor seeds to the
  // game's start time, so this is well defined at move zero and re-arming can
  // never push a deadline out.
  const remainingMs = Math.max(
    0,
    deadlineMs - (Date.now() - session.gameState.lastMoveTime),
  );

  const timer = setTimeout(() => {
    idleTimers.delete(sessionId);
    // Ask again: a move may have landed, or the game may have finished.
    const stillIdle = findIdleSeat(sessionId);
    if (!stillIdle) {
      return;
    }
    applyIdleTimeoutToSession(sessionId, stillIdle.playerId);
  }, remainingMs);
  // Half an hour is never the reason to keep the process alive.
  (timer as { unref?: () => void }).unref?.();

  idleTimers.set(sessionId, timer);

  console.info("[idle-timer] scheduled", {
    sessionId,
    playerId: idle.playerId,
    timeoutMs: remainingMs,
  });
};

// ============================================================================

const ensureSession = (id: string): GameSession => {
  const session = sessions.get(id);
  if (!session) {
    throw new Error("Game session not found");
  }
  return session;
};

export const getSession = (id: string): GameSession => ensureSession(id);

/** Partial config type for API requests that may not include variantConfig */
export type PartialGameConfiguration = Omit<
  GameConfiguration,
  "variantConfig" | "randomStart"
> & {
  randomStart?: boolean;
  variantConfig?: GameConfiguration["variantConfig"];
  // Legacy survival field for backward compatibility
  survival?: SurvivalSetupInput;
};

/**
 * Build a complete GameConfiguration with variantConfig populated.
 * Handles configs that may not yet have variantConfig (backward compatibility).
 */
export const buildCompleteConfig = (
  baseConfig: PartialGameConfiguration,
): GameConfiguration => {
  const normalizedBase = {
    ...baseConfig,
    randomStart: baseConfig.randomStart ?? false,
  };
  if (
    normalizedBase.variant === "animal-cycle" &&
    normalizedBase.randomStart &&
    Math.min(normalizedBase.boardWidth, normalizedBase.boardHeight) < 4
  ) {
    throw new Error(
      "Animal Cycle Random Start requires both board dimensions to be at least 4.",
    );
  }
  // If variantConfig already exists, use it
  if (baseConfig.variantConfig) {
    return normalizedBase as GameConfiguration;
  }

  const { boardWidth, boardHeight, variant } = normalizedBase;

  if (variant === "survival" && baseConfig.survival) {
    const survivalInput: SurvivalSetupInput = {
      boardWidth,
      boardHeight,
      turnsToSurvive: baseConfig.survival.turnsToSurvive,
      mouseCanMove: baseConfig.survival.mouseCanMove,
      walls: baseConfig.survival.walls,
      catPosition: baseConfig.survival.catPosition,
      mousePosition: baseConfig.survival.mousePosition,
    };
    return {
      ...normalizedBase,
      variantConfig: buildSurvivalInitialState(survivalInput),
    };
  }

  if (
    variant === "standard" ||
    variant === "classic" ||
    variant === "animal-cycle"
  ) {
    return {
      ...normalizedBase,
      variantConfig: buildOrdinaryInitialState(normalizedBase),
    };
  }

  throw new Error(`Unsupported variant: ${variant}`);
};

const createGameState = (config: PartialGameConfiguration): GameState => {
  const completeConfig = buildCompleteConfig(config);
  return new GameState(completeConfig, Date.now());
};

const buildMatchScoreSnapshot = (session: GameSession): MatchScore => {
  const hostId = session.players.host.playerId;
  const joinerId = session.players.joiner.playerId;
  const snapshot: MatchScore = { 1: 0, 2: 0 };
  snapshot[hostId] = session.matchScore.host;
  snapshot[joinerId] = session.matchScore.joiner;
  return snapshot;
};

const awardWin = (session: GameSession, winner: PlayerId) => {
  if (session.players.host.playerId === winner) {
    session.matchScore.host += 1;
    return;
  }
  if (session.players.joiner.playerId === winner) {
    session.matchScore.joiner += 1;
  }
};

const awardDraw = (session: GameSession) => {
  session.matchScore.host += 0.5;
  session.matchScore.joiner += 0.5;
};

const finalizeMatchScore = (
  session: GameSession,
  result: GameResult | null | undefined,
) => {
  if (session.lastScoredGameInstanceId === session.gameInstanceId) {
    return;
  }
  // An aborted game leaves the series score untouched, not even as a draw.
  if (!isCountedResult(result)) {
    return;
  }
  if (result.winner === 1 || result.winner === 2) {
    awardWin(session, result.winner);
  } else {
    awardDraw(session);
  }
  session.lastScoredGameInstanceId = session.gameInstanceId;
};

/**
 * Every name already spoken for in this game: both seats, plus the spectators
 * who have already been handed one. Passed to `pickGuestName` so no two people
 * in the same game answer to the same name.
 *
 * Deliberately every name, not only the guest ones - a spectator should not
 * turn up wearing "Hard Bot" either.
 */
const namesInUse = (session: GameSession): string[] => [
  session.players.host.displayName,
  session.players.joiner.displayName,
  ...session.spectatorGuestNames.values(),
];

/**
 * Names the person taking a seat. This is the authority on seat names, so it
 * decides on the account first and only then looks at what was asked for.
 *
 * Nobody gets to name a guest, not even a server caller: a seat with no account
 * behind it is a guest, and a guest gets an animal so the two sides of a game
 * can be told apart. Honouring a requested name here would put the invariant in
 * whichever caller happened to sanitize its input - `resolveSeatDisplayName`
 * does exactly that today - and a future caller that forgot would quietly seat
 * a guest under a registered player's name.
 *
 * An authenticated seat keeps the name it was given, and falls back to the
 * neutral placeholder when the account lookup came back empty. That is not a
 * guest: no animal.
 *
 * Only for a seat someone is actually taking. The joiner seat of a fresh
 * session is a placeholder or a bot, and neither is a person to name.
 */
const resolveSeatName = (args: {
  authUserId: string | undefined;
  requested: string | undefined;
  placeholder: string;
  taken?: string[];
}): string => {
  if (!args.authUserId) {
    return pickGuestName(args.taken);
  }
  // An empty request is not a name: the browser sends one while its settings
  // query is still in flight.
  const requested = args.requested?.trim();
  if (!requested) {
    return args.placeholder;
  }
  return requested;
};

/**
 * Creates a new game session.
 *
 * @param hostIsPlayer1 - Whether the host becomes Player 1 (who starts first).
 *   If not provided, the server randomly chooses. Tests can pass this explicitly
 *   for deterministic behavior.
 * @param hostAuthUserId - Host's auth provider user ID (for rating updates).
 * @param hostElo - Host's ELO rating, looked up from DB by the route handler.
 * @param joinerConfig - Configuration for the joiner seat (custom bot, etc.)
 */
export const createGameSession = (args: {
  config: PartialGameConfiguration;
  matchType: MatchType;
  hostDisplayName?: string;
  hostAppearance?: PlayerAppearance;
  hostIsPlayer1?: boolean;
  hostAuthUserId?: string;
  hostElo?: number;
  /** The host browser's anonymous id, when it sent one. */
  hostAnonymousId?: string;
  joinerConfig?: {
    type: PlayerConfigType;
    displayName?: string;
  };
  /** Server-resolved saved-puzzle id; see `GameSession.puzzleId` (S-ID). */
  puzzleId?: string;
}): GameCreationResult => {
  const completeConfig = buildCompleteConfig(args.config);
  const id = nanoid(8); // Short, shareable game ID (62^8 = 218 trillion combinations)
  // No invite code needed - the game ID itself is secure enough
  const hostToken = nanoid(); // 21 chars by default for security
  const hostSocketToken = nanoid();
  const guestToken = nanoid();
  const guestSocketToken = nanoid();
  const now = Date.now();

  // Determine which role gets which PlayerId based on hostIsPlayer1
  // If not provided, randomly choose. See game-types.ts for Player A/B vs Player 1/2 terminology.
  const hostIsPlayer1 = args.hostIsPlayer1 ?? Math.random() < 0.5;
  const hostPlayerId: PlayerId = hostIsPlayer1 ? 1 : 2;
  const joinerPlayerId: PlayerId = hostIsPlayer1 ? 2 : 1;

  // Determine joiner display name and config type
  const joinerConfigType = args.joinerConfig?.type ?? "friend";
  const joinerDisplayName =
    args.joinerConfig?.displayName ??
    (args.matchType === "friend" ? "Friend" : `Player ${joinerPlayerId}`);

  // Joiner starts not ready (will be set ready when they join or for bot games)
  const joinerReady = false;

  const session: GameSession = {
    id,
    seriesId: id,
    rematchParentId: undefined,
    rematchNumber: 0,
    socketConnects: { total: 0, first: [] },
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    config: completeConfig,
    puzzleId: args.puzzleId,
    status: joinerReady ? "ready" : "waiting",
    matchType: args.matchType,
    cancelled: false,
    players: {
      host: {
        role: "host",
        playerId: hostPlayerId,
        token: hostToken,
        socketToken: hostSocketToken,
        displayName: resolveSeatName({
          authUserId: args.hostAuthUserId,
          requested: args.hostDisplayName,
          placeholder: `Player ${hostPlayerId}`,
        }),
        connected: false,
        ready: true,
        lastSeenAt: now,
        appearance: args.hostAppearance ?? {},
        authUserId: args.hostAuthUserId,
        anonymousId: args.hostAnonymousId,
        ratingAtStart: args.hostElo,
        elo: args.hostElo,
      },
      joiner: {
        role: "joiner",
        playerId: joinerPlayerId,
        token: guestToken,
        socketToken: guestSocketToken,
        displayName: joinerDisplayName,
        connected: false,
        ready: joinerReady,
        lastSeenAt: now,
        appearance: {},
        ratingAtStart: undefined,
        configType: joinerConfigType,
      },
    },
    matchScore: {
      host: 0,
      joiner: 0,
    },
    gameInstanceId: 0,
    lastScoredGameInstanceId: -1,
    gameState: createGameState(completeConfig),
    spectatorGuestNames: new Map(),
  };

  registerSession(session);

  return {
    session,
    hostToken,
    hostSocketToken,
  };
};

export const joinGameSession = (args: {
  id: string;
  displayName?: string;
  appearance?: PlayerAppearance;
  authUserId?: string; // Auth provider's user ID (for rating updates + seat ownership)
  elo?: number; // Looked up from DB by the route handler
  /** The joining browser's anonymous id, when it sent one. */
  anonymousId?: string;
}): JoinGameSessionResult => {
  const session = ensureSession(args.id);
  if (session.cancelled) {
    throw new Error("The game was aborted by the creator.");
  }

  const joiner = session.players.joiner;

  // Guests cannot take a seat in a rated game. Without this the game kept
  // advertising itself as rated while no rating could ever be applied.
  if (!joiner.ready && ratedSeatRequiresLogin(session, args.authUserId)) {
    throw new Error(RATED_REQUIRES_LOGIN_MESSAGE);
  }

  // Seat is available – assign it immediately.
  if (!joiner.ready) {
    joiner.ready = true;
    joiner.displayName = resolveSeatName({
      authUserId: args.authUserId,
      requested: args.displayName,
      placeholder: session.matchType === "friend" ? "Friend" : "Player 2",
      taken: namesInUse(session),
    });
    joiner.appearance = {
      ...joiner.appearance,
      ...args.appearance,
    };
    joiner.authUserId = args.authUserId;
    joiner.anonymousId = args.anonymousId;
    joiner.ratingAtStart = args.elo;
    joiner.elo = args.elo;
    joiner.lastSeenAt = Date.now();
    session.updatedAt = Date.now();
    session.status = session.players.host.ready ? "ready" : "waiting";
    return {
      kind: "player",
      session,
      player: joiner,
    };
  }

  // Seat already claimed. Allow reissue only if the authenticated user owns it.
  if (args.authUserId && joiner.authUserId === args.authUserId) {
    refreshSeatCredential(joiner);
    session.updatedAt = Date.now();
    return {
      kind: "player",
      session,
      player: joiner,
    };
  }

  return {
    kind: "spectator",
    session,
  };
};

export const markHostReady = (id: string): void => {
  const session = ensureSession(id);
  session.players.host.ready = true;
  session.updatedAt = Date.now();
  session.status = session.players.joiner.ready ? "ready" : "waiting";
};

export const getSessionSnapshot = (id: string): GameSnapshot => {
  const session = ensureSession(id);
  return {
    id: session.id,
    puzzleId: session.puzzleId,
    status: session.status,
    config: session.config,
    matchType: session.matchType,

    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    players: buildPlayerSummaries(session),
    matchScore: buildMatchScoreSnapshot(session),
  };
};

export const resolveSessionForToken = (args: {
  id: string;
  token: string;
}): { session: GameSession; player: SessionPlayer } | null => {
  const session = ensureSession(args.id);
  const player =
    session.players.host.token === args.token
      ? session.players.host
      : session.players.joiner.token === args.token
        ? session.players.joiner
        : null;
  if (!player) return null;
  player.lastSeenAt = Date.now();
  return { session, player };
};

export type SessionAccessResolution =
  | { kind: "not-found" }
  | { kind: "player"; session: GameSession; player: SessionPlayer }
  | { kind: "waiting"; session: GameSession; reason?: GameAccessWaitingReason }
  | { kind: "spectator"; session: GameSession }
  | { kind: "replay"; session: GameSession };

const resolveSeatConfigType = (
  player: SessionPlayer,
): GamePlayerSummary["configType"] => (player.botCompositeId ? "bot" : "human");

/**
 * For bots, check if the bot client is still connected; for humans, use the
 * session field. A bot client in disconnect grace reports NOT connected —
 * the game survives, but the seat should show the drop.
 */
const resolveSeatConnected = (player: SessionPlayer): boolean =>
  player.botCompositeId
    ? isBotClientConnected(player.botCompositeId)
    : player.connected;

/** The single place a session's seats are projected onto the wire contract. */
const buildPlayerSummaries = (session: GameSession): GamePlayerSummary[] =>
  [session.players.host, session.players.joiner].map(
    (player): GamePlayerSummary => ({
      role: player.role,
      playerId: player.playerId,
      displayName: player.displayName,
      connected: resolveSeatConnected(player),
      ready: player.ready,
      configType: resolveSeatConfigType(player),
      appearance: player.appearance,
      elo: player.elo,
      ratingAtStart: player.ratingAtStart,
    }),
  );

export const resolveGameAccess = (args: {
  id: string;
  token?: string;
  authUserId?: string;
}): SessionAccessResolution => {
  const session = sessions.get(args.id);
  if (!session) {
    return { kind: "not-found" };
  }

  const now = Date.now();

  const matchByToken = (): SessionPlayer | null => {
    if (!args.token) return null;
    if (session.players.host.token === args.token) {
      return session.players.host;
    }
    if (session.players.joiner.token === args.token) {
      return session.players.joiner;
    }
    return null;
  };

  const matchByAuth = (): SessionPlayer | null => {
    if (!args.authUserId) return null;
    if (session.players.host.authUserId === args.authUserId) {
      refreshSeatCredential(session.players.host);
      session.updatedAt = now;
      return session.players.host;
    }
    if (session.players.joiner.authUserId === args.authUserId) {
      refreshSeatCredential(session.players.joiner);
      session.updatedAt = now;
      return session.players.joiner;
    }
    return null;
  };

  const matchedPlayer = matchByToken() ?? matchByAuth();
  if (matchedPlayer) {
    matchedPlayer.lastSeenAt = now;
    return { kind: "player", session, player: matchedPlayer };
  }

  if (session.status === "waiting") {
    if (session.cancelled) {
      return { kind: "waiting", session, reason: "host-aborted" };
    }
    if (ratedSeatRequiresLogin(session, args.authUserId)) {
      return { kind: "waiting", session, reason: "rated-requires-login" };
    }
    return { kind: "waiting", session };
  }

  if (session.status === "completed") {
    return { kind: "replay", session };
  }

  return { kind: "spectator", session };
};

export const resolveSessionForSocketToken = (args: {
  id: string;
  socketToken: string;
}): { session: GameSession; player: SessionPlayer } | null => {
  const session = ensureSession(args.id);
  const player =
    session.players.host.socketToken === args.socketToken
      ? session.players.host
      : session.players.joiner.socketToken === args.socketToken
        ? session.players.joiner
        : null;
  if (!player) return null;
  return { session, player };
};

export const listSessions = (): GameSnapshot[] => {
  return [...sessions.values()].map((session) => ({
    id: session.id,
    puzzleId: session.puzzleId,
    status: session.status,
    config: session.config,
    matchType: session.matchType,

    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    players: buildPlayerSummaries(session),
    matchScore: buildMatchScoreSnapshot(session),
  }));
};

// List only matchmaking games that are waiting for players
export const listMatchmakingGames = (): GameSnapshot[] => {
  return [...sessions.values()]
    .filter(
      (session) =>
        session.matchType === "matchmaking" &&
        session.status === "waiting" &&
        !session.cancelled,
    )
    .map((session) => ({
      id: session.id,
      puzzleId: session.puzzleId,
      status: session.status,
      config: session.config,
      matchType: session.matchType,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      players: buildPlayerSummaries(session),
      matchScore: buildMatchScoreSnapshot(session),
    }));
};

// ============================================================================
// Spectator Tracking
// ============================================================================

const spectatorCounts = new Map<string, number>();

export const incrementSpectatorCount = (gameId: string): number => {
  const count = (spectatorCounts.get(gameId) ?? 0) + 1;
  spectatorCounts.set(gameId, count);
  return count;
};

export const decrementSpectatorCount = (gameId: string): number => {
  const count = Math.max(0, (spectatorCounts.get(gameId) ?? 1) - 1);
  if (count === 0) {
    spectatorCounts.delete(gameId);
  } else {
    spectatorCounts.set(gameId, count);
  }
  return count;
};

export const getSpectatorCount = (gameId: string): number => {
  return spectatorCounts.get(gameId) ?? 0;
};

// ============================================================================
// Spectator Names
// ============================================================================

/**
 * The name a spectator goes by, for as long as their connection lives.
 *
 * Players carry their name on their seat; a spectator has no seat, so the
 * session holds it for them, keyed by socket. Drawn from the same pool as seat
 * names and excluding everything already in use in this game, so a spectator
 * never shadows a player or another spectator.
 *
 * Assigned when the socket opens rather than when it first speaks, so a
 * spectator is somebody from the moment they arrive.
 */
export const assignSpectatorGuestName = (
  sessionId: string,
  socketId: string,
): string => {
  const session = ensureSession(sessionId);

  const existing = session.spectatorGuestNames.get(socketId);
  if (existing !== undefined) {
    return existing;
  }

  const name = pickGuestName(namesInUse(session));
  session.spectatorGuestNames.set(socketId, name);
  return name;
};

/**
 * Hands a spectator's name back when their socket closes.
 *
 * Names are handed out per connection, so without this a long-running game
 * would accumulate one entry for every spectator who ever passed through, and
 * exhaust the pool for the ones actually watching. A spectator who reconnects
 * arrives on a new socket and is simply named again.
 */
export const releaseSpectatorGuestName = (
  sessionId: string,
  socketId: string,
): void => {
  sessions.get(sessionId)?.spectatorGuestNames.delete(socketId);
};

// ============================================================================
// Live Games (In-Progress Games for Spectating)
// ============================================================================

/**
 * Lists all in-progress games for the live games page.
 * Returns games sorted by average ELO (descending), then by lastMoveAt (descending).
 */
const buildLiveGameSummary = (session: GameSession): LiveGameSummary => {
  const players = [session.players.host, session.players.joiner];
  const elos = players.map((p) => p.elo ?? 1500);
  const averageElo = Math.round((elos[0] + elos[1]) / 2);
  const status: LiveGameSummary["status"] =
    session.status === "ready" ? "ready" : "in-progress";

  return {
    id: session.id,
    variant: session.config.variant,
    randomStart: session.config.randomStart,
    rated: session.config.rated,
    timeControl: session.config.timeControl,
    boardWidth: session.config.boardWidth,
    boardHeight: session.config.boardHeight,
    players: players.map((p) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      elo: p.elo,
      role: p.role,
    })),
    status,
    moveCount: session.gameState.moveCount,
    averageElo,
    lastMoveAt: session.updatedAt,
    spectatorCount: getSpectatorCount(session.id),
  };
};

export const listLiveGames = (limit = 100): LiveGameSummary[] => {
  return [...sessions.values()]
    .filter(
      (session) =>
        (session.status === "ready" || session.status === "in-progress") &&
        !session.cancelled &&
        // Puzzle attempts are solo practice, not spectator content.
        session.puzzleId === undefined,
    )
    .map((session) => buildLiveGameSummary(session))
    .sort((a, b) => b.averageElo - a.averageElo || b.lastMoveAt - a.lastMoveAt)
    .slice(0, limit);
};

/**
 * Gets a single live game summary by ID.
 * Returns null if the game doesn't exist or is not in-progress.
 */
export const getLiveGameSummary = (gameId: string): LiveGameSummary | null => {
  const session = sessions.get(gameId);
  if (
    !session ||
    (session.status !== "ready" && session.status !== "in-progress") ||
    // Puzzle attempts are solo practice, not spectator content.
    session.puzzleId !== undefined
  ) {
    return null;
  }

  return buildLiveGameSummary(session);
};

const applyActionToSession = (
  session: GameSession,
  action: GameAction,
): GameState => {
  if (
    action.kind === "move" &&
    session.gameState.moveCount === 0 &&
    session.startedAt == null
  ) {
    session.startedAt = action.timestamp;
  }
  const next = session.gameState.applyGameAction(action);
  session.gameState = next;
  session.updatedAt = Date.now();
  // Everything that reaches here is the game moving on, which is exactly what a
  // pending takeback offer does not survive: `move`, and the four that end the
  // game outright (`resign`, `timeout`, `draw`, and an accepted `takeback`).
  // Note what does NOT reach here - `giveTime` adjusts a clock in place without
  // an action, so a gift of time leaves an outstanding offer standing, which is
  // the same answer the client reaches by watching the history length.
  //
  // Expiring here rather than at each call site is what stops a later action
  // kind from quietly leaving an offer alive behind it.
  session.pendingTakebackFrom = undefined;
  session.status = next.status === "finished" ? "completed" : "in-progress";
  if (next.status === "finished") {
    // Game ended - clear any pending timers
    clearTimeoutTimer(session.id);
    clearAbandonTimer(session.id);
    clearIdleTimer(session.id);
    finalizeMatchScore(session, next.result ?? null);
  } else {
    if (action.kind === "move") {
      // Move was made and game continues - schedule timeout for next player
      scheduleTimeoutTimer(session.id);
    }
    // Recomputed after every action that leaves the game running, not only a
    // move. The deadline comes from `lastMoveTime`, so this is idempotent and
    // cannot extend anybody's grace; asking unconditionally is what stops an
    // action kind added later - one that shifts the turn, say - from leaving a
    // deadline pointing at the wrong seat.
    //
    // `updateConnectionState` is the other arming site, since the policy now
    // covers a game nobody has moved in and stands down for a seat known to be
    // gone. Between them every state change this policy reads is covered.
    refreshIdleTimer(session.id);
  }
  return next;
};

export const applyPlayerMove = (args: {
  id: string;
  playerId: PlayerId;
  move: Move;
  timestamp: number;
}): GameState => {
  const session = ensureSession(args.id);
  if (session.gameState.status !== "playing") {
    throw new Error("Game has already finished");
  }

  // Check if the player's time has already expired before allowing the move
  // (skip for unlimited time control games)
  const state = session.gameState;
  if (state.moveCount > 0 && !isUnlimitedTimeControl(state.timeControl)) {
    const elapsedMs = args.timestamp - state.lastMoveTime;
    const currentTimeLeftMs = state.timeLeft[args.playerId] * 1000 - elapsedMs;
    if (currentTimeLeftMs <= TIMEOUT_FLOOR_MS) {
      // Player's time has expired - apply timeout instead of move
      return applyActionToSession(session, {
        kind: "timeout",
        playerId: args.playerId,
        timestamp: args.timestamp,
      });
    }
  }

  return applyActionToSession(session, {
    kind: "move",
    move: args.move,
    playerId: args.playerId,
    timestamp: args.timestamp,
  });
};

export const resignGame = (args: {
  id: string;
  playerId: PlayerId;
  timestamp: number;
}): GameState => {
  const session = ensureSession(args.id);
  if (session.gameState.status !== "playing") {
    return session.gameState;
  }
  return applyActionToSession(session, {
    kind: "resign",
    playerId: args.playerId,
    timestamp: args.timestamp,
  });
};

export const giveTime = (args: {
  id: string;
  playerId: PlayerId;
  seconds: number;
}): GameState => {
  const session = ensureSession(args.id);
  const state = session.gameState;

  if (state.status !== "playing") {
    return state;
  }

  const opponent: PlayerId = args.playerId === 1 ? 2 : 1;
  state.timeLeft[opponent] += args.seconds;

  session.updatedAt = Date.now();
  return state;
};

export const acceptDraw = (args: {
  id: string;
  playerId: PlayerId;
}): GameState => {
  const session = ensureSession(args.id);
  return applyActionToSession(session, {
    kind: "draw",
    playerId: args.playerId,
    timestamp: Date.now(),
  });
};

export const rejectDraw = (args: { id: string; playerId: PlayerId }): void => {
  // This is handled in the WebSocket layer for broadcasting
  // The function exists for API consistency
  console.info("Draw rejected", {
    sessionId: args.id,
    playerId: args.playerId,
  });
};

/**
 * Records that a player has asked to retake their last turn.
 *
 * The bot path calls this immediately before accepting on the bot's behalf. A
 * bot answers in the same breath, so nothing can expire in between - but it
 * still goes through the offer, so there is one way in and no second path that
 * skips the check.
 */
export const offerTakeback = (args: {
  id: string;
  playerId: PlayerId;
}): void => {
  ensureSession(args.id).pendingTakebackFrom = args.playerId;
};

/**
 * Answers a takeback offer, if there is still one to answer.
 *
 * Returns null when there is not: no offer, an offer the game has moved past,
 * or an offer the accepter made themselves. Returning rather than throwing is
 * deliberate - a stale accept is a normal thing for a client to send, not an
 * error, and the caller has nothing to tell the board about it.
 */
export const acceptTakeback = (args: {
  id: string;
  playerId: PlayerId;
}): GameState | null => {
  const session = ensureSession(args.id);
  if (
    session.pendingTakebackFrom === undefined ||
    session.pendingTakebackFrom === args.playerId
  ) {
    return null;
  }
  return applyActionToSession(session, {
    kind: "takeback",
    playerId: args.playerId,
    timestamp: Date.now(),
  });
};

export const rejectTakeback = (args: {
  id: string;
  playerId: PlayerId;
}): void => {
  // Broadcasting is the WebSocket layer's job; retiring the offer is this one's,
  // so a declined offer cannot be accepted afterwards.
  ensureSession(args.id).pendingTakebackFrom = undefined;
  console.info("Takeback rejected", {
    sessionId: args.id,
    playerId: args.playerId,
  });
};

export const serializeGameState = (
  session: GameSession,
): SerializedGameState => {
  const state = session.gameState;
  const historyRows = state.config.boardHeight;
  console.info("[debug-serialize] walls", {
    sessionId: session.id,
    walls: state.grid.getWalls(),
  });
  return {
    status: state.status,
    result: state.result,
    turn: state.turn,
    moveCount: state.moveCount,
    timeLeft: { ...state.timeLeft },
    lastMoveTime: state.lastMoveTime,
    pawns: clonePawns(state.pawns),
    walls: state.grid.getWalls(),
    initialState: state.getInitialState(),
    history: state.history.map((entry) => ({
      index: entry.index,
      notation: moveToStandardNotation(entry.move, historyRows),
    })),
    config: {
      boardWidth: state.config.boardWidth,
      boardHeight: state.config.boardHeight,
      variant: state.config.variant,
      randomStart: state.config.randomStart,
      rated: session.config.rated,
      timeControl: session.config.timeControl,
      variantConfig: state.config.variantConfig,
    },
  };
};

export const getSerializedState = (id: string): SerializedGameState => {
  const session = ensureSession(id);
  return serializeGameState(session);
};

export interface RematchSessionResult {
  newSession: GameSession;
  seatCredentials: {
    host: RematchSeatCredentials;
    joiner: RematchSeatCredentials;
  };
}

export const createRematchSession = (
  previousSessionId: string,
): RematchSessionResult => {
  const previous = ensureSession(previousSessionId);

  if (previous.gameState.status !== "finished") {
    throw new Error("Cannot start a rematch before the game is finished.");
  }

  if (previous.nextGameId) {
    throw new Error("Rematch already started for this game.");
  }

  const now = Date.now();
  const newId = nanoid(8);
  const hostCredentials: RematchSeatCredentials = {
    token: nanoid(),
    socketToken: nanoid(),
  };
  const joinerCredentials: RematchSeatCredentials = {
    token: nanoid(),
    socketToken: nanoid(),
  };
  // Random Start is deliberately randomized, so every rematch gets a brand-new
  // starting position rather than replaying the previous one from the other
  // side: drop the layout and let `createGameState` generate a fresh one.
  const newRematchNumber = previous.rematchNumber + 1;
  let configForNewGame: PartialGameConfiguration = previous.config;
  if (previous.config.randomStart) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { variantConfig, ...rest } = previous.config;
    configForNewGame = rest;
  }

  // Build the state first so the session records the config the game is actually
  // played with: for Random Start `configForNewGame` has no variantConfig and
  // `createGameState` generates one, which the session must then carry so the
  // players, spectators and replay all see the board that was actually played.
  const gameState = createGameState(configForNewGame);

  // Swap player IDs so the other player goes first in the rematch
  const hostPlayerId = previous.players.host.playerId;
  const joinerPlayerId = previous.players.joiner.playerId;

  // NOTE: `puzzleId` is deliberately NOT carried over (S-ID). A rematch swaps
  // seats and starts a different game, so crediting it as a solve of the
  // original puzzle would be wrong — and the server accepts a rematch offer
  // even where the UI suppresses one for puzzles.
  const newSession: GameSession = {
    id: newId,
    seriesId: previous.seriesId ?? previous.id,
    rematchParentId: previous.id,
    rematchNumber: newRematchNumber,
    // A rematch is its own game with its own sockets: the parent's connect
    // history describes the parent, and carrying it would misreport this one.
    socketConnects: { total: 0, first: [] },
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    config: gameState.config,
    status: "ready",
    matchType: previous.matchType,
    cancelled: false,
    players: {
      host: {
        ...previous.players.host,
        playerId: joinerPlayerId,
        token: hostCredentials.token,
        socketToken: hostCredentials.socketToken,
        connected: false,
        ready: true,
        lastSeenAt: now,
        ratingAtStart: previous.players.host.elo,
      },
      joiner: {
        ...previous.players.joiner,
        playerId: hostPlayerId,
        token: joinerCredentials.token,
        socketToken: joinerCredentials.socketToken,
        connected: false,
        ready: true,
        lastSeenAt: now,
        ratingAtStart: previous.players.joiner.elo,
      },
    },
    matchScore: {
      host: previous.matchScore.host,
      joiner: previous.matchScore.joiner,
    },
    gameInstanceId: 0,
    lastScoredGameInstanceId: -1,
    gameState,
    // Seat names ride along on the spread seats above, so a guest keeps their
    // animal across the rematch. Spectator names deliberately do not: they are
    // keyed by socket, and the rematch is a new game with new connections.
    spectatorGuestNames: new Map(),
  };

  registerSession(newSession);
  previous.nextGameId = newId;
  previous.nextGameSeatCredentials = {
    host: hostCredentials,
    joiner: joinerCredentials,
  };
  previous.updatedAt = now;

  return {
    newSession,
    seatCredentials: {
      host: hostCredentials,
      joiner: joinerCredentials,
    },
  };
};

export const updateConnectionState = (args: {
  id: string;
  socketToken: string;
  connected: boolean;
}): void => {
  const session = ensureSession(args.id);
  const player =
    session.players.host.socketToken === args.socketToken
      ? session.players.host
      : session.players.joiner.socketToken === args.socketToken
        ? session.players.joiner
        : null;
  if (!player) {
    console.warn(
      "[sessions] updateConnectionState skipped for unknown socket",
      {
        sessionId: args.id,
        socketToken: args.socketToken,
        connected: args.connected,
      },
    );
    return;
  }
  player.connected = args.connected;
  player.lastSeenAt = Date.now();
  session.updatedAt = Date.now();
  // A game whose player walked away has to end itself. Without a clock there is
  // nothing else that ever would, and it holds an engine session while it sits.
  refreshAbandonTimer(session.id);
  // The idle timer stands down while a seat is known to be gone, so a
  // connection change is when it may need to take the game back - or hand it
  // over. The deadline comes from `lastMoveTime`, so re-arming can never
  // extend anybody's grace.
  refreshIdleTimer(session.id);
};

/**
 * Processes rating updates after a game ends.
 * Returns the new rating values if ratings were updated, or undefined otherwise.
 *
 * Rating updates only happen for rated games where both players are authenticated.
 */
export const processRatingUpdate = async (
  id: string,
): Promise<{ player1NewElo: number; player2NewElo: number } | undefined> => {
  const session = ensureSession(id);
  const gameState = session.gameState;

  // Only process if game is finished
  if (gameState.status !== "finished") {
    return undefined;
  }

  // Only process rated games
  if (!session.config.rated) {
    return undefined;
  }

  // Get player info - find which player is which by playerId
  const player1 =
    session.players.host.playerId === 1
      ? session.players.host
      : session.players.joiner;
  const player2 =
    session.players.host.playerId === 2
      ? session.players.host
      : session.players.joiner;

  // Both players must be authenticated for rating updates
  if (!player1.authUserId || !player2.authUserId) {
    console.info("[ratings] Skipping update - not all players authenticated", {
      sessionId: id,
      player1Auth: !!player1.authUserId,
      player2Auth: !!player2.authUserId,
    });
    return undefined;
  }

  const variant = session.config.variant;
  const timeControl = session.config.timeControl.preset ?? "rapid";

  // The old ratings used to be read here, before the write. They are now read
  // inside the transaction and returned, because a value fetched out here is
  // not the one the update was computed from - with two games finishing at once
  // the log would report a transition that never happened.

  // Determine outcome from game result
  const result = gameState.result;
  if (!result) {
    console.warn("[ratings] Game finished but no result found", {
      sessionId: id,
    });
    return undefined;
  }

  // Aborted games are not games. Rating them here while persistence threw them
  // away is what let a rated game move both players' ratings and win/loss
  // records without ever appearing in past games.
  //
  // BOTH HALVES OF THE PERSISTENCE GATE, because one of them was missing and
  // the pair had drifted apart. `persistCompletedGame` skips on the move count
  // AND on an uncounted result; this asked only the second. They agree only
  // while "too few moves" implies "aborted", which resign, timeout and draw
  // guarantee - they share one `isAbort` in game-state.ts - and which the WIN
  // conditions inside `applyMove` do not: they set the move count and then
  // return a counted result with no such test, so a game can end on ply 1 with
  // {reason: "capture"} or {reason: "survival"}. Measured 2026-08-16: such a
  // game was skipped by persistence and accepted here, which is a rating with
  // no record behind it - the same failure the paragraph above describes,
  // through the door the fix for it did not close.
  //
  // Derived from MIN_MOVES_FOR_A_COUNTED_GAME rather than written out, as
  // game-utils.ts requires of every consumer of the threshold.
  if (
    endedBeforeBothPlayersMoved(gameState.moveCount) ||
    !isCountedResult(result)
  ) {
    console.info("[ratings] Skipping update - game does not count", {
      sessionId: id,
      moveCount: gameState.moveCount,
      reason: result.reason,
    });
    return undefined;
  }

  let outcomeForPlayer1: Outcome;
  if (result.winner === 1) {
    outcomeForPlayer1 = Outcome.Win;
  } else if (result.winner === 2) {
    outcomeForPlayer1 = Outcome.Loss;
  } else {
    outcomeForPlayer1 = Outcome.Tie;
  }
  /*
  One transaction does the whole thing: the per-variant chain, the global chain,
  and the ledger row that stops the same game being rated twice.

  This used to read both states here and then fire two independent upserts in a
  `Promise.all`, which could half-apply a game, and nothing anywhere recorded
  that a game had been rated - `status === "finished"` stays true forever, so a
  timeout racing a resignation would count the same result twice. Both are
  handled inside applyRatingsForFinishedGame; see server/db/rating-write.ts.
  */
  const applied = await applyRatingsForFinishedGame({
    gameId: id,
    authUserIdA: player1.authUserId,
    authUserIdB: player2.authUserId,
    variant,
    timeControl,
    outcomeForA: outcomeForPlayer1,
  });

  if (!applied) {
    // Already rated, or a player is not a known user. Either way nothing moved,
    // so report no change rather than a rating the database does not hold.
    return undefined;
  }

  console.info("[ratings] Updated ratings", {
    sessionId: id,
    player1: {
      authUserId: player1.authUserId,
      oldRating: applied.oldBucketA,
      newRating: applied.bucketA,
      newGlobalRating: applied.globalA,
    },
    player2: {
      authUserId: player2.authUserId,
      oldRating: applied.oldBucketB,
      newRating: applied.bucketB,
      newGlobalRating: applied.globalB,
    },
    outcome: outcomeForPlayer1,
  });

  // Update the session's ELO values so match-status reflects the new ratings.
  // The GLOBAL chain, matching what the seat was given when the game started:
  // the seat's `ratingAtStart` is a global rating, so handing it a per-variant
  // one here would make the change shown at the end of the game a difference
  // between two different ratings.
  player1.elo = applied.globalA;
  player2.elo = applied.globalB;

  return {
    player1NewElo: applied.globalA,
    player2NewElo: applied.globalB,
  };
};

export const cancelGameSession = (args: {
  id: string;
  token?: string;
}): GameSession => {
  const session = ensureSession(args.id);
  if (session.cancelled) {
    return session;
  }
  const hostToken = session.players.host.token;
  if (hostToken !== args.token) {
    throw new Error("Only the host can abort this game.");
  }
  session.cancelled = true;
  session.updatedAt = Date.now();
  return session;
};
