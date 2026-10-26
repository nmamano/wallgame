/**
 * The race a viewer can see, replayed from a stored game: each player's
 * shortest walk, through the walls of each position, of any of their hunters
 * to its target (the header of daily-candidates.ts explains the signal).
 *
 * Only shared/domain: no database, no zod. The daily picker reads it, and so
 * do the storyboard and the renderer's race counter on the 4090 render kit,
 * which has shared/domain and nothing else of the repo's TypeScript.
 */
import { GameState } from "../../shared/domain/game-state";
import type {
  GameConfiguration,
  GameInitialState,
  GamePawns,
  PawnType,
  PlayerId,
  Variant,
} from "../../shared/domain/game-types";
import type { Grid } from "../../shared/domain/grid";
import { timeControlConfigFromPreset } from "../../shared/domain/game-utils";
import { pawnCell, requirePawnCell } from "../../shared/domain/pawns";
import {
  cellToStandardNotation,
  moveFromStandardNotation,
} from "../../shared/domain/standard-notation";
import {
  executableRulesFor,
  resolveRulePlayer,
} from "../../shared/domain/variant-rules";

/** Each player's shortest hunter walk; null when the player hunts nothing. */
export type RaceDistances = Record<PlayerId, number | null>;

export const other = (player: PlayerId): PlayerId => (player === 1 ? 2 : 1);

/** Distances in one position, from the variant's hunts. */
export const raceDistances = (state: GameState): RaceDistances =>
  raceFromWalks(huntsFor(state.config.variant), huntWalks(state));

/** Each hunt's walk in one position, in huntsFor order. */
export const huntWalks = (state: GameState): number[] =>
  walksOn(huntsFor(state.config.variant), state.grid, state.pawns);

/** Each hunt's walk through `grid`, with the pawns at `pawns`. */
export const walksOn = (
  hunts: Hunt[],
  grid: Grid,
  pawns: GamePawns,
): number[] =>
  hunts.map((hunt) => {
    const hunter = pawnCell(pawns, hunt.hunter.player, hunt.hunter.type);
    const target = pawnCell(pawns, hunt.target.player, hunt.target.type);
    if (!hunter || !target) throw new Error("a hunt names a missing pawn");
    const walk = grid.distance(hunter, target);
    if (walk < 0) throw new Error("a hunter cannot reach its target");
    return walk;
  });

/** Each player's shortest walk over their own hunts. */
export const raceFromWalks = (
  hunts: Hunt[],
  walks: number[],
): RaceDistances => {
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
