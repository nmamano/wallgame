/**
 * Lists the finished games that can be the daily video and the moves a viewer
 * can see turn the race, and prints the best candidates with those moves.
 *
 * Board task e8d26610. It posts nothing and renders nothing. The rules (who is
 * eligible, what a jump is) live in daily-candidates.ts.
 *
 *   bun scripts/game-video/pick-daily-candidates.ts --container wgvideo-restore \
 *     --until 2026-10-25T10:20:48Z [--days 7] [--top 5] [--game ID ...] [--out F]
 *     [--engine]
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
 * need, and tell Infra & Security, who own the 4090.
 *
 * The engine is its own process. For each engine command it starts one extra
 * `deep_ww_bgs_engine` on the 4090 over `ssh -T`, with exactly the command the
 * bot-client config gives the analysis bot, and speaks the BGS JSON-lines
 * protocol to it, one request at a time. It never talks to the serving
 * engines or the bot client, and it writes nothing on the 4090. It runs at
 * nice 10, as ~/nil/infra/DESKTOP-COMPUTE.md asks of every long desktop job
 * (desktop-run cannot hold a stdio pipe, so it is not used). Before it starts
 * any engine, it compares the bot-client config here with the 4090's copy and
 * stops if they differ, because the engine command is read from this copy and
 * run with the 4090's paths. The engine seeds its search from the session id,
 * which is `daily-<gameId>`, but the parallel search still varies: a rerun of
 * 5 games on the same engine build moved single positions by at most 0.07
 * (measured 2026-10-25).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configFileSchema } from "../../official-custom-bot-client/src/config-schema";
import type {
  GameInitialState,
  PlayerId,
  Variant,
} from "../../shared/domain/game-types";
import {
  closeCallsOf,
  describeCloseCall,
  describeJump,
  pickBoard,
  evalBarEngineFor,
  gameEligibility,
  jumpsOf,
  minJumpFor,
  pickJumps,
  PICKS_PER_GAME,
  rankCandidates,
  replayDistances,
  swingsOf,
  type DescribedCloseCall,
  type PickedJump,
  type PlyBoard,
  type RaceDistances,
  type SeatKind,
  type StoredGameSummary,
  type Swing,
} from "./daily-candidates";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BOT_CONFIG = resolve(
  REPO,
  "official-custom-bot-client/transformer.prod.config.json",
);
/** The bot client's working directory; engine commands are relative to it. */
const ENGINE_CWD = "~/nil/wallgame/official-custom-bot-client";
const REMOTE_BOT_CONFIG = `${ENGINE_CWD}/transformer.prod.config.json`;
const REQUEST_TIMEOUT_MS = 120_000;

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
  out: string;
}

const parseArgs = (argv: string[]): Args => {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  let gpuHost: string | undefined;
  if (argv.includes("--engine")) {
    gpuHost = process.env.WALLGAME_GPU_HOST ?? "";
    if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(gpuHost)) {
      throw new Error(
        "--engine needs WALLGAME_GPU_HOST=<user@host> of the 4090 WSL",
      );
    }
  }
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
    ga.puzzle_id as "puzzleId", ga.started_at as "startedAt",
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
        'outcomeReason', p.outcome_reason) order by p.player_order), '[]'::json)
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

/* --------------------------------------------------------------- engine -- */

interface EngineReply {
  type?: string;
  success?: boolean;
  evaluation?: number;
  ply?: number;
  bestMove?: string;
  error?: string;
  [key: string]: unknown;
}

/** One engine process on the 4090, one request in flight. */
class EngineLink {
  private readonly proc;
  private buffer = "";
  private waiting: ((reply: EngineReply) => void) | null = null;
  /** Set on a timeout: a late reply could otherwise answer the next request. */
  broken = false;
  readonly stderrTail: string[] = [];

  constructor(
    readonly gpuHost: string,
    readonly command: string,
  ) {
    this.proc = Bun.spawn({
      cmd: [
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        gpuHost,
        `cd ${ENGINE_CWD} && exec nice -n 10 ${command}`,
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.readStdout();
    void this.readStderr();
  }

  private async readStdout() {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let reply: EngineReply;
        try {
          reply = JSON.parse(line) as EngineReply;
        } catch {
          // A torn reply means the stream can no longer be trusted to pair
          // replies with requests: retire the link, let the request time out.
          this.broken = true;
          continue;
        }
        const done = this.waiting;
        this.waiting = null;
        done?.(reply);
      }
    }
  }

  private async readStderr() {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      for (const line of decoder.decode(chunk, { stream: true }).split("\n")) {
        if (line.trim()) this.stderrTail.push(line.trim());
      }
      if (this.stderrTail.length > 40) this.stderrTail.splice(0, 20);
    }
  }

