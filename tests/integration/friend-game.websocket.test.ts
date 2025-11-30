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
import { cellFromStandardNotation } from "../../shared/domain/standard-notation";

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

  expect(res.status).toBe(201);
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
  waitForMessage: <T extends ServerMessage>(
    predicate: (msg: ServerMessage) => msg is T,
  ) => Promise<T>;
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
    const listeners: ((msg: ServerMessage) => void)[] = [];

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      buffer.push(msg);
      listeners.forEach((l) => l(msg));
    });

    ws.on("open", () => {
      resolve({
        ws,
        close: () => ws.close(),
        waitForMessage: <T extends ServerMessage>(
          predicate: (msg: ServerMessage) => msg is T,
        ) => {
          return new Promise<T>((resolveWait, rejectWait) => {
            // Check buffer first
            const index = buffer.findIndex(predicate);
            if (index > -1) {
              const [msg] = buffer.splice(index, 1);
              return resolveWait(msg as T);
            }

            const check = (msg: ServerMessage) => {
              if (predicate(msg)) {
                clearTimeout(timeout);
                const listenerIndex = listeners.indexOf(check);
                if (listenerIndex > -1) listeners.splice(listenerIndex, 1);

                const bufferIndex = buffer.indexOf(msg);
                if (bufferIndex > -1) buffer.splice(bufferIndex, 1);

                resolveWait(msg as T);
              }
            };

            const timeout = setTimeout(() => {
              const listenerIndex = listeners.indexOf(check);
              if (listenerIndex > -1) listeners.splice(listenerIndex, 1);
              rejectWait(new Error("Timeout waiting for WS message"));
            }, 5000);

            listeners.push(check);
          });
        },
      });
    });

    ws.on("error", (err) => reject(err));
  });
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
    // The board is 5x5 (from a1 at the bottom-left to e5 at the top-right)
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: false,
      boardWidth: 5,
      boardHeight: 5,
    };
    // Create game with host as Player 1 for deterministic testing
    // In production, hostIsPlayer1 is randomly chosen by the host frontend
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

    // Wait for initial state
    const stateMsgA = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    const stateMsgB = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );

    const initialState = stateMsgA.state;
    expect(initialState).toBeDefined();
    expect(stateMsgB.state).toEqual(initialState);

    // Wait for match status updates to get player appearances
    const matchStatusMsgA = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "match-status" }> =>
        msg.type === "match-status",
    );
    const matchStatusMsgB = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "match-status" }> =>
        msg.type === "match-status",
    );

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

    // 4. User A (Player 1) sends first move - move cat from a5 to b4
    // Player 1 always starts, and their cat starts at a5 (top-left)
    socketA.ws.send(
      JSON.stringify({
        type: "submit-move",
        actions: [{ type: "cat", cell: cellFromStandardNotation("b4", 5) }],
      }),
    );

    // 5. Verify both players receive the new state
    const updateMsgB = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    const updateMsgA = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    expect(updateMsgB.state.pawns["1"].cat).toEqual(
      cellFromStandardNotation("b4", 5),
    );
    expect(updateMsgA.state.pawns["1"].cat).toEqual(
      cellFromStandardNotation("b4", 5),
    );

    // 6. User B (Player 2) sends a move - move cat from e5 to d4
    socketB.ws.send(
      JSON.stringify({
        type: "submit-move",
        actions: [{ type: "cat", cell: cellFromStandardNotation("d4", 5) }],
      }),
    );

    // 7. Verify both players receive the new state
    const finalMsgA = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    const finalMsgB = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    expect(finalMsgA.state.pawns["2"].cat).toEqual(
      cellFromStandardNotation("d4", 5),
    );
    expect(finalMsgB.state.pawns["2"].cat).toEqual(
      cellFromStandardNotation("d4", 5),
    );

    // // 8. Add more moves including wall moves and pawn moves
    // // User A places a wall (using safer coordinates)
    // const wallPayloadA = {
    //   type: "submit-move",
    //   actions: [{ type: "wall", cell: [1, 1], orientation: "vertical" }],
    // };
    // socketA.ws.send(JSON.stringify(wallPayloadA));

    // const wallUpdateMsgB = await socketB.waitForMessage(
    //   (msg) => msg.type === "state",
    // );
    // expect(wallUpdateMsgB.state.walls).toHaveLength(1);
    // expect(wallUpdateMsgB.state.walls[0]).toEqual({
    //   cell: [1, 1],
    //   orientation: "vertical",
    //   playerId: 1,
    // });

    // // User B moves mouse
    // const p2Mouse = wallUpdateMsgB.state.pawns["2"].mouse as [number, number];
    // const mouseTargetB: [number, number] = [p2Mouse[0] - 1, p2Mouse[1]];

    // const mouseMovePayloadB = {
    //   type: "submit-move",
    //   actions: [{ type: "mouse", cell: mouseTargetB }],
    // };
    // socketB.ws.send(JSON.stringify(mouseMovePayloadB));

    // const mouseUpdateMsgA = await socketA.waitForMessage(
    //   (msg) => msg.type === "state",
    // );
    // expect(mouseUpdateMsgA.state.pawns["2"].mouse).toEqual(mouseTargetB);

    // // User A places another wall
    // const wallPayloadA2 = {
    //   type: "submit-move",
    //   actions: [{ type: "wall", cell: [2, 3], orientation: "horizontal" }],
    // };
    // socketA.ws.send(JSON.stringify(wallPayloadA2));

    // const wallUpdateMsgB2 = await socketB.waitForMessage(
    //   (msg) => msg.type === "state",
    // );
    // expect(wallUpdateMsgB2.state.walls).toHaveLength(2);

    // // User B moves cat
    // const p2Cat2 = wallUpdateMsgB2.state.pawns["2"].cat as [number, number];
    // const catTargetB2: [number, number] = [p2Cat2[0] + 1, p2Cat2[1]];

    // const catMovePayloadB2 = {
    //   type: "submit-move",
    //   actions: [{ type: "cat", cell: catTargetB2 }],
    // };
    // socketB.ws.send(JSON.stringify(catMovePayloadB2));

    // const finalStateMsg = await socketA.waitForMessage(
    //   (msg) => msg.type === "state",
    // );
    // expect(finalStateMsg.state.pawns["2"].cat).toEqual(catTargetB2);

    // // 9. Test time control - User A gives time to User B
    // const initialTimeLeft = finalStateMsg.state.timeLeft;
    // const giveTimePayload = {
    //   type: "give-time",
    //   seconds: 30,
    // };
    // socketA.ws.send(JSON.stringify(giveTimePayload));

    // const timeUpdateMsg = await socketB.waitForMessage(
    //   (msg) => msg.type === "state",
    // );
    // expect(timeUpdateMsg.state.timeLeft["2"]).toBe(initialTimeLeft["2"] + 30);

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

    // Wait for initial state
    const stateMsgA = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    const stateMsgB = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );

    const initialState = stateMsgA.state;
    expect(initialState).toBeDefined();
    expect(stateMsgB.state).toEqual(initialState);

    // Wait for match status updates to get player appearances
    const matchStatusMsgA = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "match-status" }> =>
        msg.type === "match-status",
    );
    const matchStatusMsgB = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "match-status" }> =>
        msg.type === "match-status",
    );

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

    // Wait for initial state
    const stateMsgA = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    const stateMsgB = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );

    // Make some moves to have an active game
    // Player 1 moves cat from a9 to e8
    const moveTarget = cellFromStandardNotation("b8", gameConfig.boardHeight);

    const movePayload: ClientMessage = {
      type: "submit-move",
      actions: [{ type: "cat", cell: moveTarget }],
    };
    socketA.ws.send(JSON.stringify(movePayload));

    await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );

    // Test draw offer and rejection
    const drawOfferPayload: ClientMessage = {
      type: "draw-offer",
    };
    socketA.ws.send(JSON.stringify(drawOfferPayload));

    const drawOfferMsg = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "draw-offer" }> =>
        msg.type === "draw-offer",
    );
    expect(drawOfferMsg.playerId).toBe(1);

    const drawRejectPayload: ClientMessage = {
      type: "draw-reject",
    };
    socketB.ws.send(JSON.stringify(drawRejectPayload));

    const drawRejectMsg = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "draw-rejected" }> =>
        msg.type === "draw-rejected",
    );
    expect(drawRejectMsg.playerId).toBe(2);

    // Test draw offer and acceptance
    socketA.ws.send(JSON.stringify(drawOfferPayload));

    const drawOfferMsg2 = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "draw-offer" }> =>
        msg.type === "draw-offer",
    );

    const drawAcceptPayload: ClientMessage = {
      type: "draw-accept",
    };
    socketB.ws.send(JSON.stringify(drawAcceptPayload));

    const drawEndMsg = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    expect(drawEndMsg.state.status).toBe("finished");
    expect(drawEndMsg.state.result?.reason).toBe("draw-agreement");

    // Test rematch offer and acceptance
    const rematchOfferPayload: ClientMessage = {
      type: "rematch-offer",
    };
    socketA.ws.send(JSON.stringify(rematchOfferPayload));

    const rematchOfferMsg = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "rematch-offer" }> =>
        msg.type === "rematch-offer",
    );
    expect(rematchOfferMsg.playerId).toBe(1);

    const rematchAcceptPayload: ClientMessage = {
      type: "rematch-accept",
    };
    socketB.ws.send(JSON.stringify(rematchAcceptPayload));

    const rematchStateMsg = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    expect(rematchStateMsg.state.status).toBe("playing");
    expect(rematchStateMsg.state.moveCount).toBe(1);

    // Make a move in the new game
    // Player 1 moves cat from a9 to e8
    const newMoveTarget = cellFromStandardNotation(
      "b8",
      gameConfig.boardHeight,
    );

    const newMovePayload: ClientMessage = {
      type: "submit-move",
      actions: [{ type: "cat", cell: newMoveTarget }],
    };
    socketA.ws.send(JSON.stringify(newMovePayload));

    await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );

    // Test rematch rejection
    const resignPayload: ClientMessage = {
      type: "resign",
    };
    socketB.ws.send(JSON.stringify(resignPayload));

    const resignEndMsg = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "state" }> =>
        msg.type === "state",
    );
    expect(resignEndMsg.state.status).toBe("finished");

    socketA.ws.send(JSON.stringify(rematchOfferPayload));
    const rematchOfferMsg2 = await socketB.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "rematch-offer" }> =>
        msg.type === "rematch-offer",
    );

    const rematchRejectPayload: ClientMessage = {
      type: "rematch-reject",
    };
    socketB.ws.send(JSON.stringify(rematchRejectPayload));

    const rematchRejectMsg = await socketA.waitForMessage(
      (msg): msg is Extract<ServerMessage, { type: "rematch-rejected" }> =>
        msg.type === "rematch-rejected",
    );
    expect(rematchRejectMsg.playerId).toBe(2);

    socketA.close();
    socketB.close();
  });
});
