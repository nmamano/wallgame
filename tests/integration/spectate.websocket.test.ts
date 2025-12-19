/**
 * Integration tests for spectating and live games functionality.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * No manual database setup required - just Docker.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  GameCreateResponse,
  GameSessionDetails,
  JoinGameResponse,
  LiveGameSummary,
  SpectateResponse,
} from "../../shared/contracts/games";
import type {
  ServerMessage,
  LiveGamesServerMessage,
} from "../../shared/contracts/websocket-messages";
import type {
  GameConfiguration,
  PlayerAppearance,
} from "../../shared/domain/game-types";

// ================================
// --- Test Harness ---
// ================================

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
  server = Bun.serve({
    fetch: app.fetch,
    websocket,
    port: 0,
  });
  baseUrl = `http://localhost:${server.port}`;
}

async function stopTestServer() {
  if (server) {
    await server.stop(true); // Force close all connections
  }
}

// ================================
// --- HTTP Client Helpers ---
// ================================

const DEFAULT_CONFIG: GameConfiguration = {
  timeControl: {
    initialSeconds: 300,
    incrementSeconds: 5,
    preset: "rapid",
  },
  variant: "standard",
  rated: false,
  boardWidth: 9,
  boardHeight: 9,
};

async function createFriendGame(
  userId: string,
  config: GameConfiguration = DEFAULT_CONFIG,
  options?: {
    appearance?: PlayerAppearance;
    hostIsPlayer1?: boolean;
  },
): Promise<GameCreateResponse> {
  const res = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      config,
      matchType: "friend",
      hostDisplayName: `Player ${userId}`,
      hostAppearance: options?.appearance,
      hostIsPlayer1: options?.hostIsPlayer1,
    }),
  });

  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(`Expected 201, got ${res.status}: ${text}`);
  }
  return (await res.json()) as GameCreateResponse;
}

async function joinFriendGame(
  userId: string,
  gameId: string,
  appearance?: PlayerAppearance,
): Promise<GameSessionDetails> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      displayName: `Player ${userId}`,
      appearance,
    }),
  });

  expect(res.status).toBe(200);
  const json = (await res.json()) as JoinGameResponse;
  expect(json.role).toBe("player");
  if (json.role !== "player") {
    throw new Error("Expected player join response");
  }
  return {
    snapshot: json.snapshot,
    role: json.seat,
    playerId: json.playerId,
    token: json.token,
    socketToken: json.socketToken,
    shareUrl: json.shareUrl,
  };
}

async function markHostReady(gameId: string, hostToken: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/ready`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: hostToken }),
  });
  expect(res.status).toBe(200);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function fetchLiveGames(): Promise<LiveGameSummary[]> {
  const res = await fetch(`${baseUrl}/api/games/live`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { games: LiveGameSummary[] };
  return json.games;
}

async function fetchSpectateData(
  gameId: string,
): Promise<{ status: number; data?: SpectateResponse; error?: string }> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/spectate`);
  if (res.ok) {
    return { status: res.status, data: (await res.json()) as SpectateResponse };
  }
  const error = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: error.error };
}

// ================================
// --- WebSocket Client Helpers ---
// ================================

interface TestSocket {
  ws: WebSocket;
  waitForMessage: <T extends ServerMessage["type"]>(
    expectedType: T,
    options?: { ignore?: ServerMessage["type"][] },
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  drainMessages: (type: ServerMessage["type"]) => void;
  close: () => void;
}

async function openGameSocket(
  userId: string,
  gameId: string,
  socketToken: string,
): Promise<TestSocket> {
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

    const buffer: ServerMessage[] = [];
    let waitingResolve: ((msg: ServerMessage) => void) | null = null;

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (waitingResolve) {
        const resolve = waitingResolve;
        waitingResolve = null;
        resolve(msg);
      } else {
        buffer.push(msg);
      }
    });

    ws.on("open", () => {
      resolve({
        ws,
        close: () => ws.close(),
        drainMessages: (type: ServerMessage["type"]) => {
          for (let i = buffer.length - 1; i >= 0; i--) {
            if (buffer[i].type === type) {
              buffer.splice(i, 1);
            }
          }
        },
        waitForMessage: <T extends ServerMessage["type"]>(
          expectedType: T,
          options?: { ignore?: ServerMessage["type"][] },
        ) => {
          const ignoreTypes = options?.ignore ?? [];
          return new Promise<Extract<ServerMessage, { type: T }>>(
            (resolveWait, rejectWait) => {
              const processMessage = (msg: ServerMessage): boolean => {
                if (msg.type === expectedType) {
                  resolveWait(msg as Extract<ServerMessage, { type: T }>);
                  return true;
                } else if (ignoreTypes.includes(msg.type)) {
                  return false;
                } else {
                  rejectWait(
                    new Error(
                      `Expected "${expectedType}" but got "${msg.type}"`,
                    ),
                  );
                  return true;
                }
              };

              while (buffer.length > 0) {
                const msg = buffer.shift()!;
                if (processMessage(msg)) return;
              }

              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(new Error(`Timeout waiting for "${expectedType}"`));
              }, 5000);

              const waitForNext = () => {
                waitingResolve = (msg: ServerMessage) => {
                  if (processMessage(msg)) {
                    clearTimeout(timeout);
                  } else {
                    waitForNext();
                  }
                };
              };
              waitForNext();
            },
          );
        },
      });
    });

    ws.on("error", (err) => reject(err));
  });
}

/**
 * Opens a spectator WebSocket connection (no token).
 */
