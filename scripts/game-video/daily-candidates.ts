/**
 * Which finished games can be the daily video, and where each one turns.
 *
 * Board task e8d26610, step 1. Pure functions only: no database, no engine,
 * no network. `pick-daily-candidates.ts` feeds them stored rows and engine
 * readings; the tests feed them fixtures.
 *
 * ELIGIBILITY (Nil, 2026-10-25). Every seat must be a guest, an official bot
 * or Nil's own account. One seat held by any other signed-in member, or by a
 * bot that is not official, takes the whole game out. Every variant is in.
 * Puzzle attempts are out: they start from an authored position and are a
 * solve, not a game. Fewer than MIN_PLIES moves is out: see the constant.
 *
 * THE SCORE is the evaluation bar's own number: the MCTS root value the BGS
 * engine returns, in [-1, +1], from player 1's side (bgs_session.cpp negates
 * it when player 2 is to move). The bar draws (value + 1) / 2 as player 1's
 * share, and that is the win chance used here.
 *
 * A SWING is the change in the MOVER's win chance across one move: the
 * position before the move against the position after it. The mover's side,
 * not a fixed side, because "this move threw the game away" and "this move
 * won it" are statements about the player who made the move, and a fixed side
 * would print the same blunder as +40 for one seat and -40 for the other. The
 * size of a swing is its absolute value, so a blunder and a brilliant move
 * rank on one scale; the sign says which it was.
 */
import { classifyPastGamePlayer } from "../../server/db/past-game-player-kind";
import { botCapabilityVariant } from "../../shared/domain/bot-capability";
import type { PlayerId, Variant } from "../../shared/domain/game-types";
import type { ConfigFile } from "../../official-custom-bot-client/src/config-schema";

/** Nil's user id on wallgame.io (users.user_id, display name "nil"). */
export const NIL_USER_ID = 1;

/**
 * A game needs at least this many plies (one ply = one player's full turn).
 * Ten plies is five turns each: below that, a stored game is almost always an
 * early resignation or a misclick, and there is too little play for a swing to
 * mean anything or for a short video to tell a story.
 */
export const MIN_PLIES = 10;

/**
 * Endings that take a game out (Wall Game PM, 2026-10-26): a game won on the
 * clock has no turning point on the board to show. Abandonment cannot be
 * listed: the server ends an abandoned game with resignGame
 * (applyAbandonToSession in server/games/store.ts), so it is stored as
 * "resignation", the same as a real one.
 */
export const EXCLUDED_ENDINGS: readonly string[] = ["timeout"];

/** How many swings each candidate reports. */
export const SWINGS_PER_GAME = 3;

/** One row of game_players, joined with built_in_bots.is_official. */
export interface StoredSeat {
  playerOrder: number;
  playerConfigType: string;
  displayName: string;
  userId: number | null;
  botId: string | null;
  /** NULL when the seat has no bot. */
  botIsOfficial: boolean | null;
  outcomeRank: number;
  outcomeReason: string;
}

export interface StoredGameSummary {
  gameId: string;
  variant: string;
  boardWidth: number;
  boardHeight: number;
  movesCount: number;
  puzzleId: string | null;
  seats: StoredSeat[];
}

export type SeatKind = "guest" | "nil" | "official bot";

export type SeatVerdict =
  | { ok: true; kind: SeatKind }
  | { ok: false; reason: string };

export type GameVerdict =
  | { eligible: true; seatKinds: SeatKind[] }
  | { eligible: false; reason: string };

/**
 * Classifies one seat. Guest, member and bot come from the Past Games
 * classifier, so the two surfaces cannot disagree about what a guest is.
 */
export const classifySeat = (seat: StoredSeat): SeatVerdict => {
  const kind = classifyPastGamePlayer(seat.playerConfigType, seat.userId);
  if (kind === "guest") return { ok: true, kind: "guest" };
  if (kind === "member") {
    return seat.userId === NIL_USER_ID
      ? { ok: true, kind: "nil" }
      : { ok: false, reason: "signed-in member seat" };
  }
  return seat.botIsOfficial === true
    ? { ok: true, kind: "official bot" }
    : { ok: false, reason: `non-official bot seat (${seat.botId ?? "no id"})` };
};

