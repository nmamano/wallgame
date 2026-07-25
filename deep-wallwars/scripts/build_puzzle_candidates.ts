// Reconstruct playable positions for puzzle candidates.
//
// The analyzer's JSONL records the eval, per-action Q/prior and the cat cell, but NOT
// the wall state - so a candidate cannot be rendered from it alone. What identifies a
// candidate is (game_id, move_index), and we have the converted game's full move list,
// so we replay the game in GAME space and snapshot the position just before that move.
//
// NOTATION (verified empirically, see below): the engine's action strings come from
// operator<<(Action), which prints the RAW INTERNAL cell via
//   kColumnLabels = a..m, kRowLabels = {'1'..'9','X'}   ('X' = internal row 9)
// This is NOT the flipped "official row" notation that cell_notation()/the frontend's
// standard notation use - mixing them up silently produces a legal-but-wrong wall.
//   ">cell" = Wall::Right  -> frontend vertical   wall at the same cell
//   "^cell" = Wall::Down   -> frontend horizontal wall at [row + 1, col]
//   "Cat:Left" etc.        -> pawn move relative to the pawn's CURRENT cell
// Verified by mapping known human moves forward into engine notation and confirming the
// exact string appears in that position's edge list (5/5 matched).
//
// Frames: the analyzer runs the game embedded in the model's 12x10 frame, so its cat
// cell and action notation are in MODEL coords and get mapped back down.
//
// Usage:
//   bun deep-wallwars/scripts/build_puzzle_candidates.ts \
//     ~/nil/wallwars_games/candidates_8x8.json \
//     ~/nil/wallwars_games/games_converted.jsonl \
//     ~/nil/wallwars_games/puzzles_8x8.json

import type { Action, Cell, Move, PlayerId } from "../../shared/domain/game-types";
import { importEngineGame } from "../../frontend/src/lib/engine-game-import";

/** Engine kRowLabels: index = internal row, value = printed label. */
const ROW_LABELS = "123456789X";

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
  /** Full intended turn: BOTH actions (a turn is two actions). */
  best_turn?: [string, string];
  best_turn_actions?: [string, string];
  /** The engine's expected continuation, both sides, in play order. */
  pv_actions?: PvAction[];
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

interface Offsets {
  rowOffset: number;
  colOffset: number;
}

/** Classic embeds at the bottom, horizontally centered (left-biased). */
const classicOffsets = (
  modelRows: number,
  modelCols: number,
  gameRows: number,
  gameCols: number,
): Offsets => ({
  rowOffset: modelRows - gameRows,
  colOffset: Math.floor((modelCols - gameCols) / 2),
});

/** Parse the engine's raw-internal-cell notation ("g4", "bX") into a model cell. */
function parseEngineCell(text: string): Cell {
  const col = text.charCodeAt(0) - "a".charCodeAt(0);
  const row = ROW_LABELS.indexOf(text[1]);
  if (col < 0 || row < 0) {
    throw new Error(`cannot parse engine cell "${text}"`);
  }
  return [row, col];
}

/**
 * Map one engine action (MODEL space) to a game-space Action, given where the mover's
 * cat currently stands (needed for the relative "Cat:Left" form).
 */
function engineActionToGameAction(
  action: string,
  catGame: Cell,
  off: Offsets,
  gameRows: number,
  gameCols: number,
): Action {
  const dir = /^(Cat|Mouse):(Up|Down|Left|Right)$/.exec(action);
  if (dir) {
    // Internal rows grow downward, so Down = row + 1.
    const deltas: Record<string, [number, number]> = {
      Up: [-1, 0],
      Down: [1, 0],
      Left: [0, -1],
      Right: [0, 1],
    };
    const [dr, dc] = deltas[dir[2]];
    return {
      type: dir[1] === "Cat" ? "cat" : "mouse",
      target: [catGame[0] + dr, catGame[1] + dc],
    };
  }

  const sym = action[0];
  if (sym !== ">" && sym !== "^") {
    throw new Error(`unrecognized engine action: ${action}`);
  }
  const model = parseEngineCell(action.slice(1));
  // "^" is Wall::Down at `model`, which the frontend stores one row lower.
  const modelRow = sym === "^" ? model[0] + 1 : model[0];
  const target: Cell = [modelRow - off.rowOffset, model[1] - off.colOffset];
  if (
    target[0] < 0 ||
    target[1] < 0 ||
    target[0] >= gameRows ||
    target[1] >= gameCols
  ) {
    throw new Error(
      `action ${action} maps outside the ${gameRows}x${gameCols} game area: [${target}]`,
    );
  }
  return {
    type: "wall",
    target,
    wallOrientation: sym === ">" ? "vertical" : "horizontal",
  };
}

/**
 * Map a full engine turn, threading the cat position through pawn moves. Returns where
 * that cat ends up, because a principal variation continues for several turns and each
 * later "Cat:Left" is relative to wherever the cat stands by then.
 */
function engineTurnToMove(
  actions: string[],
  catGame: Cell,
  off: Offsets,
  gameRows: number,
  gameCols: number,
): { move: Move; cat: Cell } {
  let cat = catGame;
  const mapped: Action[] = [];
  for (const raw of actions) {
    const action = engineActionToGameAction(raw, cat, off, gameRows, gameCols);
    if (action.type === "cat") cat = action.target;
    mapped.push(action);
  }
  return { move: { actions: mapped }, cat };
}

interface PvAction {
  action: string;
  player: string;
  second: boolean;
}

