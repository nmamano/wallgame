/**
 * Once a seat's credentials rotate, a socket on the old socketToken is no
 * longer that seat in any way (board task b3661f40).
 *
 * A logged-in owner who opens the game again without the current token (a new
 * tab or device) gets new credentials. The sockets on the old token used to
 * stay in the game with the seat's role: every move was refused, but chat on
 * the players' channel and the seat's credentials for a rematch still reached
 * them. Now the rotation closes them with SEAT_MOVED_CLOSE_CODE, so nothing
 * that trusts a socket's role can reach them.
 *
 * Uses Testcontainers for an ephemeral PostgreSQL, so this needs Docker.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  GameCreateResponse,
  JoinGameResponse,
} from "../../shared/contracts/games";
import {
  SEAT_MOVED_CLOSE_CODE,
  type ServerMessage,
} from "../../shared/contracts/websocket-messages";
import type { PartialGameConfiguration } from "../../server/games/store";

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

const HOST_USER = "stale-seat-host";

const GAME_CONFIG: PartialGameConfiguration = {
  timeControl: { initialSeconds: 600, incrementSeconds: 0, preset: "rapid" },
  variant: "standard",
  randomStart: false,
  rated: false,
  boardWidth: 3,
  boardHeight: 3,
};

/** Message types that may arrive at any time and say nothing here. */
const BACKGROUND: ServerMessage["type"][] = ["welcome", "match-status"];

interface Seat {
  ws: WebSocket;
  /** Every message this socket received, background included. */
  received: ServerMessage[];
  /** The close code, once the server closed the socket. */
  closed: Promise<number>;
  /** The next message that is not background, or a timeout error. */
  next: () => Promise<ServerMessage>;
  send: (message: unknown) => void;
}

const openSeat = (gameId: string, socketToken: string): Promise<Seat> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${baseUrl.replace("http", "ws")}/ws/games/${gameId}?token=${socketToken}`,
      { headers: { Origin: "http://localhost:5173" } },
    );
    const received: ServerMessage[] = [];
    const buffer: ServerMessage[] = [];
    let waiting: ((message: ServerMessage) => void) | null = null;
    const closed = new Promise<number>((resolveClose) =>
      ws.on("close", (code: number) => resolveClose(code)),
    );
    ws.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      received.push(message);
      if (BACKGROUND.includes(message.type)) return;
      if (waiting) {
        const deliver = waiting;
        waiting = null;
        deliver(message);
      } else {
        buffer.push(message);
      }
    });
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        ws,
        received,
        closed,
        send: (message) => ws.send(JSON.stringify(message)),
        next: () => {
          const queued = buffer.shift();
          if (queued) return Promise.resolve(queued);
          return new Promise((resolveNext, rejectNext) => {
            const timeout = setTimeout(
              () => rejectNext(new Error("Timed out waiting for a message")),
              5_000,
            );
            waiting = (message) => {
              clearTimeout(timeout);
              resolveNext(message);
            };
          });
        },
      }),
    );
  });

/** The seat's next message, which must be of the given type. */
async function expectNext<T extends ServerMessage["type"]>(
  seat: Seat,
  type: T,
): Promise<Extract<ServerMessage, { type: T }>> {
  const message = await seat.next();
  expect(message.type).toBe(type);
  return message as Extract<ServerMessage, { type: T }>;
}

/**
 * A started friend game: a logged-in host as Player 1 on socket `stale`, a
 * guest opponent, and an anonymous spectator.
 */
async function startHostGame() {
  const created = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": HOST_USER,
    },
    body: JSON.stringify({
      config: GAME_CONFIG,
      matchType: "friend",
      hostIsPlayer1: true,
    }),
  });
  expect(created.status).toBe(201);
  const game = (await created.json()) as GameCreateResponse;

  const joined = await fetch(`${baseUrl}/api/games/${game.gameId}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "Guest" }),
  });
  expect(joined.status).toBe(200);
  const join = (await joined.json()) as JoinGameResponse;
  if (join.role !== "player") throw new Error("The joiner got no seat");

  const stale = await openSeat(game.gameId, game.socketToken);
  const opponent = await openSeat(game.gameId, join.socketToken);
  await expectNext(stale, "state");
  await expectNext(opponent, "state");
  const spectator = await openSeat(game.gameId, "");
  await expectNext(spectator, "state");
  return { game, stale, opponent, spectator };
}

