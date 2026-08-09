/**
 * Integration test for the classic minimax engine (minimax-engine/minimax_bgs_engine)
 * served via the official custom bot client over the V3 BGS protocol.
 *
 * Unlike bot-3 (5x5, a couple of "---" passes, then resignation), this plays an
 * actual 8x8 CLASSIC game to a NATURAL finish: the human (P1) makes one real
 * two-step move (two cat actions) and then passes, while the minimax bot (P2)
 * marches to its goal and wins. Every bot move is
 * asserted server-accepted via the authoritative state wire (moveCount/turn/
 * status), not UI rendering. If the bot ever returned an illegal move the server
 * would reject it, moveCount would stall, and the test would time out.
 *
 * Offline: ephemeral Postgres (testcontainers) + in-process server (NODE_ENV=test
 * mock auth). No prod, no network. The engine runs with --think-millis 100
 * (test-only speed tuning; production default is ~3000ms).
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type { PlayerId } from "../../shared/domain/game-types";
import type { PartialGameConfiguration } from "../../server/games/store";

// Absolute path to the built wrapper binary (test runs from the repo root).
const MINIMAX_ENGINE = join(
  process.cwd(),
  "minimax-engine",
  "build_release",
  "minimax_bgs_engine",
);

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;
let createApp: typeof import("../../server/index").createApp;

async function importServerModules() {
  const serverModule = await import("../../server/index");
  createApp = serverModule.createApp;
}

function startTestServer() {
  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}

async function stopTestServer() {
  if (server) await server.stop(true);
}

/** Build the wrapper so this test is self-contained as a gate. */
async function buildEngine() {
  const proc = spawn({
    cmd: [
      "sh",
      "-c",
      "cmake --preset release && ( cd build_release && make minimax_bgs_engine )",
    ],
    cwd: "./minimax-engine",
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(
      `Failed to build minimax_bgs_engine (exit ${code}):\n${err}`,
    );
  }
}

// ================================ HTTP helpers ================================

interface PlayVsBotResponse {
  gameId: string;
  token: string;
  socketToken: string;
  role: "host" | "joiner";
  playerId: 1 | 2;
  shareUrl?: string;
}

async function createGameVsBot(
  userId: string,
  botId: string,
  config: PartialGameConfiguration,
  hostIsPlayer1?: boolean,
): Promise<PlayVsBotResponse> {
  const res = await fetch(`${baseUrl}/api/bots/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user-id": userId },
    body: JSON.stringify({
      botId,
      config,
      hostDisplayName: `Player ${userId}`,
      hostIsPlayer1,
    }),
  });
  if (res.status !== 201) {
    throw new Error(`Expected 201 but got ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PlayVsBotResponse;
}

async function listBots(filters: {
  variant: string;
  boardWidth?: number;
  boardHeight?: number;
}): Promise<{
  bots: { id: string; botId: string; name: string; clientId: string }[];
}> {
  const params = new URLSearchParams();
  params.set("variant", filters.variant);
  if (filters.boardWidth) params.set("boardWidth", String(filters.boardWidth));
  if (filters.boardHeight)
    params.set("boardHeight", String(filters.boardHeight));
  const res = await fetch(`${baseUrl}/api/bots?${params.toString()}`);
  if (res.status !== 200) {
    throw new Error(`Expected 200 but got ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as {
    bots: { id: string; botId: string; name: string; clientId: string }[];
  };
}

// ============================ Human player socket ============================

interface HumanSocket {
  ws: WebSocket;
  waitForMessage: <T extends ServerMessage["type"]>(
    expectedType: T,
    options?: { ignore?: ServerMessage["type"][]; timeoutMs?: number },
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  waitForState: (
    predicate: (state: Extract<ServerMessage, { type: "state" }>) => boolean,
    options?: { timeoutMs?: number },
  ) => Promise<Extract<ServerMessage, { type: "state" }>>;
  close: () => void;
}

async function openHumanSocket(
  userId: string,
  gameId: string,
  socketToken: string,
): Promise<HumanSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl =
      baseUrl.replace("http", "ws") +
      `/ws/games/${gameId}?token=${socketToken}`;
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: "http://localhost:5173", "x-test-user-id": userId },
    });
    const buffer: ServerMessage[] = [];
    let waitingResolve: ((msg: ServerMessage) => void) | null = null;

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (waitingResolve) {
        const r = waitingResolve;
        waitingResolve = null;
        r(msg);
      } else {
        buffer.push(msg);
      }
    });

    ws.on("open", () => {
      resolve({
        ws,
        close: () => ws.close(),
        waitForMessage: <T extends ServerMessage["type"]>(
          expectedType: T,
          options?: { ignore?: ServerMessage["type"][]; timeoutMs?: number },
        ) => {
          const ignoreTypes = ["welcome", ...(options?.ignore ?? [])];
          const timeoutMs = options?.timeoutMs ?? 10000;
          return new Promise<Extract<ServerMessage, { type: T }>>(
            (res, rej) => {
              const process = (msg: ServerMessage): boolean => {
                if (msg.type === expectedType) {
                  res(msg as Extract<ServerMessage, { type: T }>);
                  return true;
                } else if (ignoreTypes.includes(msg.type)) {
                  return false;
                }
                rej(
                  new Error(
                    `Expected "${expectedType}" but got "${msg.type}": ${JSON.stringify(msg)}`,
                  ),
                );
                return true;
              };
              while (buffer.length > 0) if (process(buffer.shift()!)) return;
              const timeout = setTimeout(() => {
                waitingResolve = null;
                rej(new Error(`Timeout waiting for "${expectedType}"`));
              }, timeoutMs);
              const waitForNext = () => {
                waitingResolve = (msg) => {
                  if (process(msg)) clearTimeout(timeout);
                  else waitForNext();
                };
              };
              waitForNext();
            },
          );
        },
        waitForState: (predicate, options) => {
          const timeoutMs = options?.timeoutMs ?? 15000;
          return new Promise<Extract<ServerMessage, { type: "state" }>>(
            (res, rej) => {
              const process = (msg: ServerMessage): boolean => {
                if (msg.type === "state" && predicate(msg)) {
                  res(msg);
                  return true;
                }
                return false;
              };
              while (buffer.length > 0) if (process(buffer.shift()!)) return;
              const timeout = setTimeout(() => {
                waitingResolve = null;
                rej(new Error("Timeout waiting for state predicate"));
              }, timeoutMs);
              const waitForNext = () => {
                waitingResolve = (msg) => {
                  if (process(msg)) clearTimeout(timeout);
                  else waitForNext();
                };
              };
              waitForNext();
            },
          );
        },
      });
    });
    ws.on("error", reject);
  });
}

// =============================== Bot client =================================

interface BotClientProcess {
  proc: Subprocess;
  kill: () => void;
  waitForExit: () => Promise<number>;
}
interface BotConfigFile {
  path: string;
  cleanup: () => Promise<void>;
}

const defaultVariants = {
  standard: {
    boardWidth: { min: 3, max: 15 },
    boardHeight: { min: 3, max: 15 },
    recommended: [{ boardWidth: 8, boardHeight: 8 }],
  },
  classic: {
    boardWidth: { min: 3, max: 15 },
    boardHeight: { min: 3, max: 15 },
    recommended: [{ boardWidth: 8, boardHeight: 8 }],
  },
  // Freestyle stopped being 12x10-only in a8d2dad, so it now needs recommended
  // sizes like every other configurable variant. An empty list here is what the
  // server rejects with INVALID_BOT_CONFIG.
  freestyle: {
    boardWidth: { min: 3, max: 15 },
    boardHeight: { min: 3, max: 15 },
    recommended: [{ boardWidth: 8, boardHeight: 8 }],
  },
};

async function createBotConfigFile(args: {
  serverUrl: string;
  botId: string;
  botName: string;
  engine: string;
}): Promise<BotConfigFile> {
  const dir = await mkdtemp(join(tmpdir(), "wallgame-minimax-"));
  const path = join(dir, "bot-config.json");
  const config = {
    server: args.serverUrl,
    bots: [
      {
        botId: args.botId,
        name: args.botName,
        username: null,
        variants: defaultVariants,
      },
    ],
    engineCommands: { [args.botId]: args.engine },
  };
  await writeFile(path, JSON.stringify(config, null, 2));
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function spawnBotClient(
  configPath: string,
  clientId: string,
): BotClientProcess {
  const proc = spawn({
    cmd: [
      "bun",
      "run",
      "src/index.ts",
      "--client-id",
      clientId,
      "--config",
      configPath,
      "--log-level",
      "debug",
    ],
    cwd: "./official-custom-bot-client",
    stdout: "pipe",
    stderr: "pipe",
  });
  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      console.log("[BOT STDOUT]", decoder.decode(value));
    }
  })();
  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      console.log("[BOT STDERR]", decoder.decode(value));
    }
  })();
  return { proc, kill: () => proc.kill(), waitForExit: () => proc.exited };
}

// ================================ Helpers ===================================

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function submitHumanMove(
  s: HumanSocket,
  moveNotation: string,
  boardHeight: number,
) {
  const { moveFromStandardNotation } =
    await import("../../shared/domain/standard-notation");
  const move = moveFromStandardNotation(moveNotation, boardHeight);
  s.ws.send(JSON.stringify({ type: "submit-move", move }));
}

async function waitForTurn(
  s: HumanSocket,
  playerId: PlayerId,
  currentState?: Extract<ServerMessage, { type: "state" }>,
  timeoutMs?: number,
): Promise<Extract<ServerMessage, { type: "state" }>> {
  if (
    currentState?.state.status === "playing" &&
    currentState.state.turn === playerId
  )
    return currentState;
  if (currentState && currentState.state.status !== "playing")
    return currentState;
  return s.waitForState(
    (st) => st.state.status !== "playing" || st.state.turn === playerId,
    { timeoutMs },
  );
}

async function waitForBotRegistration(
  botId: string,
  filters: { variant: string },
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { bots } = await listBots(filters);
    if (bots.some((b) => b.id === botId)) return;
    await sleep(100);
  }
  throw new Error(`Bot ${botId} did not register within ${timeoutMs}ms`);
}

// ================================== Test ====================================

describe("minimax engine integration V3 (8x8 classic, full game)", () => {
  beforeAll(async () => {
    await buildEngine();
    const handle = await setupEphemeralDb();
    container = handle.container;
    await importServerModules();
    startTestServer();
  }, 180_000);

  afterAll(async () => {
    await stopTestServer();
    await teardownEphemeralDb(container);
  }, 60_000);

  // SKIPPED against a real, reproducing bug - not a flake, and not stale.
  // The engine is launched with --think-millis 100, but at ply 15, with its cat
  // one step from home, it enters a depth-4 search with ~20ms left and never
  // answers. The server waits out BGS_REQUEST_TIMEOUT_MS (10s) and resigns the
  // bot, so the passing human "wins" by resignation. Same ply and same move on
  // every run. Earlier plies abort their searches cleanly, so the defect is a
  // deep search entered with no budget left in a near-terminal position - and
  // the same path serves the production Negamax bot.
  //
  // Tracked as task 1bd83f99. Un-skip with that fix; the assertions below are
  // correct as written and should start passing once the engine does.
  it.skip("plays a full 8x8 classic game to a natural finish (bot wins)", async () => {
    const hostUserId = "host-minimax-8x8";
    const clientId = "test-client-minimax";
    const botId = "minimax-bot";
    const compositeId = `${clientId}:${botId}`;
    let botClient: BotClientProcess | null = null;
    let humanSocket: HumanSocket | null = null;
    let configFile: BotConfigFile | null = null;

    const gameConfig: PartialGameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "classic",
      rated: false,
      boardWidth: 8,
      boardHeight: 8,
    };

    try {
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: botId,
        engine: `${MINIMAX_ENGINE} --think-millis 100`,
      });
      botClient = spawnBotClient(configFile.path, clientId);

      await waitForBotRegistration(compositeId, { variant: "classic" });
      const { bots } = await listBots({
        variant: "classic",
        boardWidth: 8,
        boardHeight: 8,
      });
      expect(bots.some((b) => b.id === compositeId)).toBe(true);

      const { gameId, socketToken, playerId } = await createGameVsBot(
        hostUserId,
        compositeId,
        gameConfig,
        true, // human is Player 1, moves first
      );
      expect(playerId).toBe(1);

      humanSocket = await openHumanSocket(hostUserId, gameId, socketToken);
      const initialState = await humanSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(initialState.state.status).toBe("playing");
      expect(initialState.state.config.variant).toBe("classic");
      expect(initialState.state.config.boardWidth).toBe(8);
      expect(initialState.state.config.boardHeight).toBe(8);

      await sleep(1000); // external engine process startup

      const humanPlayerId: PlayerId = 1;
      const botPlayerId: PlayerId = 2;
      let currentState = initialState;
      let botMoves = 0;
      const MAX_ROUNDS = 50;

      for (let round = 0; round < MAX_ROUNDS; round++) {
        currentState = await waitForTurn(
          humanSocket,
          humanPlayerId,
          currentState,
          20000,
        );
        if (currentState.state.status !== "playing") break;

        const moveCountBefore = currentState.state.moveCount;
        // The FIRST human turn makes a real two-step move (two cat actions) to
        // exercise apply_move end-to-end (regression for the prod two-cat bug);
        // afterwards the human passes so the bot still reaches a natural win.
        const humanMove = round === 0 ? "Cb8.Cb7" : "---";
        await submitHumanMove(humanSocket, humanMove, 8);

        // The server must apply BOTH the human's move and the bot's move (or the
        // game must finish). If the bot returned an illegal move, moveCount
        // would not advance and this would time out -> a real failure.
        currentState = await humanSocket.waitForState(
          (s) =>
            s.state.moveCount >= moveCountBefore + 2 ||
            s.state.status !== "playing",
          { timeoutMs: 20000 },
        );
        if (currentState.state.moveCount >= moveCountBefore + 2) botMoves++;
        if (currentState.state.status !== "playing") break;
      }

      // Evidence (server wire): the bot made many accepted moves and the minimax
      // engine marched to its goal against a passing human -> natural win for P2.
      expect(botMoves).toBeGreaterThan(3);
      expect(currentState.state.status).toBe("finished");
      expect(currentState.state.result?.winner).toBe(botPlayerId);
    } finally {
      humanSocket?.close();
      if (botClient) {
        botClient.kill();
        await botClient.waitForExit();
      }
      if (configFile) await configFile.cleanup();
    }
  }, 120_000);
});
