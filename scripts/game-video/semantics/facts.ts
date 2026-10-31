/**
 * The facts of every move of one game: what the board and the engine say
 * happened, before any meaning is put on it (labels.ts) or any words
 * (sentences.ts). Pure functions only: no database, no engine, no network.
 *
 * THE BOARD. Each hunt's walk (race-replay.ts huntWalks: the same BFS as the
 * race counter and the renderer's path) before and after the move, the
 * mover's pawn steps and the walls the move placed.
 *
 * THE ENGINE (optional). The evaluation bar's value of the position before
 * and after the move (engine-eval.ts scoreGame), as the MOVER's win chance,
 * and the engine's best move in the position before. The best move is also
 * played on a copy of the position, so the walks it would have given are
 * computed here, never guessed.
 */
import type { GameState } from "../../../shared/domain/game-state";
import type { Grid } from "../../../shared/domain/grid";
import type {
  GameResult,
  Cell,
  GamePawns,
  GameInitialState,
  GamePawnType,
  PlayerId,
  Variant,
} from "../../../shared/domain/game-types";
import { pawnCell } from "../../../shared/domain/pawns";
import {
  cellToStandardNotation,
  moveFromStandardNotation,
  wallToStandardNotation,
} from "../../../shared/domain/standard-notation";
import type { SeatKind } from "../daily-candidates";
import { winChance } from "../daily-candidates";
import {
  huntsFor,
  huntWalks,
  replayDistances,
  type Hunt,
  type PawnRef,
  type ReplayedGame,
} from "../race-replay";

/** One game as a daily item or a candidates day file stores it. */
export interface SemanticGame {
  gameId: string;
  variant: string;
  boardWidth: number;
  boardHeight: number;
  initialState: GameInitialState;
  /** Every ply's standard notation, 0-based. */
  moves: string[];
  seats: { playerOrder: number; kind: SeatKind; name: string }[];
  /**
   * The stored result, when the source has it (candidate reports from
   * 2026-10-31 on). It overrides the replay's: the replay applies today's
   * rules, and a game before 2026-09-01 that the one-move rule made a draw
   * replays as a capture win.
   */
  result?: GameResult;
}

/** The engine's numbers for one game (engine-eval.ts scoreGame). */
export interface EngineData {
  botId: string;
  /** One per position: before each move, and after the last. */
  evaluationsP1: number[];
  /** The engine's best move in each position; null where it gave none. */
  bestMoves: (string | null)[];
  /** The final value is the game result, not the engine's opinion. */
  finalFromResult: boolean;
}

/** One hunt across one move. */
export interface HuntChange extends Hunt {
  before: number;
  after: number;
  /** Standard notation of both pawns, before and after the move. */
  hunterFrom: string;
  hunterTo: string;
  targetFrom: string;
  targetTo: string;
}

/** A pawn of the mover that moved on this ply. */
export interface PawnStep {
  type: GamePawnType;
  from: string;
  to: string;
}

export interface EngineFacts {
  /** The mover's win chance in [0, 1] before and after the move. */
  before: number;
  after: number;
  /** after - before: negative is worse for the mover. */
  delta: number;
  /** The value after the move is the game result (the final position). */
  afterFromResult: boolean;
  /** The engine's best move in the position before; null if none. */
  bestMove: string | null;
  /** The played move is the engine's best move (same actions, any order). */
  playedBest: boolean;
  /** The walls of the best move, in standard notation. */
  bestWalls: string[];
  /**
   * Each hunt's walk had the best move been played (huntsFor order), or
   * null when the best move is missing or cannot be played here.
   */
  bestWalks: number[] | null;
}

/**
 * A mouse's ROOM across one move (Nil, 2026-10-29, on v-lQeZ8T: "red blocks
 * the blue mouse, putting it in a dire situation"): the cells the mouse
 * reaches in fewer steps than every cat that hunts it. Both counts use the
 * pawns after the move; `before` the walls before it, `after` the walls
 * after it, so only the move's walls change it, not a cat's step.
 */
export interface MouseRoom {
  /** An animal the mover's pawns hunt. */
  target: PawnRef;
  hunters: PawnRef[];
  before: number;
  after: number;
}

