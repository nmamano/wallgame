/**
 * Forced wins: positions where the side to move can force a capture in 2 or
 * 3 of its own turns against every defence (Nil, 2026-11-25, ask 816d58d5:
 * "what needs to improve is the detection of good puzzle positions"). An
 * exact search on the game's own rules (GameState), not the engine: a value
 * net misses forced lines it does not value at 90% (labels.ts MissedWin).
 *
 * THE RULES OF THE SEARCH, as tests pin them:
 * - 1 turn: a cat within CAPTURE_REACH on its own turn captures. That is no
 *   puzzle, so such a position is skipped.
 * - 2 turns: a move M after which every reply leaves a cat within
 *   CAPTURE_REACH (defenceOf "no-answer"). A reply that captures first, or
 *   leaves the defender's own cat in reach (it captures first next), is an
 *   answer ("wins-first").
 * - 3 turns: a move M1 after which every reply R1 allows a 2-turn win. A
 *   reply that ends the game counts for whoever won it: a mouse that steps
 *   onto the mover's cat loses (EDP5pYum 38, Mh2).
 *
 * PRUNING THAT LOSES NOTHING. Walls never shorten a walk, and each pawn
 * action moves a cat one cell, so a cat's walk falls by at most 2 in one
 * turn. A 2-turn win therefore needs a cat within 2 x CAPTURE_REACH before M
 * and within CAPTURE_REACH after it; a 3-turn win needs 3 x CAPTURE_REACH
 * before M1 and 2 x CAPTURE_REACH after it and after every reply. Only
 * moves with a cat step can bring a cat within CAPTURE_REACH (a test
 * compares the pruned search with the full one).
 *
 * COVERED: Standard only. Classic's race is a cat to its home, which
 * defenceOf does not read, and Animal Cycle has no test yet; both give
 * `covered: false`, never a wrong yes.
 */
import type { GameState } from "../../../shared/domain/game-state";
import type { PlayerId } from "../../../shared/domain/game-types";
import { pawnCell } from "../../../shared/domain/pawns";
import {
  cellToStandardNotation,
  moveFromStandardNotation,
} from "../../../shared/domain/standard-notation";
import { huntsFor, huntWalks } from "../race-replay";
import { actionsOf, CAPTURE_REACH, defenceOf } from "./facts";

export const FORCED_TURNS = { min: 2, max: 3 } as const;
/** Stored results of another version are searched again. */
export const FORCED_VERSION = "2";
/**
 * The search time of one ply in a scan (2026-11-26: on the 10 picked games,
 * 4 of 342 plies took 10 min to over 1.5 h on one desktop thread, the
 * rest at most 5 min). Past it, the ply is "not known", never "no win".
 */
export const FORCED_CAP_MS = 15 * 60_000;
/**
 * A puzzle where this share of the legal first moves or more wins is
 * marked trivial in the report (the Director, 2026-11-25: "when almost
 * every move wins, the puzzle is trivial, so flag it"). A flag, no filter.
 */
export const TRIVIAL_SHARE = 0.5;
/** The first-move list is kept only when it is this short (the Director). */
export const LIST_WINNING = 5;
export const COVERED_VARIANTS: readonly string[] = ["standard"];

export interface ForcedWin {
  ply: number;
  mover: PlayerId;
  /** False when the variant is not covered: then nothing else is known. */
  covered: boolean;
  /** The mover's cat walk to the prey before the move; null if not covered. */
  walk: number | null;
  /** The fewest own turns that force the capture, or null (none in 3). */
  turns: number | null;
  /** How many distinct legal first moves win in `turns`, and of how many. */
  winningCount: number;
  legalCount: number;
  /** The winning first moves when there are LIST_WINNING or fewer. */
  winning: string[] | null;
  /** One winning first move (always kept, for the line in the report). */
  example: string | null;
  played: string;
  /**
   * What the played move did: "found" (it is a winning move), "delayed"
   * (it misses the 2-turn win but still wins in 3), "lost" (no forced win
   * within 3 turns after it); null when there is no forced win.
   */
  playedVerdict: "found" | "delayed" | "lost" | "unknown" | null;
  /** The time cap stopped the search before any answer: turns is unknown. */
  timedOut: boolean;
  /** The time cap stopped the count: winningCount is a lower bound. */
  countCapped: boolean;
}

/** The time cap of the running search (forcedWinAt sets it). */
class TimeUp extends Error {}
let deadline = Infinity;

/** The same move written with its actions in another order is one move. */
export const sameMove = (a: string, b: string) =>
  a.split(".").sort().join(".") === b.split(".").sort().join(".");
