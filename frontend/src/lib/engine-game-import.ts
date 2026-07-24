// Import games recorded by the Deep-Wallwars engine into replayable GameStates.
//
// The engine's --ranking / evaluation modes write one JSON object per line
// (see deep-wallwars/src/game_recorder.cpp to_json):
//   {"creator": "model_36.trt", "joiner": "model_24.trt",
//    "rows": 10, "columns": 12, "moves": "1. >c2.>c1 2. >i2.>i1 3. ..."}
//
// Caveats of that format this module compensates for:
// - Every move is numbered (not turns): "1." is Red's move, "2." is Blue's, etc.
// - "rows"/"columns" are the MODEL FRAME dims. A game played at a smaller size
//   (e.g. 8x8 inside a 12x10 frame) records the frame dims; the carving walls
//   and shifted pawn starts are implicit in the engine's padding logic
//   (deep-wallwars/src/engine_adapter.cpp), which is ported here.
// - The variant is not recorded. Mouse moves ("M" actions) prove standard;
//   otherwise the caller must supply it.
import type {
  Cell,
  GameConfiguration,
  GameInitialState,
  PlayerId,
  WallOrientation,
  WallPosition,
} from "../../../shared/domain/game-types";
import { GameState } from "../../../shared/domain/game-state";
import { moveFromStandardNotation } from "../../../shared/domain/standard-notation";
import { buildStandardInitialState } from "../../../shared/domain/standard-setup";
import { buildClassicInitialState } from "../../../shared/domain/classic-setup";
import { BOT_GAME_TIME_CONTROL } from "../../../shared/domain/game-utils";

export interface EngineGameRecord {
  creator: string;
  joiner: string;
  rows: number; // model frame rows (board height)
  columns: number; // model frame columns (board width)
  moves: string;
}

export type EngineVariant = "standard" | "classic";

export interface ParsedEngineGames {
  records: EngineGameRecord[];
  errors: string[];
}

/**
 * Parse pasted text into engine game records. Accepts:
 * - one or more JSON lines (games.json format), or
 * - a bare moves string ("1. Ce4 2. ..."), for which the caller must know
 *   the frame dims (fallbackRows/fallbackColumns).
 */