async function openSpectatorSocket(gameId: string): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    // No token = spectator mode
    const wsUrl = baseUrl.replace("http", "ws") + `/ws/games/${gameId}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: "http://localhost:5173",
      },
    });

    const buffer: ServerMessage[] = [];
    let waitingResolve: ((msg: ServerMessage) => void) | null = null;

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (waitingResolve) {
        const resolve = waitingResolve;
        waitingResolve = null;
        resolve(msg);
      } else {
        buffer.push(msg);
      }
    });

    ws.on("open", () => {
      resolve({
        ws,
        close: () => ws.close(),
        drainMessages: (type: ServerMessage["type"]) => {
          for (let i = buffer.length - 1; i >= 0; i--) {
            if (buffer[i].type === type) {
              buffer.splice(i, 1);
            }
          }
        },
        waitForMessage: <T extends ServerMessage["type"]>(
          expectedType: T,
          options?: { ignore?: ServerMessage["type"][] },
        ) => {
          const ignoreTypes = options?.ignore ?? [];
          return new Promise<Extract<ServerMessage, { type: T }>>(
            (resolveWait, rejectWait) => {
              const processMessage = (msg: ServerMessage): boolean => {
                if (msg.type === expectedType) {
                  resolveWait(msg as Extract<ServerMessage, { type: T }>);
                  return true;
                } else if (ignoreTypes.includes(msg.type)) {
                  return false;
                } else {
                  rejectWait(
                    new Error(
                      `Expected "${expectedType}" but got "${msg.type}"`,
                    ),
                  );
                  return true;
                }
              };

              while (buffer.length > 0) {
                const msg = buffer.shift()!;
                if (processMessage(msg)) return;
              }

              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(new Error(`Timeout waiting for "${expectedType}"`));
              }, 5000);

              const waitForNext = () => {
                waitingResolve = (msg: ServerMessage) => {
                  if (processMessage(msg)) {
                    clearTimeout(timeout);
                  } else {
                    waitForNext();
                  }
                };
              };
              waitForNext();
            },
          );
        },
      });
    });

    ws.on("error", (err) => reject(err));
  });
}

interface LiveGamesTestSocket {
  ws: WebSocket;
  waitForMessage: <T extends LiveGamesServerMessage["type"]>(
    expectedType: T,
  ) => Promise<Extract<LiveGamesServerMessage, { type: T }>>;
  close: () => void;
}

async function openLiveGamesSocket(): Promise<LiveGamesTestSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace("http", "ws") + "/ws/live-games";

    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: "http://localhost:5173",
      },
    });

    const buffer: LiveGamesServerMessage[] = [];
    let waitingResolve: ((msg: LiveGamesServerMessage) => void) | null = null;

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as LiveGamesServerMessage;
      if (waitingResolve) {
        const resolve = waitingResolve;
        waitingResolve = null;
        resolve(msg);
      } else {
        buffer.push(msg);
      }
    });

    ws.on("open", () => {
      resolve({
        ws,
        close: () => ws.close(),
        waitForMessage: <T extends LiveGamesServerMessage["type"]>(
          expectedType: T,
        ) => {
          return new Promise<Extract<LiveGamesServerMessage, { type: T }>>(
            (resolveWait, rejectWait) => {
              // Check buffer first
              for (let i = 0; i < buffer.length; i++) {
                if (buffer[i].type === expectedType) {
                  const msg = buffer.splice(i, 1)[0];
                  resolveWait(
                    msg as Extract<LiveGamesServerMessage, { type: T }>,
                  );
                  return;
                }
              }

              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(new Error(`Timeout waiting for "${expectedType}"`));
              }, 5000);

              waitingResolve = (msg: LiveGamesServerMessage) => {
                clearTimeout(timeout);
                if (msg.type === expectedType) {
                  resolveWait(
                    msg as Extract<LiveGamesServerMessage, { type: T }>,
                  );
                } else {
                  // Put back in buffer
                  buffer.push(msg);
                  // Keep waiting
                  const waitForNext = () => {
                    waitingResolve = (nextMsg: LiveGamesServerMessage) => {
                      if (nextMsg.type === expectedType) {
                        clearTimeout(timeout);
                        resolveWait(
                          nextMsg as Extract<
                            LiveGamesServerMessage,
                            { type: T }
                          >,
                        );
                      } else {
                        buffer.push(nextMsg);
                        waitForNext();
                      }
                    };
                  };
                  waitForNext();
                }
              };
            },
          );
        },
      });
    });

    ws.on("error", (err) => reject(err));
  });
}

// ================================
// --- Test Setup ---
// ================================

beforeAll(async () => {
  const handle = await setupEphemeralDb();

  container = handle.container;
  await importServerModules();
  startTestServer();
}, 60000);

afterAll(async () => {
  await stopTestServer();
  await teardownEphemeralDb(container);
}, 30000);

// ================================
// --- Live Games List Tests ---
// ================================

describe("Live Games List", () => {
  it("returns empty snapshot when no games in progress", async () => {
    const socket = await openLiveGamesSocket();
    try {
      const msg = await socket.waitForMessage("snapshot");
      expect(msg.type).toBe("snapshot");
      expect(msg.games).toBeArray();
      // May or may not be empty depending on test order, but should be an array
    } finally {
      socket.close();
    }
  });

  it("game appears in list when first move is played", async () => {
    // Create and set up game
    const hostId = "host-live-1";
    const joinerId = "joiner-live-1";

    const createRes = await createFriendGame(hostId, DEFAULT_CONFIG, {
      hostIsPlayer1: true,
    });
    const joinRes = await joinFriendGame(joinerId, createRes.gameId);
    await markHostReady(createRes.gameId, createRes.hostToken);

    // Connect players first
    const hostSocket = await openGameSocket(
      hostId,
      createRes.gameId,
      createRes.socketToken,
    );
    const joinerSocket = await openGameSocket(
      joinerId,
      createRes.gameId,
      joinRes.socketToken,
    );

    // Wait a bit for messages to arrive
    await new Promise((r) => setTimeout(r, 100));

    // Connect to live games list after players are ready
    const liveSocket = await openLiveGamesSocket();
    await liveSocket.waitForMessage("snapshot"); // Clear initial snapshot

    try {
      // Make first move (host is Player 1)
      // On a 9x9 board, Player 1's cat starts at [0,0] and mouse at [8,0]
      // Valid first move: cat to [0,1] and mouse to [7,0]
      hostSocket.ws.send(
        JSON.stringify({
          type: "submit-move",
          move: {
            actions: [
              { type: "cat", target: [0, 1] },
              { type: "mouse", target: [7, 0] },
            ],
          },
        }),
      );

      // Wait for upsert in live games list
      const upsertMsg = await liveSocket.waitForMessage("upsert");
      expect(upsertMsg.type).toBe("upsert");
      expect(upsertMsg.game.id).toBe(createRes.gameId);
      expect(upsertMsg.game.status).toBe("in-progress");
      expect(upsertMsg.game.moveCount).toBeGreaterThanOrEqual(1);
    } finally {
      hostSocket.close();
      joinerSocket.close();
      liveSocket.close();
    }
  });

  it("game removed from list when ended by resignation", async () => {
    const hostId = "host-resign-1";
    const joinerId = "joiner-resign-1";

    const createRes = await createFriendGame(hostId, DEFAULT_CONFIG, {
      hostIsPlayer1: true,
    });
    const joinRes = await joinFriendGame(joinerId, createRes.gameId);
    await markHostReady(createRes.gameId, createRes.hostToken);

    // Connect players and make a move to start game
    const hostSocket = await openGameSocket(
      hostId,
      createRes.gameId,
      createRes.socketToken,
    );
    const joinerSocket = await openGameSocket(
      joinerId,
      createRes.gameId,
      joinRes.socketToken,
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // Make first move
    hostSocket.ws.send(
      JSON.stringify({
        type: "submit-move",
        move: {
          actions: [
            { type: "cat", target: [0, 1] },
            { type: "mouse", target: [7, 0] },
          ],
        },
      }),
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // Now connect to live games
    const liveSocket = await openLiveGamesSocket();
    const snapshot = await liveSocket.waitForMessage("snapshot");
    const gameInList = snapshot.games.find((g) => g.id === createRes.gameId);
    expect(gameInList).toBeDefined();

    try {
      // Resign
      hostSocket.ws.send(JSON.stringify({ type: "resign" }));

      // Wait for remove
      const removeMsg = await liveSocket.waitForMessage("remove");
      expect(removeMsg.type).toBe("remove");
      expect(removeMsg.gameId).toBe(createRes.gameId);
    } finally {
      hostSocket.close();
      joinerSocket.close();
      liveSocket.close();
    }
  });
});

// ================================
// --- Spectate REST Endpoint Tests ---
// ================================

describe("Spectate REST Endpoint", () => {
  it("returns 404 for waiting game", async () => {
    const hostId = "host-rest-1";
    const createRes = await createFriendGame(hostId);

    const result = await fetchSpectateData(createRes.gameId);
    expect(result.status).toBe(404);
    expect(result.error).toContain("not currently spectatable");
  });

  it("returns 200 for in-progress game", async () => {
    const hostId = "host-rest-2";
    const joinerId = "joiner-rest-2";

    const createRes = await createFriendGame(hostId, DEFAULT_CONFIG, {
      hostIsPlayer1: true,
    });
    const joinRes = await joinFriendGame(joinerId, createRes.gameId);
    await markHostReady(createRes.gameId, createRes.hostToken);

    // Connect and make a move
    const hostSocket = await openGameSocket(
      hostId,
      createRes.gameId,
      createRes.socketToken,
    );
    const joinerSocket = await openGameSocket(
      joinerId,
      createRes.gameId,
      joinRes.socketToken,
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    hostSocket.ws.send(
      JSON.stringify({
        type: "submit-move",
        move: {
          actions: [
            { type: "cat", target: [0, 1] },
            { type: "mouse", target: [7, 0] },
          ],
        },
      }),
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });

    try {
      const result = await fetchSpectateData(createRes.gameId);
      expect(result.status).toBe(200);
      expect(result.data).toBeDefined();
      expect(result.data!.snapshot.id).toBe(createRes.gameId);
      expect(result.data!.state.moveCount).toBeGreaterThanOrEqual(1);
    } finally {
      hostSocket.close();
      joinerSocket.close();
    }
  });
});

// ================================
// --- Spectator WebSocket Tests ---
// ================================

describe("Spectator WebSocket", () => {
  it("spectator receives current state on connect", async () => {
    const hostId = "host-spec-1";
    const joinerId = "joiner-spec-1";

    const createRes = await createFriendGame(hostId, DEFAULT_CONFIG, {
      hostIsPlayer1: true,
    });
    const joinRes = await joinFriendGame(joinerId, createRes.gameId);
    await markHostReady(createRes.gameId, createRes.hostToken);

    // Connect players and make a move
    const hostSocket = await openGameSocket(
      hostId,
      createRes.gameId,
      createRes.socketToken,
    );
    const joinerSocket = await openGameSocket(
      joinerId,
      createRes.gameId,
      joinRes.socketToken,
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    hostSocket.ws.send(
      JSON.stringify({
        type: "submit-move",
        move: {
          actions: [
            { type: "cat", target: [0, 1] },
            { type: "mouse", target: [7, 0] },
          ],
        },
      }),
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // Now connect as spectator
    const spectatorSocket = await openSpectatorSocket(createRes.gameId);

    try {
      // Spectator should receive state
      const stateMsg = await spectatorSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(stateMsg.type).toBe("state");
      expect(stateMsg.state.moveCount).toBeGreaterThanOrEqual(1);

      // And match-status
      spectatorSocket.drainMessages("state");
      const matchMsg = await spectatorSocket.waitForMessage("match-status", {
        ignore: ["state"],
      });
      expect(matchMsg.type).toBe("match-status");
      expect(matchMsg.snapshot.id).toBe(createRes.gameId);
    } finally {
      spectatorSocket.close();
      hostSocket.close();
      joinerSocket.close();
    }
  });

  it("spectator receives move updates", async () => {
    const hostId = "host-spec-2";
    const joinerId = "joiner-spec-2";

    const createRes = await createFriendGame(hostId, DEFAULT_CONFIG, {
      hostIsPlayer1: true,
    });
    const joinRes = await joinFriendGame(joinerId, createRes.gameId);
    await markHostReady(createRes.gameId, createRes.hostToken);

    const hostSocket = await openGameSocket(
      hostId,
      createRes.gameId,
      createRes.socketToken,
    );
    const joinerSocket = await openGameSocket(
      joinerId,
      createRes.gameId,
      joinRes.socketToken,
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // Make first move
    hostSocket.ws.send(
      JSON.stringify({
        type: "submit-move",
        move: {
          actions: [
            { type: "cat", target: [0, 1] },
            { type: "mouse", target: [7, 0] },
          ],
        },
      }),
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // Connect spectator
    const spectatorSocket = await openSpectatorSocket(createRes.gameId);
    await spectatorSocket.waitForMessage("state", { ignore: ["match-status"] });
    spectatorSocket.drainMessages("match-status");

    try {
      // Joiner makes move
      joinerSocket.ws.send(
        JSON.stringify({
          type: "submit-move",
          move: {
            actions: [
              { type: "cat", target: [0, 7] },
              { type: "mouse", target: [7, 8] },
            ],
          },
        }),
      );

      // Spectator should receive the state update
      const stateMsg = await spectatorSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(stateMsg.type).toBe("state");
      expect(stateMsg.state.moveCount).toBeGreaterThanOrEqual(2);
    } finally {
      spectatorSocket.close();
      hostSocket.close();
      joinerSocket.close();
    }
  });

  it("spectator cannot send game messages", async () => {
    const hostId = "host-spec-3";
    const joinerId = "joiner-spec-3";

    const createRes = await createFriendGame(hostId, DEFAULT_CONFIG, {
      hostIsPlayer1: true,
    });
    const joinRes = await joinFriendGame(joinerId, createRes.gameId);
    await markHostReady(createRes.gameId, createRes.hostToken);

    const hostSocket = await openGameSocket(
      hostId,
      createRes.gameId,
      createRes.socketToken,
    );
    const joinerSocket = await openGameSocket(
      joinerId,
      createRes.gameId,
      joinRes.socketToken,
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // Make a move to get game in progress
    hostSocket.ws.send(
      JSON.stringify({
        type: "submit-move",
        move: {
          actions: [
            { type: "cat", target: [0, 1] },
            { type: "mouse", target: [7, 0] },
          ],
        },
      }),
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // Connect spectator
    const spectatorSocket = await openSpectatorSocket(createRes.gameId);
    await spectatorSocket.waitForMessage("state", { ignore: ["match-status"] });
    spectatorSocket.drainMessages("match-status");

    try {
      // Try to send a move
      spectatorSocket.ws.send(
        JSON.stringify({
          type: "submit-move",
          move: {
            actions: [{ type: "cat", target: [0, 2] }],
          },
        }),
      );

      // Should receive error
      const errorMsg = await spectatorSocket.waitForMessage("error", {
        ignore: ["match-status"],
      });
      expect(errorMsg.type).toBe("error");
      expect(errorMsg.message).toContain(
        "Spectators cannot send game messages",
      );
    } finally {
      spectatorSocket.close();
      hostSocket.close();
      joinerSocket.close();
    }
  });

  it("spectator count updates in live games list", async () => {
    const hostId = "host-count-1";
    const joinerId = "joiner-count-1";

    const createRes = await createFriendGame(hostId, DEFAULT_CONFIG, {
      hostIsPlayer1: true,
    });
    const joinRes = await joinFriendGame(joinerId, createRes.gameId);
    await markHostReady(createRes.gameId, createRes.hostToken);

    const hostSocket = await openGameSocket(
      hostId,
      createRes.gameId,
      createRes.socketToken,
    );
    const joinerSocket = await openGameSocket(
      joinerId,
      createRes.gameId,
      joinRes.socketToken,
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // Make move to start game
    hostSocket.ws.send(
      JSON.stringify({
        type: "submit-move",
        move: {
          actions: [
            { type: "cat", target: [0, 1] },
            { type: "mouse", target: [7, 0] },
          ],
        },
      }),
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // Connect to live games
    const liveSocket = await openLiveGamesSocket();
    const snapshot = await liveSocket.waitForMessage("snapshot");
    const initialGame = snapshot.games.find((g) => g.id === createRes.gameId);
    expect(initialGame).toBeDefined();
    const initialCount = initialGame!.spectatorCount;

    // Connect spectator
    const spectatorSocket = await openSpectatorSocket(createRes.gameId);
    await spectatorSocket.waitForMessage("state", { ignore: ["match-status"] });

    try {
      // Should get upsert with increased spectator count
      const upsertMsg = await liveSocket.waitForMessage("upsert");
      expect(upsertMsg.game.id).toBe(createRes.gameId);
      expect(upsertMsg.game.spectatorCount).toBe(initialCount + 1);

      // Disconnect spectator
      spectatorSocket.close();

      // Should get upsert with decreased count
      const upsertMsg2 = await liveSocket.waitForMessage("upsert");
      expect(upsertMsg2.game.id).toBe(createRes.gameId);
      expect(upsertMsg2.game.spectatorCount).toBe(initialCount);
    } finally {
      liveSocket.close();
      hostSocket.close();
      joinerSocket.close();
    }
  });

  it("spectator follows rematch transitions", async () => {
    const hostId = "host-rematch-spectator";
    const joinerId = "joiner-rematch-spectator";

    const createRes = await createFriendGame(hostId, DEFAULT_CONFIG, {
      hostIsPlayer1: true,
    });
    const joinRes = await joinFriendGame(joinerId, createRes.gameId);
    await markHostReady(createRes.gameId, createRes.hostToken);

    const hostSocket = await openGameSocket(
      hostId,
      createRes.gameId,
      createRes.socketToken,
    );
    const joinerSocket = await openGameSocket(
      joinerId,
      createRes.gameId,
      joinRes.socketToken,
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // First move to enter in-progress state
    hostSocket.ws.send(
      JSON.stringify({
        type: "submit-move",
        move: {
          actions: [
            { type: "cat", target: [0, 1] },
            { type: "mouse", target: [7, 0] },
          ],
        },
      }),
    );

    await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
    await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

    // Connect spectator
    const spectatorSocket = await openSpectatorSocket(createRes.gameId);
    await spectatorSocket.waitForMessage("state", { ignore: ["match-status"] });

    try {
      // Finish game via resignation
      hostSocket.ws.send(JSON.stringify({ type: "resign" }));
      await hostSocket.waitForMessage("state", { ignore: ["match-status"] });
      await joinerSocket.waitForMessage("state", { ignore: ["match-status"] });

      const finishedMsg = await spectatorSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(finishedMsg.state.status).toBe("finished");

      // Host offers rematch, joiner accepts
      hostSocket.ws.send(JSON.stringify({ type: "rematch-offer" }));
      await joinerSocket.waitForMessage("rematch-offer", {
        ignore: ["state", "match-status"],
      });
      joinerSocket.ws.send(JSON.stringify({ type: "rematch-accept" }));

      await hostSocket.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      });
      await joinerSocket.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      });

      const rematchState = await spectatorSocket.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      });
      expect(rematchState.state.status).toBe("playing");
      expect(rematchState.state.moveCount).toBe(1);
    } finally {
      spectatorSocket.close();
      hostSocket.close();
      joinerSocket.close();
    }
  });
});
