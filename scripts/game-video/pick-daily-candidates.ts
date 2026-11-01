/**
 * Lists the finished games that can be the daily video and the moves a viewer
 * can see turn the race, and prints the best candidates with those moves.
 *
 * Board task e8d26610. It posts nothing and renders nothing. The rules (who is
 * eligible, what a jump is) live in daily-candidates.ts.
 *
 *   bun scripts/game-video/pick-daily-candidates.ts --container wgvideo-restore \
 *     --until 2026-10-25T10:20:48Z [--days 7] [--top 5] [--game ID ...] [--out F]
 *     [--engine] [--nil-seat]
 *
 * A member's seat other than Nil's is named by its colour, never by its
 * display name (memberSeatName; Nil, 2026-11-01).
 *
 * --nil-seat keeps only games with a Nil seat (nilGameEligibility), for a
 * by-hand report of Nil's own games over a long --days window.
 *
 * THE GAMES COME FROM A RESTORED COPY, NEVER FROM PRODUCTION. --container names
 * a local PostgreSQL container that holds a restored nightly dump; the script
 * reads it with `docker exec ... psql` and one SELECT. It does not call
 * GET /api/games/:id, which writes a view count (server/db/game-queries.ts).
 *
 * THE DAILY RUN NEEDS NO ENGINE. Picks come from walking distances on the
 * board (Nil, 2026-10-26), computed here on the office box.
 *
 * --engine ADDS THE EVALUATION BAR'S SCORE AS A DEBUG COLUMN. It needs
 * WALLGAME_GPU_HOST, the ssh target of the 4090's WSL (an env var only because
 * the repo is public; the value is in ops-private/wallgamer-agent-notes.md).
 * Before such a run: run ~/nil/infra/bin/desktop-status on the office box and
 * stay in its thread budget, keep the GPU headroom the live bot's engines
 * need, and tell the Warden, who owns the 4090. How the engine runs, and what
 * it never touches: engine-eval.ts.
 */
import { writeFileSync } from "node:fs";
import type { ConfigFile } from "../../official-custom-bot-client/src/config-schema";
import type {
  GameInitialState,
  GameResult,
  PlayerId,
  Variant,
} from "../../shared/domain/game-types";
import {
  closeCallsOf,
  describeCloseCall,
  describeEscape,
  describeJump,
  escapesOf,
  pickBoard,
  evalBarEngineFor,
  gameEligibility,
  jumpsOf,
  memberSeatName,
  nilGameEligibility,
  oneExitLoss,
  unknownBotNames,
  pickJumps,
  PICKS_PER_GAME,
  rankCandidates,
  swingsOf,
  type DescribedCloseCall,
  type DescribedEscape,
  type PickedJump,
  type PlyBoard,
  type SeatKind,
  type StoredGameSummary,
  type Swing,
} from "./daily-candidates";
import { dailySeatColors } from "./edl.mjs";
import { siteMove } from "./site-move.mjs";
import {
  EngineLink,
  engineConfig,
  gpuHostFromEnv,
  scoreGame,
} from "./engine-eval";
import { minJumpFor, replayDistances, type RaceDistances } from "./race-replay";

/* ------------------------------------------------------------------ args -- */

interface Args {
  /** Set only with --engine. */
  gpuHost?: string;
  container: string;
  database: string;
  until: Date;
  days: number;
  top: number;
  games: string[];
  /** --nil-seat: only games with a Nil seat. */
  nilSeat: boolean;
  out: string;
}

const parseArgs = (argv: string[]): Args => {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const gpuHost = argv.includes("--engine")
    ? gpuHostFromEnv("--engine")
    : undefined;
  const container = value("container");
  if (!container || !/^[A-Za-z0-9_.-]+$/.test(container)) {
    throw new Error("--container <local postgres container> is required");
  }
  const until = new Date(value("until") ?? Date.now());
  if (Number.isNaN(until.getTime())) throw new Error("--until is not a date");
  const games = argv.flatMap((a, i) =>
    a === "--game" && argv[i + 1] ? [argv[i + 1]] : [],
  );
  const stamp = until.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return {
    gpuHost,
    container,
    database: value("database") ?? "wallgame",
    until,
    days: Number(value("days") ?? 7),
    top: Number(value("top") ?? 5),
    games,
    nilSeat: argv.includes("--nil-seat"),
    out: value("out") ?? `/tmp/daily-candidates-${stamp}Z.json`,
  };
};