/**
 * The room a box-in is about: the mouse whose room the move cut the most,
 * by share. Throws on a ply with no room to cut (VR1, 2026-10-30), which a
 * box-in label cannot have.
 */
export const boxedRoom = (f: PlyFacts): MouseRoom => {
  const room = f.rooms
    .filter((r) => r.before > 0)
    .sort((a, b) => a.after / a.before - b.after / b.before)[0];
  if (!room) throw new Error(`box-in with no room change at ply ${f.ply}`);
  return room;
};

export interface PlyFacts {
  /** 0-based index into the stored move list (edl.mjs convention). */
  ply: number;
  /** 1-based, as the replay page counts moves. */
  moveNumber: number;
  mover: PlayerId;
  notation: string;
  steps: PawnStep[];
  /** The walls the move placed, in standard notation (">e4", "^e4"). */
  walls: string[];
  /** Every hunt of the variant, in huntsFor order. */
  hunts: HuntChange[];
  /** The room of each animal the mover hunts. */
  rooms: MouseRoom[];
  engine: EngineFacts | null;
  /**
   * Set on the move that ends the game on the board. The winner and reason
   * are the stored result's when the game has one (SemanticGame.result).
   */
  end: { winner: PlayerId | null; reason: string } | null;
}

export interface GameFacts {
  game: SemanticGame;
  plies: PlyFacts[];
  /**
   * The stored winner when the game has a result; else the winner on the
   * board. Null for a draw, or a game not ended on the board.
   */
  winner: PlayerId | null;
  engineBotId: string | null;
}

const sameActions = (a: string, b: string): boolean =>
  a.split(".").sort().join(".") === b.split(".").sort().join(".");

const wallsOf = (notation: string, height: number): string[] =>
  moveFromStandardNotation(notation, height).actions.flatMap((a) =>
    a.type === "wall" && a.wallOrientation
      ? [
          wallToStandardNotation(
            { cell: a.target, orientation: a.wallOrientation },
            height,
          ),
        ]
      : [],
  );

/** Each hunt's walk after `notation` is played in `state`; null if illegal. */
const walksAfter = (state: GameState, notation: string): number[] | null => {
  try {
    const next = state.applyGameAction({
      kind: "move",
      move: moveFromStandardNotation(notation, state.config.boardHeight),
      playerId: state.turn,
      timestamp: 0,
    });
    return huntWalks(next);
  } catch {
    return null;
  }
};

/** Steps from `start` to every cell it reaches through `grid`. */
const stepsFrom = (grid: Grid, start: Cell): Map<string, number> => {
  const key = (c: Cell) => `${c[0]},${c[1]}`;
  const steps = new Map([[key(start), 0]]);
  const queue: Cell[] = [start];
  for (const at of queue) {
    for (const next of grid.accessibleNeighbors(at)) {
      if (steps.has(key(next))) continue;
      steps.set(key(next), steps.get(key(at))! + 1);
      queue.push(next);
    }
  }
  return steps;
};

/** Cells `target` reaches in fewer steps than every one of `hunters`. */
const roomOf = (
  grid: Grid,
  pawns: GamePawns,
  target: PawnRef,
  hunters: PawnRef[],
): number => {
  const cell = (p: PawnRef) => {
    const c = pawnCell(pawns, p.player, p.type);
    if (!c) throw new Error(`no ${p.type} of player ${p.player} on the board`);
    return c;
  };
  const own = stepsFrom(grid, cell(target));
  const theirs = hunters.map((h) => stepsFrom(grid, cell(h)));
  let room = 0;
  for (const [key, steps] of own) {
    if (theirs.every((t) => steps < (t.get(key) ?? Infinity))) room++;
  }
  return room;
};

