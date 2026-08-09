/**
 * Regression test for S-P1 lead-in games: the FIRST human connect to a game
 * that already has real history (the puzzle's scripted bot ply 0) must build
 * the engine session via the history rebuild, not the fresh-ply-0 init.
 *
 * The pre-fix failure mode (found in production, 2026-07-26): the fresh init
 * evaluated the pre-position at ply 0 and left bgs.currentPly behind the
 * game history forever, so the sync guard in executeBotTurnV3 (correctly)
 * refused every bot turn and the bot never replied to the human's first
 * move.
 *
 * Harness: the bot-6/bot-7 pattern — real in-process server, autopilot mock
 * bot client, ephemeral Postgres when a container runtime exists, DB-less
 * fallback otherwise (nothing here depends on persistence). The lead-in
 * game is created through the same store calls the puzzle launch route
 * makes (the route's DB row fetch is the only part bypassed).
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type {
  CustomBotServerMessage,
  CustomBotClientMessage,
  BotConfig,
} from "../../shared/contracts/custom-bot-protocol";
import { buildSavedPuzzleSeedRows } from "../../shared/domain/saved-puzzles";
import { generateCustomSetupCandidates } from "../../shared/domain/generated-custom-setup-candidates";
import verdictFile from "../../shared/domain/generated-custom-setup-verdicts.json";
import type { CandidateVerdictFile } from "../../shared/domain/custom-setup-verdicts";
import { resolveSavedPuzzleLaunch } from "../../shared/domain/puzzle-lead-in";
import { BOT_GAME_TIME_CONTROL } from "../../shared/domain/game-utils";

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let createApp: typeof import("../../server/app").createApp;
let store: typeof import("../../server/games/store");
let customBotStore: typeof import("../../server/games/custom-bot-store");
let bgsStore: typeof import("../../server/games/bgs-store");

async function importServerModules() {
  createApp = (await import("../../server/app")).createApp;
  store = await import("../../server/games/store");
  customBotStore = await import("../../server/games/custom-bot-store");
  bgsStore = await import("../../server/games/bgs-store");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(
  pred: () => boolean,
  label: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting until: ${label}`);
    }
    await sleep(50);
  }
}

// ================================
// --- Human Player WebSocket ---
// ================================

interface HumanSocket {
  ws: WebSocket;
  states: Extract<ServerMessage, { type: "state" }>[];
  waitForState: (
    pred: (s: Extract<ServerMessage, { type: "state" }>) => boolean,
    timeoutMs?: number,
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
      headers: {
        Origin: "http://localhost:5173",
        "x-test-user-id": userId,
      },
    });

    const states: Extract<ServerMessage, { type: "state" }>[] = [];
    const waiters: {
      pred: (s: Extract<ServerMessage, { type: "state" }>) => boolean;
      resolve: (s: Extract<ServerMessage, { type: "state" }>) => void;
    }[] = [];

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (msg.type !== "state") return;
      states.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          const w = waiters[i];
          waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    });

    ws.on("open", () => {
      resolve({
        ws,
        states,
        close: () => ws.close(),
        waitForState: (pred, timeoutMs = 10000) => {
          const existing = states.find(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise((resolveWait, rejectWait) => {
            const timeout = setTimeout(() => {
              rejectWait(
                new Error(
                  `Timeout waiting for state. Seen: ${states
                    .map((s) => `n=${s.state.history.length}:${s.state.status}`)
                    .join(", ")}`,
                ),
              );
            }, timeoutMs);
            waiters.push({
              pred,
              resolve: (s) => {
                clearTimeout(timeout);
                resolveWait(s);
              },
            });
          });
        },
      });
    });

    ws.on("error", (err) => reject(err));
  });
}

// ================================
// --- Autopilot Bot WebSocket ---
// ================================

interface AutoBot {
  ws: WebSocket;
  transcript: CustomBotServerMessage[];
  waitFor: (
    pred: (m: CustomBotServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<CustomBotServerMessage>;
}

function botConfigFor(botId: string): BotConfig {
  return {
    botId,
    name: `Bot ${botId}`,
    username: null,
    variants: {
      standard: {
        boardWidth: { min: 3, max: 15 },
        boardHeight: { min: 3, max: 15 },
        recommended: [{ boardWidth: 3, boardHeight: 3 }],
      },
    },
  };
}

async function openAutoBot(
  clientId: string,
  botIds: string[],
): Promise<AutoBot> {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace("http", "ws") + `/ws/custom-bot`;
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: "http://localhost:5173" },
    });

    const transcript: CustomBotServerMessage[] = [];
    const waiters: {
      pred: (m: CustomBotServerMessage) => boolean;
      resolve: (m: CustomBotServerMessage) => void;
    }[] = [];
    let attachedResolve: ((bot: AutoBot) => void) | null = null;

    const sendMsg = (msg: CustomBotClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const bot: AutoBot = {
      ws,
      transcript,
      waitFor: (pred, timeoutMs = 10000) => {
        const existing = transcript.find(pred);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolveWait, rejectWait) => {
          const timeout = setTimeout(() => {
            rejectWait(
              new Error(
                `Timeout waiting for bot message. Transcript: ${transcript
                  .map((m) => m.type)
                  .join(", ")}`,
              ),
            );
          }, timeoutMs);
          waiters.push({
            pred,
            resolve: (m) => {
              clearTimeout(timeout);
              resolveWait(m);
            },
          });
        });
      },
    };

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as CustomBotServerMessage;
      transcript.push(msg);

      if (msg.type === "attached" && attachedResolve) {
        const r = attachedResolve;
        attachedResolve = null;
        r(bot);
      } else if (msg.type === "start_game_session") {
        sendMsg({
          type: "game_session_started",
          bgsId: msg.bgsId,
          success: true,
          error: "",
        });
      } else if (msg.type === "end_game_session") {
        sendMsg({
          type: "game_session_ended",
          bgsId: msg.bgsId,
          success: true,
          error: "",
        });
      } else if (msg.type === "evaluate_position") {
        sendMsg({
          type: "evaluate_response",
          bgsId: msg.bgsId,
          ply: msg.expectedPly,
          bestMove: "---",
          evaluation: 0,
          success: true,
          error: "",
        });
      } else if (msg.type === "apply_move") {
        sendMsg({
          type: "move_applied",
          bgsId: msg.bgsId,
          ply: msg.expectedPly + 1,
          success: true,
          error: "",
        });
      }

      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          const w = waiters[i];
          waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    });

    ws.on("open", () => {
      attachedResolve = resolve;
      sendMsg({
        type: "attach",
        protocolVersion: 3,
        clientId,
        bots: botIds.map(botConfigFor),
        client: { name: "leadin-test-bot", version: "3.0.0" },
      });
    });

    ws.on("error", (err) => reject(err));
  });
}

// ================================
// --- Tests ---
// ================================

const seedRows = buildSavedPuzzleSeedRows(
  generateCustomSetupCandidates(),
  verdictFile as CandidateVerdictFile,
);

describe("lead-in game BGS initialization (S-P1)", () => {
  beforeAll(async () => {
    try {
      const handle = await setupEphemeralDb();
      container = handle.container;
      console.log("[bot-8] using ephemeral Postgres container");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNoContainerRuntime =
        message.includes("Could not find a working container runtime") ||
        message.includes("Docker is not running");
      if (!isNoContainerRuntime) {
        throw error;
      }
      process.env.DATABASE_URL ??=
        "postgres://unused:unused@127.0.0.1:9/unused";
      console.log("[bot-8] no container runtime — running without a database");
    }
    await importServerModules();
    const { app, websocket } = createApp();
    server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
    baseUrl = `http://localhost:${server.port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) {
      await server.stop(true);
      server = null;
    }
    await teardownEphemeralDb(container);
  }, 60_000);

  it("first connect to a lead-in game rebuilds the BGS from history and the bot replies", async () => {
    const compositeId = "leadin-client:b";
    const bot = await openAutoBot("leadin-client", ["b"]);

    // Create the lead-in game exactly as the puzzle launch route does
    // (minus the DB row fetch): P2 seed row -> pre-position session with
    // the bot as P1 -> scripted lead-in applied as real ply 0.
    const p2Row = seedRows.find(
      (row) => row.config.variantConfig.turn.playerId === 2,
    )!;
    const launch = resolveSavedPuzzleLaunch(p2Row);
    const { session, hostSocketToken } = store.createGameSession({
      config: {
        ...launch.config,
        timeControl: BOT_GAME_TIME_CONTROL,
        rated: false,
      },
      matchType: "friend",
      hostDisplayName: "human",
      hostIsPlayer1: launch.humanIsPlayer1,
      joinerConfig: { type: "bot", displayName: "PuzzleBot" },
    });
    store.setBotCompositeId(session.id, "joiner", compositeId);
    session.players.joiner.ready = true;
    session.status = "ready";
    store.applyPlayerMove({
      id: session.id,
      playerId: session.players.joiner.playerId,
      move: launch.leadInMove!,
      timestamp: Date.now(),
    });
    customBotStore.addActiveGame(compositeId, session.id, 1, "human");
    expect(session.gameState.history).toHaveLength(1);

    // Human connects: BGS must be built via the history rebuild.
    const human = await openHumanSocket(
      "user-leadin",
      session.id,
      hostSocketToken,
    );
    const s0 = await human.waitForState((s) => s.state.history.length === 1);
    expect(s0.state.turn).toBe(2);

    // The rebuild replays the scripted ply 0 into the engine session and
    // evaluates the post-lead-in position.
    await bot.waitFor((m) => m.type === "apply_move" && m.expectedPly === 0);
    await bot.waitFor(
      (m) => m.type === "evaluate_position" && m.expectedPly === 1,
    );
    await waitUntil(
      () => bgsStore.getBgs(session.id)?.currentPly === 1,
      "BGS in sync with game history (currentPly 1)",
    );

    // The failing prod symptom: human moves, bot never replies. Post-fix,
    // the bot's autopilot answer must land as a real move.
    human.ws.send(
      JSON.stringify({ type: "submit-move", move: { actions: [] } }),
    );
    await human.waitForState(
      (s) => s.state.history.length >= 3 && s.state.turn === 2,
    );

    // Cleanup only (no assertion): the finished broadcast can stall behind
    // dead-database persistence in multi-suite runs, and the session is
    // in-memory anyway. The regression is fully proven above.
    human.ws.send(JSON.stringify({ type: "resign" }));
    await sleep(200);
    human.close();
    bot.ws.close();
  }, 30_000);
});
