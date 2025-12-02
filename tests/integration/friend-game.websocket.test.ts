import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { createApp } from "../../server/index";
import { WebSocket } from "ws";
import type {
  GameCreateResponse,
  GameSessionDetails,
  JoinGameResponse,
  MatchmakingGamesResponse,
} from "../../shared/contracts/games";
import type {
  ClientMessage,
  ServerMessage,
} from "../../shared/contracts/websocket-messages";
import type {
  GameConfiguration,
  PlayerAppearance,
} from "../../shared/domain/game-types";
import {
  cellFromStandardNotation,
  moveFromStandardNotation,
} from "../../shared/domain/standard-notation";

// ================================
// --- Test Harness ---
// ================================

let server: any;
let baseUrl: string;

function startTestServer() {
  const { app, websocket } = createApp();
  server = Bun.serve({
    fetch: app.fetch,
    websocket,
    port: 0, // Random available port
  });
  baseUrl = `http://localhost:${server.port}`;
}

async function stopTestServer() {
  if (server) {
    server.stop();
  }
}

// ================================
// --- HTTP Client Helpers ---
// ================================

/**
 * Creates a friend game with explicit Player 1 assignment for deterministic tests.
 *
 * @param hostIsPlayer1 - Whether the host becomes Player 1 (who starts first).
 *   Pass explicitly in tests for determinism. If omitted, server chooses randomly.
 *   See game-types.ts for terminology: Player A/B (roles) vs Player 1/2 (game logic).
 */
async function createFriendGame(
  userId: string,
  config: GameConfiguration,
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
      config: config,
      matchType: "friend",
      hostDisplayName: `Player ${userId}`,
      hostAppearance: options?.appearance,
      hostIsPlayer1: options?.hostIsPlayer1,
    }),
  });

  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(
      `Expected status 201 but got ${res.status}. Error: ${text}`,
    );
  }
  const json = await res.json();
  return json as GameCreateResponse;
}

/**
 * Creates a matchmaking game with explicit Player 1 assignment for deterministic tests.
 *
 * @param hostIsPlayer1 - Whether the host becomes Player 1 (who starts first).
 *   Pass explicitly in tests for determinism. If omitted, server chooses randomly.
 *   See game-types.ts for terminology: Player A/B (roles) vs Player 1/2 (game logic).
 */
async function createMatchmakingGame(
  userId: string,
  config: GameConfiguration,
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
      config: config,
      matchType: "matchmaking",
      hostDisplayName: `Player ${userId}`,
      hostAppearance: options?.appearance,
      hostIsPlayer1: options?.hostIsPlayer1,
    }),
  });

  expect(res.status).toBe(201);
  const json = await res.json();
  return json as GameCreateResponse;
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

  // Find joiner's playerId from the snapshot
  // The host chose whether they're Player 1 or 2, so joiner gets the other
  const joinerPlayer = json.snapshot.players.find((p) => p.role === "joiner");
  const playerId = joinerPlayer?.playerId ?? 2;

  return {
    snapshot: json.snapshot,
    role: "joiner",
    playerId,
    token: json.token,
    socketToken: json.socketToken,
    shareUrl: json.shareUrl,
  };
}

async function fetchMatchmakingGames(): Promise<
  MatchmakingGamesResponse["games"]
