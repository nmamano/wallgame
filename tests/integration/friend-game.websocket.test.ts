import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { createApp } from "../../server/index";
import { WebSocket } from "ws";
import type {
  GameCreateResponse,
  GameSessionDetails,
} from "../../frontend/src/lib/api";

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

async function createFriendGame(
  userId: string,
  appearance?: { pawnColor?: string; catSkin?: string; mouseSkin?: string },
): Promise<GameCreateResponse> {
  const res = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      config: {
        timeControl: {
          initialSeconds: 600,
          incrementSeconds: 0,
          preset: "rapid",
        },
        variant: "standard",
        boardWidth: 9,
        boardHeight: 9,
      },
      matchType: "friend",
      hostDisplayName: `Player ${userId}`,
      hostAppearance: appearance,
    }),
  });

  expect(res.status).toBe(201);
  const json = await res.json();
  return json as GameCreateResponse;
}

async function createMatchmakingGame(
  userId: string,
  appearance?: { pawnColor?: string; catSkin?: string; mouseSkin?: string },
): Promise<GameCreateResponse> {
  const res = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      config: {
        timeControl: {
          initialSeconds: 600,
          incrementSeconds: 0,
          preset: "rapid",
        },
        variant: "standard",
        boardWidth: 9,
        boardHeight: 9,
      },
      matchType: "matchmaking",
      hostDisplayName: `Player ${userId}`,
      hostAppearance: appearance,
    }),
  });

  expect(res.status).toBe(201);
  const json = await res.json();
  return json as GameCreateResponse;
}

async function joinFriendGame(
  userId: string,
  gameId: string,
  appearance?: { pawnColor?: string; catSkin?: string; mouseSkin?: string },
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
  const json = (await res.json()) as {
    gameId: string;
    token: string;
    socketToken: string;
    snapshot: any;
    shareUrl: string;
  };
  return {
    snapshot: json.snapshot,
    role: "joiner",
    playerId: 2,
    token: json.token,
    socketToken: json.socketToken,
    shareUrl: json.shareUrl,
  };
}