export function parseEngineGameRecords(
  text: string,
  fallbackRows: number,
  fallbackColumns: number,
): ParsedEngineGames {
  const records: EngineGameRecord[] = [];
  const errors: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { records, errors };

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    // Bare moves string.
    records.push({
      creator: "Player 1",
      joiner: "Player 2",
      rows: fallbackRows,
      columns: fallbackColumns,
      moves: trimmed,
    });
    return { records, errors };
  }

  const pushRecord = (value: unknown, label: string) => {
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as EngineGameRecord).moves === "string" &&
      typeof (value as EngineGameRecord).rows === "number" &&
      typeof (value as EngineGameRecord).columns === "number"
    ) {
      const v = value as EngineGameRecord;
      records.push({
        creator: typeof v.creator === "string" ? v.creator : "Player 1",
        joiner: typeof v.joiner === "string" ? v.joiner : "Player 2",
        rows: v.rows,
        columns: v.columns,
        moves: v.moves,
      });
    } else {
      errors.push(`${label}: not a game record (need rows, columns, moves)`);
    }
  };

  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) {
        arr.forEach((item, i) => pushRecord(item, `entry ${i + 1}`));
      } else {
        errors.push("top-level JSON is not an array");
      }
    } catch (e) {
      errors.push(`JSON parse failed: ${e instanceof Error ? e.message : e}`);
    }
    return { records, errors };
  }

  trimmed.split("\n").forEach((line, i) => {
    const l = line.trim();
    if (!l) return;
    try {
      pushRecord(JSON.parse(l), `line ${i + 1}`);
    } catch (e) {
      errors.push(
        `line ${i + 1}: JSON parse failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  });
  return { records, errors };
}

/**
 * Mouse moves only exist in standard games; their absence proves nothing
 * (returns null = unknown, caller should let the user pick).
 */
export function inferVariant(moves: string): EngineVariant | null {
  return /(^|[\s.])M[a-z]\d/.test(moves) ? "standard" : null;
}

/** Split a moves string into move tokens, dropping the "N." numbering. */
export function tokenizeMoves(moves: string): string[] {
  return moves
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^\d+\.$/.test(t));
}

// ---------------------------------------------------------------------------
// Padding reconstruction (port of deep-wallwars/src/engine_adapter.cpp)
// ---------------------------------------------------------------------------

interface PaddingConfig {
  modelRows: number;
  modelCols: number;
  gameRows: number;
  gameCols: number;
  rowOffset: number;
  colOffset: number;
}

const createPaddingConfig = (
  modelRows: number,
  modelCols: number,
  gameRows: number,
  gameCols: number,
  variant: EngineVariant,
): PaddingConfig => ({
  modelRows,
  modelCols,
  gameRows,
  gameCols,
  // Standard embeds at top-left; Classic embeds at the bottom, horizontally
  // centered (left-biased), so the bottom row stays a path to the corner goals.
  rowOffset: variant === "standard" ? 0 : modelRows - gameRows,
  colOffset: variant === "standard" ? 0 : Math.floor((modelCols - gameCols) / 2),
});

/**
 * Collects walls in frontend coordinates while mirroring the engine's
 * is_blocked() semantics: border walls are skipped, duplicates are deduped.
 * Engine walls are addressed as (column, row) + Right/Down; frontend walls are
 * {cell: [row, col], orientation} where "vertical" sits right of the cell and
 * "horizontal" sits above it.
 */
class WallCollector {
  readonly walls: WallPosition[] = [];
  private seen = new Set<string>();

  constructor(
    private modelRows: number,
    private modelCols: number,
  ) {}

  /** Engine Wall::Right at (col, row): blocks (row,col) <-> (row,col+1). */
  addRight(col: number, row: number): void {
    if (col < 0 || row < 0 || row >= this.modelRows) return;
    if (col >= this.modelCols - 1) return; // board edge, engine treats as blocked
    this.add([row, col], "vertical");
  }

  /** Engine Wall::Down at (col, row): blocks (row,col) <-> (row+1,col). */
  addDown(col: number, row: number): void {
    if (col < 0 || col >= this.modelCols || row < 0) return;
    if (row >= this.modelRows - 1) return; // board edge
    this.add([row + 1, col], "horizontal");
  }

  private add(cell: Cell, orientation: WallOrientation): void {
    const key = `${orientation}:${cell[0]}:${cell[1]}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.walls.push({ cell, orientation });
  }
}

/** Port of place_padding_walls(). */
const buildPaddingWalls = (
  cfg: PaddingConfig,
  variant: EngineVariant,
): WallPosition[] => {
  const w = new WallCollector(cfg.modelRows, cfg.modelCols);

  if (variant === "standard") {
    // Bottom boundary of the game area.
    for (let col = 0; col < cfg.gameCols; col++) {
      w.addDown(col, cfg.gameRows - 1);
    }
    // Right boundary of the game area.
    for (let row = 0; row < cfg.gameRows; row++) {
      w.addRight(cfg.gameCols - 1, row);
    }
    // Fill the padding area so no wall slots remain open.
    for (let row = 0; row < cfg.modelRows; row++) {
      for (let col = 0; col < cfg.modelCols; col++) {
        if (row < cfg.gameRows && col < cfg.gameCols) continue;
        w.addRight(col, row);
        w.addDown(col, row);
      }
    }
    return w.walls;
  }

  // Classic: block the top padding rows entirely.
  for (let row = 0; row < cfg.rowOffset; row++) {
    for (let col = 0; col < cfg.modelCols; col++) {
      w.addDown(col, row);
      w.addRight(col, row);
    }
  }
  // Top boundary of the game area.
  if (cfg.rowOffset > 0) {
    for (let col = cfg.colOffset; col < cfg.colOffset + cfg.gameCols; col++) {
      w.addDown(col, cfg.rowOffset - 1);
    }
  }
  // Left boundary — bottom row stays open as the path to the corner goal.
  if (cfg.colOffset > 0) {
    for (let row = cfg.rowOffset; row < cfg.modelRows - 1; row++) {
      w.addRight(cfg.colOffset - 1, row);
    }
  }
  // Right boundary — same bottom-row exception.
  const rightBoundaryCol = cfg.colOffset + cfg.gameCols - 1;
  if (rightBoundaryCol < cfg.modelCols - 1) {
    for (let row = cfg.rowOffset; row < cfg.modelRows - 1; row++) {
      w.addRight(rightBoundaryCol, row);
    }
  }
  // Padding columns within the game rows (bottom row keeps Right walls open).
  for (let row = cfg.rowOffset; row < cfg.modelRows; row++) {
    for (let col = 0; col < cfg.modelCols; col++) {
      if (col >= cfg.colOffset && col < cfg.colOffset + cfg.gameCols) continue;
      w.addDown(col, row);
      if (row === cfg.modelRows - 1) continue;
      w.addRight(col, row);
    }
  }
  return w.walls;
};

/** Port of make_padded_training_board()'s pawn placement + wall setup. */
const buildEngineInitialState = (
  cfg: PaddingConfig,
  variant: EngineVariant,
): GameInitialState => {
  const needsPadding =
    cfg.gameRows !== cfg.modelRows || cfg.gameCols !== cfg.modelCols;
  if (!needsPadding) {
    // Engine default boards match the frontend defaults exactly.
    return variant === "classic"
      ? buildClassicInitialState(cfg.modelCols, cfg.modelRows)
      : buildStandardInitialState(cfg.modelCols, cfg.modelRows);
  }

  const walls = buildPaddingWalls(cfg, variant);
  const redCat: Cell = [cfg.rowOffset, cfg.colOffset];
  const blueCat: Cell = [cfg.rowOffset, cfg.colOffset + cfg.gameCols - 1];

  if (variant === "classic") {
    // Engine classic goals sit at the MODEL bottom corners (the padding leaves
    // the bottom row open as the path). Engine goal(Red) = blue's "mouse" at
    // bottom-right, which the frontend stores as p1.home (and vice versa).
    return {
      pawns: {
        p1: { cat: redCat, home: [cfg.modelRows - 1, cfg.modelCols - 1] },
        p2: { cat: blueCat, home: [cfg.modelRows - 1, 0] },
      },
      walls,
    };
  }
  return {
    pawns: {
      p1: {
        cat: redCat,
        mouse: [cfg.rowOffset + cfg.gameRows - 1, cfg.colOffset],
      },
      p2: {
        cat: blueCat,
        mouse: [
          cfg.rowOffset + cfg.gameRows - 1,
          cfg.colOffset + cfg.gameCols - 1,
        ],
      },
    },
    walls,
  };
};

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ImportedEngineGame {
  record: EngineGameRecord;
  variant: EngineVariant;
  gameRows: number;
  gameCols: number;
  config: GameConfiguration;
  /** Final state; .history holds one entry per successfully replayed move. */
  finalState: GameState;
  /** All move tokens from the record (including any that failed to replay). */
  moveNotations: string[];
  /** null = full clean replay; otherwise where/why the replay stopped. */
  replayError: string | null;
}

/**
 * Rebuild a full GameState (with per-move history snapshots) from an engine
 * record. gameRows/gameCols are the ACTUAL game size (the record only stores
 * the frame size) — pass the frame size for unpadded games.
 */
export function importEngineGame(
  record: EngineGameRecord,
  variant: EngineVariant,
  gameRows: number,
  gameCols: number,
  // Engine self-play always records Red first; human games (e.g. wallwars.net
  // imports) may start with either player, so the caller can override.
  firstPlayer: PlayerId = 1,
): ImportedEngineGame {
  const cfg = createPaddingConfig(
    record.rows,
    record.columns,
    gameRows,
    gameCols,
    variant,
  );
  const config: GameConfiguration = {
    variant,
    timeControl: BOT_GAME_TIME_CONTROL,
    rated: false,
    boardWidth: record.columns,
    boardHeight: record.rows,
    variantConfig: buildEngineInitialState(cfg, variant),
  };

  const moveNotations = tokenizeMoves(record.moves);
  let state = new GameState(config, 0);
  // GameState defaults to player 1 moving first; human imports may start with p2.
  state.turn = firstPlayer;
  let replayError: string | null = null;

  for (let i = 0; i < moveNotations.length; i++) {
    const notation = moveNotations[i];
    const other: PlayerId = firstPlayer === 1 ? 2 : 1;
    const playerId: PlayerId = i % 2 === 0 ? firstPlayer : other;
    try {
      const move = moveFromStandardNotation(notation, record.rows);
      state = state.applyGameAction({
        kind: "move",
        move,
        playerId,
        timestamp: 0,
      });
    } catch (e) {
      replayError = `Replay stopped at move ${i + 1} ("${notation}"): ${
        e instanceof Error ? e.message : e
      }`;
      break;
    }
    if (state.status !== "playing" && i < moveNotations.length - 1) {
      replayError = `Game ended at move ${i + 1} by frontend rules, but the record has ${moveNotations.length} moves.`;
      break;
    }
  }

  return {
    record,
    variant,
    gameRows,
    gameCols,
    config,
    finalState: state,
    moveNotations,
    replayError,
  };
}