/**
 * Turn the engine's principal variation into the alternating move sequence a Puzzle
 * already stores. `Puzzle.moves` is exactly "the human's turn, then the opponent's, then
 * the human's again", which is the same shape as a PV - so storing the line here costs no
 * new data model, and the puzzle's existing auto-reply plays the opponent's side for free.
 *
 * A turn is TWO actions, so PV actions are consumed in pairs. A trailing half-turn (the
 * PV was cut off mid-turn by the visit floor) is dropped: half a turn is not playable.
 */
function pvToMoves(
  pv: PvAction[],
  cats: [Cell, Cell],
  off: Offsets,
  gameRows: number,
  gameCols: number,
): Move[] {
  const moves: Move[] = [];
  const working: [Cell, Cell] = [cats[0], cats[1]];

  for (let i = 0; i + 1 < pv.length; i += 2) {
    const [first, second] = [pv[i], pv[i + 1]];
    // Both actions of a turn belong to the same side; anything else means the line is
    // not the clean alternation we assume, so stop rather than mis-attribute a move.
    if (first.player !== second.player || first.second || !second.second) break;
    const idx = first.player === "red" ? 0 : 1;
    const mapped = engineTurnToMove(
      [first.action, second.action],
      working[idx],
      off,
      gameRows,
      gameCols,
    );
    working[idx] = mapped.cat;
    moves.push(mapped.move);
  }
  return moves;
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
      console.error(`! ${c.game_id}: not in converted games`);
      continue;
    }

    const imported = importEngineGame(
      {
        creator: game.players[0],
        joiner: game.players[1],
        rows: game.rows,
        columns: game.columns,
        moves: game.moves,
      },
      "classic",
      game.rows,
      game.columns,
      game.firstPlayer,
    );
    if (imported.replayError) {
      console.error(`! ${c.game_id}: ${imported.replayError}`);
      continue;
    }

    const hist = imported.finalState.history;
    const prev = c.move_index - 1;
    if (prev >= hist.length) {
      console.error(`! ${c.game_id} mv${c.move_index}: beyond replay history`);
      continue;
    }
    const initial = imported.config.variantConfig as {
      pawns: { p1: { cat: Cell; home: Cell }; p2: { cat: Cell; home: Cell } };
      walls: { cell: Cell; orientation: "vertical" | "horizontal" }[];
    };
    const catPos: [Cell, Cell] =
      prev >= 0
        ? hist[prev].catPos
        : [initial.pawns.p1.cat, initial.pawns.p2.cat];
    const walls = prev >= 0 ? hist[prev].grid.getWalls() : initial.walls;

    const mover: PlayerId = c.player === "red" ? 1 : 2;
    const catGame = catPos[mover - 1];

    // Frame cross-check: analyzer cat (model) == game cat + embedding offsets.
    const off = classicOffsets(
      c.model_rows,
      c.model_columns,
      c.game_rows,
      c.game_columns,
    );
    const expectModel = [catGame[0] + off.rowOffset, catGame[1] + off.colOffset];
    const frameOk =
      expectModel[0] === c.cat_model[0] && expectModel[1] === c.cat_model[1];

    const turnActions = c.best_turn_actions ?? c.best_turn ?? [c.best_action];
    let solution: Move | null = null;
    let line: Move[] = [];
    let mapError = "";
    try {
      solution = engineTurnToMove(
        turnActions,
        catGame,
        off,
        c.game_rows,
        c.game_columns,
      ).move;
      // The whole expected line, when the analyzer recorded one. Its first turn is the
      // solution turn, so the line supersedes `solution` rather than following it.
      if (c.pv_actions?.length) {
        line = pvToMoves(
          c.pv_actions,
          [catPos[0], catPos[1]],
          off,
          c.game_rows,
          c.game_columns,
        );
      }
    } catch (e) {
      mapError = e instanceof Error ? e.message : String(e);
    }

    const describe = (a: Action) =>
      a.type === "wall"
        ? `${a.wallOrientation === "vertical" ? ">" : "^"}[${a.target}]`
        : `${a.type}->[${a.target}]`;

    console.log(
      `${c.game_id.slice(-4)} mv${c.move_index} ${c.player}: frame=${frameOk ? "OK" : "MISMATCH"} ` +
        `walls=${walls.length} line=${line.length} turns turn=[${turnActions.join(", ")}] -> ` +
        (solution ? solution.actions.map(describe).join(" + ") : `ERR ${mapError}`),
    );

    built.push({
      id: `gen-${c.game_id.slice(-6)}-${c.move_index}`,
      title: `Human game ${c.game_id.slice(-4)}, move ${c.move_index}`,
      author: "deep-wallwars",
      difficulty: 1500,
      boardWidth: game.columns,
      boardHeight: game.rows,
      p1Cat: catPos[0],
      p1Home: initial.pawns.p1.home,
      p2Cat: catPos[1],
      p2Home: initial.pawns.p2.home,
      initialWalls: walls,
      humanPlaysAs: mover,
      // Prefer the full engine line - it makes the puzzle multi-turn and, more to the
      // point, lets a reviewer walk the continuation instead of taking the first move on
      // faith. Falls back to the single solution turn when no line was recorded.
      moves: line.length > 0 ? line.map((m) => [m]) : solution ? [[solution]] : [],
      _meta: {
        source_game: c.game_id,
        move_index: c.move_index,
        root_q: c.root_q,
        best_prior: c.best_prior,
        gap: c.gap,
        engine_turn_model: turnActions,
        line_turns: line.length,
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