async function fetchMatchmakingGames(): Promise<any[]> {
  const res = await fetch(`${baseUrl}/api/games/matchmaking`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { games: any[] };
  return json.games;
}

// ================================
// --- WebSocket Client Helpers ---
// ================================

type WSMessage = { type: string; [key: string]: any };

type TestSocket = {
  ws: WebSocket;
  waitForMessage: (
    predicate: (msg: WSMessage) => boolean,
  ) => Promise<WSMessage>;
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

    const buffer: WSMessage[] = [];
    const listeners: ((msg: WSMessage) => void)[] = [];

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      buffer.push(msg);
      listeners.forEach((l) => l(msg));
    });

    ws.on("open", () => {
      resolve({
        ws,
        close: () => ws.close(),
        waitForMessage: (predicate: (msg: WSMessage) => boolean) => {
          return new Promise<WSMessage>((resolveWait, rejectWait) => {
            // Check buffer first
            const index = buffer.findIndex(predicate);
            if (index > -1) {
              const [msg] = buffer.splice(index, 1);
              return resolveWait(msg);
            }

            const check = (msg: WSMessage) => {
              if (predicate(msg)) {
                clearTimeout(timeout);
                const listenerIndex = listeners.indexOf(check);
                if (listenerIndex > -1) listeners.splice(listenerIndex, 1);

                const bufferIndex = buffer.indexOf(msg);
                if (bufferIndex > -1) buffer.splice(bufferIndex, 1);

                resolveWait(msg);
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
    const {
      gameId,
      shareUrl,
      socketToken: socketTokenA,
      snapshot: initialSnapshotA,
    } = await createFriendGame(userA, userAAppearance);
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
      (msg) => msg.type === "state",
    );
    const stateMsgB = await socketB.waitForMessage(
      (msg) => msg.type === "state",
    );

    const initialState = stateMsgA.state;
    expect(initialState).toBeDefined();
    expect(stateMsgB.state).toEqual(initialState);

    // Wait for match status updates to get player appearances
    const matchStatusMsgA = await socketA.waitForMessage(
      (msg) => msg.type === "match-status",
    );
    const matchStatusMsgB = await socketB.waitForMessage(
      (msg) => msg.type === "match-status",
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

    // 4. User A sends a move
    const p1Cat = initialState.pawns["1"].cat as [number, number];
    const moveTarget: [number, number] = [p1Cat[0] + 1, p1Cat[1]];

    const movePayload = {
      type: "submit-move",
      actions: [{ type: "cat", cell: moveTarget }],
    };

    socketA.ws.send(JSON.stringify(movePayload));

    // 5. Verify User B receives the new state
    const updateMsgB = await socketB.waitForMessage(
      (msg) => msg.type === "state",
    );
    expect(updateMsgB.state.pawns["1"].cat).toEqual(moveTarget);

    // Verify User A also receives the update
    const updateMsgA = await socketA.waitForMessage(
      (msg) => msg.type === "state",
    );

    // 6. User B sends a move
    const p2Cat = updateMsgB.state.pawns["2"].cat as [number, number];
    const targetRowB = p2Cat[0] > 4 ? p2Cat[0] - 1 : p2Cat[0] + 1;
    const moveTargetB: [number, number] = [targetRowB, p2Cat[1]];

    const movePayloadB = {
      type: "submit-move",
      actions: [{ type: "cat", cell: moveTargetB }],
    };

    socketB.ws.send(JSON.stringify(movePayloadB));

    // 7. Verify User A receives the new state
    const finalMsgA = await socketA.waitForMessage(
      (msg) => msg.type === "state",
    );
    expect(finalMsgA.state.pawns["2"].cat).toEqual(moveTargetB);

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
    const {
      gameId,
      socketToken: socketTokenA,
      snapshot: initialSnapshotA,
    } = await createMatchmakingGame(userA, userAAppearance);
    expect(gameId).toBeDefined();
    expect(socketTokenA).toBeDefined();
    expect(initialSnapshotA.players[0].appearance).toEqual(userAAppearance);

    // 2. User B fetches available matchmaking games and joins one
    const availableGames = await fetchMatchmakingGames();
    expect(availableGames.length).toBeGreaterThan(0);

    // Find the game created by user A
    const gameToJoin = availableGames.find((game: any) => game.id === gameId);
    expect(gameToJoin).toBeDefined();
    expect(gameToJoin.players[0].appearance).toEqual(userAAppearance);

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
      (msg) => msg.type === "state",
    );
    const stateMsgB = await socketB.waitForMessage(
      (msg) => msg.type === "state",
    );

    const initialState = stateMsgA.state;
    expect(initialState).toBeDefined();
    expect(stateMsgB.state).toEqual(initialState);

    // Wait for match status updates to get player appearances
    const matchStatusMsgA = await socketA.waitForMessage(
      (msg) => msg.type === "match-status",
    );
    const matchStatusMsgB = await socketB.waitForMessage(
      (msg) => msg.type === "match-status",
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
    const { gameId, socketToken: socketTokenA } = await createFriendGame(userA);

    const { socketToken: socketTokenB } = await joinFriendGame(userB, gameId);

    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, socketTokenB);

    // Wait for initial state
    const stateMsgA = await socketA.waitForMessage(
      (msg) => msg.type === "state",
    );
    const stateMsgB = await socketB.waitForMessage(
      (msg) => msg.type === "state",
    );

    // Make some moves to have an active game
    const p1CatDraw = stateMsgA.state.pawns["1"].cat as [number, number];
    const moveTarget: [number, number] = [p1CatDraw[0] + 1, p1CatDraw[1]];

    const movePayload = {
      type: "submit-move",
      actions: [{ type: "cat", cell: moveTarget }],
    };
    socketA.ws.send(JSON.stringify(movePayload));

    await socketB.waitForMessage((msg) => msg.type === "state");
    await socketA.waitForMessage((msg) => msg.type === "state");

    // Test draw offer and rejection
    const drawOfferPayload = {
      type: "draw-offer",
    };
    socketA.ws.send(JSON.stringify(drawOfferPayload));

    const drawOfferMsg = await socketB.waitForMessage(
      (msg) => msg.type === "draw-offer",
    );
    expect(drawOfferMsg.playerId).toBe(1);

    const drawRejectPayload = {
      type: "draw-reject",
    };
    socketB.ws.send(JSON.stringify(drawRejectPayload));

    const drawRejectMsg = await socketA.waitForMessage(
      (msg) => msg.type === "draw-rejected",
    );
    expect(drawRejectMsg.playerId).toBe(2);

    // Test draw offer and acceptance
    socketA.ws.send(JSON.stringify(drawOfferPayload));

    const drawOfferMsg2 = await socketB.waitForMessage(
      (msg) => msg.type === "draw-offer",
    );

    const drawAcceptPayload = {
      type: "draw-accept",
    };
    socketB.ws.send(JSON.stringify(drawAcceptPayload));

    const drawEndMsg = await socketA.waitForMessage(
      (msg) => msg.type === "state",
    );
    expect(drawEndMsg.state.status).toBe("finished");
    expect(drawEndMsg.state.result?.reason).toBe("draw-agreement");

    // Test rematch offer and acceptance
    const rematchOfferPayload = {
      type: "rematch-offer",
    };
    socketA.ws.send(JSON.stringify(rematchOfferPayload));

    const rematchOfferMsg = await socketB.waitForMessage(
      (msg) => msg.type === "rematch-offer",
    );
    expect(rematchOfferMsg.playerId).toBe(1);

    const rematchAcceptPayload = {
      type: "rematch-accept",
    };
    socketB.ws.send(JSON.stringify(rematchAcceptPayload));

    const rematchStateMsg = await socketA.waitForMessage(
      (msg) => msg.type === "state",
    );
    expect(rematchStateMsg.state.status).toBe("playing");
    expect(rematchStateMsg.state.moveCount).toBe(1);

    // Make a move in the new game
    const p1CatNew = rematchStateMsg.state.pawns["1"].cat as [number, number];
    const newMoveTarget: [number, number] = [p1CatNew[0] + 1, p1CatNew[1]];

    const newMovePayload = {
      type: "submit-move",
      actions: [{ type: "cat", cell: newMoveTarget }],
    };
    socketA.ws.send(JSON.stringify(newMovePayload));

    await socketB.waitForMessage((msg) => msg.type === "state");
    await socketA.waitForMessage((msg) => msg.type === "state");

    // Test rematch rejection
    const resignPayload = {
      type: "resign",
    };
    socketB.ws.send(JSON.stringify(resignPayload));

    const resignEndMsg = await socketA.waitForMessage(
      (msg) => msg.type === "state",
    );
    expect(resignEndMsg.state.status).toBe("finished");

    socketA.ws.send(JSON.stringify(rematchOfferPayload));
    const rematchOfferMsg2 = await socketB.waitForMessage(
      (msg) => msg.type === "rematch-offer",
    );

    const rematchRejectPayload = {
      type: "rematch-reject",
    };
    socketB.ws.send(JSON.stringify(rematchRejectPayload));

    const rematchRejectMsg = await socketA.waitForMessage(
      (msg) => msg.type === "rematch-rejected",
    );
    expect(rematchRejectMsg.playerId).toBe(2);

    socketA.close();
    socketB.close();
  });
});
