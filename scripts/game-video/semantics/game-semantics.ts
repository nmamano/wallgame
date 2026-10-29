/**
 * The meaning of every move of past games: label, strength, links and one
 * sentence per move (facts.ts, labels.ts, sentences.ts).
 *
 *   bun scripts/game-video/semantics/game-semantics.ts \
 *     (--item ITEM.json | --candidates DAY.json [--game ID ...]) \
 *     --out DIR [--engine] [--sentences]
 *
 * THE GAMES COME FROM FILES THE DAILY JOB ALREADY WROTE: a daily item
 * (items/<id>.json, its `candidate`) or a candidates day file (its `ranked`
 * list). Both hold the moves and the start position, so this script reads no
 * database and loads no production page. It never writes those files.
 *
 * --engine scores each game with the evaluation bar's engine on the 4090
 * (engine-eval.ts: one extra engine over ssh at nice 10, the Warden's limits
 * of 2026-10-29: desktop-status before the run, one engine at a time, a few
 * minutes at most per run). It needs WALLGAME_GPU_HOST. The scores go to
 * DIR/<game>.engine.json; a later run without --engine reads them from there.
 * Without either, the engine labels (threat, blunder, turn, punish,
 * trap-closes) do not appear.
 *
 * --sentences asks a model for one sentence per move (sentences.ts) and
 * checks each against the move's facts.
 *
 * Writes DIR/<game>.semantics.json (everything) and DIR/<game>.md (the short
 * table for a person).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Variant } from "../../../shared/domain/game-types";
import { evalBarEngineFor } from "../daily-candidates";
import {
  EngineLink,
  engineConfig,
  gpuHostFromEnv,
  scoreGame,
} from "../engine-eval";
import { replayDistances } from "../race-replay";
import { gameFacts, type EngineData, type SemanticGame } from "./facts";
import { labelGame } from "./labels";
import { renderTable, writeSentences, type GameSemantics } from "./sentences";

interface Args {
  item?: string;
  candidates?: string;
  games: string[];
  out: string;
  engine: boolean;
  sentences: boolean;
}

const parseArgs = (argv: string[]): Args => {
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const out = value("out");
  if (!out) throw new Error("--out DIR is required");
  const args: Args = {
    item: value("item"),
    candidates: value("candidates"),
    games: argv.flatMap((a, i) =>
      a === "--game" && argv[i + 1] ? [argv[i + 1]] : [],
    ),
    out,
    engine: argv.includes("--engine"),
    sentences: argv.includes("--sentences"),
  };
  if (!args.item === !args.candidates) {
    throw new Error("give exactly one of --item or --candidates");
  }
  return args;
};

/** The fields a candidate (in an item or a day file) has for this script. */
type StoredCandidate = SemanticGame & { movesCount: number };

const asGame = (c: StoredCandidate): SemanticGame => ({
  gameId: c.gameId,
  variant: c.variant,
  boardWidth: c.boardWidth,
  boardHeight: c.boardHeight,
  initialState: c.initialState,
  moves: c.moves.map(String),
  seats: c.seats.map((s) => ({
    playerOrder: s.playerOrder,
    kind: s.kind,
    name: s.name,
  })),
});

const readGames = (args: Args): SemanticGame[] => {
  if (args.item) {
    const item = JSON.parse(readFileSync(args.item, "utf8")) as {
      candidate: StoredCandidate;
    };
    return [asGame(item.candidate)];
  }
  const day = JSON.parse(readFileSync(args.candidates!, "utf8")) as {
    ranked: StoredCandidate[];
  };
  return day.ranked
    .filter((c) => args.games.length === 0 || args.games.includes(c.gameId))
    .map(asGame);
};

const scoreOnGpu = async (games: SemanticGame[], dir: string) => {
  const gpuHost = gpuHostFromEnv("--engine");
  const config = engineConfig(gpuHost);
  const links = new Map<string, EngineLink>();
  try {
    for (const game of games) {
      const engine = evalBarEngineFor(
        config,
        game.variant as Variant,
        game.boardWidth,
        game.boardHeight,
      );
      if (!engine) {
        console.error(`${game.gameId}: no evaluation bar for this board`);
        continue;
      }
      let link = links.get(engine.command);
      if (!link || link.broken) {
        await link?.close();
        link = new EngineLink(gpuHost, engine.command);
        links.set(engine.command, link);
      }
      const replay = replayDistances(game);
      const last = replay.states.at(-1)!;
      const t0 = performance.now();
      const scored = await scoreGame(link, {
        ...game,
        winner:
          last.status === "finished" ? (last.result?.winner ?? null) : null,
      });
      const data: EngineData = {
        botId: engine.botId,
        evaluationsP1: scored.evaluations,
        bestMoves: scored.bestMoves,
        finalFromResult: scored.finalFromResult,
      };
      writeFileSync(
        join(dir, `${game.gameId}.engine.json`),
        JSON.stringify(data),
      );
      console.error(
        `engine scored ${game.gameId} (${game.moves.length} plies) in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
      );
    }
  } finally {
    for (const link of links.values()) await link.close();
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const games = readGames(args);
  if (args.engine) await scoreOnGpu(games, args.out);
  for (const game of games) {
    const enginePath = join(args.out, `${game.gameId}.engine.json`);
    const engine = existsSync(enginePath)
      ? (JSON.parse(readFileSync(enginePath, "utf8")) as EngineData)
      : null;
    const facts = gameFacts(game, engine);
    const labels = labelGame(facts);
    const semantics: GameSemantics = args.sentences
      ? writeSentences(facts, labels)
      : { facts, labels, sentences: null };
    writeFileSync(
      join(args.out, `${game.gameId}.semantics.json`),
      JSON.stringify(semantics, null, 1),
    );
    writeFileSync(join(args.out, `${game.gameId}.md`), renderTable(semantics));
    const counts = new Map<string, number>();
    for (const p of labels.plies)
      counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
    console.log(
      `${game.gameId}: ${[...counts].map(([l, n]) => `${l} ${n}`).join(", ")}${engine ? "" : " (no engine data)"}`,
    );
  }
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
