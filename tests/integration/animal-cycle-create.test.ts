import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StartedTestContainer } from "testcontainers";
import { WebSocket } from "ws";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  GameCreateResponse,
  JoinGameResponse,
} from "../../shared/contracts/games";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import { pawnCell } from "../../shared/domain/pawns";
import type { AnimalCycleInitialState } from "../../shared/domain/game-types";

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl = "";
let db: typeof import("../../server/db").db;
let gameDetailsTable: typeof import("../../server/db/schema/game-details").gameDetailsTable;
let eq: typeof import("drizzle-orm").eq;

beforeAll(async () => {
  ({ container } = await setupEphemeralDb());
  const { createApp } = await import("../../server/app");
  db = (await import("../../server/db")).db;
  gameDetailsTable = (await import("../../server/db/schema/game-details"))
    .gameDetailsTable;
  eq = (await import("drizzle-orm")).eq;
  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}, 120_000);

afterAll(async () => {
  await server?.stop(true);
  await teardownEphemeralDb(container);
});

describe("Animal Cycle HTTP creation", () => {
  it("creates and plays a real friend-game session", async () => {
    const response = await fetch(`${baseUrl}/api/games`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          variant: "animal-cycle",
          boardWidth: 8,
          boardHeight: 8,
          rated: false,
          timeControl: {
            initialSeconds: 180,
            incrementSeconds: 2,
            preset: "blitz",
          },
        },
        matchType: "friend",
        hostDisplayName: "Dog and Mouse",
        hostIsPlayer1: true,
      }),
    });

    const body = (await response.json()) as GameCreateResponse;
    expect(response.status).toBe(201);
    expect(body.snapshot.config.variant).toBe("animal-cycle");
    const initialState = body.snapshot.config
      .variantConfig as AnimalCycleInitialState;
    expect(initialState.pawns).toEqual({
      p1: { dog: [0, 0], mouse: [7, 0] },
      p2: { cat: [0, 7], elephant: [7, 7] },
    });

    const joinResponse = await fetch(
      `${baseUrl}/api/games/${body.gameId}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Cat and Elephant" }),
      },
    );
    expect(joinResponse.status).toBe(200);
    const joined = (await joinResponse.json()) as JoinGameResponse;
    expect(joined.role).toBe("player");
    if (joined.role !== "player") throw new Error("expected player join");

    const hostSocket = await openSocket(body.gameId, body.socketToken);
    const joinerSocket = await openSocket(body.gameId, joined.socketToken);
    await Bun.sleep(20);
    hostSocket.drain("state");
    joinerSocket.drain("state");

    const sockets = [hostSocket, joinerSocket] as const;
    const play = async (index: 0 | 1, notation: string) => {
      sockets[index].ws.send(
        JSON.stringify({
          type: "submit-move",
          move: moveFromStandardNotation(notation, 8),
        }),
      );
      const [hostState, joinerState] = await Promise.all([
        hostSocket.waitFor("state"),
        joinerSocket.waitFor("state"),
      ]);
      expect(hostState.state).toEqual(joinerState.state);
      return hostState.state;
    };

    await play(0, "Dc8");
    await play(1, "---");
    await play(0, "De8");
    await play(1, "---");
    await play(0, "Dg8");
    await play(1, "---");
    const terminal = await play(0, "Dh8.Mb1");

    expect(terminal.status).toBe("finished");
    expect(terminal.result).toEqual({ winner: 1, reason: "capture" });
    expect(pawnCell(terminal.pawns, 1, "mouse")).toEqual([7, 0]);
    expect(terminal.history.at(-1)?.notation).toBe("Dh8");

    await Bun.sleep(50);
    const [stored] = await db
      .select()
      .from(gameDetailsTable)
      .where(eq(gameDetailsTable.gameId, body.gameId));
    expect(stored).toBeDefined();
    expect((stored.moves as string[]).at(-1)).toBe("Dh8");
    expect(
      (stored.configParameters as { initialState: unknown }).initialState,
    ).toEqual(body.snapshot.config.variantConfig);

    const { getReplayGameReadonly } =
      await import("../../server/db/game-queries");
    const replay = await getReplayGameReadonly(body.gameId);
    expect(replay?.matchStatus.config.variant).toBe("animal-cycle");
    expect(replay?.state.result).toEqual({ winner: 1, reason: "capture" });
    expect(replay?.state.history.at(-1)?.notation).toBe("Dh8");
    expect(replay && pawnCell(replay.state.pawns, 1, "mouse")).toEqual([7, 0]);

    const { createRematchSession } = await import("../../server/games/store");
    const rematch = createRematchSession(body.gameId);
    expect(rematch.newSession.config.variant).toBe("animal-cycle");
    expect(rematch.newSession.config.variantConfig).toEqual(
      body.snapshot.config.variantConfig,
    );

    hostSocket.ws.close();
    joinerSocket.ws.close();
  }, 30_000);
});

interface SocketHarness {
  ws: WebSocket;
  drain(type: ServerMessage["type"]): void;
  waitFor<T extends ServerMessage["type"]>(
    type: T,
  ): Promise<Extract<ServerMessage, { type: T }>>;
}

async function openSocket(
  gameId: string,
  socketToken: string,
): Promise<SocketHarness> {
  const ws = new WebSocket(
    `${baseUrl.replace("http", "ws")}/ws/games/${gameId}?token=${socketToken}`,
    { headers: { Origin: "http://localhost:5173" } },
  );
  const messages: ServerMessage[] = [];
  const listeners = new Set<() => void>();
  ws.on("message", (raw) => {
    let payload: string;
    if (Array.isArray(raw)) {
      payload = Buffer.concat(raw).toString("utf8");
    } else if (raw instanceof ArrayBuffer) {
      payload = new TextDecoder().decode(raw);
    } else {
      payload = raw.toString("utf8");
    }
    const message = JSON.parse(payload) as ServerMessage;
    messages.push(message);
    for (const listener of listeners) listener();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  return {
    ws,
    drain: (type) => {
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].type === type) messages.splice(index, 1);
      }
    },
    waitFor: async <T extends ServerMessage["type"]>(type: T) => {
      const take = (): Extract<ServerMessage, { type: T }> | undefined => {
        const index = messages.findIndex((message) => message.type === type);
        if (index < 0) return undefined;
        return messages.splice(index, 1)[0] as Extract<
          ServerMessage,
          { type: T }
        >;
      };
      const ready = take();
      if (ready) return ready;
      return await new Promise<Extract<ServerMessage, { type: T }>>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            listeners.delete(check);
            reject(
              new Error(
                `timeout waiting for ${type}; buffered ${messages
                  .map((message) => message.type)
                  .join(",")}`,
              ),
            );
          }, 5_000);
          const check = () => {
            const message = take();
            if (!message) return;
            clearTimeout(timeout);
            listeners.delete(check);
            resolve(message);
          };
          listeners.add(check);
        },
      );
    },
  };
}
