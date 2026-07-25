// Reconstruct playable positions for puzzle candidates.
//
// The analyzer's JSONL records the eval, per-action Q/prior and the cat cell, but NOT
// the wall state - so a candidate cannot be rendered from it alone. What identifies a
// candidate is (game_id, move_index), and we have the converted game's full move list,
// so we replay the game in GAME space and snapshot the position just before that move.
//
// Coordinate frames: the analyzer runs the 8x8 game embedded in the model's 12x10
// frame, so its cat cell and best-move notation are in MODEL coords. The replay here is
// pure game space (the converted records carry the real board size), so the engine's
// best move has to be mapped back down. We verify the frames agree by checking the
// replayed cat against the analyzer's recorded cat.
//
// Usage:
//   bun deep-wallwars/scripts/build_puzzle_candidates.ts \
//     ~/nil/wallwars_games/candidates_8x8.json \
//     ~/nil/wallwars_games/games_converted.jsonl \
//     ~/nil/wallwars_games/puzzles_8x8.json

import type { Cell, Move, PlayerId } from "../../shared/domain/game-types";
import {
  cellFromStandardNotation,
  cellToStandardNotation,
} from "../../shared/domain/standard-notation";
import { importEngineGame } from "../../frontend/src/lib/engine-game-import";

interface Candidate {
  game_id: string;
  move_index: number;
  player: string;
  game_rows: number;
  game_columns: number;
  model_rows: number;
  model_columns: number;
  cat_model: [number, number];
  best_action: string;
  best_prior: number;
  gap: number;
  root_q: number;
}

interface ConvertedGame {
  id: string;
  rows: number;
  columns: number;
  firstPlayer: 1 | 2;
  players: string[];
  ratings: number[];
  moves: string;
}

/** Classic embeds at the bottom, horizontally centered (left-biased). */
const classicOffsets = (
  modelRows: number,
  modelCols: number,
  gameRows: number,
  gameCols: number,
) => ({
  rowOffset: modelRows - gameRows,
  colOffset: Math.floor((modelCols - gameCols) / 2),
});

/**
 * Map an engine action in MODEL space to a game-space Action.
 * Wall/pawn notation ("^g7", ">f8", "Cg7") carries a cell; "Cat:Left" style actions are
 * relative to the cat, so they need the cat's game-space cell to resolve a target.
 */
function engineActionToGameMove(
  action: string,
  catGame: Cell,
  cfg: { rowOffset: number; colOffset: number },
  modelRows: number,
  gameRows: number,
): Move {
  const dirMatch = /^(Cat|Mouse):(Up|Down|Left|Right)$/.exec(action);
  if (dirMatch) {
    // Internal rows grow downward, so Down = row + 1.
    const deltas: Record<string, [number, number]> = {
      Up: [-1, 0],
      Down: [1, 0],
      Left: [0, -1],
      Right: [0, 1],
    };
    const [dr, dc] = deltas[dirMatch[2]];
    return {
      actions: [
        {
          type: dirMatch[1] === "Cat" ? "cat" : "mouse",
          target: [catGame[0] + dr, catGame[1] + dc],
        },
      ],
    };
  }

  const sym = action[0];
  const isWall = sym === ">" || sym === "^";
  const isPawn = sym === "C" || sym === "M";
  if (!isWall && !isPawn) {
    throw new Error(`unrecognized engine action: ${action}`);
  }
  const modelCell = cellFromStandardNotation(action.slice(1), modelRows);
  const gameCell: Cell = [
    modelCell[0] - cfg.rowOffset,
    modelCell[1] - cfg.colOffset,
  ];
  if (
    gameCell[0] < 0 ||
    gameCell[1] < 0 ||
    gameCell[0] >= gameRows ||
    gameCell[1] >= gameRows
  ) {
    throw new Error(
      `action ${action} maps outside the game area: [${gameCell}] (offsets ${cfg.rowOffset},${cfg.colOffset})`,
    );
  }
  if (isWall) {
    return {
      actions: [
        {
          type: "wall",
          target: gameCell,
          wallOrientation: sym === ">" ? "vertical" : "horizontal",
        },
      ],
    };
  }
  return {
    actions: [{ type: sym === "C" ? "cat" : "mouse", target: gameCell }],
  };
}