/* ------------------------------------------------------------- database -- */

interface StoredGame extends StoredGameSummary {
  startedAt: string;
  moves: string[];
  configParameters: { initialState?: GameInitialState };
}

/**
 * One row per game, with its seats as a JSON array: a join of games with
 * game_players would return a bot-vs-bot game as two rows.
 */
const GAMES_SQL = `
select coalesce(json_agg(g order by g."startedAt"), '[]'::json) from (
  select ga.game_id as "gameId", ga.variant, ga.board_width as "boardWidth",
    ga.board_height as "boardHeight", ga.moves_count as "movesCount",
    ga.puzzle_id as "puzzleId", ga.started_at as "startedAt", ga.rated,
    coalesce(gd.moves, '[]'::jsonb) as moves,
    coalesce(gd.config_parameters, '{}'::jsonb) as "configParameters",
    (select coalesce(json_agg(json_build_object(
        'playerOrder', p.player_order,
        'playerConfigType', p.player_config_type,
        'displayName', p.display_name,
        'userId', p.user_id,
        'botId', p.bot_id,
        'botIsOfficial', b.is_official,
        'outcomeRank', p.outcome_rank,
        'outcomeReason', p.outcome_reason,
        'ratingAtStart', p.rating_at_start) order by p.player_order), '[]'::json)
      from game_players p left join built_in_bots b on b.bot_id = p.bot_id
      where p.game_id = ga.game_id) as seats
  from games ga left join game_details gd on gd.game_id = ga.game_id
  where ga.started_at >= :'since'::timestamptz
    and ga.started_at < :'until'::timestamptz
) g;
`;

const readGames = (args: Args): StoredGame[] => {
  const since = new Date(args.until.getTime() - args.days * 86_400_000);
  const proc = Bun.spawnSync({
    cmd: [
      "docker",
      "exec",
      "-i",
      args.container,
      "psql",
      "-X",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      args.database,
      "-v",
      `since=${since.toISOString()}`,
      "-v",
      `until=${args.until.toISOString()}`,
    ],
    stdin: Buffer.from(GAMES_SQL),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`psql failed: ${proc.stderr.toString().slice(0, 500)}`);
  }
  return JSON.parse(proc.stdout.toString()) as StoredGame[];
};

/* ----------------------------------------------------------------- main -- */

interface EngineColumn {
  botId: string;
  scoreSeconds: number;
  evaluationsP1: number[];
  /**
   * The final position's value is the game result, because the engine
   * refused it (as the bar does). A swing on the last move is then not the
   * engine's opinion.
   */
  finalFromResult: boolean;
  topSwings: Swing[];
}

interface Candidate {
  gameId: string;
  startedAt: string;
  variant: string;
  boardWidth: number;
  boardHeight: number;
  movesCount: number;
  /**
   * Every ply's standard notation, 0-based, movesCount long: the app checks an
   * edit list against it before it renders, without loading the game again.
   */
  moves: string[];
  /**
   * The stored start position (config_parameters.initialState): with `moves`
   * it replays the game through replayDistances, with no production view.
   */
  initialState: GameInitialState;
  /** games.rated. */
  rated: boolean;
  /** rating: game_players.rating_at_start (null for a custom bot). */
  seats: {
    playerOrder: number;
    kind: SeatKind;
    name: string;
    rating: number | null;
  }[];
  /**
   * The stored result (game_players outcome_rank and outcome_reason). A game
   * with no winner is not a candidate, so `winner` is always set.
   */
  result: GameResult & { winner: PlayerId };
  /** Before each move, and after the last: movesCount + 1 entries. */
  distances: RaceDistances[];
  /** The smallest jump that is a pick in this variant (minJumpFor). */
  minJump: number;
  picks: PickedJump[];
  /** Close calls (danger, save, relief), largest save first; may be []. */
  beats: DescribedCloseCall[];
  /** Escapes by a prey's own move, largest first; may be []. */
  escapes: DescribedEscape[];
  /**
   * Only with --engine. An engine failure is written here and does not take
   * the game out: the debug column cannot remove a candidate.
   */
  engine?: EngineColumn | { error: string };
}

const walk = (n: number | null) => (n === null ? "-" : String(n));

