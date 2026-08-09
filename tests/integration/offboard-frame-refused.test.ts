/**
 * The game socket validates what arrives instead of asserting it.
 *
 * `parseMessage` was `JSON.parse(raw) as ClientMessage` — a cast, which declares
 * a shape without checking one. So any JSON at all reached the handlers, and a
 * crafted `submit-move` frame from an authenticated seat in its own game carried
 * a pawn target straight into `applyMove`, which had no bounds check either.
 *
 * MEASURED ON THE UNFIXED TREE (66f6688, board task d39862b4). The exact frame
 *
 *     {"type":"submit-move","move":{"actions":[{"type":"cat","target":[0,-1]}]}}
 *
 * drew no error frame at all. The server broadcast `state` to BOTH seats, so the
 * opponent's client was told the position too; the authoritative state moved the
 * cat from [0,1] to [0,-1] and passed the turn; and the finished game persisted
 * ["Cb8","Cg8","C`8","Cf8"] — that third term decodes to [0,-1].
 *
 * TWO LAYERS, AND THIS FILE KEEPS THEM APART ON PURPOSE. `cellSchema` bounds a
 * cell to 0..19, which is the widest board the wire allows, so it cannot know
 * that [0,9] is off an 8x8 board. The rules check does. The two refusals carry
 * different messages, which is what lets each test name the layer that acted:
 *
 *     [0,-1]  ->  "Invalid message format"        (the schema)
 *     [0,9]   ->  "A pawn cannot leave the board" (the rules)
 *
 * The rest of the file is the other half of the obligation: every message type a
 * real client sends must still pass, and the rejections that already existed
 * must still come back in their own shapes rather than as generic errors.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database. Needs Docker.
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
import { timeControlConfigFromPreset } from "../../shared/domain/game-utils";
import { requirePawnCell } from "../../shared/domain/pawns";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type { PartialGameConfiguration } from "../../server/games/store";

const SCHEMA_REFUSAL = "Invalid message format";
const RULES_REFUSAL = "A pawn cannot leave the board";

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let db: typeof import("../../server/db").db;
let createApp: typeof import("../../server/app").createApp;
let store: typeof import("../../server/games/store");
let persistCompletedGame: typeof import("../../server/games/persistence").persistCompletedGame;
let gamesTable: typeof import("../../server/db/schema/games").gamesTable;
let gameDetailsTable: typeof import("../../server/db/schema/game-details").gameDetailsTable;
let eq: typeof import("drizzle-orm").eq;

const CONFIG: PartialGameConfiguration = {
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
  timeControl: timeControlConfigFromPreset("unlimited"),
  rated: false,
};

interface TestSocket {
  send: (frame: unknown) => void;
  /** Raw text, for the frames that are not valid JSON at all. */
  sendRaw: (text: string) => void;
  /** Everything that arrived in the window. Empty means the server said nothing. */
  collect: (ms?: number) => Promise<ServerMessage[]>;
  close: () => void;
}

const openSocket = (gameId: string, socketToken: string): Promise<TestSocket> =>
  new Promise((resolve, reject) => {
    const url =
      baseUrl.replace("http", "ws") +
      `/ws/games/${gameId}?token=${socketToken}`;
    const ws = new WebSocket(url, {
      headers: { Origin: "http://localhost:5173" },
    });
    const buffer: ServerMessage[] = [];
    ws.on("message", (data: Buffer) => {
      buffer.push(JSON.parse(data.toString()) as ServerMessage);
    });
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        send: (frame) => ws.send(JSON.stringify(frame)),
        sendRaw: (text) => ws.send(text),
        // Deliberately a window rather than a wait-for-type: several assertions
        // below are about what did NOT arrive, and "the next frame of type X"
        // cannot see an absence.
        collect: async (ms = 300) => {
          await Bun.sleep(ms);
          return buffer.splice(0, buffer.length);
        },
        close: () => ws.close(),
      }),
    );
  });

/** A two-seat friend game with both sockets connected and the opening played. */
const openGame = async () => {
  const { session, hostSocketToken } = store.createGameSession({
    config: CONFIG,
    matchType: "friend",
    hostDisplayName: "host",
    hostIsPlayer1: true,
  });
  const joined = store.joinGameSession({
    id: session.id,
    displayName: "joiner",
  });
  if (joined.kind !== "player") throw new Error("joiner got no seat");

  const host = await openSocket(session.id, hostSocketToken);
  const joiner = await openSocket(session.id, joined.player.socketToken);
  await host.collect(400);
  await joiner.collect(400);

  // One legal move each, so the crafted frames land in a running game rather
  // than in the opening position.
  host.send({
    type: "submit-move",
    move: { actions: [{ type: "cat", target: [0, 1] }] },
  });
  await host.collect();
  joiner.send({
    type: "submit-move",
    move: { actions: [{ type: "cat", target: [0, 6] }] },
  });
  await joiner.collect();
  await host.collect();

  return { id: session.id, host, joiner };
};

