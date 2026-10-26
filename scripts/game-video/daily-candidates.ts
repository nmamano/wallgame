/**
 * Which finished games can be the daily video, and where each one turns.
 *
 * Board task e8d26610. Pure functions only: no database, no engine, no
 * network. `pick-daily-candidates.ts` feeds them stored rows; the tests feed
 * them fixtures.
 *
 * ELIGIBILITY (Nil, 2026-10-25). Every seat must be a guest, an official bot
 * or Nil's own account. One seat held by any other signed-in member, or by a
 * bot that is not official, takes the whole game out. Every variant is in.
 * Puzzle attempts are out: they start from an authored position and are a
 * solve, not a game. Fewer than MIN_PLIES moves is out: see the constant.
 *
 * THE SIGNAL IS THE RACE A VIEWER CAN SEE (Nil, 2026-10-26: the engine's
 * swings put the effects on moves no human would notice). Each player's
 * distance is the shortest walk, through today's walls, of any of their
 * hunters to its target, read from the variant's capture relations: a cat to
 * the opponent's mouse in Standard, a cat to its own home in Classic, both
 * hunters in Animal Cycle. The RACE from one side is the opponent's distance
 * minus that side's own. A JUMP is the change in the mover's race across one
 * move, so a wall that makes the opponent walk around it scores high, and so
 * does a mover who walls in their own hunter (negative).
 *
 * A turn has two actions, and one step of a pawn changes each relation that
 * names the pawn, as hunter or as target, by at most 1. So a move with no
 * wall changes the race by at most 2 x (the most relations any one pawn is
 * in): 2 in Standard, Classic and Survival, where every ordinary advance
 * scores +2, and 4 in Animal Cycle, where each pawn hunts and is hunted. Only
 * a jump above that bound is a pick (minJumpFor), or the effects would land on
 * ordinary moves again.
 *
 * The engine's evaluation (swingsOf below) is kept as a debug column only.
 */
import { classifyPastGamePlayer } from "../../server/db/past-game-player-kind";
import { botCapabilityVariant } from "../../shared/domain/bot-capability";
import { GameState } from "../../shared/domain/game-state";
import type {
  GameConfiguration,
  GameInitialState,
  PlayerId,
  Variant,
} from "../../shared/domain/game-types";
import { timeControlConfigFromPreset } from "../../shared/domain/game-utils";
import { pawnCell } from "../../shared/domain/pawns";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import {
  executableRulesFor,
  resolveRulePlayer,
} from "../../shared/domain/variant-rules";
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

/** How many picks (effect plies) each candidate reports. */
export const PICKS_PER_GAME = 3;

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

/* ------------------------------------------------- engine (debug column) -- */

/*
 * The evaluation bar's number: the MCTS root value the BGS engine returns, in
 * [-1, +1], from player 1's side (bgs_session.cpp negates it when player 2 is
 * to move). A swing is the change in the mover's win chance (value + 1) / 2
 * across one move. Only `--engine` runs read it.
 */

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

/* ------------------------------------------------------------- distances -- */

/** Each player's shortest hunter walk; null when the player hunts nothing. */
export type RaceDistances = Record<PlayerId, number | null>;

const other = (player: PlayerId): PlayerId => (player === 1 ? 2 : 1);

/** Distances in one position, from the variant's capture relations. */
export const raceDistances = (state: GameState): RaceDistances => {
  const rules = executableRulesFor(state.config.variant);
  const forPlayer = (player: PlayerId): number | null => {
    let best: number | null = null;
    for (const relation of rules.captureRelations) {
      if (resolveRulePlayer(relation.hunter.player, player) !== player)
        continue;
      const hunter = pawnCell(state.pawns, player, relation.hunter.type);
      const target = pawnCell(
        state.pawns,
        resolveRulePlayer(relation.target.player, player),
        relation.target.type,
      );
      if (!hunter || !target) continue;
      const walk = state.grid.distance(hunter, target);
      if (walk < 0) throw new Error("a hunter cannot reach its target");
      best = best === null ? walk : Math.min(best, walk);
    }
    return best;
  };
  return { 1: forPlayer(1), 2: forPlayer(2) };
};

/**
 * The smallest jump that is a pick: one more than any move without a wall can
 * make. Read from the capture relations (see the header): each relation is
 * resolved for both players and counted once, then the pawn named by the most
 * relations sets the bound.
 */
export const minJumpFor = (variant: Variant): number => {
  const instances = new Set<string>();
  for (const relation of executableRulesFor(variant).captureRelations) {
    for (const player of [1, 2] as const) {
      const hunter = `${resolveRulePlayer(relation.hunter.player, player)}:${relation.hunter.type}`;
      const target = `${resolveRulePlayer(relation.target.player, player)}:${relation.target.type}`;
      instances.add(`${hunter}>${target}`);
    }
  }
  const perPawn = new Map<string, number>();
  for (const instance of instances) {
    for (const pawn of instance.split(">")) {
      perPawn.set(pawn, (perPawn.get(pawn) ?? 0) + 1);
    }
  }
  return 2 * Math.max(...perPawn.values()) + 1;
};

/** The race from `side`: opponent's walk minus own. A missing walk counts 0. */
export const raceFor = (d: RaceDistances, side: PlayerId): number =>
  (d[other(side)] ?? 0) - (d[side] ?? 0);

export interface ReplayableGame {
  variant: string;
  boardWidth: number;
  boardHeight: number;
  initialState: GameInitialState;
  moves: string[];
}

/**
 * Replays a stored game through today's GameState, the way the replay page
 * assembles one (assembleReplayGame in server/db/game-queries.ts), and returns
 * who made each move and the distances before each move and after the last.
 * The mover comes from the state, not parity: a custom setup can start with
 * player 2.
 */