  async request(message: Record<string, unknown>): Promise<EngineReply> {
    if (this.broken)
      throw new Error("engine link broken earlier (timeout or bad reply)");
    if (this.waiting) throw new Error("engine request already in flight");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<EngineReply>((done, fail) => {
      this.waiting = done;
      timer = setTimeout(() => {
        this.waiting = null;
        this.broken = true;
        fail(new Error(`engine timeout on ${String(message.type)}`));
      }, REQUEST_TIMEOUT_MS);
    });
    void this.proc.stdin.write(JSON.stringify(message) + "\n");
    void this.proc.stdin.flush();
    try {
      return await reply;
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    try {
      void this.proc.stdin.end();
    } catch {
      // already closed
    }
    this.proc.kill();
    await this.proc.exited;
  }
}

/** The engine answered and said no; a timeout or a broken link is not this. */
class EngineRefused extends Error {}

/**
 * The evaluation bar's numbers for one game: ply 0, then one per move. Like
 * the bar (initializeBgsHistory in server/routes/eval-socket.ts), an engine
 * that refuses to evaluate the FINAL position, which can be terminal, gives
 * way to the game result: +1 when player 1 won, -1 when player 2 won, 0
 * otherwise. Unlike the bar, any other failure there leaves the game unscored.
 */
const scoreGame = async (
  link: EngineLink,
  game: StoredGame,
): Promise<{ evaluations: number[]; finalFromResult: boolean }> => {
  const bgsId = `daily-${game.gameId}`;
  const started = await link.request({
    type: "start_game_session",
    bgsId,
    botId: "daily-video",
    config: {
      variant: game.variant,
      boardWidth: game.boardWidth,
      boardHeight: game.boardHeight,
      initialState: game.configParameters.initialState,
    },
  });
  if (started.success === false) {
    throw new Error(`start_game_session: ${started.error ?? "refused"}`);
  }
  try {
    const evaluate = async (ply: number): Promise<number> => {
      const reply = await link.request({
        type: "evaluate_position",
        bgsId,
        expectedPly: ply,
      });
      if (reply.success === false || typeof reply.evaluation !== "number") {
        throw new EngineRefused(
          `evaluate ply ${ply}: ${reply.error ?? "no value"}`,
        );
      }
      if (reply.ply !== ply) {
        throw new Error(
          `evaluate ply ${ply}: engine answered ply ${String(reply.ply)}`,
        );
      }
      return reply.evaluation;
    };
    const evaluations = [await evaluate(0)];
    let finalFromResult = false;
    for (let ply = 0; ply < game.moves.length; ply++) {
      const applied = await link.request({
        type: "apply_move",
        bgsId,
        expectedPly: ply,
        move: String(game.moves[ply]),
      });
      if (applied.success === false) {
        throw new Error(`apply_move ply ${ply}: ${applied.error ?? "refused"}`);
      }
      const isLast = ply === game.moves.length - 1;
      try {
        evaluations.push(await evaluate(ply + 1));
      } catch (error) {
        // Only the engine REFUSING the final position (it can be terminal)
        // takes the result. A timeout or a broken link is not a verdict on
        // the position, and a made-up +1 there would fake a last-move swing.
        if (!isLast || !(error instanceof EngineRefused)) throw error;
        finalFromResult = true;
        const winner = game.seats.find(
          (s) =>
            s.outcomeRank === 1 &&
            game.seats.some((o) => o !== s && o.outcomeRank > 1),
        );
        evaluations.push(
          winner?.playerOrder === 1 ? 1 : winner?.playerOrder === 2 ? -1 : 0,
        );
      }
    }
    return { evaluations, finalFromResult };
  } finally {
    // A session that will not end does not change this game's scores.
    await link.request({ type: "end_game_session", bgsId }).catch(() => null);
  }
};

/** Stops the run if the 4090's bot-client config is not this one. */
const assertSameConfigOnGpu = (gpuHost: string, configText: string) => {
  const local = createHash("sha256").update(configText).digest("hex");
  const proc = Bun.spawnSync({
    cmd: [
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      gpuHost,
      `sha256sum ${REMOTE_BOT_CONFIG}`,
    ],
  });
  const remote = proc.stdout.toString().split(/\s/)[0];
  if (proc.exitCode !== 0 || remote !== local) {
    throw new Error(
      `bot-client config differs on the 4090 (here ${local.slice(0, 16)}, there ${remote.slice(0, 16) || "unreadable"})`,
    );
  }
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
  seats: { playerOrder: number; kind: SeatKind; name: string }[];
  /** Before each move, and after the last: movesCount + 1 entries. */
  distances: RaceDistances[];
  /** The smallest jump that is a pick in this variant (minJumpFor). */
  minJump: number;
  picks: PickedJump[];
  /** Close calls (danger, save, relief), largest save first; may be []. */
  beats: DescribedCloseCall[];
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
      `   close call: danger move ${b.danger.moveNumber} (walk ${b.danger.walk}), save move ${b.save.moveNumber} ${b.save.notation} (${b.save.walkBefore} -> ${b.save.walk}), relief move ${b.relief.moveNumber} (walk ${b.relief.walk}), ${zoom(b.save)}`,
      `     ${b.description}`,
    );
  }
  for (const p of c.picks) {
    const sign = p.jump >= 0 ? "+" : "";
    lines.push(
      `   move ${p.moveNumber} by P${p.mover} ${p.notation}: jump ${sign}${p.jump} (mover's walk ${walk(p.ownBefore)} -> ${walk(p.ownAfter)}, opponent's ${walk(p.opponentBefore)} -> ${walk(p.opponentAfter)}), ${zoom(p)}`,
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

  let botConfig: ReturnType<typeof configFileSchema.parse> | undefined;
  if (args.gpuHost) {
    const configText = readFileSync(BOT_CONFIG, "utf8");
    assertSameConfigOnGpu(args.gpuHost, configText);
    botConfig = configFileSchema.parse(JSON.parse(configText));
  }

  const excluded: { gameId: string; reason: string }[] = [];
  const unscored: { gameId: string; reason: string }[] = [];
  const candidates: Candidate[] = [];
  const links = new Map<string, EngineLink>();

  try {
    for (const game of all) {
      const verdict = gameEligibility(game);
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
        const { movers, distances } = replay;
        const names = {
          1: game.seats.find((s) => s.playerOrder === 1)?.displayName ?? "P1",
          2: game.seats.find((s) => s.playerOrder === 2)?.displayName ?? "P2",
        };
        const minJump = minJumpFor(game.variant as Variant);
        const candidate: Candidate = {
          gameId: game.gameId,
          startedAt: game.startedAt,
          variant: game.variant,
          boardWidth: game.boardWidth,
          boardHeight: game.boardHeight,
          movesCount: game.movesCount,
          moves,
          initialState,
          seats: [...game.seats]
            .sort((a, b) => a.playerOrder - b.playerOrder)
            .map((s, i) => ({
              playerOrder: s.playerOrder,
              kind: verdict.seatKinds[i],
              name: s.displayName,
            })),
          distances,
          minJump,
          picks: pickJumps(jumpsOf(distances, moves, movers), minJump).map(
            (p) => ({
              ...p,
              ...pickBoard(replay, p),
              description: describeJump(p, names),
            }),
          ),
          beats: closeCallsOf(replay, moves).map((b) => ({
            ...b,
            description: describeCloseCall(b, names),
          })),
        };
        if (botConfig && args.gpuHost) {
          candidate.engine = await engineColumn(
            botConfig,
            args.gpuHost,
            links,
            game,
            movers,
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
    engineCommands: [...links.keys()],
    counts: {
      games: all.length,
      excluded: excluded.length,
      unscored: unscored.length,
      scored: candidates.length,
      withPicks: candidates.filter((c) => c.picks.length > 0).length,
      withBeats: candidates.filter((c) => c.beats.length > 0).length,
    },
    ranked,
    excluded,
    unscored,
  };
  writeFileSync(args.out, JSON.stringify(report, null, 1));

  console.log(
    `${all.length} games started ${report.window.since} .. ${report.window.until}: ${excluded.length} not eligible, ${unscored.length} eligible but not scored, ${candidates.length} scored, ${report.counts.withPicks} with a pick, ${report.counts.withBeats} with a close call.`,
  );
  for (const u of unscored)
    console.log(`  not scored ${u.gameId}: ${u.reason}`);
  console.log("");
  ranked.slice(0, args.top).forEach((c, i) => console.log(describe(c, i + 1)));
  console.log(`\nfull report: ${args.out}`);
};

/** The --engine debug column for one game, on the evaluation bar's engine. */
const engineColumn = async (
  botConfig: ReturnType<typeof configFileSchema.parse>,
  gpuHost: string,
  links: Map<string, EngineLink>,
  game: StoredGame,
  movers: PlayerId[],
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
  const { evaluations, finalFromResult } = await scoreGame(link, game);
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