const snapshot = (id: string) => {
  const state = store.getSession(id).gameState;
  return {
    cat: requirePawnCell(state.pawns, 1, "cat"),
    turn: state.turn,
    moveCount: state.moveCount,
    history: state.history.length,
  };
};

const errorsIn = (frames: ServerMessage[]) =>
  frames.filter((frame) => frame.type === "error");

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;

  db = (await import("../../server/db")).db;
  createApp = (await import("../../server/app")).createApp;
  store = await import("../../server/games/store");
  persistCompletedGame = (await import("../../server/games/persistence"))
    .persistCompletedGame;
  gamesTable = (await import("../../server/db/schema/games")).gamesTable;
  gameDetailsTable = (await import("../../server/db/schema/game-details"))
    .gameDetailsTable;
  eq = (await import("drizzle-orm")).eq;

  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}, 120_000);

beforeEach(async () => {
  await db.delete(gamesTable);
});

afterAll(async () => {
  if (server) await server.stop(true);
  await teardownEphemeralDb(container);
}, 60_000);

describe("the crafted off-board frame", () => {
  it("is refused by the schema, and the opponent is told nothing", async () => {
    const { id, host, joiner } = await openGame();
    const before = snapshot(id);

    host.send({
      type: "submit-move",
      move: { actions: [{ type: "cat", target: [0, -1] }] },
    });
    const hostFrames = await host.collect(500);
    const joinerFrames = await joiner.collect(100);

    const errors = errorsIn(hostFrames);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ type: "error", message: SCHEMA_REFUSAL });
    // On 66f6688 this was a `state` broadcast to both seats. The opponent's
    // client must not be told about a position that was never legal.
    expect(hostFrames.filter((frame) => frame.type === "state")).toHaveLength(
      0,
    );
    expect(joinerFrames).toHaveLength(0);

    expect(snapshot(id)).toEqual(before);

    host.close();
    joiner.close();
  });

  it("is refused by the rules when it clears the wire's 0..19 ceiling", async () => {
    // [0,9] is a legal cell on the widest board the wire allows and is off THIS
    // board, so only the rules layer can refuse it. The message proves which
    // layer acted, which is what makes the two independent rather than one
    // check reported twice.
    const { id, host, joiner } = await openGame();
    const before = snapshot(id);

    host.send({
      type: "submit-move",
      move: { actions: [{ type: "cat", target: [0, 9] }] },
    });
    const frames = await host.collect(500);

    const errors = errorsIn(frames);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ type: "error", message: RULES_REFUSAL });
    expect(snapshot(id)).toEqual(before);

    host.close();
    joiner.close();
  });

  it("persists nothing, and a legal move over the same socket still does", async () => {
    const { id, host, joiner } = await openGame();

    host.send({
      type: "submit-move",
      move: { actions: [{ type: "cat", target: [0, -1] }] },
    });
    await host.collect();
    host.send({
      type: "submit-move",
      move: { actions: [{ type: "cat", target: [0, 9] }] },
    });
    await host.collect();

    // The positive control, and it has to come after the refusals: it shows the
    // socket still works and the turn never moved on.
    host.send({
      type: "submit-move",
      move: { actions: [{ type: "cat", target: [0, 2] }] },
    });
    const accepted = await host.collect(500);
    expect(
      accepted.filter((frame) => frame.type === "state").length,
    ).toBeGreaterThan(0);
    expect(errorsIn(accepted)).toHaveLength(0);

    store.resignGame({ id, playerId: 2, timestamp: Date.now() });
    await persistCompletedGame(store.getSession(id));

    const [details] = await db
      .select()
      .from(gameDetailsTable)
      .where(eq(gameDetailsTable.gameId, id));
    const moves = details.moves as string[];

    // Three accepted plies, and nothing from the two refusals.
    expect(moves).toEqual(["Cb8", "Cg8", "Cc8"]);
    // The census predicate, inlined: decode each term the way
    // `cellFromStandardNotation` does and check it against the stored board. On
    // 66f6688 the same read produced "C`8" -> [0,-1].
    const offBoard = moves.flatMap((token, ply) =>
      token
        .split(".")
        .map((term) => ({
          ply,
          term,
          row: 8 - Number.parseInt(term.slice(2), 10),
          col: term.charCodeAt(1) - 97,
        }))
        .filter(({ row, col }) => row < 0 || row > 7 || col < 0 || col > 7),
    );
    expect(offBoard).toEqual([]);

    host.close();
    joiner.close();
  });

  it("refuses an off-board wall target through the same path", async () => {
    const { id, host, joiner } = await openGame();
    const before = snapshot(id);

    host.send({
      type: "submit-move",
      move: {
        actions: [
          { type: "wall", target: [0, -1], wallOrientation: "vertical" },
        ],
      },
    });
    const frames = await host.collect(500);

    expect(errorsIn(frames)).toHaveLength(1);
    expect(snapshot(id)).toEqual(before);

    host.close();
    joiner.close();
  });
});