export const gameEligibility = (game: StoredGameSummary): GameVerdict => {
  if (game.puzzleId !== null) {
    return { eligible: false, reason: "puzzle attempt" };
  }
  if (game.movesCount < MIN_PLIES) {
    return {
      eligible: false,
      reason: `${game.movesCount} plies, below ${MIN_PLIES}`,
    };
  }
  const ending = game.seats.find((s) =>
    EXCLUDED_ENDINGS.includes(s.outcomeReason),
  );
  if (ending) {
    return { eligible: false, reason: `ended by ${ending.outcomeReason}` };
  }
  if (game.seats.length !== 2) {
    return { eligible: false, reason: `${game.seats.length} seats, not 2` };
  }
  const seatKinds: SeatKind[] = [];
  for (const seat of [...game.seats].sort(
    (a, b) => a.playerOrder - b.playerOrder,
  )) {
    const verdict = classifySeat(seat);
    if (!verdict.ok) return { eligible: false, reason: verdict.reason };
    seatKinds.push(verdict.kind);
  }
  return { eligible: true, seatKinds };
};

/**
 * The engine command the evaluation bar uses for a stored game of this shape,
 * read from the bot-client config the way `findEvalBot`
 * (server/games/custom-bot-store.ts) matches a connected bot: the first
 * official analysis bot with placement "opponent" whose declared range covers
 * the board. Null means
 * the site shows no bar for this game (Survival, or an unsupported size).
 */
export const evalBarEngineFor = (
  config: ConfigFile,
  variant: Variant,
  boardWidth: number,
  boardHeight: number,
): { botId: string; command: string } | null => {
  if (variant === "survival") return null;
  const rules = botCapabilityVariant(variant, false);
  for (const bot of config.bots) {
    // The server's isAnalysisBot is official && analysis, and a config bot is
    // official unless it says `official: false` (custom-bot-store.ts:193).
    if (bot.analysis !== true || bot.official === false) continue;
    if ((bot.placement ?? "opponent") !== "opponent") continue;
    const range = bot.variants[rules];
    if (!range) continue;
    if (boardWidth < range.boardWidth.min || boardWidth > range.boardWidth.max)
      continue;
    if (
      boardHeight < range.boardHeight.min ||
      boardHeight > range.boardHeight.max
    )
      continue;
    const command = config.engineCommands[bot.botId];
    if (!command) continue;
    return { botId: bot.botId, command };
  }
  return null;
};

/** Win chance in [0, 1] for `side`, from an evaluation-bar value. */
export const winChance = (evaluationP1: number, side: PlayerId): number => {
  const clamped = Math.max(-1, Math.min(1, evaluationP1));
  const forSide = side === 1 ? clamped : -clamped;
  return (forSide + 1) / 2;
};

export interface Swing {
  /** 0-based index into the stored move list. */
  ply: number;
  /** 1-based, as the replay page counts moves. */
  moveNumber: number;
  mover: PlayerId;
  notation: string;
  evaluationBeforeP1: number;
  evaluationAfterP1: number;
  /** The mover's win chance before and after the move, in [0, 1]. */
  moverBefore: number;
  moverAfter: number;
  /** moverAfter - moverBefore: negative is a blunder, positive a good move. */
  delta: number;
  size: number;
}

/**
 * Every move's swing, largest first. `evaluationsP1[k]` scores the position
 * before move k, so it has one more entry than `moves`; `movers[k]` is the
 * player who made move k.
 */
export const swingsOf = (
  evaluationsP1: number[],
  moves: string[],
  movers: PlayerId[],
): Swing[] => {
  if (evaluationsP1.length !== moves.length + 1) {
    throw new Error(
      `need ${moves.length + 1} evaluations for ${moves.length} moves, got ${evaluationsP1.length}`,
    );
  }
  if (movers.length !== moves.length) {
    throw new Error(`need ${moves.length} movers, got ${movers.length}`);
  }
  const swings = moves.map((notation, ply): Swing => {
    const mover = movers[ply];
    const moverBefore = winChance(evaluationsP1[ply], mover);
    const moverAfter = winChance(evaluationsP1[ply + 1], mover);
    const delta = moverAfter - moverBefore;
    return {
      ply,
      moveNumber: ply + 1,
      mover,
      notation,
      evaluationBeforeP1: evaluationsP1[ply],
      evaluationAfterP1: evaluationsP1[ply + 1],
      moverBefore,
      moverAfter,
      delta,
      size: Math.abs(delta),
    };
  });
  // Earlier move first on a tie, so the order never depends on the sort.
  return swings.sort((a, b) => b.size - a.size || a.ply - b.ply);
};

export interface RankedCandidate {
  gameId: string;
  topSwings: Swing[];
}

/** Largest swing first; then the second swing, then the game id. */
export const rankCandidates = <T extends RankedCandidate>(
  candidates: T[],
): T[] =>
  [...candidates].sort((a, b) => {
    for (let i = 0; i < SWINGS_PER_GAME; i++) {
      const diff = (b.topSwings[i]?.size ?? 0) - (a.topSwings[i]?.size ?? 0);
      if (diff !== 0) return diff;
    }
    return a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0;
  });
