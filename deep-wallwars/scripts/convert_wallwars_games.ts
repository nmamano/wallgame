// Convert exported wallwars.net games (internal numeric grid notation) into
// wallgame-native form, validated by replaying through importEngineGame.
//
// Input:  a JSONL export of the wallwars `games` collection (see
//         ~/nil/wallwars_games/games_raw.jsonl). Each line:
//   { id, dims:[gridRows,gridCols], startPos, goalPos, players, ratings,
//     winner, finishReason, numMoves, moves: Turn[] }
//   where each Turn is an array of 1-2 numeric actions [gr,gc] in the DOUBLED
//   internal grid (cells at even/even, walls at even/odd or odd/even).
//
// Output: JSONL of converted games, each with the real board size, a
//   standard-notation `moves` string (engine-readable), the parsed metadata,
//   and a replay-validation verdict. Games that don't replay cleanly are
//   reported but kept out of the "ok" output.
//
// Usage (from repo root):
//   bun deep-wallwars/scripts/convert_wallwars_games.ts \
//     ~/nil/wallwars_games/games_raw.jsonl ~/nil/wallwars_games/games_converted.jsonl

import type { Action, Move } from "../../shared/domain/game-types";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import {
  importEngineGame,
  type EngineGameRecord,
} from "../../frontend/src/lib/engine-game-import";

interface RawGame {
  id: string;
  dims: [number, number]; // [gridRows, gridCols], doubled grid
  startPos: [number, number][];
  goalPos: [number, number][];
  players: string[];
  ratings: number[];
  winner: string;
  finishReason: string;
  numMoves: number;
  creatorStarts: boolean;
  finalDists: [number, number] | null;
  moves: [number, number][][]; // Turn[] -> Action[] -> [gr, gc]
}

// One numeric grid coord [gr,gc] -> one wallgame Action.
//   even/even -> cat move to destination cell [gr/2, gc/2]
//   even/odd  -> vertical wall right of cell [gr/2, (gc-1)/2]
//   odd/even  -> horizontal wall below cell -> wallgame [(gr+1)/2, gc/2]
function gridCoordToAction(gr: number, gc: number): Action {
  const grEven = gr % 2 === 0;
  const gcEven = gc % 2 === 0;
  if (grEven && gcEven) {
    return { type: "cat", target: [gr / 2, gc / 2] };
  }
  if (grEven && !gcEven) {
    return {
      type: "wall",
      target: [gr / 2, (gc - 1) / 2],
      wallOrientation: "vertical",
    };
  }
  if (!grEven && gcEven) {
    return {
      type: "wall",
      target: [(gr + 1) / 2, gc / 2],
      wallOrientation: "horizontal",
    };
  }
  throw new Error(`Both grid coords odd (joint, not an action): [${gr},${gc}]`);
}

function turnToMove(turn: [number, number][]): Move {
  return { actions: turn.map(([gr, gc]) => gridCoordToAction(gr, gc)) };
}

interface ConvertedGame {
  id: string;
  variant: "classic";
  rows: number; // real board height
  columns: number; // real board width
  players: string[];
  ratings: number[];
  winner: string;
  finishReason: string;
  numMoves: number;
  moves: string; // standard notation, "1. .. 2. .." style
  finalDistsExpected: [number, number] | null;
  finalDistsReplayed: [number, number] | null;
  replayError: string | null;
  // True only for the fixed wallgame-classic layout (cats at top corners,
  // homes at diagonally opposite bottom corners). wallwars.net also allowed
  // custom cat starts / center goals, which wallgame.io classic can't express.
  classicGeometry: boolean;
}

// Does this game's DB start/goal match the fixed wallgame-classic layout?
// grid coords: cats at [0,0]/[0,gC-1], goals at [gR-1,gC-1]/[gR-1,0].
function isClassicGeometry(raw: RawGame): boolean {
  const [gR, gC] = raw.dims;
  const sp = raw.startPos;
  const gp = raw.goalPos;
  if (!sp || !gp || sp.length !== 2 || gp.length !== 2) return false;
  const eq = (a: [number, number], b: [number, number]) =>
    a[0] === b[0] && a[1] === b[1];
  return (
    eq(sp[0], [0, 0]) &&
    eq(sp[1], [0, gC - 1]) &&
    eq(gp[0], [gR - 1, gC - 1]) &&
    eq(gp[1], [gR - 1, 0])
  );
}

