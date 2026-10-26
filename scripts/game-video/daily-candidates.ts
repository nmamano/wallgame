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
 * AI VS HUMAN ONLY (Nil, 2026-10-26, through Wall Game PM): exactly one seat
 * is an official bot, so the other is a guest or Nil; bot vs bot and human vs
 * human are out.
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
  Cell,
  GameConfiguration,
  GameInitialState,
  GamePawns,
  PawnType,
  PlayerId,
  Variant,
  WallPosition,
} from "../../shared/domain/game-types";
import type { Grid } from "../../shared/domain/grid";
import { timeControlConfigFromPreset } from "../../shared/domain/game-utils";
import {
  boardPawns,
  pawnCell,
  requirePawnCell,
} from "../../shared/domain/pawns";
import {
  cellToStandardNotation,
  moveFromStandardNotation,
  wallToStandardNotation,
} from "../../shared/domain/standard-notation";
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
  const bots = seatKinds.filter((kind) => kind === "official bot").length;
  if (bots === 0) return { eligible: false, reason: "human vs human" };
  if (bots === 2) return { eligible: false, reason: "bot vs bot" };
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

/** Distances in one position, from the variant's hunts. */
export const raceDistances = (state: GameState): RaceDistances =>
  raceFromWalks(huntsFor(state.config.variant), huntWalks(state));

/** Each hunt's walk in one position, in huntsFor order. */
const huntWalks = (state: GameState): number[] =>
  walksOn(huntsFor(state.config.variant), state.grid, state.pawns);

/** Each hunt's walk through `grid`, with the pawns at `pawns`. */
const walksOn = (hunts: Hunt[], grid: Grid, pawns: GamePawns): number[] =>
  hunts.map((hunt) => {
    const hunter = pawnCell(pawns, hunt.hunter.player, hunt.hunter.type);
    const target = pawnCell(pawns, hunt.target.player, hunt.target.type);
    if (!hunter || !target) throw new Error("a hunt names a missing pawn");
    const walk = grid.distance(hunter, target);
    if (walk < 0) throw new Error("a hunter cannot reach its target");
    return walk;
  });

/** Each player's shortest walk over their own hunts. */
const raceFromWalks = (hunts: Hunt[], walks: number[]): RaceDistances => {
  const best = (player: PlayerId): number | null => {
    const own = walks.filter((_, i) => hunts[i].hunter.player === player);
    return own.length === 0 ? null : Math.min(...own);
  };
  return { 1: best(1), 2: best(2) };
};
/** One pawn of one player. */
export interface PawnRef {
  player: PlayerId;
  type: PawnType;
}

/** One hunter and the pawn it must reach, with both players resolved. */
export interface Hunt {
  hunter: PawnRef;
  target: PawnRef;
}

/**
 * The variant's capture relations, resolved for both players and each listed
 * once: Standard has two (each cat to the other mouse), Classic two (each cat
 * to its own home), Animal Cycle four, Survival one.
 */
export const huntsFor = (variant: Variant): Hunt[] => {
  const hunts = new Map<string, Hunt>();
  for (const relation of executableRulesFor(variant).captureRelations) {
    for (const player of [1, 2] as const) {
      const hunt: Hunt = {
        hunter: {
          player: resolveRulePlayer(relation.hunter.player, player),
          type: relation.hunter.type,
        },
        target: {
          player: resolveRulePlayer(relation.target.player, player),
          type: relation.target.type,
        },
      };
      hunts.set(
        `${hunt.hunter.player}:${hunt.hunter.type}>${hunt.target.player}:${hunt.target.type}`,
        hunt,
      );
    }
  }
  return [...hunts.values()];
};

/**
 * The smallest jump that is a pick: one more than any move without a wall can
 * make (see the header): the pawn named by the most hunts sets the bound.
 */