/** The host opens the game again; returns the seat's socketToken it gets. */
async function reopenAsHost(gameId: string, token?: string) {
  const query = token ? `?token=${token}` : "";
  const reopened = await fetch(`${baseUrl}/api/games/${gameId}${query}`, {
    headers: { "x-test-user-id": HOST_USER },
  });
  const access = (await reopened.json()) as {
    kind: string;
    seat?: { socketToken: string };
  };
  if (access.kind !== "player" || !access.seat) {
    throw new Error("The owner did not get the seat back");
  }
  return access.seat.socketToken;
}

/**
 * startHostGame, then the host opens the game in a new tab or device: no
 * token, only the login. That rotates the host seat; `fresh` is the socket on
 * the new token.
 */
async function rotateHostSeat() {
  const { game, stale, opponent, spectator } = await startHostGame();
  const socketToken = await reopenAsHost(game.gameId);
  expect(socketToken).not.toBe(game.socketToken);

  const fresh = await openSeat(game.gameId, socketToken);
  await expectNext(fresh, "state");
  return { stale, fresh, opponent, spectator };
}

const OPEN = 1;

describe("a socket on a rotated seat credential", () => {
  beforeAll(async () => {
    const handle = await setupEphemeralDb();
    container = handle.container;
    const { createApp } = await import("../../server/app");
    const { app, websocket } = createApp();
    server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
    baseUrl = `http://localhost:${server.port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) await server.stop(true);
    await teardownEphemeralDb(container);
  }, 60_000);

  it("is closed with the seat-moved code when the seat rotates", async () => {
    const { stale, opponent, spectator } = await rotateHostSeat();

    expect(await stale.closed).toBe(SEAT_MOVED_CLOSE_CODE);
    // Only the moved seat's old sockets go.
    expect(opponent.ws.readyState).toBe(OPEN);
    expect(spectator.ws.readyState).toBe(OPEN);
  });

  it("stays open when the owner opens the game with the current token", async () => {
    const { game, stale } = await startHostGame();

    // The site's own tab sends its seat token, which matches first and
    // rotates nothing.
    expect(await reopenAsHost(game.gameId, game.hostToken)).toBe(
      game.socketToken,
    );
    stale.send({ type: "ping" });
    await expectNext(stale, "pong");
    expect(stale.ws.readyState).toBe(OPEN);
  });

  it("cannot chat as the seat; the new socket can", async () => {
    const { stale, fresh, opponent } = await rotateHostSeat();

    // Sent before this client has read the close: the server dropped the
    // socket at the rotation, so the message reaches no one.
    stale.send({ type: "chat-message", channel: "game", text: "from stale" });
    fresh.send({ type: "chat-message", channel: "game", text: "from fresh" });

    const chat = await expectNext(opponent, "chat-message");
    expect(chat.text).toBe("from fresh");
  });

  it("gets no rematch credentials; the new socket gets the seat", async () => {
    const { stale, fresh, opponent } = await rotateHostSeat();

    fresh.send({ type: "resign" });
    expect((await expectNext(fresh, "state")).state.status).toBe("finished");
    expect((await expectNext(opponent, "state")).state.status).toBe("finished");
    opponent.send({ type: "rematch-offer" });
    await expectNext(fresh, "rematch-offer");
    fresh.send({ type: "rematch-accept" });

    const started = await expectNext(fresh, "rematch-started");
    expect(started.seat?.socketToken).toBeString();
    expect((await expectNext(opponent, "rematch-started")).seat).toBeDefined();
    expect(
      stale.received.filter(
        (message) =>
          message.type === "rematch-started" ||
          message.type === "rematch-offer" ||
          message.type === "chat-message",
      ),
    ).toEqual([]);
    expect(await stale.closed).toBe(SEAT_MOVED_CLOSE_CODE);
  });
});