function convert(raw: RawGame): ConvertedGame {
  const rows = (raw.dims[0] + 1) / 2;
  const columns = (raw.dims[1] + 1) / 2;

  const perTurn = raw.moves.map(turnToMove);
  // Serialize to a numbered standard-notation string, one token per turn.
  const moves = perTurn
    .map((mv, i) => `${i + 1}. ${moveToStandardNotation(mv, rows)}`)
    .join(" ");

  let finalDistsReplayed: [number, number] | null = null;
  let replayError: string | null = null;
  try {
    const record: EngineGameRecord = {
      creator: raw.players?.[0] ?? "Player 1",
      joiner: raw.players?.[1] ?? "Player 2",
      rows,
      columns,
      moves,
    };
    // creator = players[0] = Red = p1 (top-left), matching importEngineGame.
    const firstPlayer = raw.creatorStarts ? 1 : 2;
    const imported = importEngineGame(
      record,
      "classic",
      rows,
      columns,
      firstPlayer,
    );
    replayError = imported.replayError;
    // Final cat-to-goal graph distances (classic goal = player's own home).
    const st = imported.finalState;
    finalDistsReplayed = [
      st.grid.distance(st.pawns[1].cat, st.goalCell(1)),
      st.grid.distance(st.pawns[2].cat, st.goalCell(2)),
    ];
  } catch (e) {
    replayError = e instanceof Error ? e.message : String(e);
  }

  return {
    id: raw.id,
    variant: "classic",
    rows,
    columns,
    players: raw.players,
    ratings: raw.ratings,
    winner: raw.winner,
    finishReason: raw.finishReason,
    numMoves: raw.numMoves,
    moves,
    finalDistsExpected: raw.finalDists ?? null,
    finalDistsReplayed,
    replayError,
    classicGeometry: isClassicGeometry(raw),
  };
}

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error(
      "usage: bun convert_wallwars_games.ts <in.jsonl> <out.jsonl>",
    );
    process.exit(1);
  }
  const text = await Bun.file(inPath).text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  const converted: ConvertedGame[] = [];
  const bySize: Record<string, number> = {};
  let ok = 0;
  let replayFail = 0;
  let convertFail = 0;

  for (const line of lines) {
    let raw: RawGame;
    try {
      raw = JSON.parse(line) as RawGame;
    } catch {
      convertFail++;
      continue;
    }
    let cg: ConvertedGame;
    try {
      cg = convert(raw);
    } catch (e) {
      convertFail++;
      converted.push({
        id: raw.id,
        variant: "classic",
        rows: (raw.dims[0] + 1) / 2,
        columns: (raw.dims[1] + 1) / 2,
        players: raw.players,
        ratings: raw.ratings,
        winner: raw.winner,
        finishReason: raw.finishReason,
        numMoves: raw.numMoves,
        moves: "",
        finalDistsExpected: null,
        finalDistsReplayed: null,
        replayError: `convert threw: ${e instanceof Error ? e.message : e}`,
        classicGeometry: isClassicGeometry(raw),
      });
      continue;
    }
    const sizeKey = `${cg.rows}x${cg.columns}`;
    bySize[sizeKey] = (bySize[sizeKey] || 0) + 1;
    if (cg.replayError === null) ok++;
    else replayFail++;
    converted.push(cg);
  }

  // In scope = fixed wallgame-classic layout AND a clean rules-legal replay.
  const okGames = converted.filter(
    (c) => c.replayError === null && c.classicGeometry,
  );
  const skippedNonClassic = converted.filter(
    (c) => c.replayError === null && !c.classicGeometry,
  ).length;
  console.log(`Skipped non-classic geometry (clean replay): ${skippedNonClassic}`);
  await Bun.write(
    outPath,
    okGames.map((c) => JSON.stringify(c)).join("\n") + "\n",
  );

  console.log(`Total games:      ${lines.length}`);
  console.log(`Clean replay:     ${ok}`);
  console.log(`Replay failed:    ${replayFail}`);
  console.log(`Convert failed:   ${convertFail}`);
  console.log(`By size (all):    ${JSON.stringify(bySize)}`);
  const okBySize: Record<string, number> = {};
  for (const c of okGames) {
    const k = `${c.rows}x${c.columns}`;
    okBySize[k] = (okBySize[k] || 0) + 1;
  }
  console.log(`By size (ok):     ${JSON.stringify(okBySize)}`);

  // Cross-check replayed final cat distances against the DB's finalDists.
  let distMatch = 0;
  let distMismatch = 0;
  let distMissing = 0;
  const mismatches: string[] = [];
  for (const c of okGames) {
    if (!c.finalDistsExpected || !c.finalDistsReplayed) {
      distMissing++;
      continue;
    }
    const [e0, e1] = c.finalDistsExpected;
    const [r0, r1] = c.finalDistsReplayed;
    if (e0 === r0 && e1 === r1) distMatch++;
    else {
      distMismatch++;
      if (mismatches.length < 8) {
        mismatches.push(
          `  ${c.id} ${c.rows}x${c.columns}: db=[${e0},${e1}] replay=[${r0},${r1}]`,
        );
      }
    }
  }
  console.log(
    `finalDists match: ${distMatch}  mismatch: ${distMismatch}  missing: ${distMissing}`,
  );
  if (mismatches.length) {
    console.log(`Sample dist mismatches:\n${mismatches.join("\n")}`);
  }

  // Show a few replay failures for diagnosis.
  const fails = converted
    .filter((c) => c.replayError !== null)
    .slice(0, 8)
    .map((c) => `  ${c.id} ${c.rows}x${c.columns}: ${c.replayError}`);
  if (fails.length) {
    console.log(`Sample failures:\n${fails.join("\n")}`);
  }
  console.log(`Wrote ${okGames.length} ok games -> ${outPath}`);
}

main();