const key = (m: string) => m.split(".").sort().join(".");

const apply = (state: GameState, notation: string): GameState | null => {
  try {
    return state.applyGameAction({
      kind: "move",
      move: moveFromStandardNotation(notation, state.config.boardHeight),
      playerId: state.turn,
      timestamp: 0,
    });
  } catch {
    return null;
  }
};

/** The smallest walk of `player`'s hunts of an animal (not a home). */
const walkOf = (state: GameState, player: PlayerId): number => {
  const walks = huntWalks(state);
  const own = huntsFor(state.config.variant).flatMap((h, i) =>
    h.hunter.player === player && h.target.type !== "home" ? [walks[i]] : [],
  );
  return own.length === 0 ? Infinity : Math.min(...own);
};

/**
 * Every move of the side to move as notation (some are illegal: apply drops
 * them). `catLed` keeps only moves with a cat step (the pruning above).
 */
export function* movesOf(
  state: GameState,
  catLed: boolean,
  near?: string,
): Generator<string> {
  const { pawns, walls: all } = actionsOf(state, state.turn);
  // Walls close to `near` (a cell) first: a defence is found sooner.
  const walls = near
    ? [...all].sort((a, b) => far(a, near) - far(b, near))
    : all;
  const cats = pawns.filter((p) => p.type === "cat");
  const others = pawns.filter((p) => p.type !== "cat");
  for (const c of cats) {
    yield* c.far;
    yield* c.near;
    for (const a of c.near) {
      for (const w of walls) yield `${a}.${w}`;
      for (const o of others) for (const b of o.near) yield `${a}.${b}`;
    }
  }
  if (catLed) return;
  for (const o of others) {
    yield* o.far;
    yield* o.near;
    for (const a of o.near) for (const w of walls) yield `${a}.${w}`;
  }
  yield* walls;
  for (let i = 0; i < walls.length; i++)
    for (let j = i + 1; j < walls.length; j++) yield `${walls[i]}.${walls[j]}`;
}

/** Manhattan distance from a wall's cell to a cell, both in notation. */
const far = (wall: string, cell: string) =>
  Math.abs(wall.charCodeAt(1) - cell.charCodeAt(0)) +
  Math.abs(Number(wall.slice(2)) - Number(cell.slice(1)));

/**
 * The distinct legal moves of the side to move, with the state after each,
 * one at a time (a caller that finds its answer stops early).
 */
function* legalMoves(
  state: GameState,
  catLed: boolean,
  near?: string,
): Generator<{ move: string; next: GameState }> {
  const seen = new Set<string>();
  for (const m of movesOf(state, catLed, near)) {
    if (performance.now() > deadline) throw new TimeUp();
    const k = key(m);
    if (seen.has(k)) continue;
    seen.add(k);
    const next = apply(state, m);
    if (next) yield { move: m, next };
  }
}

/** The cell of `player`'s cat in notation, if it has one. */
const catCell = (state: GameState, player: PlayerId): string | undefined => {
  const at = pawnCell(state.pawns, player, "cat");
  return at ? cellToStandardNotation(at, state.config.boardHeight) : undefined;
};

const winnerIs = (s: GameState, p: PlayerId) =>
  s.status === "finished" && s.result?.winner === p;

/** After `move` by `mover`, the defender has no answer: a 2-turn win. */
const noAnswer = (next: GameState, mover: PlayerId) =>
  next.status === "playing" &&
  walkOf(next, mover) <= CAPTURE_REACH &&
  defenceOf(next, mover) === "no-answer";

/** `state` (mover to move) is won within 2 turns: now, or by a 2-turn move. */
const wonIn2 = (state: GameState, mover: PlayerId): boolean => {
  const walk = walkOf(state, mover);
  if (walk <= CAPTURE_REACH) return true;
  if (walk > 2 * CAPTURE_REACH) return false;
  for (const { next } of legalMoves(state, true))
    if (winnerIs(next, mover) || noAnswer(next, mover)) return true;
  return false;
};

/** After M1 (defender to move), every reply leaves a win within 2 turns. */
/**
 * Replies that refuted an earlier first move: a reply that saves one
 * position often saves its neighbours, so they are tried first (a search
 * speed-up only; every reply is still tried before a "yes").
 */
const killers: string[] = [];
const KILLERS = 8;
const remember = (move: string) => {
  const i = killers.indexOf(move);
  if (i !== -1) killers.splice(i, 1);
  killers.unshift(move);
  killers.length = Math.min(killers.length, KILLERS);
};

