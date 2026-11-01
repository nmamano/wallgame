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
import { siteMoveNumber } from "../site-move.mjs";
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
   * The stored result (game_players, as the replay page reads it). Never the
   * replay's: the replay applies today's rules, and a game before 2026-09-01
   * that the one-move rule made a draw replays as a capture win.
   */
  result: GameResult;
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
  /** The pawn steps of the best move: the pawn and the cell it ends on. */
  bestSteps: { pawn: GamePawnType; to: string }[];
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
  /** wallgame.io's move number (siteMoveNumber): both turns of a pair share it. */
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
   * Set on the move that ends the game on the board, with the stored
   * result's winner and reason (SemanticGame.result).
   */
  end: { winner: PlayerId | null; reason: string } | null;
  /**
   * How the other side can answer the mover's hunts after this move
   * (defenceOf); null on the move that ends the game. "no-answer" is a
   * trap: the mover captures next move unless it errs.
   */
  defence: Defence | null;
}

export interface GameFacts {
  game: SemanticGame;
  plies: PlyFacts[];
  /** The stored winner; null for a draw. */
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

const pawnStepsOf = (
  notation: string,
  height: number,
): { pawn: GamePawnType; to: string }[] =>
  moveFromStandardNotation(notation, height).actions.flatMap((a) =>
    a.type === "wall"
      ? []
      : [{ pawn: a.type, to: cellToStandardNotation(a.target, height) }],
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

/** A cat this close reaches its prey in one turn of two steps. */
export const CAPTURE_REACH = 2;

/**
 * How the side to move can answer the mover's hunts after a move (the
 * threat split, 2026-11-01; the board trap of 2026-11-01):
 * - out-of-reach: no animal hunt of the mover is within CAPTURE_REACH.
 * - wins-first: one is, but the side to move captures first (its own hunt
 *   is within CAPTURE_REACH).
 * - one-action: one action answers it (a one-cell step or one wall).
 * - two-actions: only a full turn answers it (two walls, a two-cell step,
 *   a step and a wall).
 * - no-answer: no reply keeps every animal out of reach: a trap.
 */
export type Defence =
  | "out-of-reach"
  | "wins-first"
  | "one-action"
  | "two-actions"
  | "no-answer";

/** The Defence of the side to move in `state` against `mover`'s hunts. */
export const defenceOf = (state: GameState, mover: PlayerId): Defence => {
  const hunts = huntsFor(state.config.variant);
  const animal = (by: PlayerId) =>
    hunts.flatMap((h, i) =>
      h.hunter.player === by && h.target.type !== "home" ? [i] : [],
    );
  const reach = animal(mover);
  const caught = (walks: number[]) =>
    reach.some((i) => walks[i] <= CAPTURE_REACH);
  const now = huntWalks(state);
  // Walls never shorten a walk, so with no hunt in reach any wall is safe.
  if (!caught(now)) return "out-of-reach";
  const defender = state.turn;
  if (animal(defender).some((i) => now[i] <= CAPTURE_REACH)) {
    return "wins-first";
  }
  const height = state.config.boardHeight;
  const width = state.config.boardWidth;
  const cells: Cell[] = [];
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) cells.push([r, c]);
  const name = (c: Cell) => cellToStandardNotation(c, height);
  const walls = cells.flatMap((c) => [`>${name(c)}`, `^${name(c)}`]);
  const letter: Record<string, string> = {
    cat: "C",
    mouse: "M",
    dog: "D",
    elephant: "E",
  };
  // Each pawn's steps by length: a step of 2 cells costs both actions, so
  // it never pairs with anything (VR1, review 135 N1).
  const pawns = (["cat", "mouse", "dog", "elephant"] as GamePawnType[])
    .map((type) => ({ type, at: pawnCell(state.pawns, defender, type) }))
    .filter((p): p is { type: GamePawnType; at: Cell } => p.at !== undefined)
    .map((p) => {
      const at = (d: number) =>
        cells
          .filter(
            (c) => Math.abs(c[0] - p.at[0]) + Math.abs(c[1] - p.at[1]) === d,
          )
          .map((c) => `${letter[p.type]}${name(c)}`);
      return { near: at(1), far: at(2) };
    });
  const safe = (notation: string): boolean => {
    let next: GameState;
    try {
      next = state.applyGameAction({
        kind: "move",
        move: moveFromStandardNotation(notation, height),
        playerId: defender,
        timestamp: 0,
      });
    } catch {
      return false;
    }
    if (next.status === "finished") return next.result?.winner === defender;
    return !caught(huntWalks(next));
  };
  const near = pawns.flatMap((p) => p.near);
  if ([...near, ...walls].some(safe)) return "one-action";
  const full = function* (): Generator<string> {
    for (const p of pawns) yield* p.far;
    for (const s of near)
      for (const w of walls) {
        yield `${s}.${w}`;
        yield `${w}.${s}`;
      }
    for (let a = 0; a < pawns.length; a++)
      for (let b = a + 1; b < pawns.length; b++)
        for (const s of pawns[a].near)
          for (const t of pawns[b].near) {
            yield `${s}.${t}`;
            yield `${t}.${s}`;
          }
    for (let a = 0; a < walls.length; a++)
      for (let b = a + 1; b < walls.length; b++)
        yield `${walls[a]}.${walls[b]}`;
  };
  for (const m of full()) if (safe(m)) return "two-actions";
  return "no-answer";
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
        bestSteps: bestMove ? pawnStepsOf(bestMove, height) : [],
        bestWalks: bestMove ? walksAfter(before, bestMove) : null,
      };
    }
    const ended = after.status === "finished" && before.status !== "finished";
    return {
      ply,
      moveNumber: siteMoveNumber(ply),
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
        ? { winner: game.result.winner ?? null, reason: game.result.reason }
        : null,
      defence: ended ? null : defenceOf(after, mover),
    };
  });
  return {
    game,
    plies,
    winner: game.result.winner ?? null,
    engineBotId: engine?.botId ?? null,
  };
};
