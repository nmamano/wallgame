/**
 * Lead-in moves for saved puzzles (S-P1, the "P1 moves first" axiom).
 *
 * A puzzle's curated position is what the human must solve. When the human
 * plays P2, the game must still open with a real P1 (bot) move, so the game
 * starts one scripted ply earlier: the bot's `piece` stands on `from` in the
 * pre-position and double-moves to its curated cell as real ply 0, landing
 * exactly on the curated position with the human to move.
 *
 * The lead-in is chosen by Nil's plausibility heuristic (2026-07-26):
 *   1. CAT ADVANCE — a 2-step greedy advance toward the human mouse.
 *   2. MOUSE FLEE — a 2-step flee from the human cat.
 * There is deliberately NO wall fallback: walls placed by a move are stamped
 * with the mover's playerId (visibly owned), so a wall lead-in cannot
 * reproduce the curated neutral-wall board. The current pool needs no
 * fallback (census 2026-07-26: 19/19 P2 rows admit a pawn lead-in); callers
 * fail closed when neither heuristic applies.
 *
 * All distances are true path lengths through the curated walls
 * (Grid.distance). A qualifying cell must ALSO be at Manhattan distance 2:
 * applyMove charges pawn actions by Manhattan distance and resolves the
 * intermediate step itself, so Manhattan 2 + path distance 2 is exactly "a
 * legal double move exists".
 */

import { GameState } from "./game-state";
import { boardPawns, requirePawnCell } from "./pawns";
import type { Cell, GameConfiguration, Move } from "./game-types";
import type {
  SavedPuzzleConfig,
  SavedPuzzleDbRow,
  SavedPuzzleLeadIn,
} from "../contracts/puzzles";

/** Bot games are untimed; pure lead-in math needs a placeholder clock. */
const NOMINAL_TIME_CONTROL = { initialSeconds: 600, incrementSeconds: 0 };

const cellEq = (a: Cell, b: Cell): boolean => a[0] === b[0] && a[1] === b[1];
const manhattan = (a: Cell, b: Cell): number =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

const toPlayableConfig = (config: SavedPuzzleConfig): GameConfiguration =>
  ({
    ...config,
    randomStart: false,
    rated: false,
    timeControl: NOMINAL_TIME_CONTROL,
    variantConfig: config.initialState,
  }) as GameConfiguration;

/**
 * The bot's lead-in move per Nil's heuristic, or null when the human plays
 * P1 (no lead-in) OR no pawn heuristic applies (callers must fail closed —
 * see the header for why there is no wall fallback).
 */
export const computeLeadIn = (
  config: SavedPuzzleConfig,
): SavedPuzzleLeadIn | null => {
  if (config.initialState.turn.playerId !== 2) {
    return null;
  }
  if (config.variant !== "standard") {
    // The heuristic reasons about cat->mouse races; classic has homes.
    throw new Error(
      `lead-in heuristic only supports Standard positions, got ${config.variant}`,
    );
  }

  const state = new GameState(toPlayableConfig(config), 0);
  // Guarded above: this heuristic only runs on authored Standard positions, so all
  // four cat/mouse pawns exist.
  const botCat = requirePawnCell(state.pawns, 1, "cat");
  const botMouse = requirePawnCell(state.pawns, 1, "mouse");
  const humanCat = requirePawnCell(state.pawns, 2, "cat");
  const humanMouse = requirePawnCell(state.pawns, 2, "mouse");
  const grid = state.grid;
  const pawnCells = [botCat, botMouse, humanCat, humanMouse];

  const findCell = (predicate: (cell: Cell) => boolean): Cell | null => {
    // Lexicographic scan = deterministic tie-break.
    for (let row = 0; row < config.boardHeight; row++) {
      for (let col = 0; col < config.boardWidth; col++) {
        const cell: Cell = [row, col];
        if (pawnCells.some((pawn) => cellEq(pawn, cell))) continue;
        if (predicate(cell)) return cell;
      }
    }
    return null;
  };

  const catTargetDist = grid.distance(botCat, humanMouse);
  const catFrom = findCell(
    (cell) =>
      manhattan(cell, botCat) === 2 &&
      grid.distance(cell, botCat) === 2 &&
      grid.distance(cell, humanMouse) === catTargetDist + 2,
  );
  if (catFrom) {
    return { piece: "cat", from: catFrom };
  }

  const mouseThreatDist = grid.distance(botMouse, humanCat);
  const mouseFrom = findCell(
    (cell) =>
      manhattan(cell, botMouse) === 2 &&
      grid.distance(cell, botMouse) === 2 &&
      grid.distance(cell, humanCat) === mouseThreatDist - 2,
  );
  if (mouseFrom) {
    return { piece: "mouse", from: mouseFrom };
  }

  return null;
};

export interface LeadInLaunch {
  /** The curated config rewound one ply: bot piece on `from`, P1 to move. */
  preConfig: SavedPuzzleConfig;
  /** The bot's real ply-0 move (one action, Manhattan-2 target). */
  move: Move;
}

/**
 * The pre-position config and ply-0 move for a stored lead-in. Pure shape
 * construction; use validateLeadInReplay to prove it lands on the curated
 * position.
 */