/** The reply `next` refutes: it saves the defender within 2 more turns. */
const refutes = (next: GameState, mover: PlayerId): boolean =>
  next.status !== "playing"
    ? !winnerIs(next, mover)
    : walkOf(next, mover) > 2 * CAPTURE_REACH || !wonIn2(next, mover);

export const everyReplyLoses = (after: GameState, mover: PlayerId): boolean => {
  if (after.status !== "playing") return winnerIs(after, mover);
  if (walkOf(after, mover) > 2 * CAPTURE_REACH) return false;
  const defender = after.turn;
  // The defender captures first.
  if (walkOf(after, defender) <= CAPTURE_REACH) return false;
  for (const k of [...killers]) {
    const next = apply(after, k);
    if (next && refutes(next, mover)) {
      remember(k);
      return false;
    }
  }
  const left: { move: string; next: GameState }[] = [];
  // Cheap refutations first: a reply that ends the game for the defender,
  // or keeps every cat out of 2-turn range.
  for (const r of legalMoves(after, false, catCell(after, mover))) {
    if (r.next.status !== "playing") {
      if (!winnerIs(r.next, mover)) return false;
      continue;
    }
    if (walkOf(r.next, mover) > 2 * CAPTURE_REACH) {
      remember(r.move);
      return false;
    }
    left.push(r);
  }
  for (const r of left)
    if (!wonIn2(r.next, mover)) {
      remember(r.move);
      return false;
    }
  return true;
};

/**
 * The winning first moves for `turns` (2 or 3) in `state`. `pruned: false`
 * tries every legal move with no walk bound (the tests' reference).
 */
export const winningMoves = (
  state: GameState,
  mover: PlayerId,
  turns: 2 | 3,
  pruned = true,
): string[] => collectWins(state, mover, turns, pruned).moves;

/** winningMoves, with what it found so far when the time cap stops it. */
const collectWins = (
  state: GameState,
  mover: PlayerId,
  turns: 2 | 3,
  pruned: boolean,
): { moves: string[]; capped: boolean } => {
  const walk = walkOf(state, mover);
  if (pruned && walk > turns * CAPTURE_REACH)
    return { moves: [], capped: false };
  const out: string[] = [];
  try {
    for (const { move, next } of legalMoves(state, pruned && turns === 2)) {
      if (winnerIs(next, mover)) continue; // a 1-turn win: skipped above
      if (turns === 2 ? noAnswer(next, mover) : everyReplyLoses(next, mover))
        out.push(move);
    }
  } catch (error) {
    if (error instanceof TimeUp && out.length > 0)
      return { moves: out, capped: true };
    throw error;
  }
  return { moves: out, capped: false };
};

export const forcedWinAt = (
  state: GameState,
  ply: number,
  played: string,
  capMs = Infinity,
): ForcedWin => {
  const mover = state.turn;
  const base = {
    ply,
    mover,
    walk: null,
    played,
    turns: null,
    winningCount: 0,
    legalCount: 0,
    winning: null,
    example: null,
    playedVerdict: null,
    timedOut: false,
    countCapped: false,
  };
  if (!COVERED_VARIANTS.includes(state.config.variant))
    return { ...base, covered: false };
  const walk = walkOf(state, mover);
  if (walk <= CAPTURE_REACH || walk > FORCED_TURNS.max * CAPTURE_REACH)
    return { ...base, walk, covered: true };
  deadline = performance.now() + capMs;
  try {
    for (const turns of [2, 3] as const) {
      const { moves: wins, capped } = collectWins(state, mover, turns, true);
      if (wins.length === 0) continue;
      const found = wins.some((w) => sameMove(w, played));
      let verdict: ForcedWin["playedVerdict"] = found ? "found" : "lost";
      if (!found && turns === 2) {
        const after = apply(state, played);
        try {
          if (after && everyReplyLoses(after, mover)) verdict = "delayed";
        } catch (error) {
          if (!(error instanceof TimeUp)) throw error;
          verdict = "unknown";
        }
      }
      deadline = Infinity;
      return {
        ...base,
        walk,
        covered: true,
        turns,
        winningCount: wins.length,
        legalCount: [...legalMoves(state, false)].length,
        winning: wins.length <= LIST_WINNING ? wins : null,
        example: wins[0],
        playedVerdict: verdict,
        countCapped: capped,
      };
    }
  } catch (error) {
    if (!(error instanceof TimeUp)) throw error;
    return { ...base, walk, covered: true, timedOut: true };
  } finally {
    deadline = Infinity;
  }
  return { ...base, walk, covered: true };
};