async function main() {
  const [, , candPath, gamesPath, outPath] = process.argv;
  if (!candPath || !gamesPath || !outPath) {
    console.error(
      "usage: bun build_puzzle_candidates.ts <candidates.json> <games_converted.jsonl> <out.json>",
    );
    process.exit(1);
  }

  const cands = JSON.parse(await Bun.file(candPath).text()) as Candidate[];
  const games = new Map<string, ConvertedGame>();
  for (const line of (await Bun.file(gamesPath).text()).split("\n")) {
    if (!line.trim()) continue;
    const g = JSON.parse(line) as ConvertedGame;
    games.set(g.id, g);
  }

  const built: unknown[] = [];
  for (const c of cands) {
    const game = games.get(c.game_id);
    if (!game) {
      console.error(`! ${c.game_id}: not found in converted games`);
      continue;
    }

    // Replay in pure game space: the converted record's rows/columns ARE the real size.
    const imported = importEngineGame(
      { creator: game.players[0], joiner: game.players[1], rows: game.rows, columns: game.columns, moves: game.moves },
      "classic",
      game.rows,
      game.columns,
      game.firstPlayer,
    );
    if (imported.replayError) {
      console.error(`! ${c.game_id}: replay error: ${imported.replayError}`);
      continue;
    }

    // Position just BEFORE the candidate move = snapshot after the previous move.
    const hist = imported.finalState.history;
    const prev = c.move_index - 1;
    if (prev >= hist.length) {
      console.error(`! ${c.game_id} mv${c.move_index}: beyond replay history`);
      continue;
    }
    const initial = imported.config.variantConfig;
    const grid = prev >= 0 ? hist[prev].grid : null;
    const catPos: [Cell, Cell] =
      prev >= 0
        ? hist[prev].catPos
        : [
            (initial as { pawns: { p1: { cat: Cell } } }).pawns.p1.cat,
            (initial as { pawns: { p2: { cat: Cell } } }).pawns.p2.cat,
          ];
    const walls = grid ? grid.getWalls() : initial.walls;

    const mover: PlayerId = c.player === "red" ? 1 : 2;
    const catGame = catPos[mover - 1];

    // Frame cross-check: analyzer cat (model) must equal game cat + embedding offsets.
    const cfg = classicOffsets(c.model_rows, c.model_columns, c.game_rows, c.game_columns);
    const expectModel = [catGame[0] + cfg.rowOffset, catGame[1] + cfg.colOffset];
    const frameOk =
      expectModel[0] === c.cat_model[0] && expectModel[1] === c.cat_model[1];

    let solution: Move | null = null;
    let solutionNotation = "";
    let mapError = "";
    try {
      solution = engineActionToGameMove(
        c.best_action,
        catGame,
        cfg,
        c.model_rows,
        c.game_rows,
      );
      const a = solution.actions[0];
      solutionNotation =
        (a.type === "wall"
          ? a.wallOrientation === "vertical"
            ? ">"
            : "^"
          : a.type === "cat"
            ? "C"
            : "M") + cellToStandardNotation(a.target, game.rows);
    } catch (e) {
      mapError = e instanceof Error ? e.message : String(e);
    }

    const p1 = (initial as { pawns: { p1: { cat: Cell; home: Cell } } }).pawns.p1;
    const p2 = (initial as { pawns: { p2: { cat: Cell; home: Cell } } }).pawns.p2;

    console.log(
      `${c.game_id.slice(-4)} mv${c.move_index} ${c.player}: frame=${frameOk ? "OK" : "MISMATCH"} ` +
        `cat_game=[${catGame}] cat_model=[${c.cat_model}] expect=[${expectModel}] ` +
        `walls=${walls.length} best=${c.best_action}->${solutionNotation || "ERR:" + mapError}`,
    );

    built.push({
      id: `gen-${c.game_id.slice(-6)}-${c.move_index}`,
      title: `Human game ${c.game_id.slice(-4)}, move ${c.move_index}`,
      author: "auto-generated (deep-wallwars)",
      difficulty: 1500,
      boardWidth: game.columns,
      boardHeight: game.rows,
      p1Cat: catPos[0],
      p1Home: p1.home,
      p2Cat: catPos[1],
      p2Home: p2.home,
      initialWalls: walls,
      humanPlaysAs: mover,
      // NOTE: the engine's root edges are FIRST ACTIONS of a turn, so this is the key
      // action only, not the complete 2-action turn.
      moves: solution ? [[solution]] : [],
      _meta: {
        source_game: c.game_id,
        move_index: c.move_index,
        root_q: c.root_q,
        best_prior: c.best_prior,
        gap: c.gap,
        engine_action_model: c.best_action,
        solution_notation_game: solutionNotation,
        frame_check_ok: frameOk,
        players: game.players,
        ratings: game.ratings,
      },
    });
  }

  await Bun.write(outPath, JSON.stringify(built, null, 1));
  console.log(`\nwrote ${built.length} reconstructed positions -> ${outPath}`);
}

main();
