import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { createApp } from "../../server/index";
import { WebSocket } from "ws";

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

type CreateGameResponse = {
  gameId: string;
  inviteCode: string;
  hostToken: string;
  socketToken: string;
};

type JoinGameResponse = {
  gameId: string;
  token: string;
  socketToken: string;
};

async function createFriendGame(userId: string): Promise<CreateGameResponse> {
  const res = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      config: {
        timeControl: { initialSeconds: 600, incrementSeconds: 0, preset: "rapid" },
        variant: "standard",
        boardWidth: 9,
        boardHeight: 9,
      },
      matchType: "friend",
    }),
  });

  expect(res.status).toBe(201);
  const json = await res.json();
  return json as CreateGameResponse;
}

async function joinFriendGame(
  userId: string,
  gameId: string,
  inviteCode: string
): Promise<JoinGameResponse> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({ inviteCode }),
  });

  expect(res.status).toBe(200);
  const json = await res.json();
  return json as JoinGameResponse;
}

// --- WebSocket Client Helpers ---

type WSMessage = { type: string; [key: string]: any };

type TestSocket = {
  ws: WebSocket;
  waitForMessage: (predicate: (msg: WSMessage) => boolean) => Promise<WSMessage>;
  close: () => void;
};

async function openGameSocket(
  userId: string,
  gameId: string,
  socketToken: string
): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl =
      baseUrl.replace("http", "ws") + `/ws/games/${gameId}?token=${socketToken}`;

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

    // 1. User A creates a friend game
    const { gameId, inviteCode, socketToken: socketTokenA } = await createFriendGame(
      userA
    );
    expect(gameId).toBeDefined();
    expect(inviteCode).toBeDefined();
    expect(socketTokenA).toBeDefined();

    // 2. User B joins the game
    const { socketToken: socketTokenB } = await joinFriendGame(
      userB,
      gameId,
      inviteCode
    );
    expect(socketTokenB).toBeDefined();

    // 3. Both connect via WebSocket
    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, socketTokenB);

    // Wait for initial state
    const stateMsgA = await socketA.waitForMessage((msg) => msg.type === "state");
    const stateMsgB = await socketB.waitForMessage((msg) => msg.type === "state");

    const initialState = stateMsgA.state;
    expect(initialState).toBeDefined();
    expect(stateMsgB.state).toEqual(initialState);

    // 4. User A sends a move
    const p1Cat = initialState.pawns["1"].cat as [number, number];
    const moveTarget: [number, number] = [p1Cat[0] + 1, p1Cat[1]];

    const movePayload = {
      type: "submit-move",
      actions: [{ type: "cat", cell: moveTarget }],
    };

    socketA.ws.send(JSON.stringify(movePayload));

    // 5. Verify User B receives the new state
    const updateMsgB = await socketB.waitForMessage((msg) => msg.type === "state");
    expect(updateMsgB.state.pawns["1"].cat).toEqual(moveTarget);

    // Verify User A also receives the update
    const updateMsgA = await socketA.waitForMessage((msg) => msg.type === "state");

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
    const finalMsgA = await socketA.waitForMessage((msg) => msg.type === "state");
    expect(finalMsgA.state.pawns["2"].cat).toEqual(moveTargetB);

    socketA.close();
    socketB.close();
  });
});