describe("the frames a real client sends still pass", () => {
  // The other half of the obligation. A schema that refused the crafted frame
  // and also broke ordinary play would be worse than the bug.

  it("ping still answers pong", async () => {
    const { host, joiner } = await openGame();
    host.send({ type: "ping" });
    const frames = await host.collect();
    expect(frames.map((frame) => frame.type)).toContain("pong");
    host.close();
    joiner.close();
  });

  it("a wall placement, a two-action move and a mouse move all pass", async () => {
    const { id, host, joiner } = await openGame();

    host.send({
      type: "submit-move",
      move: {
        actions: [
          { type: "cat", target: [0, 2] },
          { type: "wall", target: [3, 3], wallOrientation: "horizontal" },
        ],
      },
    });
    expect(errorsIn(await host.collect(500))).toHaveLength(0);
    await joiner.collect();

    joiner.send({
      type: "submit-move",
      move: { actions: [{ type: "mouse", target: [7, 6] }] },
    });
    expect(errorsIn(await joiner.collect(500))).toHaveLength(0);
    await host.collect();

    expect(snapshot(id).moveCount).toBe(4);

    host.close();
    joiner.close();
  });

  it("an action-request is acknowledged, and an unknown action is still nacked", async () => {
    // `action` stays a plain string in the schema precisely so UNKNOWN_ACTION
    // remains reachable. This is the test that would fail if it were an enum.
    const { host, joiner } = await openGame();

    host.send({
      type: "action-request",
      requestId: "req-1",
      action: "offerDraw",
    });
    const ack = await host.collect(500);
    expect(ack.map((frame) => frame.type)).toContain("actionAck");

    host.send({
      type: "action-request",
      requestId: "req-2",
      action: "notAnAction",
    });
    const nack = (await host.collect(500)).find(
      (frame) => frame.type === "actionNack",
    );
    expect(nack).toBeDefined();
    expect(nack).toMatchObject({ requestId: "req-2", code: "UNKNOWN_ACTION" });

    host.close();
    joiner.close();
  });

  it("a chat message is delivered, and a garbage channel still gets chat-error", async () => {
    // `channel` stays a plain string for the same reason: an unknown channel is
    // already refused by `validateChatChannelAccess`, with its own code. An enum
    // here would replace this `chat-error` with a generic `error`.
    const { host, joiner } = await openGame();

    host.send({ type: "chat-message", channel: "game", text: "hello" });
    const delivered = await joiner.collect(500);
    expect(delivered.map((frame) => frame.type)).toContain("chat-message");

    host.send({ type: "chat-message", channel: "not-a-channel", text: "hi" });
    const refused = await host.collect(500);
    const chatError = refused.find((frame) => frame.type === "chat-error");
    expect(chatError).toBeDefined();
    expect(chatError).toMatchObject({ code: "INVALID_CHANNEL" });
    expect(errorsIn(refused)).toHaveLength(0);

    host.close();
    joiner.close();
  });

  it("give-time is shape-checked only, so its own policy is untouched", async () => {
    // The schema checks that `seconds` is a number and nothing more. What a seat
    // is ALLOWED to do to a clock is the handler's business, and the fact that
    // this frame validates nothing is a separate hole, filed separately.
    const { id, host, joiner } = await openGame();

    host.send({ type: "give-time", seconds: "thirty" });
    const refused = await host.collect(500);
    expect(errorsIn(refused)).toHaveLength(1);
    expect(errorsIn(refused)[0]).toEqual({
      type: "error",
      message: SCHEMA_REFUSAL,
    });

    host.send({ type: "give-time", seconds: 30 });
    const accepted = await host.collect(500);
    expect(errorsIn(accepted)).toHaveLength(0);
    expect(store.getSession(id).gameState.status).toBe("playing");

    host.close();
    joiner.close();
  });

  it("a frame that is not JSON at all still gets the error frame it always did", async () => {
    const { host, joiner } = await openGame();
    host.sendRaw("{ not json");
    const frames = await host.collect(500);
    expect(errorsIn(frames)).toHaveLength(1);
    host.close();
    joiner.close();
  });
});
