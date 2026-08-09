/**
 * Integration tests for where a seat's display name comes from.
 *
 * The browser sends a name when it creates or joins a game, but that name is
 * only a suggestion: it is empty while the settings query is still in flight
 * and "Guest" until the login state resolves. An empty name used to reach the
 * session as-is, and every reader downstream treats a nameless seat as a
 * guest — which is how a logged-in player ended up chatting as "Guest 1".
 *
 * So the property under test is that a seat is named by the server, never by
 * the request: an authenticated seat from the account, a guest seat from the
 * animal pool. The account lookup is a database read, so asserting it against
 * anything else would be pretending.
 *
 * Guest names are drawn at random, so the assertions here are on the shape and
 * on the distinctness that motivated the feature, never on a chosen animal.
 *
 * Uses Testcontainers for an ephemeral PostgreSQL, so this needs Docker.
 */

import {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  expect,
} from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  GameCreateResponse,
  JoinGameResponse,
} from "../../shared/contracts/games";
import type { GameSnapshot } from "../../shared/domain/game-types";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type { PartialGameConfiguration } from "../../server/games/store";

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let db: typeof import("../../server/db").db;
let createApp: typeof import("../../server/index").createApp;
let usersTable: typeof import("../../server/db/schema/users").usersTable;
let userAuthTable: typeof import("../../server/db/schema/users").userAuthTable;

async function importServerModules() {
  // Dynamic imports - these must happen AFTER DATABASE_URL is set
  db = (await import("../../server/db")).db;
  createApp = (await import("../../server/index")).createApp;
  const users = await import("../../server/db/schema/users");
  usersTable = users.usersTable;
  userAuthTable = users.userAuthTable;
}

function startTestServer() {
  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}

const GAME_CONFIG: PartialGameConfiguration = {
  timeControl: { initialSeconds: 600, incrementSeconds: 0, preset: "rapid" },
  variant: "standard",
  rated: false,
  boardWidth: 3,
  boardHeight: 3,
};

/**
 * Seeds an account whose stored capitalization differs from its lowercase
 * handle, so an assertion on the capitalized form proves the name came from
 * the accounts table rather than from anywhere else.
 *
 * @returns the x-test-user-id to send, and the name the seat should show
 */
async function seedAccount(
  handle: string,
): Promise<{ authUserId: string; accountName: string }> {
  const accountName = `${handle[0].toUpperCase()}${handle.slice(1)}`;
  const [user] = await db
    .insert(usersTable)
    .values({
      displayName: handle,
      capitalizedDisplayName: accountName,
      authProvider: "test",
    })
    .returning({ userId: usersTable.userId });

  const authUserId = `auth-${handle}`;
  await db.insert(userAuthTable).values({
    userId: user.userId,
    authProvider: "test",
    authUserId,
  });

  return { authUserId, accountName };
}

const authHeaders = (authUserId?: string) => ({
  "Content-Type": "application/json",
  ...(authUserId ? { "x-test-user-id": authUserId } : {}),
});

