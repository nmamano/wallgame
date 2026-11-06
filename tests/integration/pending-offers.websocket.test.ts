/**
 * A draw or a rematch starts only when the other seat made an offer that still
 * stands (board task b387a044).
 *
 * The server used to keep no record of either offer, so a seat could send an
 * accept on its own: a player about to lose turned the loss into a (rated)
 * draw, and either seat could start a rematch alone. These tests drive the real
 * socket for each of the three accept paths (draw-accept, rematch-accept, and
 * the action-request respondRematch "accepted"), and for the rules that decide
 * how long a draw offer stands.
 *
 * A refused accept sends nothing to the board, so "nothing happened" is shown
 * with a ping: the pong must be the next message, which it cannot be if a state
 * or a rematch-started was sent first.
 *
 * Uses Testcontainers for an ephemeral PostgreSQL, so this needs Docker.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  GameCreateResponse,
  JoinGameResponse,
} from "../../shared/contracts/games";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type { PartialGameConfiguration } from "../../server/games/store";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

const GAME_CONFIG: PartialGameConfiguration = {
  timeControl: { initialSeconds: 600, incrementSeconds: 0, preset: "rapid" },
  variant: "standard",
  randomStart: false,
  rated: false,
  boardWidth: 3,
  boardHeight: 3,
};

/** Message types that may arrive at any time and say nothing about an offer. */
const BACKGROUND: ServerMessage["type"][] = ["welcome", "match-status"];