/** The walls the zoom aims at, e.g. "zoom >e4" or "zoom >e4 + ^f5 together". */
const zoom = (board: PlyBoard): string => {
  const causes = board.walls.filter((w) => w.cause).map((w) => w.notation);
  if (causes.length === 0) return "zoom: no wall, the pawns";
  return `zoom ${causes.join(" + ")}${board.together ? " together" : ""}`;
};

const describe = (c: Candidate, rank: number): string => {
  const seats = c.seats
    .map((s) => `P${s.playerOrder} ${s.name} (${s.kind})`)
    .join(" vs ");
  const lines = [
    `${rank}. ${c.gameId}  https://wallgame.io/game/${c.gameId}`,
    `   ${c.variant} ${c.boardWidth}x${c.boardHeight}, ${c.movesCount} plies, started ${c.startedAt}`,
    `   ${seats}`,
  ];
  for (const b of c.beats) {
    lines.push(
      `   close call: danger move ${siteMove(b.danger.ply)} (walk ${b.danger.walk}), save move ${siteMove(b.save.ply)} ${b.save.notation} (${b.save.walkBefore} -> ${b.save.walk}), relief move ${siteMove(b.relief.ply)} (walk ${b.relief.walk}), ${zoom(b.save)}`,
      `     ${b.description}`,
    );
  }
  for (const e of c.escapes) {
    lines.push(
      `   escape: move ${siteMove(e.ply)} ${e.notation} (${e.walkBefore} -> ${e.walk}), ${e.prey.type} ${e.preyFrom} -> ${e.preyCell}`,
      `     ${e.description}`,
    );
  }
  for (const p of c.picks) {
    const sign = p.jump >= 0 ? "+" : "";
    lines.push(
      `   move ${siteMove(p.ply)} by P${p.mover} ${p.notation}: jump ${sign}${p.jump} (mover's walk ${walk(p.ownBefore)} -> ${walk(p.ownAfter)}, opponent's ${walk(p.opponentBefore)} -> ${walk(p.opponentAfter)}), ${zoom(p)}`,
      `     ${p.description}`,
    );
  }
  return lines.join("\n");
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const all = readGames(args).filter(
    (g) => args.games.length === 0 || args.games.includes(g.gameId),
  );

  const botConfig = args.gpuHost ? engineConfig(args.gpuHost) : undefined;

  const excluded: { gameId: string; reason: string }[] = [];
  const unscored: { gameId: string; reason: string }[] = [];
  const candidates: Candidate[] = [];
  const links = new Map<string, EngineLink>();

  try {
    for (const game of all) {
      const verdict = (args.nilSeat ? nilGameEligibility : gameEligibility)(
        game,
      );
      if (!verdict.eligible) {
        excluded.push({ gameId: game.gameId, reason: verdict.reason });
        continue;
      }
      try {
        const initialState = game.configParameters.initialState;
        if (!initialState) {
          throw new Error("no initialState in config_parameters");
        }
        const moves = game.moves.map(String);
        const replay = replayDistances({
          variant: game.variant,
          boardWidth: game.boardWidth,
          boardHeight: game.boardHeight,
          initialState,
          moves,
        });
        if (
          oneExitLoss(
            replay,
            verdict.result.winner,
            verdict.seatKinds,
            game.boardHeight,
          )
        ) {
          excluded.push({
            gameId: game.gameId,
            reason:
              "one-exit box: a human's mouse caught at its only open side",
          });
          continue;
        }
        const { movers, distances } = replay;
        const colors = dailySeatColors({
          1: verdict.seatKinds[0] === "official bot",
          2: verdict.seatKinds[1] === "official bot",
        });
        const seats = [...game.seats]
          .sort((a, b) => a.playerOrder - b.playerOrder)
          .map((s, i) => ({
            playerOrder: s.playerOrder,
            kind: verdict.seatKinds[i],
            name:
              verdict.seatKinds[i] === "member"
                ? memberSeatName(colors[s.playerOrder as PlayerId])
                : s.displayName,
            rating: s.ratingAtStart,
          }));
        const names = { 1: seats[0].name, 2: seats[1].name };
        const minJump = minJumpFor(game.variant as Variant);
        const calls = closeCallsOf(replay, moves);
        const candidate: Candidate = {
          gameId: game.gameId,
          startedAt: game.startedAt,
          variant: game.variant,
          boardWidth: game.boardWidth,
          boardHeight: game.boardHeight,
          movesCount: game.movesCount,
          moves,
          initialState,
          result: verdict.result,
          rated: game.rated,
          seats,
          distances,
          minJump,
          picks: pickJumps(jumpsOf(distances, moves, movers), minJump).map(
            (p) => ({
              ...p,
              ...pickBoard(replay, p),
              description: describeJump(p, names),
            }),
          ),
          beats: calls.map((b) => ({
            ...b,
            description: describeCloseCall(b, names),
          })),
          escapes: escapesOf(replay, moves, calls).map((e) => ({
            ...e,
            description: describeEscape(e, names),
          })),
        };
        if (botConfig && args.gpuHost) {
          candidate.engine = await engineColumn(
            botConfig,
            args.gpuHost,
            links,
            game,
            movers,
            verdict.result.winner,
          ).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        candidates.push(candidate);
      } catch (error) {
        unscored.push({
          gameId: game.gameId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    for (const link of links.values()) await link.close();
  }

  const ranked = rankCandidates(candidates);
  const report = {
    kind: "daily-video-candidates",
    task: "e8d26610",
    createdAt: new Date().toISOString(),
    window: {
      since: new Date(
        args.until.getTime() - args.days * 86_400_000,
      ).toISOString(),
      until: args.until.toISOString(),
    },
    source: { container: args.container, database: args.database },
    nilSeatOnly: args.nilSeat,
    engineCommands: [...links.keys()],
    counts: {
      games: all.length,
      excluded: excluded.length,
      unscored: unscored.length,
      scored: candidates.length,
      withPicks: candidates.filter((c) => c.picks.length > 0).length,
      withBeats: candidates.filter((c) => c.beats.length > 0).length,
    },
    /** Official bots BOT_STRENGTH does not list: they rank as strength 0. */
    unknownBotNames: unknownBotNames(candidates),
    ranked,
    excluded,
    unscored,
  };
  writeFileSync(args.out, JSON.stringify(report, null, 1));

  console.log(
    `${all.length} games started ${report.window.since} .. ${report.window.until}: ${excluded.length} not eligible, ${unscored.length} eligible but not scored, ${candidates.length} scored, ${report.counts.withPicks} with a pick, ${report.counts.withBeats} with a close call.`,
  );
  if (report.unknownBotNames.length > 0) {
    console.log(
      `  bots with no strength (rank as 0; add them to BOT_STRENGTH): ${report.unknownBotNames.join(", ")}`,
    );
  }
  for (const u of unscored)
    console.log(`  not scored ${u.gameId}: ${u.reason}`);
  console.log("");
  ranked.slice(0, args.top).forEach((c, i) => console.log(describe(c, i + 1)));
  console.log(`\nfull report: ${args.out}`);
};

/** The --engine debug column for one game, on the evaluation bar's engine. */
const engineColumn = async (
  botConfig: ConfigFile,
  gpuHost: string,
  links: Map<string, EngineLink>,
  game: StoredGame,
  movers: PlayerId[],
  winner: PlayerId,
): Promise<EngineColumn> => {
  const engine = evalBarEngineFor(
    botConfig,
    game.variant as Variant,
    game.boardWidth,
    game.boardHeight,
  );
  if (!engine) {
    throw new Error(
      `no evaluation bar for ${game.variant} ${game.boardWidth}x${game.boardHeight}`,
    );
  }
  let link = links.get(engine.command);
  if (!link || link.broken) {
    await link?.close();
    link = new EngineLink(gpuHost, engine.command);
    links.set(engine.command, link);
  }
  const t0 = performance.now();
  const { evaluations, finalFromResult } = await scoreGame(link, {
    gameId: game.gameId,
    variant: game.variant,
    boardWidth: game.boardWidth,
    boardHeight: game.boardHeight,
    initialState: game.configParameters.initialState,
    moves: game.moves.map(String),
    winner,
  });
  const scoreSeconds = (performance.now() - t0) / 1000;
  console.error(
    `engine scored ${game.gameId} (${game.moves.length} plies) in ${scoreSeconds.toFixed(1)} s`,
  );
  return {
    botId: engine.botId,
    scoreSeconds,
    evaluationsP1: evaluations,
    finalFromResult,
    topSwings: swingsOf(evaluations, game.moves.map(String), movers).slice(
      0,
      PICKS_PER_GAME,
    ),
  };
};

if (import.meta.main) await main();
