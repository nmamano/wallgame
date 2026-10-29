/**
 * The evaluation bar's engine on the 4090, for the scripts that score whole
 * games: pick-daily-candidates.ts --engine (a debug column) and
 * eval-game.ts (the daily app's `crew.mjs eval`, Wall Game Director,
 * 2026-10-29: "I need the engine to say which moves changed the game").
 *
 * The engine is its own process. For each engine command a caller starts
 * one extra `deep_ww_bgs_engine` on the 4090 over `ssh -T`, with exactly the
 * command the bot-client config gives the analysis bot (evalBarEngineFor),
 * and speaks the BGS JSON-lines protocol to it, one request at a time. It
 * never talks to the serving engines or the bot client, and it writes
 * nothing on the 4090. It runs at nice 10, as ~/nil/infra/DESKTOP-COMPUTE.md
 * asks of every long desktop job (desktop-run cannot hold a stdio pipe, so
 * it is not used). Before a caller starts any engine, engineConfig compares
 * the bot-client config here with the 4090's copy and stops if they differ,
 * because the engine command is read from this copy and run with the 4090's
 * paths. The engine seeds its search from the session id, which is
 * `daily-<gameId>`, but the parallel search still varies: a rerun of 5
 * games on the same engine build moved single positions by at most 0.07
 * (measured 2026-10-25).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configFileSchema,
  type ConfigFile,
} from "../../official-custom-bot-client/src/config-schema";
import type {
  GameInitialState,
  PlayerId,
} from "../../shared/domain/game-types";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BOT_CONFIG = resolve(
  REPO,
  "official-custom-bot-client/transformer.prod.config.json",
);
/** The bot client's working directory; engine commands are relative to it. */
const ENGINE_CWD = "~/nil/wallgame/official-custom-bot-client";
const REMOTE_BOT_CONFIG = `${ENGINE_CWD}/transformer.prod.config.json`;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * WALLGAME_GPU_HOST, the ssh target of the 4090's WSL (an env var only
 * because the repo is public; the value is in
 * ops-private/wallgamer-agent-notes.md), or a throw.
 */
export const gpuHostFromEnv = (why: string): string => {
  const host = process.env.WALLGAME_GPU_HOST ?? "";
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(host)) {
    throw new Error(
      `${why} needs WALLGAME_GPU_HOST=<user@host> of the 4090 WSL`,
    );
  }
  return host;
};

/** One game as the engine replays it, from its start position. */
export interface GameToScore {
  gameId: string;
  variant: string;
  boardWidth: number;
  boardHeight: number;
  initialState: GameInitialState | undefined;
  /** Every ply's standard notation. */
  moves: string[];
  /** The game's winner, for a final position the engine will not score. */
  winner: PlayerId | null;
}

export interface EngineReply {
  type?: string;
  success?: boolean;
  evaluation?: number;
  ply?: number;
  bestMove?: string;
  error?: string;
  [key: string]: unknown;
}

/** One engine process on the 4090, one request in flight. */
export class EngineLink {
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
export class EngineRefused extends Error {}

/**
 * The evaluation bar's numbers for one game: ply 0, then one per move. Like
 * the bar (initializeBgsHistory in server/routes/eval-socket.ts), an engine
 * that refuses to evaluate the FINAL position, which can be terminal, gives
 * way to the game result: +1 when player 1 won, -1 when player 2 won, 0
 * otherwise. Unlike the bar, any other failure there leaves the game unscored.
 * `bestMoves[k]` is the engine's best move in position k (standard
 * notation), null where the engine sent none or the result stands in.
 */
export const scoreGame = async (
  link: EngineLink,
  game: GameToScore,
): Promise<{
  evaluations: number[];
  bestMoves: (string | null)[];
  finalFromResult: boolean;
}> => {
  const bgsId = `daily-${game.gameId}`;
  const started = await link.request({
    type: "start_game_session",
    bgsId,
    botId: "daily-video",
    config: {
      variant: game.variant,
      boardWidth: game.boardWidth,
      boardHeight: game.boardHeight,
      initialState: game.initialState,
    },
  });
  if (started.success === false) {
    throw new Error(`start_game_session: ${started.error ?? "refused"}`);
  }
  try {
    const bestMoves: (string | null)[] = [];
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
      bestMoves.push(
        typeof reply.bestMove === "string" && reply.bestMove
          ? reply.bestMove
          : null,
      );
      return reply.evaluation;
    };
    const evaluations = [await evaluate(0)];
    let finalFromResult = false;
    for (let ply = 0; ply < game.moves.length; ply++) {
      const applied = await link.request({
        type: "apply_move",
        bgsId,
        expectedPly: ply,
        move: game.moves[ply],
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
        evaluations.push(game.winner === 1 ? 1 : game.winner === 2 ? -1 : 0);
        bestMoves.push(null);
      }
    }
    return { evaluations, bestMoves, finalFromResult };
  } finally {
    // A session that will not end does not change this game's scores.
    await link.request({ type: "end_game_session", bgsId }).catch(() => null);
  }
};

/** Stops the run if the 4090's bot-client config is not this one. */
export const assertSameConfigOnGpu = (gpuHost: string, configText: string) => {
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

/**
 * The bot-client config, after the check that the 4090 runs the same one
 * (assertSameConfigOnGpu): what evalBarEngineFor reads the command from.
 */
export const engineConfig = (gpuHost: string): ConfigFile => {
  const configText = readFileSync(BOT_CONFIG, "utf8");
  assertSameConfigOnGpu(gpuHost, configText);
  return configFileSchema.parse(JSON.parse(configText));
};