interface Seat {
  ws: WebSocket;
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
    const buffer: ServerMessage[] = [];
    let waiting: ((message: ServerMessage) => void) | null = null;
    ws.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
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
 * The game's status as the server holds it, read through the public GET.
 *
 * The ping check alone cannot show that a draw did not happen: the draw path
 * writes the result to the database before it broadcasts, so a pong can
 * arrive first. The state itself changes before that write, so this read,
 * made after the pong, sees it.
 */
async function serverStatus(gameId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}`);
  const body = (await res.json()) as { state?: { status: string } };
  if (!body.state) throw new Error("The game response holds no state");
  return body.state.status;
}

/** Proves the server sent this seat nothing since its last read. */
async function expectNothingSent(seat: Seat): Promise<void> {
  seat.send({ type: "ping" });
  await expectNext(seat, "pong");
}

/**
 * A started guest game on the 3x3 board. The host is Player 1 and moves
 * first; both sockets are open, and the opening state has been read.
 */
async function startGame(): Promise<{ gameId: string; p1: Seat; p2: Seat }> {
  const created = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: GAME_CONFIG,
      matchType: "friend",
      hostDisplayName: "Guest",
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

  const p1 = await openSeat(game.gameId, game.socketToken);
  const p2 = await openSeat(game.gameId, join.socketToken);
  await expectNext(p1, "state");
  await expectNext(p2, "state");
  return { gameId: game.gameId, p1, p2 };
}

/** Plays one move and reads the resulting state on both seats. */
async function move(mover: Seat, other: Seat, notation: string) {
  mover.send({
    type: "submit-move",
    move: moveFromStandardNotation(notation, GAME_CONFIG.boardHeight),
  });
  const state = await expectNext(mover, "state");
  await expectNext(other, "state");
  expect(state.state.status).toBe("playing");
}

/** Both players move once, so a draw counts; Player 1 is to move. */
async function startPlayedGame() {
  const seats = await startGame();
  await move(seats.p1, seats.p2, "Cb2");
  await move(seats.p2, seats.p1, "Cb2");
  return seats;
}

/** Ends the game by Player 1's resignation, as both seats see it. */
async function finishGame(p1: Seat, p2: Seat) {
  p1.send({ type: "resign" });
  expect((await expectNext(p1, "state")).state.status).toBe("finished");
  expect((await expectNext(p2, "state")).state.status).toBe("finished");
}

const actionRequest = (action: string, payload?: unknown) => ({
  type: "action-request",
  requestId: randomUUID(),
  action,
  ...(payload === undefined ? {} : { payload }),
});

describe("draw and rematch accepts need a standing offer", () => {
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

  it("refuses a draw-accept with no offer, and the game goes on", async () => {
    const { gameId, p1, p2 } = await startPlayedGame();

    p1.send({ type: "draw-accept" });
    await expectNothingSent(p1);
    await expectNothingSent(p2);
    expect(await serverStatus(gameId)).toBe("playing");
    await move(p1, p2, "Ca2");
  });

  it("refuses a draw-accept of your own offer", async () => {
    const { gameId, p1, p2 } = await startPlayedGame();

    p1.send({ type: "draw-offer" });
    expect((await expectNext(p2, "draw-offer")).playerId).toBe(1);
    p1.send({ type: "draw-accept" });
    await expectNothingSent(p1);
    await expectNothingSent(p2);
    expect(await serverStatus(gameId)).toBe("playing");
  });

  it("ends the game in a draw when the other seat accepts a standing offer", async () => {
    const { p1, p2 } = await startPlayedGame();

    p1.send({ type: "draw-offer" });
    await expectNext(p2, "draw-offer");
    p2.send({ type: "draw-accept" });
    const [a, b] = [
      await expectNext(p1, "state"),
      await expectNext(p2, "state"),
    ];
    expect(a.state.status).toBe("finished");
    expect(a.state.result?.reason).toBe("draw-agreement");
    expect(b.state).toEqual(a.state);
  });

  it("keeps a draw offer through the offerer's own move", async () => {
    const { p1, p2 } = await startPlayedGame();

    // "Offer, then move" is the normal order.
    p1.send({ type: "draw-offer" });
    await expectNext(p2, "draw-offer");
    await move(p1, p2, "Ca2");

    p2.send({ type: "draw-accept" });
    const ended = await expectNext(p2, "state");
    expect(ended.state.status).toBe("finished");
    expect(ended.state.result?.reason).toBe("draw-agreement");
  });

  it("retires a draw offer when its recipient moves, and refuses a later accept", async () => {
    const { gameId, p1, p2 } = await startPlayedGame();

    p2.send({ type: "draw-offer" });
    await expectNext(p1, "draw-offer");

    // Player 1 plays on instead of answering: that declines the offer.
    p1.send({
      type: "submit-move",
      move: moveFromStandardNotation("Ca2", GAME_CONFIG.boardHeight),
    });
    for (const seat of [p1, p2]) {
      expect(await expectNext(seat, "draw-rejected")).toEqual({
        type: "draw-rejected",
        playerId: 1,
      });
      expect((await expectNext(seat, "state")).state.status).toBe("playing");
    }

    p1.send({ type: "draw-accept" });
    await expectNothingSent(p1);
    await expectNothingSent(p2);
    expect(await serverStatus(gameId)).toBe("playing");
  });

  it("turns two crossed draw offers into a draw", async () => {
    const { p1, p2 } = await startPlayedGame();

    p1.send({ type: "draw-offer" });
    await expectNext(p2, "draw-offer");
    p2.send({ type: "draw-offer" });
    const ended = await expectNext(p1, "state");
    expect(ended.state.result?.reason).toBe("draw-agreement");
  });

  it("refuses a rematch-accept with no offer", async () => {
    const { p1, p2 } = await startPlayedGame();
    await finishGame(p1, p2);

    p2.send({ type: "rematch-accept" });
    expect(await expectNext(p2, "error")).toEqual({
      type: "error",
      message: "There is no rematch offer to accept.",
    });
    await expectNothingSent(p1);
    await expectNothingSent(p2);
  });

  it("refuses an action-request respondRematch accepted with no offer", async () => {
    const { p1, p2 } = await startPlayedGame();
    await finishGame(p1, p2);

    const request = actionRequest("respondRematch", { decision: "accepted" });
    p2.send(request);
    const nack = await expectNext(p2, "actionNack");
    expect(nack.requestId).toBe(request.requestId);
    expect(nack.code).toBe("REMATCH_NOT_AVAILABLE");
    await expectNothingSent(p1);
    await expectNothingSent(p2);
  });

  it("refuses a rematch accept of your own offer, and after a decline", async () => {
    const { p1, p2 } = await startPlayedGame();
    await finishGame(p1, p2);

    p1.send({ type: "rematch-offer" });
    await expectNext(p2, "rematch-offer");
    p1.send({ type: "rematch-accept" });
    await expectNext(p1, "error");

    p2.send({ type: "rematch-reject" });
    await expectNext(p1, "rematch-rejected");
    await expectNext(p2, "rematch-rejected");
    p2.send({ type: "rematch-accept" });
    await expectNext(p2, "error");
    await expectNothingSent(p1);
  });

  it("starts a rematch when the other seat accepts a standing offer, on both accept paths", async () => {
    for (const accept of [
      { type: "rematch-accept" },
      actionRequest("respondRematch", { decision: "accepted" }),
    ]) {
      const { p1, p2 } = await startPlayedGame();
      await finishGame(p1, p2);

      p1.send({ type: "rematch-offer" });
      await expectNext(p2, "rematch-offer");
      p2.send(accept);
      if (accept.type === "action-request") {
        await expectNext(p2, "actionAck");
      }
      const [a, b] = [
        await expectNext(p1, "rematch-started"),
        await expectNext(p2, "rematch-started"),
      ];
      expect(a.newGameId).toBe(b.newGameId);
      expect(a.seat?.socketToken).toBeDefined();
    }
  });

  it("turns two crossed rematch offers into a rematch", async () => {
    const { p1, p2 } = await startPlayedGame();
    await finishGame(p1, p2);

    p1.send({ type: "rematch-offer" });
    await expectNext(p2, "rematch-offer");
    p2.send({ type: "rematch-offer" });
    const [a, b] = [
      await expectNext(p1, "rematch-started"),
      await expectNext(p2, "rematch-started"),
    ];
    expect(a.newGameId).toBe(b.newGameId);
  });

  it("still refuses a takeback-accept with no offer (control)", async () => {
    const { p1, p2 } = await startPlayedGame();

    p1.send({ type: "takeback-accept" });
    await expectNothingSent(p1);
    await expectNothingSent(p2);
  });

  it("pairs an offer and an accept across the two message paths", async () => {
    // Draw: offered by action-request, accepted by the plain message.
    {
      const { p1, p2 } = await startPlayedGame();
      p1.send(actionRequest("offerDraw"));
      await expectNext(p1, "actionAck");
      await expectNext(p2, "draw-offer");
      p2.send({ type: "draw-accept" });
      const ended = await expectNext(p2, "state");
      expect(ended.state.result?.reason).toBe("draw-agreement");
    }
    // Rematch: offered by action-request, accepted by the plain message.
    {
      const { p1, p2 } = await startPlayedGame();
      await finishGame(p1, p2);
      p1.send(actionRequest("offerRematch"));
      await expectNext(p1, "actionAck");
      await expectNext(p2, "rematch-offer");
      p2.send({ type: "rematch-accept" });
      const [a, b] = [
        await expectNext(p1, "rematch-started"),
        await expectNext(p2, "rematch-started"),
      ];
      expect(a.newGameId).toBe(b.newGameId);
    }
  });

  it("refuses a draw-accept after the game ended by resignation", async () => {
    const { gameId, p1, p2 } = await startPlayedGame();

    p1.send({ type: "draw-offer" });
    await expectNext(p2, "draw-offer");
    await finishGame(p1, p2);

    p2.send({ type: "draw-accept" });
    await expectNothingSent(p1);
    await expectNothingSent(p2);
    const res = await fetch(`${baseUrl}/api/games/${gameId}`);
    const body = (await res.json()) as {
      state: { result?: { reason: string } };
    };
    expect(body.state.result?.reason).toBe("resignation");
  });

  it("refuses a rematch offer while the game is on, and a draw offer after it", async () => {
    const { p1, p2 } = await startPlayedGame();

    p1.send({ type: "rematch-offer" });
    expect(await expectNext(p1, "error")).toEqual({
      type: "error",
      message: "A rematch can be offered only after the game ends.",
    });
    await expectNothingSent(p2);

    await finishGame(p1, p2);
    p1.send({ type: "draw-offer" });
    expect(await expectNext(p1, "error")).toEqual({
      type: "error",
      message: "A draw can be offered only while the game is on.",
    });
    await expectNothingSent(p2);
  });

  it("tells the opponent about a repeated offer only once", async () => {
    const { p1, p2 } = await startPlayedGame();

    p1.send({ type: "draw-offer" });
    await expectNext(p2, "draw-offer");
    p1.send({ type: "draw-offer" });
    const repeat = actionRequest("offerDraw");
    p1.send(repeat);
    expect((await expectNext(p1, "actionAck")).requestId).toBe(
      repeat.requestId,
    );
    await expectNothingSent(p2);

    // The one offer still stands.
    p2.send({ type: "draw-accept" });
    expect((await expectNext(p2, "state")).state.result?.reason).toBe(
      "draw-agreement",
    );
  });
});
