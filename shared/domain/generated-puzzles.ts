// AUTO-GENERATED puzzle candidates from real wallwars.net human games.
//
// Produced by the Phase 1 pipeline (see info/puzzle-generation.md):
//   wallwars Mongo export -> convert_wallwars_games.ts -> deep_ww --analyze_game_file
//   -> filter_puzzle_candidates.py -> build_puzzle_candidates.ts
//
// Each position was picked because the deep search (model_83, 10k visits) found exactly
// ONE move within 0.05 of best, that move beats the second-best by >= 0.15, and the
// network gave it a LOW raw prior - i.e. deep search finds it, pattern recognition
// nearly misses it. `moves` holds the engine key ACTION only, not the full 2-action
// turn, so these are not yet fully solvable end-to-end.

import type { Puzzle } from "./puzzles";
import type { WallPosition } from "./game-types";

const v = (row: number, col: number): WallPosition => ({ cell: [row, col], orientation: "vertical" });
const h = (row: number, col: number): WallPosition => ({ cell: [row, col], orientation: "horizontal" });

export const GENERATED_PUZZLES: Record<string, Puzzle> = {
  // source game 616e198107c0cd0018d6efe0 (Nilo vs MrPlanas), move 9
  // engine: root_q=0.521 best=>f8 (model) = >d8 (game)
  //         best_prior=0.0007 gap_to_second=1.105
  "11": {
    id: "11",
    title: "Generated: efe0 move 9",
    author: "deep-wallwars",
    difficulty: 1500,
    boardWidth: 8,
    boardHeight: 8,
    p1Cat: [4, 1],
    p1Home: [7, 7],
    p2Cat: [0, 5],
    p2Home: [7, 0],
    initialWalls: [v(1, 4), v(2, 4), v(3, 2), h(3, 5), h(3, 6), h(3, 7), h(4, 2)],
    humanPlaysAs: 2,
    moves: [[{ actions: [{ type: "wall", target: [0, 3], wallOrientation: "vertical" }] }]],
  },
  // source game 616e1b0a07c0cd0018d6efe1 (Nilo vs MrPlanas), move 6
  // engine: root_q=-0.661 best=Cat:Left (model) = Cf7 (game)
  //         best_prior=0.1150 gap_to_second=0.275
  "12": {
    id: "12",
    title: "Generated: efe1 move 6",
    author: "deep-wallwars",
    difficulty: 1500,
    boardWidth: 8,
    boardHeight: 8,
    p1Cat: [2, 2],
    p1Home: [7, 7],
    p2Cat: [1, 6],
    p2Home: [7, 0],
    initialWalls: [v(1, 4), v(1, 6), h(1, 6), h(2, 6), h(2, 7), h(3, 6)],
    humanPlaysAs: 2,
    moves: [[{ actions: [{ type: "cat", target: [1, 5] }] }]],
  },
  // source game 616e1b0a07c0cd0018d6efe1 (Nilo vs MrPlanas), move 8
  // engine: root_q=-0.408 best=^e6 (model) = ^c6 (game)
  //         best_prior=0.0232 gap_to_second=0.224
  "13": {
    id: "13",
    title: "Generated: efe1 move 8",
    author: "deep-wallwars",
    difficulty: 1500,
    boardWidth: 8,
    boardHeight: 8,
    p1Cat: [2, 2],
    p1Home: [7, 7],
    p2Cat: [1, 6],
    p2Home: [7, 0],
    initialWalls: [v(1, 4), h(1, 5), v(1, 6), h(1, 6), v(2, 4), v(2, 5), h(2, 6), h(2, 7), v(3, 4), h(3, 6)],
    humanPlaysAs: 2,
    moves: [[{ actions: [{ type: "wall", target: [2, 2], wallOrientation: "horizontal" }] }]],
  },
  // source game 616e5118101da00018174fa5 (Nilo vs Gabe), move 9
  // engine: root_q=0.487 best=Cat:Down (model) = Cg6 (game)
  //         best_prior=0.0955 gap_to_second=0.176
  "14": {
    id: "14",
    title: "Generated: 4fa5 move 9",
    author: "deep-wallwars",
    difficulty: 1500,
    boardWidth: 8,
    boardHeight: 8,
    p1Cat: [3, 1],
    p1Home: [7, 7],
    p2Cat: [1, 6],
    p2Home: [7, 0],
    initialWalls: [v(1, 4), v(1, 6), h(1, 6), h(3, 0), v(3, 1), h(3, 1), h(3, 2), h(3, 3), h(3, 6), h(4, 1)],
    humanPlaysAs: 2,
    moves: [[{ actions: [{ type: "cat", target: [2, 6] }] }]],
  },
  // source game 6170c5aef18edd0018e62133 (Nilo vs Rhona), move 8
  // engine: root_q=0.562 best=^g7 (model) = ^e7 (game)
  //         best_prior=0.0173 gap_to_second=0.817
  "15": {
    id: "15",
    title: "Generated: 2133 move 8",
    author: "deep-wallwars",
    difficulty: 1500,
    boardWidth: 8,
    boardHeight: 8,
    p1Cat: [0, 0],
    p1Home: [7, 7],
    p2Cat: [1, 6],
    p2Home: [7, 0],
    initialWalls: [v(0, 0), v(1, 0), v(1, 5), v(2, 1), h(2, 1), h(2, 6), h(3, 0), v(3, 1), h(4, 2), h(4, 3), h(5, 0), h(5, 1), h(5, 2), h(5, 3)],
    humanPlaysAs: 2,
    moves: [[{ actions: [{ type: "wall", target: [1, 4], wallOrientation: "horizontal" }] }]],
  },
};
