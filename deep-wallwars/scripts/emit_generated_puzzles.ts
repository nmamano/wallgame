// Render reconstructed candidates as shared/domain/generated-puzzles.ts.
//
// The last mile of the pipeline (see info/puzzle-generation.md):
//   deep_ww --analyze_game_file -> filter_puzzle_candidates.py --json
//   -> build_puzzle_candidates.ts -> THIS -> shared/domain/generated-puzzles.ts
//
// IMPORTANT: the generated puzzles are deliberately NOT spread into PUZZLES in
// shared/domain/puzzles.ts (commit 8a30efc), so writing this file does not ship anything.
// To playtest them, add the spread as a LOCAL, UNCOMMITTED change - unvetted candidates
// must never reach the deployed site.
//
// Usage:
//   bun deep-wallwars/scripts/emit_generated_puzzles.ts \
//     ~/nil/wallwars_games/puzzles_v2.json shared/domain/generated-puzzles.ts

import type { Cell, Move, PlayerId, WallPosition } from "../../shared/domain/game-types";

interface BuiltPuzzle {
  id: string;
  title: string;
  author: string;
  difficulty: number;
  boardWidth: number;
  boardHeight: number;
  p1Cat: Cell;
  p1Home: Cell;
  p2Cat: Cell;
  p2Home: Cell;
  initialWalls: WallPosition[];
  humanPlaysAs: PlayerId;
  moves: Move[][];
  _meta: {
    source_game: string;
    move_index: number;
    root_q: number;
    best_prior: number;
    gap: number;
    engine_turn_model: string[];
    line_turns?: number;
    forced_turns?: number;
    adv_before?: number;
    immediate?: number | null;
    swing?: number;
    theme?: string;
    players?: string[];
  };
}

/** Walls render through the v()/h() helpers the file defines, to keep it readable. */
const wall = (w: WallPosition) =>
  `${w.orientation === "vertical" ? "v" : "h"}(${w.cell[0]}, ${w.cell[1]})`;

const action = (a: Move["actions"][number]) =>
  a.type === "wall"
    ? `{ type: "wall", target: [${a.target}], wallOrientation: "${a.wallOrientation}" }`
    : `{ type: "${a.type}", target: [${a.target}] }`;

const move = (m: Move) => `{ actions: [${m.actions.map(action).join(", ")}] }`;

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error(
      "usage: bun emit_generated_puzzles.ts <puzzles.json> <generated-puzzles.ts>",
    );
    process.exit(1);
  }

  const built = JSON.parse(await Bun.file(inPath).text()) as BuiltPuzzle[];

  const header = `// AUTO-GENERATED puzzle candidates from real wallwars.net human games.
//
// Written by deep-wallwars/scripts/emit_generated_puzzles.ts. Do not edit by hand.
//
// Selected by filter v2 (see info/puzzle-generation.md), which requires the position to
// have one clearly-best move that does NOT change the distance count when played, an
// opponent whose replies are near-unique for the first turns, and a line that DOES change
// the count by its end. \`moves\` holds the engine's whole principal variation, both sides,
// so the continuation can be walked in the puzzle UI - a quiet move cannot be judged from
// the move alone.
//
// These are UNVETTED candidates and are deliberately not spread into PUZZLES.

import type { Puzzle } from "./puzzles";
import type { WallPosition } from "./game-types";

const v = (row: number, col: number): WallPosition => ({ cell: [row, col], orientation: "vertical" });
const h = (row: number, col: number): WallPosition => ({ cell: [row, col], orientation: "horizontal" });

export const GENERATED_PUZZLES: Record<string, Puzzle> = {
`;

  const body = built
    .map((p, i) => {
      const id = String(11 + i);
      const m = p._meta;
      const who = m.players?.length ? ` (${m.players.join(" vs ")})` : "";
      return (
        `  // source game ${m.source_game}${who}, move ${m.move_index}\n` +
        `  // engine: root_q=${m.root_q.toFixed(3)} turn=[${m.engine_turn_model.join(", ")}] (model notation)\n` +
        `  //         prior=${m.best_prior.toFixed(4)} gap=${m.gap.toFixed(3)} ` +
        `forced_turns=${m.forced_turns ?? "?"} swing=${m.swing ?? "?"} ` +
        `immediate=${m.immediate ?? "?"} theme=${m.theme ?? "?"}\n` +
        `  "${id}": {\n` +
        `    id: "${id}",\n` +
        `    title: ${JSON.stringify(`${m.theme === "save" ? "Save" : "Winning shot"}: ${m.source_game.slice(-4)} move ${m.move_index}`)},\n` +
        `    author: "deep-wallwars",\n` +
        `    difficulty: ${p.difficulty},\n` +
        `    boardWidth: ${p.boardWidth},\n` +
        `    boardHeight: ${p.boardHeight},\n` +
        `    p1Cat: [${p.p1Cat}],\n` +
        `    p1Home: [${p.p1Home}],\n` +
        `    p2Cat: [${p.p2Cat}],\n` +
        `    p2Home: [${p.p2Home}],\n` +
        `    initialWalls: [${p.initialWalls.map(wall).join(", ")}],\n` +
        `    humanPlaysAs: ${p.humanPlaysAs},\n` +
        `    moves: [${p.moves.map((alts) => `[${alts.map(move).join(", ")}]`).join(", ")}],\n` +
        `  },\n`
      );
    })
    .join("");

  await Bun.write(outPath, header + body + "};\n");
  console.log(`wrote ${built.length} puzzles (ids 11-${10 + built.length}) -> ${outPath}`);
}

main();
