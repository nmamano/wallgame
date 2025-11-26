import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { createApp } from "../../server/index";
import { WebSocket } from "ws";
import type {
  GameCreateResponse,
  GameSessionDetails,
} from "../../frontend/src/lib/api";

// --- Test Harness ---

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

// --- HTTP Client Helpers ---

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

// --- WebSocket Client Helpers ---

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

// --- Main Test ---

describe("friend game WebSocket integration", () => {
  beforeAll(() => {
    startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  it("allows two players to create a friend game, join it, and exchange moves", async () => {
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
});