export const buildLeadInLaunch = (
  config: SavedPuzzleConfig,
  leadIn: SavedPuzzleLeadIn,
): LeadInLaunch => {
  if (config.variant !== "standard") {
    throw new Error(
      `lead-in launch only supports Standard positions, got ${config.variant}`,
    );
  }
  const curatedTarget = config.initialState.pawns.p1[leadIn.piece];
  return {
    preConfig: {
      ...config,
      initialState: {
        ...config.initialState,
        pawns: {
          ...config.initialState.pawns,
          p1: {
            ...config.initialState.pawns.p1,
            [leadIn.piece]: leadIn.from,
          },
        },
        turn: { playerId: 1, actionsTaken: [] },
      },
    },
    move: {
      actions: [{ type: leadIn.piece, target: curatedTarget }],
    },
  };
};

export interface SavedPuzzleLaunch {
  /** What the game session is created from (pre-position for P2 puzzles). */
  config: {
    variant: SavedPuzzleConfig["variant"];
    boardWidth: number;
    boardHeight: number;
    randomStart: false;
    variantConfig: SavedPuzzleConfig["initialState"];
  };
  humanIsPlayer1: boolean;
  /** The bot's scripted ply-0 move, applied at creation; null for P1 puzzles. */
  leadInMove: Move | null;
}

/**
 * Server-authoritative launch derivation from a validated saved_puzzles row.
 * Enforces the seat<->lead-in invariant BOTH ways and re-proves the lead-in
 * replay, so a violating or corrupted row refuses to launch (fail closed) —
 * this is what keeps the migration->population rollout gap safe.
 */
export const resolveSavedPuzzleLaunch = (
  row: Pick<SavedPuzzleDbRow, "config" | "leadIn">,
): SavedPuzzleLaunch => {
  const humanPlaysAs = row.config.initialState.turn.playerId;
  if (humanPlaysAs === 2) {
    if (!row.leadIn) {
      throw new Error(
        "human-as-P2 puzzle has no lead-in (not yet populated) — refusing to launch",
      );
    }
    validateLeadInReplay(row.config, row.leadIn);
    const { preConfig, move } = buildLeadInLaunch(row.config, row.leadIn);
    return {
      config: {
        variant: preConfig.variant,
        boardWidth: preConfig.boardWidth,
        boardHeight: preConfig.boardHeight,
        randomStart: false,
        variantConfig: preConfig.initialState,
      },
      humanIsPlayer1: false,
      leadInMove: move,
    };
  }
  if (row.leadIn) {
    throw new Error(
      "human-as-P1 puzzle unexpectedly has a lead-in — refusing to launch",
    );
  }
  return {
    config: {
      variant: row.config.variant,
      boardWidth: row.config.boardWidth,
      boardHeight: row.config.boardHeight,
      randomStart: false,
      variantConfig: row.config.initialState,
    },
    humanIsPlayer1: true,
    leadInMove: null,
  };
};

/**
 * Replays the lead-in from the pre-position and asserts it reproduces the
 * curated position EXACTLY: still playing, history length 1, human (P2) to
 * move with a full turn, no lingering previous-pawn restriction, pawns and
 * walls (including wall ownership) identical to a fresh curated state.
 * Throws with a specific message on any mismatch. Returns nothing — this is
 * a validator, not the launch path.
 */
export const validateLeadInReplay = (
  config: SavedPuzzleConfig,
  leadIn: SavedPuzzleLeadIn,
): void => {
  const { preConfig, move } = buildLeadInLaunch(config, leadIn);
  const preState = new GameState(toPlayableConfig(preConfig), 0);
  const replayed = preState.applyGameAction({
    kind: "move",
    playerId: 1,
    move,
    timestamp: 1,
  });
  const curated = new GameState(toPlayableConfig(config), 0);

  if (replayed.status !== "playing") {
    throw new Error(`lead-in replay ended the game (${replayed.status})`);
  }
  if (replayed.history.length !== 1) {
    throw new Error(
      `lead-in replay history length ${replayed.history.length}, expected 1`,
    );
  }
  if (replayed.turn !== 2) {
    throw new Error(`lead-in replay turn ${replayed.turn}, expected 2`);
  }
  if (replayed.actionsRemaining !== 2) {
    throw new Error(
      `lead-in replay actionsRemaining ${replayed.actionsRemaining}, expected 2`,
    );
  }
  if (replayed.previousPawnPosition !== undefined) {
    throw new Error("lead-in replay left a previous-pawn restriction");
  }
  // Compared through boardPawns so each variant contributes exactly the
  // pawns it has, in a stable order.
  const replayedPawns = boardPawns(replayed.pawns);
  const curatedPawns = boardPawns(curated.pawns);
  const pawnsEqual =
    replayedPawns.length === curatedPawns.length &&
    replayedPawns.every((pawn, index) => {
      const other = curatedPawns[index];
      return (
        pawn.playerId === other.playerId &&
        pawn.type === other.type &&
        cellEq(pawn.cell, other.cell)
      );
    });
  if (!pawnsEqual) {
    throw new Error("lead-in replay pawns differ from the curated position");
  }
  const replayedWalls = JSON.stringify(replayed.grid.getWalls());
  const curatedWalls = JSON.stringify(curated.grid.getWalls());
  if (replayedWalls !== curatedWalls) {
    throw new Error(
      "lead-in replay walls (incl. ownership) differ from the curated position",
    );
  }
};