async function createGame(args: {
  authUserId?: string;
  hostDisplayName?: string;
}): Promise<GameCreateResponse> {
  const res = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: authHeaders(args.authUserId),
    body: JSON.stringify({
      config: GAME_CONFIG,
      matchType: "friend",
      hostDisplayName: args.hostDisplayName,
      hostIsPlayer1: true,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as GameCreateResponse;
}

async function joinGame(args: {
  gameId: string;
  authUserId?: string;
  displayName?: string;
}): Promise<JoinGameResponse> {
  const res = await fetch(`${baseUrl}/api/games/${args.gameId}/join`, {
    method: "POST",
    headers: authHeaders(args.authUserId),
    body: JSON.stringify({ displayName: args.displayName }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as JoinGameResponse;
}

/**
 * Asserts the literal shape a guest name must have. Spelled out rather than
 * built from the server's own format helper, so a change to the format has to
 * be made here too instead of both sides moving together.
 */
const expectGuestName = (name: string) => {
  expect(name).toMatch(/^Guest [A-Za-z]+$/);
};

const seatName = (snapshot: GameSnapshot, role: "host" | "joiner"): string => {
  const seat = snapshot.players.find((player) => player.role === role);
  if (!seat) {
    throw new Error(`No ${role} seat in the snapshot`);
  }
  return seat.displayName;
};

/** Sends one message on the game channel and returns the name it was sent under. */
async function chatSenderName(args: {
  gameId: string;
  socketToken: string;
  authUserId?: string;
}): Promise<string> {
  const wsUrl =
    baseUrl.replace("http", "ws") +
    `/ws/games/${args.gameId}?token=${args.socketToken}`;
  const ws = new WebSocket(wsUrl, {
    headers: {
      Origin: "http://localhost:5173",
      ...(args.authUserId ? { "x-test-user-id": args.authUserId } : {}),
    },
  });

  try {
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for the chat echo")),
        10_000,
      );
      const settle = (run: () => void) => {
        clearTimeout(timeout);
        run();
      };

      ws.on("error", (error) => settle(() => reject(error)));
      ws.on("message", (data: Buffer) => {
        const message = JSON.parse(data.toString()) as ServerMessage;
        if (message.type === "chat-message") {
          settle(() => resolve(message.senderName));
        }
        if (message.type === "chat-error") {
          settle(() => reject(new Error(`Chat refused: ${message.message}`)));
        }
      });
      ws.on("open", () => {
        ws.send(
          JSON.stringify({ type: "chat-message", channel: "game", text: "hi" }),
        );
      });
    });
  } finally {
    ws.close();
  }
}

describe("seat display names", () => {
  beforeAll(async () => {
    const handle = await setupEphemeralDb();
    container = handle.container;
    await importServerModules();
    startTestServer();
  }, 120_000);

  afterAll(async () => {
    await db.delete(userAuthTable);
    await db.delete(usersTable);
    if (server) {
      await server.stop(true);
    }
    await teardownEphemeralDb(container);
  }, 60_000);

  beforeEach(async () => {
    await db.delete(userAuthTable);
    await db.delete(usersTable);
  });

  it("names a logged-in host from the account, not from the request", async () => {
    const alfa = await seedAccount("alfa");

    const game = await createGame({
      authUserId: alfa.authUserId,
      hostDisplayName: "Somebody Else",
    });

    expect(seatName(game.snapshot, "host")).toBe(alfa.accountName);
  });

  it("keeps a logged-in host named when the browser sends no name yet", async () => {
    // The reported bug: settings.displayName is "" until the settings query
    // resolves, and an empty name reads downstream as "not logged in".
    const alfa = await seedAccount("alfa");

    const game = await createGame({
      authUserId: alfa.authUserId,
      hostDisplayName: "",
    });

    expect(seatName(game.snapshot, "host")).toBe(alfa.accountName);
  });

  it("names a logged-in joiner from the account too", async () => {
    const alfa = await seedAccount("alfa");
    const bravo = await seedAccount("bravo");

    const game = await createGame({ authUserId: alfa.authUserId });
    const joined = await joinGame({
      gameId: game.gameId,
      authUserId: bravo.authUserId,
      displayName: "Somebody Else",
    });

    expect(seatName(joined.snapshot, "joiner")).toBe(bravo.accountName);
  });

  it("names a guest from the pool, ignoring the name it asked for", async () => {
    // A logged-out browser cannot offer a name - the settings field is fixed at
    // "Guest" - so the request is worth nothing, and trusting it would let a
    // guest wear a registered player's name.
    const game = await createGame({ hostDisplayName: "Rando" });

    expectGuestName(seatName(game.snapshot, "host"));
  });

  it("gives the two guests in a game names that tell them apart", async () => {
    // The reported bug: both seats were called "Guest", so the finished game
    // said "Guest won by resignation" without saying which one.
    const game = await createGame({ hostDisplayName: "Guest" });
    const joined = await joinGame({
      gameId: game.gameId,
      displayName: "Guest",
    });

    const host = seatName(joined.snapshot, "host");
    const joiner = seatName(joined.snapshot, "joiner");

    expectGuestName(host);
    expectGuestName(joiner);
    expect(host).not.toBe(joiner);
  });

  it("does not let a guest claim an account's name", async () => {
    const alfa = await seedAccount("alfa");

    const game = await createGame({ hostDisplayName: alfa.accountName });

    expect(seatName(game.snapshot, "host")).not.toBe(alfa.accountName);
  });

  it("sends chat under the account name, not a numbered guest", async () => {
    const alfa = await seedAccount("alfa");
    const game = await createGame({
      authUserId: alfa.authUserId,
      hostDisplayName: "",
    });

    const senderName = await chatSenderName({
      gameId: game.gameId,
      socketToken: game.socketToken,
      authUserId: alfa.authUserId,
    });

    expect(senderName).toBe(alfa.accountName);
  });

  it("sends a guest's chat under the name on their seat", async () => {
    // Chat used to run its own numbering ("Guest 1"), so a line could not be
    // matched to a side of the board. It reads the seat now.
    const game = await createGame({ hostDisplayName: "" });

    const senderName = await chatSenderName({
      gameId: game.gameId,
      socketToken: game.socketToken,
    });

    expectGuestName(senderName);
    expect(senderName).toBe(seatName(game.snapshot, "host"));
  });
});