/** The room of each animal the mover hunts, across one move. */
const roomsOf = (
  hunts: Hunt[],
  before: GameState,
  after: GameState,
  mover: PlayerId,
): MouseRoom[] => {
  const targets = new Map<string, MouseRoom>();
  for (const hunt of hunts) {
    if (hunt.target.type === "home" || hunt.target.player === mover) continue;
    const key = `${hunt.target.player}:${hunt.target.type}`;
    if (!targets.has(key)) {
      targets.set(key, {
        target: hunt.target,
        hunters: [],
        before: 0,
        after: 0,
      });
    }
  }
  for (const room of targets.values()) {
    room.hunters = hunts
      .filter(
        (h) =>
          h.target.player === room.target.player &&
          h.target.type === room.target.type,
      )
      .map((h) => h.hunter);
    room.before = roomOf(before.grid, after.pawns, room.target, room.hunters);
    room.after = roomOf(after.grid, after.pawns, room.target, room.hunters);
  }
  return [...targets.values()];
};

const stepsOf = (
  before: GameState,
  after: GameState,
  mover: PlayerId,
): PawnStep[] => {
  const height = before.config.boardHeight;
  const steps: PawnStep[] = [];
  for (const type of ["cat", "mouse", "dog", "elephant"] as GamePawnType[]) {
    const from = pawnCell(before.pawns, mover, type);
    const to = pawnCell(after.pawns, mover, type);
    if (!from || !to) continue;
    if (from[0] === to[0] && from[1] === to[1]) continue;
    steps.push({
      type,
      from: cellToStandardNotation(from, height),
      to: cellToStandardNotation(to, height),
    });
  }
  return steps;
};

export const gameFacts = (
  game: SemanticGame,
  engine: EngineData | null,
): GameFacts => {
  const replay: ReplayedGame = replayDistances(game);
  const hunts = huntsFor(game.variant as Variant);
  const n = game.moves.length;
  if (engine) {
    if (engine.evaluationsP1.length !== n + 1) {
      throw new Error(
        `need ${n + 1} evaluations for ${n} moves, got ${engine.evaluationsP1.length}`,
      );
    }
    if (engine.bestMoves.length !== n + 1) {
      throw new Error(
        `need ${n + 1} best moves for ${n} moves, got ${engine.bestMoves.length}`,
      );
    }
  }
  const height = game.boardHeight;
  const plies = game.moves.map((notation, ply): PlyFacts => {
    const before = replay.states[ply];
    const after = replay.states[ply + 1];
    const mover = replay.movers[ply];
    let engineFacts: EngineFacts | null = null;
    if (engine) {
      const bestMove = engine.bestMoves[ply];
      const b = winChance(engine.evaluationsP1[ply], mover);
      const a = winChance(engine.evaluationsP1[ply + 1], mover);
      engineFacts = {
        before: b,
        after: a,
        delta: a - b,
        afterFromResult: engine.finalFromResult && ply === n - 1,
        bestMove,
        playedBest: bestMove !== null && sameActions(bestMove, notation),
        bestWalls: bestMove ? wallsOf(bestMove, height) : [],
        bestWalks: bestMove ? walksAfter(before, bestMove) : null,
      };
    }
    const ended = after.status === "finished" && before.status !== "finished";
    return {
      ply,
      moveNumber: ply + 1,
      mover,
      notation,
      steps: stepsOf(before, after, mover),
      walls: wallsOf(notation, height),
      hunts: hunts.map((hunt, i) => ({
        ...hunt,
        before: replay.tracks[i].walks[ply],
        after: replay.tracks[i].walks[ply + 1],
        hunterFrom: replay.tracks[i].hunterCells[ply],
        hunterTo: replay.tracks[i].hunterCells[ply + 1],
        targetFrom: replay.tracks[i].targetCells[ply],
        targetTo: replay.tracks[i].targetCells[ply + 1],
      })),
      rooms: roomsOf(hunts, before, after, mover),
      engine: engineFacts,
      end: ended
        ? game.result
          ? { winner: game.result.winner ?? null, reason: game.result.reason }
          : {
              winner: after.result?.winner ?? null,
              reason: after.result?.reason ?? "unknown",
            }
        : null,
    };
  });
  const last = replay.states[n];
  return {
    game,
    plies,
    winner: game.result
      ? (game.result.winner ?? null)
      : last.status === "finished"
        ? (last.result?.winner ?? null)
        : null,
    engineBotId: engine?.botId ?? null,
  };
};