export const replayDistances = (
  game: ReplayableGame,
): { movers: PlayerId[]; distances: RaceDistances[] } => {
  const config: GameConfiguration = {
    variant: game.variant as Variant,
    randomStart: false,
    // A replay reads no clock; any preset gives the same moves.
    timeControl: timeControlConfigFromPreset("rapid"),
    rated: false,
    boardWidth: game.boardWidth,
    boardHeight: game.boardHeight,
    variantConfig: game.initialState,
  };
  let state = new GameState(config, 0, { allowStoredHistoryBacktracks: true });
  const movers: PlayerId[] = [];
  const distances = [raceDistances(state)];
  game.moves.forEach((notation, index) => {
    const playerId = state.turn;
    state = state.applyGameAction({
      kind: "move",
      move: moveFromStandardNotation(notation, game.boardHeight),
      playerId,
      timestamp: index,
    });
    movers.push(playerId);
    distances.push(raceDistances(state));
  });
  return { movers, distances };
};

export interface DistanceJump {
  /** 0-based index into the stored move list. */
  ply: number;
  /** 1-based, as the replay page counts moves. */
  moveNumber: number;
  mover: PlayerId;
  notation: string;
  /** The mover's own walk and the opponent's walk, before and after. */
  ownBefore: number | null;
  ownAfter: number | null;
  opponentBefore: number | null;
  opponentAfter: number | null;
  /** Change in the mover's race: positive helps the mover. */
  jump: number;
  size: number;
}

/** Every move's jump, in move order. `distances` has one more entry. */
export const jumpsOf = (
  distances: RaceDistances[],
  moves: string[],
  movers: PlayerId[],
): DistanceJump[] => {
  if (distances.length !== moves.length + 1 || movers.length !== moves.length) {
    throw new Error(
      `need ${moves.length + 1} distances and ${moves.length} movers, got ${distances.length} and ${movers.length}`,
    );
  }
  return moves.map((notation, ply): DistanceJump => {
    const mover = movers[ply];
    const before = distances[ply];
    const after = distances[ply + 1];
    const jump = raceFor(after, mover) - raceFor(before, mover);
    return {
      ply,
      moveNumber: ply + 1,
      mover,
      notation,
      ownBefore: before[mover],
      ownAfter: after[mover],
      opponentBefore: before[other(mover)],
      opponentAfter: after[other(mover)],
      jump,
      size: Math.abs(jump),
    };
  });
};

/**
 * The effect plies: the largest jumps of at least `minJump`, at most
 * PICKS_PER_GAME, never two next to each other (a wall and the reply that
 * walks around it are one moment). Largest first; earlier first on a tie.
 */
export const pickJumps = (
  jumps: DistanceJump[],
  minJump: number,
): DistanceJump[] => {
  const picks: DistanceJump[] = [];
  const ordered = jumps
    .filter((j) => j.size >= minJump)
    .sort((a, b) => b.size - a.size || a.ply - b.ply);
  for (const jump of ordered) {
    if (picks.length === PICKS_PER_GAME) break;
    if (picks.some((p) => Math.abs(p.ply - jump.ply) <= 1)) continue;
    picks.push(jump);
  }
  return picks;
};

/** A pick with its plain line; what the CLI writes in `picks`. */
export type PickedJump = DistanceJump & { description: string };

const squares = (n: number) => `${n} extra square${n === 1 ? "" : "s"}`;

/**
 * What a viewer sees at a pick, in one plain line, for the crew to turn into
 * a caption (Wall Game PM, 2026-10-26). `names` maps each player to the name
 * on their seat. It tells the larger of the two walk changes: the opponent's
 * (a wall in their way, or a step that brings them closer) or the mover's own.
 */
export const describeJump = (
  pick: DistanceJump,
  names: Record<PlayerId, string>,
): string => {
  const mover = names[pick.mover];
  const opponent = names[other(pick.mover)];
  const walls = pick.notation
    .split(".")
    .filter((a) => a.startsWith(">") || a.startsWith("^")).length;
  const by = walls === 0 ? "move" : walls === 1 ? "wall" : "walls";
  const verb = walls > 1 ? "make" : "makes";
  const opponentChange = (pick.opponentAfter ?? 0) - (pick.opponentBefore ?? 0);
  const ownChange = (pick.ownAfter ?? 0) - (pick.ownBefore ?? 0);
  if (Math.abs(opponentChange) >= Math.abs(ownChange)) {
    return opponentChange > 0
      ? `${mover}'s ${by} ${verb} ${opponent} walk ${squares(opponentChange)} (${pick.opponentBefore} to ${pick.opponentAfter}).`
      : `${mover}'s ${by} ${verb} ${opponent}'s walk ${-opponentChange} square${opponentChange === -1 ? "" : "s"} shorter (${pick.opponentBefore} to ${pick.opponentAfter}).`;
  }
  return ownChange > 0
    ? `${mover}'s own ${by} ${verb} ${mover} walk ${squares(ownChange)} (${pick.ownBefore} to ${pick.ownAfter}).`
    : `${mover}'s ${by} cuts ${mover}'s own walk by ${-ownChange} (${pick.ownBefore} to ${pick.ownAfter}).`;
};

export interface RankedCandidate {
  gameId: string;
  picks: { size: number }[];
}

/** Largest pick first; then the second and third, then the game id. */
export const rankCandidates = <T extends RankedCandidate>(
  candidates: T[],
): T[] =>
  [...candidates].sort((a, b) => {
    for (let i = 0; i < PICKS_PER_GAME; i++) {
      const diff = (b.picks[i]?.size ?? 0) - (a.picks[i]?.size ?? 0);
      if (diff !== 0) return diff;
    }
    return a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0;
  });