export const minJumpFor = (variant: Variant): number => {
  const perPawn = new Map<string, number>();
  for (const hunt of huntsFor(variant)) {
    for (const pawn of [hunt.hunter, hunt.target]) {
      const key = `${pawn.player}:${pawn.type}`;
      perPawn.set(key, (perPawn.get(key) ?? 0) + 1);
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
export interface ReplayedGame {
  movers: PlayerId[];
  /** One per position: before each move, and after the last. */
  distances: RaceDistances[];
  /** One per hunt, with its walk and both cells in every position. */
  tracks: HuntTrack[];
  /** One per position, like `distances`. */
  states: GameState[];
}

export interface HuntTrack extends Hunt {
  walks: number[];
  /** Standard notation, e.g. "g4". */
  hunterCells: string[];
  targetCells: string[];
}

export const replayDistances = (game: ReplayableGame): ReplayedGame => {
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
  const hunts = huntsFor(config.variant);
  let state = new GameState(config, 0, { allowStoredHistoryBacktracks: true });
  const tracks: HuntTrack[] = hunts.map((hunt) => ({
    ...hunt,
    walks: [],
    hunterCells: [],
    targetCells: [],
  }));
  const movers: PlayerId[] = [];
  const distances: RaceDistances[] = [];
  const states: GameState[] = [];
  const read = () => {
    states.push(state);
    const walks = huntWalks(state);
    distances.push(raceFromWalks(hunts, walks));
    tracks.forEach((track, i) => {
      track.walks.push(walks[i]);
      const cell = (pawn: PawnRef) =>
        cellToStandardNotation(
          requirePawnCell(state.pawns, pawn.player, pawn.type),
          game.boardHeight,
        );
      track.hunterCells.push(cell(track.hunter));
      track.targetCells.push(cell(track.target));
    });
  };
  read();
  game.moves.forEach((notation, index) => {
    const playerId = state.turn;
    state = state.applyGameAction({
      kind: "move",
      move: moveFromStandardNotation(notation, game.boardHeight),
      playerId,
      timestamp: index,
    });
    movers.push(playerId);
    read();
  });
  return { movers, distances, tracks, states };
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

/** A pick with its board facts and plain line; what the CLI writes in `picks`. */
export type PickedJump = DistanceJump & PlyBoard & { description: string };

/** Wall actions in one move's notation (">e4" or "^e4", see standard-notation.ts). */
const wallCount = (notation: string): number =>
  notation.split(".").filter((a) => a.startsWith(">") || a.startsWith("^"))
    .length;

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
  const walls = wallCount(pick.notation);
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

/* ------------------------------------------------- what to zoom at -- */

/*
 * WHERE THE MOMENT IS ON THE BOARD (Wall Game PM, 2026-10-26: the zoom aimed
 * at the wrong one of two walls). A move can put down two walls, and often
 * only one of them is in the hunter's way. So each wall of the ply is measured
 * ALONE: the position after the ply (pawns where they end), with the walls of
 * before the ply plus only that wall, against the same position with none of
 * the ply's walls. The wall whose own change is the largest and makes the
 * whole change of all the ply's walls is the cause. When no single wall does
 * that, the walls work only together, and all of them are the cause (a move
 * has at most two actions, so that is both walls). When no wall adds
 * anything, no wall is the cause: the pawns make the moment.
 */

/** One wall put down on a ply. */
export interface PlacedWall {
  /** Standard notation: ">e4" is right of e4, "^e4" is above e4. */
  notation: string;
  /** The two cells the wall separates, in standard notation. */
  between: [string, string];
  /** The change this wall makes alone, in the measure of the moment. */
  alone: number;
  /** A wall the zoom aims at. */
  cause: boolean;
}

/** Where one pawn stands before and after a ply, in standard notation. */
export interface PawnPlace {
  player: PlayerId;
  type: PawnType;
  before: string;
  after: string;
}

/** The board facts of one ply, for the zoom and the director. */
export interface PlyBoard {
  /** Every pawn on the board, in the board's own order. */
  pawns: PawnPlace[];
  /** The walls put down on the ply, in notation order; [] for none. */
  walls: PlacedWall[];
  /** The change all the ply's walls make together. */
  wallsChange: number;
  /** True when no single wall makes the whole wallsChange. */
  together: boolean;
}

const wallSides = (wall: WallPosition): [Cell, Cell] => {
  const [r, c] = wall.cell;
  return wall.orientation === "vertical"
    ? [
        [r, c],
        [r, c + 1],
      ]
    : [
        [r - 1, c],
        [r, c],
      ];
};

/** Every pawn before and after `ply`. */
const pawnsOn = (replay: ReplayedGame, ply: number): PawnPlace[] => {
  const before = replay.states[ply];
  const after = boardPawns(replay.states[ply + 1].pawns);
  const cell = (c: Cell) =>
    cellToStandardNotation(c, before.config.boardHeight);
  return boardPawns(before.pawns).map((pawn, i) => ({
    player: pawn.playerId,
    type: pawn.type,
    before: cell(pawn.cell),
    after: cell(after[i].cell),
  }));
};

/**
 * The board facts of `ply`. `measure` turns each hunt's walk (huntsFor order)
 * into the number the moment is about, larger = more of the moment.
 */
const plyBoardOf = (
  replay: ReplayedGame,
  ply: number,
  notation: string,
  measure: (walks: number[]) => number,
): PlyBoard => {
  const before = replay.states[ply];
  const after = replay.states[ply + 1];
  const height = before.config.boardHeight;
  const cell = (c: Cell) => cellToStandardNotation(c, height);
  const placed: WallPosition[] = moveFromStandardNotation(
    notation,
    height,
  ).actions.flatMap((a) =>
    a.type === "wall" && a.wallOrientation
      ? [{ cell: a.target, orientation: a.wallOrientation }]
      : [],
  );
  const measureWith = (walls: WallPosition[]) => {
    const grid = before.grid.clone();
    for (const wall of walls) grid.addWall(wall);
    return measure(walksOn(replay.tracks, grid, after.pawns));
  };
  const none = measureWith([]);
  const alone = placed.map((wall) => measureWith([wall]) - none);
  const wallsChange = placed.length === 0 ? 0 : measureWith(placed) - none;
  const best = Math.max(0, ...alone);
  const together = placed.length > 1 && best < wallsChange;
  // When no wall adds anything, best is 0 and the pawns make the moment.
  const cause = alone.map(
    (change) => together || (best > 0 && change === best),
  );
  return {
    pawns: pawnsOn(replay, ply),
    walls: placed.map((wall, i) => ({
      notation: wallToStandardNotation(wall, height),
      between: wallSides(wall).map(cell) as [string, string],
      alone: alone[i],
      cause: cause[i],
    })),
    wallsChange,
    together,
  };
};

/**
 * The board facts of a pick. The measure is the mover's race, turned so that
 * the jump's own direction counts up: for a wall the mover puts in their own
 * hunter's way (a negative jump), the cause is that wall.
 */
export const pickBoard = (replay: ReplayedGame, pick: DistanceJump): PlyBoard =>
  plyBoardOf(
    replay,
    pick.ply,
    pick.notation,
    (walks) =>
      Math.sign(pick.jump) *
      raceFor(raceFromWalks(replay.tracks, walks), pick.mover),
  );

/* ----------------------------------------------------------- close calls -- */

/*
 * A CLOSE CALL (Nil, 2026-10-26: the mouse looks scared, a wall lands with
 * the FAAAH, then the mouse laughs) is three moves on one hunt whose target is
 * an animal: DANGER, a move after which the hunter is DANGER_WALK or fewer
 * squares away, so it can reach the prey on its next turn (two steps); SAVE,
 * within the next two moves, a move by the prey's owner that pushes the walk
 * up by SAVE_JUMP or more; RELIEF, the hunter's reply, after which the walk is
 * still above DANGER_WALK. Classic has no close call: its cats run to a home,
 * and a home has no face to be scared with.
 */

/** A hunter this close reaches its prey on its next turn (two steps). */
export const DANGER_WALK = 2;

/**
 * One move changes one hunt's walk by at most 2 without a wall: the mover
 * owns one of the two pawns and moves it at most two steps. So a rise of 3 or
 * more is a wall, the FAAAH moment.
 */
export const SAVE_JUMP = 3;

/** How many close calls each candidate reports. */
export const BEATS_PER_GAME = 3;

export interface BeatMoment {
  ply: number;
  moveNumber: number;
  notation: string;
  /** The hunt's walk after this ply. */
  walk: number;
  /** Both pawns after this ply, in standard notation. */
  hunterCell: string;
  preyCell: string;
  /** Every pawn before and after this ply. */
  pawns: PawnPlace[];
}

export interface CloseCall {
  hunter: PawnRef;
  prey: PawnRef;
  danger: BeatMoment;
  /**
   * `walk` is after the save; the walk before it is the danger-side value.
   * The walls are measured on this hunt's walk.
   */
  save: BeatMoment & PlyBoard & { walkBefore: number };
  relief: BeatMoment;
  /** save.walk - save.walkBefore. */
  size: number;
}

/**
 * Every close call in a game, largest save first; later ones that share a
 * ply with an earlier pick are dropped, and at most BEATS_PER_GAME remain.
 */
export const closeCallsOf = (
  replay: ReplayedGame,
  moves: string[],
): CloseCall[] => {
  const found: CloseCall[] = [];
  replay.tracks.forEach((track, hunt) => {
    if (track.target.type === "home") return;
    const moment = (ply: number): BeatMoment => ({
      ply,
      moveNumber: ply + 1,
      notation: moves[ply],
      walk: track.walks[ply + 1],
      hunterCell: track.hunterCells[ply + 1],
      preyCell: track.targetCells[ply + 1],
      pawns: pawnsOn(replay, ply),
    });
    for (let danger = 0; danger < moves.length; danger++) {
      const close = track.walks[danger + 1];
      if (close === 0 || close > DANGER_WALK) continue;
      if (track.walks[danger] <= DANGER_WALK) continue;
      for (const save of [danger + 1, danger + 2]) {
        if (save >= moves.length - 1) break;
        // Still close when the save comes; a capture ends the game instead.
        if (track.walks[save] > DANGER_WALK) break;
        if (replay.movers[save] !== track.target.player) continue;
        const rise = track.walks[save + 1] - track.walks[save];
        if (rise < SAVE_JUMP) break;
        if (track.walks[save + 2] <= DANGER_WALK) break;
        found.push({
          hunter: track.hunter,
          prey: track.target,
          danger: moment(danger),
          save: {
            ...moment(save),
            ...plyBoardOf(replay, save, moves[save], (walks) => walks[hunt]),
            walkBefore: track.walks[save],
          },
          relief: moment(save + 1),
          size: rise,
        });
        break;
      }
    }
  });
  const kept: CloseCall[] = [];
  for (const call of found.sort(
    (a, b) => b.size - a.size || a.danger.ply - b.danger.ply,
  )) {
    if (kept.length === BEATS_PER_GAME) break;
    const plies = (c: CloseCall) => [c.danger.ply, c.save.ply, c.relief.ply];
    if (kept.some((k) => plies(k).some((p) => plies(call).includes(p))))
      continue;
    kept.push(call);
  }
  return kept;
};

/** One plain line for the crew: who nearly caught whom, and the wall. */
export const describeCloseCall = (
  call: CloseCall,
  names: Record<PlayerId, string>,
): string => {
  const squaresAway = (n: number) => `${n} square${n === 1 ? "" : "s"}`;
  const walls = wallCount(call.save.notation);
  const wall = walls === 1 ? "A wall makes" : "Walls make";
  return (
    `${names[call.hunter.player]}'s ${call.hunter.type} gets ${squaresAway(call.danger.walk)} from ${names[call.prey.player]}'s ${call.prey.type}. ` +
    `${wall} it walk ${call.save.walk} (move ${call.save.moveNumber}), and the ${call.prey.type} is safe.`
  );
};

/** A close call with its plain line; what the CLI writes in `beats`. */
export type DescribedCloseCall = CloseCall & { description: string };

export interface RankedCandidate {
  gameId: string;
  beats: { size: number }[];
  picks: { size: number }[];
}

/**
 * A game with a close call first, by its largest save; then the largest pick,
 * the second and the third; then the game id. Every game with a close call
 * ranks above every game without one, however large its jumps (Wall Game PM,
 * 2026-10-26): the close call (scared, the FAAAH wall, the laugh) is the story
 * of the video, and a game without one has no payoff beat.
 */
export const rankCandidates = <T extends RankedCandidate>(
  candidates: T[],
): T[] =>
  [...candidates].sort((a, b) => {
    const beat = (b.beats[0]?.size ?? 0) - (a.beats[0]?.size ?? 0);
    if (beat !== 0) return beat;
    for (let i = 0; i < PICKS_PER_GAME; i++) {
      const diff = (b.picks[i]?.size ?? 0) - (a.picks[i]?.size ?? 0);
      if (diff !== 0) return diff;
    }
    return a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0;
  });