> {
  const res = await fetch(`${baseUrl}/api/games/matchmaking`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as MatchmakingGamesResponse;
  return json.games;
}

// ================================
// --- WebSocket Client Helpers ---
// ================================

type TestSocket = {
  ws: WebSocket;
  /** Wait for the next message of the expected type. Skips messages of ignored types. Fails immediately if an unexpected type arrives. */
  waitForMessage: <T extends ServerMessage["type"]>(
    expectedType: T,
    options?: { ignore?: ServerMessage["type"][] },
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  /** Consume and ignore any buffered messages of the given type (useful for match-status messages). */
  drainMessages: (type: ServerMessage["type"]) => void;
  /** Get current buffer state for debugging. */
  getBufferState: () => string;
  close: () => void;
};

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

    ws.on("message", (data) => {
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

        getBufferState: () => {
          return buffer.map((m) => m.type).join(", ") || "(empty)";
        },

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
                  return true; // Handled
                } else if (ignoreTypes.includes(msg.type)) {
                  return false; // Skip, keep waiting
                } else {
                  rejectWait(
                    new Error(
                      `Expected message type "${expectedType}" but got "${msg.type}". ` +
                        `Message: ${JSON.stringify(msg, null, 2)}`,
                    ),
                  );
                  return true; // Handled (with error)
                }
              };

              // Check buffer first, skip ignored messages
              while (buffer.length > 0) {
                const msg = buffer.shift()!;
                if (processMessage(msg)) {
                  return;
                }
                // Message was ignored, continue checking buffer
              }

              // Set up timeout
              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(
                  new Error(
                    `Timeout waiting for "${expectedType}" message. Buffer: ${buffer.map((m) => m.type).join(", ") || "(empty)"}`,
                  ),
                );
              }, 5000);

              // Wait for messages, skipping ignored ones
              const waitForNext = () => {
                waitingResolve = (msg: ServerMessage) => {
                  if (processMessage(msg)) {
                    clearTimeout(timeout);
                  } else {
                    // Message was ignored, wait for next
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
 * Sends a move from one socket and waits for both sockets to receive the state update.
 * Verifies both sockets received the same state and that the move was applied correctly.
 * Returns the state from the first socket.
 */
async function sendMoveAndWaitForState(
  senderSocketIdx: 0 | 1,
  allSockets: [TestSocket, TestSocket],
  moveNotation: string,
  boardHeight: number,
): Promise<Extract<ServerMessage, { type: "state" }>["state"]> {
  const move = moveFromStandardNotation(moveNotation, boardHeight);

  const senderSocket = allSockets[senderSocketIdx];
  senderSocket.ws.send(
    JSON.stringify({
      type: "submit-move",
      move,
    }),
  );

  const [stateA, stateB] = await Promise.all([
    allSockets[0].waitForMessage("state", { ignore: ["match-status"] }),
    allSockets[1].waitForMessage("state", { ignore: ["match-status"] }),
  ]);

  expect(stateA.state).toEqual(stateB.state);

  // Verify each action in the move was applied correctly
  // After a move, state.turn switches to the other player, so the mover is the opposite
  const playerId = stateA.state.turn === 1 ? "2" : "1";
  for (const action of move.actions) {
    if (action.type === "cat") {
      expect(stateA.state.pawns[playerId].cat).toEqual(action.target);
    } else if (action.type === "mouse") {
      expect(stateA.state.pawns[playerId].mouse).toEqual(action.target);
    } else if (action.type === "wall") {
      const matchingWall = stateA.state.walls.find(
        (w) =>
          w.cell[0] === action.target[0] &&
          w.cell[1] === action.target[1] &&
          w.orientation === action.wallOrientation,
      );
      expect(matchingWall).toBeDefined();
    }
  }

  return stateA.state;
}

// ================================
// --- Main Tests ---
// ================================

describe("friend game WebSocket integration", () => {
  beforeAll(() => {
    startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  it("allows two players to create a friend game, join it, exchange moves, and do meta actions", async () => {
    const userA = "user-a";
    const userB = "user-b";

    // Define appearance data for testing
    const userAAppearance = {
      pawnColor: "green",
      catSkin: "cat1.svg",
      mouseSkin: "mouse5.svg",
    };
    const userBAppearance = {
      pawnColor: "blue",
      catSkin: "cat2.svg",
      mouseSkin: "mouse3.svg",
    };

    // 1. User A creates a friend game with appearance
    // The board is 3x3 (from a1 at the bottom-left to c3 at the top-right)
    /*
      C1 __ C2
      __ __ __
      M1 __ M2
    */
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: false,
      boardWidth: 3,
      boardHeight: 3,
    };
    // Create game with host as Player 1 (who starts first) for deterministic testing
    // In normal games, hostIsPlayer1 is randomly chosen by the host frontend
    const {
      gameId,
      shareUrl,
      socketToken: socketTokenA,
      snapshot: initialSnapshotA,
    } = await createFriendGame(userA, gameConfig, {
      appearance: userAAppearance,
      hostIsPlayer1: true,
    });
    expect(gameId).toBeDefined();
    expect(shareUrl).toBeDefined();
    expect(socketTokenA).toBeDefined();
    expect(initialSnapshotA.players[0].appearance).toEqual(userAAppearance);

    // 2. User B joins the game with appearance
    const { socketToken: socketTokenB, snapshot: joinSnapshotB } =
      await joinFriendGame(userB, gameId, userBAppearance);
    expect(socketTokenB).toBeDefined();
    expect(joinSnapshotB.players[0].appearance).toEqual(userAAppearance); // Host appearance
    expect(joinSnapshotB.players[1].appearance).toEqual(userBAppearance); // Joiner appearance

    // 3. Both connect via WebSocket
    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, socketTokenB);

    // Wait for initial match status and state (match-status comes first on connect)
    const matchStatusMsgA = await socketA.waitForMessage("match-status");
    const stateMsgA = await socketA.waitForMessage("state");
    const matchStatusMsgB = await socketB.waitForMessage("match-status");
    const stateMsgB = await socketB.waitForMessage("state");

    const initialState = stateMsgA.state;
    expect(initialState).toBeDefined();
    expect(stateMsgB.state).toEqual(initialState);

    // Verify both clients receive correct player appearances
    expect(matchStatusMsgA.snapshot.players[0].appearance).toEqual(
      userAAppearance,
    ); // Host
    expect(matchStatusMsgA.snapshot.players[1].appearance).toEqual(
      userBAppearance,
    ); // Joiner
    expect(matchStatusMsgB.snapshot.players[0].appearance).toEqual(
      userAAppearance,
    ); // Host
    expect(matchStatusMsgB.snapshot.players[1].appearance).toEqual(
      userBAppearance,
    ); // Joiner

    // 4. User A (Player 1) sends first move - move cat from a3 to b2
    // Player 1 starts, and their cat starts at a3 (top-left)
    /* __ __ C2
       __ C1 __
       M1 __ M2
    */
    await sendMoveAndWaitForState(0, [socketA, socketB], "Cb2", 3);

    // 5. User B (Player 2) sends a move - move cat from c3 to b2
    /* __ _____ __
       __ C1/C2 __
       M1 _____ M2
    */
    await sendMoveAndWaitForState(1, [socketA, socketB], "Cb2", 3);

    // // 8. Add more moves including wall moves and pawn moves
    // // User A places a vertical wall to the right of b4
    // socketA.ws.send(
    //   JSON.stringify({
    //     type: "submit-move",
    //     move: moveFromStandardNotation(">b4", 5),
    //   }),
    // );

    // const [wallUpdateMsgA, wallUpdateMsgB] = await Promise.all([
    //   socketA.waitForMessage("state", { ignore: ["match-status"] }),
    //   socketB.waitForMessage("state", { ignore: ["match-status"] }),
    // ]);
    // expect(wallUpdateMsgA.state.walls).toHaveLength(1);
    // expect(wallUpdateMsgB.state.walls).toHaveLength(1);
    // expect(wallUpdateMsgB.state.walls[0]).toEqual({
    //   cell: cellFromStandardNotation("b4", 5),
    //   orientation: "vertical",
    //   playerId: 1,
    // });

    // // User B moves mouse from e1 to e2
    // socketB.ws.send(
    //   JSON.stringify({
    //     type: "submit-move",
    //     move: moveFromStandardNotation("Me2", 5),
    //   }),
    // );

    // const [mouseUpdateMsgA, mouseUpdateMsgB] = await Promise.all([
    //   socketA.waitForMessage("state", { ignore: ["match-status"] }),
    //   socketB.waitForMessage("state", { ignore: ["match-status"] }),
    // ]);
    // expect(mouseUpdateMsgA.state.pawns["2"].mouse).toEqual(
    //   cellFromStandardNotation("e2", 5),
    // );
    // expect(mouseUpdateMsgB.state.pawns["2"].mouse).toEqual(
    //   cellFromStandardNotation("e2", 5),
    // );

    // // User A places a horizontal wall above c2 (doesn't block cat's path)
    // socketA.ws.send(
    //   JSON.stringify({
    //     type: "submit-move",
    //     move: moveFromStandardNotation("^c2", 5),
    //   }),
    // );

    // const [wall2UpdateMsgA, wall2UpdateMsgB] = await Promise.all([
    //   socketA.waitForMessage("state", { ignore: ["match-status"] }),
    //   socketB.waitForMessage("state", { ignore: ["match-status"] }),
    // ]);
    // expect(wall2UpdateMsgA.state.walls).toHaveLength(2);
    // expect(wall2UpdateMsgB.state.walls).toHaveLength(2);

    // // User B moves cat from d4 to d3
    // socketB.ws.send(
    //   JSON.stringify({
    //     type: "submit-move",
    //     move: moveFromStandardNotation("Cd3", 5),
    //   }),
    // );

    // const [catUpdateMsgA, catUpdateMsgB] = await Promise.all([
    //   socketA.waitForMessage("state", { ignore: ["match-status"] }),
    //   socketB.waitForMessage("state", { ignore: ["match-status"] }),
    // ]);
    // expect(catUpdateMsgA.state.pawns["2"].cat).toEqual(
    //   cellFromStandardNotation("d3", 5),
    // );
    // expect(catUpdateMsgB.state.pawns["2"].cat).toEqual(
    //   cellFromStandardNotation("d3", 5),
    // );

    // // 10. Test takeback flows - both rejection and acceptance scenarios

    // // 10a. Takeback offer from player who just moved (User B), rejection from User A
    // const stateBeforeTakeback = timeUpdateMsg.state;
    // const takebackOfferPayloadB = {
    //   type: "takeback-offer",
    // };
    // socketB.ws.send(JSON.stringify(takebackOfferPayloadB));

    // const takebackOfferMsgA = await socketA.waitForMessage(
    //   (msg) => msg.type === "takeback-offer",
    // );
    // expect(takebackOfferMsgA.playerId).toBe(2);

    // const takebackRejectPayloadA = {
    //   type: "takeback-reject",
    // };
    // socketA.ws.send(JSON.stringify(takebackRejectPayloadA));

    // const takebackRejectMsgB = await socketB.waitForMessage(
    //   (msg) => msg.type === "takeback-rejected",
    // );
    // expect(takebackRejectMsgB.playerId).toBe(1);

    // // 10b. Takeback offer from player who didn't just move (User A), acceptance from User B
    // const takebackOfferPayloadA = {
    //   type: "takeback-offer",
    // };
    // socketA.ws.send(JSON.stringify(takebackOfferPayloadA));

    // const takebackOfferMsgB = await socketB.waitForMessage(
    //   (msg) => msg.type === "takeback-offer",
    // );
    // expect(takebackOfferMsgB.playerId).toBe(1);

    // const takebackAcceptPayloadB = {
    //   type: "takeback-accept",
    // };
    // socketB.ws.send(JSON.stringify(takebackAcceptPayloadB));

    // const takebackMsgA = await socketA.waitForMessage(
    //   (msg) => msg.type === "state",
    // );
    // expect(takebackMsgA.state.moveCount).toBe(stateBeforeTakeback.moveCount - 1);
    // expect(takebackMsgA.state.turn).toBe(2); // Should be User B's turn again

    // // 10c. Test accepted takeback from player who just moved
    // // Make a move first
    // const p1CatAfterTakeback = takebackMsgA.state.pawns["1"].cat as [number, number];
    // const moveAfterTakeback: [number, number] = [p1CatAfterTakeback[0] + 1, p1CatAfterTakeback[1]];
    // const moveAfterTakebackPayload = {
    //   type: "submit-move",
    //   actions: [{ type: "cat", cell: moveAfterTakeback }],
    // };
    // socketA.ws.send(JSON.stringify(moveAfterTakebackPayload));

    // const moveAfterTakebackMsg = await socketB.waitForMessage(
    //   (msg) => msg.type === "state",
    // );

    // // User B (who just moved) offers takeback, User A accepts
    // const takebackOfferPayloadB2 = {
    //   type: "takeback-offer",
    // };
    // socketB.ws.send(JSON.stringify(takebackOfferPayloadB2));

    // const takebackOfferMsgA2 = await socketA.waitForMessage(
    //   (msg) => msg.type === "takeback-offer",
    // );
    // expect(takebackOfferMsgA2.playerId).toBe(2);

    // const takebackAcceptPayloadA = {
    //   type: "takeback-accept",
    // };
    // socketA.ws.send(JSON.stringify(takebackAcceptPayloadA));

    // const takebackMsgB = await socketB.waitForMessage(
    //   (msg) => msg.type === "state",
    // );
    // expect(takebackMsgB.state.moveCount).toBe(takebackMsgA.state.moveCount - 1);
    // expect(takebackMsgB.state.turn).toBe(2); // Should be User B's turn again

    // // 12. Test resign functionality
    // // Make a move first to ensure game is active
    // const p1CatForResign = takebackMsgB.state.pawns["1"].cat as [number, number];
    // const resignMoveTarget: [number, number] = [p1CatForResign[0] + 1, p1CatForResign[1]];
    // const resignMovePayload = {
    //   type: "submit-move",
    //   actions: [{ type: "cat", cell: resignMoveTarget }],
    // };
    // socketA.ws.send(JSON.stringify(resignMovePayload));

    // const resignMoveMsg = await socketB.waitForMessage(
    //   (msg) => msg.type === "state",
    // );

    // // User B resigns
    // const resignPayload = {
    //   type: "resign",
    // };
    // socketB.ws.send(JSON.stringify(resignPayload));

    // const resignEndMsg = await socketA.waitForMessage(
    //   (msg) => msg.type === "state",
    // );
    // expect(resignEndMsg.state.status).toBe("finished");
    // expect(resignEndMsg.state.result?.winner).toBe(1); // User A wins
    // expect(resignEndMsg.state.result?.reason).toBe("resignation");

    socketA.close();
    socketB.close();
  });

  it("allows two players to create a matchmaking game, join via lobby, and see pawn styles", async () => {
    const userA = "user-a";
    const userB = "user-b";

    // Define appearance data for testing
    const userAAppearance = {
      pawnColor: "red",
      catSkin: "cat3.svg",
      mouseSkin: "mouse1.svg",
    };
    const userBAppearance = {
      pawnColor: "blue",
      catSkin: "cat4.svg",
      mouseSkin: "mouse2.svg",
    };

    // 1. User A creates a matchmaking game with appearance
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: false,
      boardWidth: 9,
      boardHeight: 9,
    };
    // Create game with host as Player 1 for deterministic testing
    const {
      gameId,
      socketToken: socketTokenA,
      snapshot: initialSnapshotA,
    } = await createMatchmakingGame(userA, gameConfig, {
      appearance: userAAppearance,
      hostIsPlayer1: true,
    });
    expect(gameId).toBeDefined();
    expect(socketTokenA).toBeDefined();
    expect(initialSnapshotA.players[0].appearance).toEqual(userAAppearance);

    // 2. User B fetches available matchmaking games and joins one
    const availableGames = await fetchMatchmakingGames();
    expect(availableGames.length).toBeGreaterThan(0);

    // Find the game created by user A
    const gameToJoin = availableGames.find((game) => game.id === gameId);
    expect(gameToJoin).toBeDefined();
    expect(gameToJoin?.players[0].appearance).toEqual(userAAppearance);

    const { socketToken: socketTokenB, snapshot: joinSnapshotB } =
      await joinFriendGame(userB, gameId, userBAppearance);
    expect(socketTokenB).toBeDefined();
    expect(joinSnapshotB.players[0].appearance).toEqual(userAAppearance); // Host appearance
    expect(joinSnapshotB.players[1].appearance).toEqual(userBAppearance); // Joiner appearance

    // 3. Both connect via WebSocket
    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, socketTokenB);

    // Wait for initial match status and state (match-status comes first on connect)
    const matchStatusMsgA = await socketA.waitForMessage("match-status");
    const stateMsgA = await socketA.waitForMessage("state");
    const matchStatusMsgB = await socketB.waitForMessage("match-status");
    const stateMsgB = await socketB.waitForMessage("state");

    const initialState = stateMsgA.state;
    expect(initialState).toBeDefined();
    expect(stateMsgB.state).toEqual(initialState);

    // Verify both clients receive correct player appearances
    expect(matchStatusMsgA.snapshot.players[0].appearance).toEqual(
      userAAppearance,
    ); // Host
    expect(matchStatusMsgA.snapshot.players[1].appearance).toEqual(
      userBAppearance,
    ); // Joiner
    expect(matchStatusMsgB.snapshot.players[0].appearance).toEqual(
      userAAppearance,
    ); // Host
    expect(matchStatusMsgB.snapshot.players[1].appearance).toEqual(
      userBAppearance,
    ); // Joiner

    socketA.close();
    socketB.close();
  });

  it("supports draw offers, rejections, acceptance, and rematch functionality", async () => {
    const userA = "user-a";
    const userB = "user-b";

    // Create and join a new game for draw/rematch testing
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: false,
      boardWidth: 9,
      boardHeight: 9,
    };
    // Create game with host as Player 1 for deterministic testing
    const { gameId, socketToken: socketTokenA } = await createFriendGame(
      userA,
      gameConfig,
      { hostIsPlayer1: true },
    );

    const { socketToken: socketTokenB } = await joinFriendGame(userB, gameId);

    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, socketTokenB);

    // Wait for initial match status and state (match-status comes first on connect)
    await socketA.waitForMessage("match-status");
    await socketA.waitForMessage("state");
    await socketB.waitForMessage("match-status");
    await socketB.waitForMessage("state");

    // Make some moves to have an active game
    // Player 1 moves cat from a9 to b8
    await sendMoveAndWaitForState(
      0,
      [socketA, socketB],
      "Cb8",
      gameConfig.boardHeight,
    );

    // Test draw offer and rejection
    const drawOfferPayload: ClientMessage = {
      type: "draw-offer",
    };
    socketA.ws.send(JSON.stringify(drawOfferPayload));

    const drawOfferMsg = await socketB.waitForMessage("draw-offer", {
      ignore: ["match-status"],
    });
    expect(drawOfferMsg.playerId).toBe(1);

    const drawRejectPayload: ClientMessage = {
      type: "draw-reject",
    };
    socketB.ws.send(JSON.stringify(drawRejectPayload));

    const drawRejectMsg = await socketA.waitForMessage("draw-rejected", {
      ignore: ["match-status", "draw-offer"],
    });
    expect(drawRejectMsg.playerId).toBe(2);

    // Test draw offer and acceptance
    socketA.ws.send(JSON.stringify(drawOfferPayload));

    await socketB.waitForMessage("draw-offer", {
      ignore: ["match-status", "draw-rejected"],
    });

    const drawAcceptPayload: ClientMessage = {
      type: "draw-accept",
    };
    socketB.ws.send(JSON.stringify(drawAcceptPayload));

    const drawEndMsg = await socketA.waitForMessage("state", {
      ignore: ["match-status", "draw-offer"],
    });
    expect(drawEndMsg.state.status).toBe("finished");
    expect(drawEndMsg.state.result?.reason).toBe("draw-agreement");

    // Test rematch offer and acceptance
    const rematchOfferPayload: ClientMessage = {
      type: "rematch-offer",
    };
    socketA.ws.send(JSON.stringify(rematchOfferPayload));

    const rematchOfferMsg = await socketB.waitForMessage("rematch-offer", {
      ignore: ["match-status", "state"],
    });
    expect(rematchOfferMsg.playerId).toBe(1);

    const rematchAcceptPayload: ClientMessage = {
      type: "rematch-accept",
    };
    socketB.ws.send(JSON.stringify(rematchAcceptPayload));

    // Wait for both sockets to receive the new game state after rematch
    const [rematchStateMsgA, rematchStateMsgB] = await Promise.all([
      socketA.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
      socketB.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
    ]);
    expect(rematchStateMsgA.state.status).toBe("playing");
    expect(rematchStateMsgA.state.moveCount).toBe(1);
    expect(rematchStateMsgA.state).toEqual(rematchStateMsgB.state);

    // Make a move in the new game
    // Player 1 moves cat from a9 to b8
    await sendMoveAndWaitForState(
      0,
      [socketA, socketB],
      "Cb8",
      gameConfig.boardHeight,
    );

    // Test rematch rejection
    const resignPayload: ClientMessage = {
      type: "resign",
    };
    socketB.ws.send(JSON.stringify(resignPayload));

    const resignEndMsg = await socketA.waitForMessage("state", {
      ignore: ["match-status"],
    });
    expect(resignEndMsg.state.status).toBe("finished");

    socketA.ws.send(JSON.stringify(rematchOfferPayload));
    await socketB.waitForMessage("rematch-offer", {
      ignore: ["match-status", "state"],
    });

    const rematchRejectPayload: ClientMessage = {
      type: "rematch-reject",
    };
    socketB.ws.send(JSON.stringify(rematchRejectPayload));

    const rematchRejectMsg = await socketA.waitForMessage("rematch-rejected", {
      ignore: ["match-status", "rematch-offer"],
    });
    expect(rematchRejectMsg.playerId).toBe(2);

    socketA.close();
    socketB.close();
  });
});
