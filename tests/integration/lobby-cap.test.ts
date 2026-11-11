/**
 * The matchmaking lobby stays small (security audit lead 1, c1facd32).
 *
 * Every matchmaking create, join and cancel sends the whole list of waiting
 * games to every lobby viewer. Before this fix one requester could keep any
 * number of games waiting, each listed with its full starting layout, so a
 * burst of guest creates cost quadratic work and bandwidth. Now one requester
 * (the account, else the client network) can keep 3 waiting, and a lobby row
 * carries no starting layout, and a burst of changes goes out as one frame.
 *
 * Uses Testcontainers for an ephemeral PostgreSQL, so this needs Docker.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import {
  MAX_WAITING_MATCHMAKING_GAMES_PER_REQUESTER,
  type GameCreateResponse,
  type LobbyGame,
} from "../../shared/contracts/games";

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl = "";

beforeAll(async () => {
  ({ container } = await setupEphemeralDb());
  const { createApp } = await import("../../server/app");
  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}, 120_000);

afterAll(async () => {
  await server?.stop(true);
  await teardownEphemeralDb(container);
});

const config = {
  timeControl: {
    initialSeconds: 180,
    incrementSeconds: 2,
    preset: "blitz" as const,
  },
  rated: false,
  variant: "standard",
  randomStart: false,
  boardWidth: 8,
  boardHeight: 8,
};

/** A guest create from one client address. */
const createGame = async (source: string, matchType = "matchmaking") => {
  const response = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": source },
    body: JSON.stringify({ config, matchType }),
  });
  return {
    status: response.status,
    body: (await response.json()) as GameCreateResponse & { error?: string },
  };
};

const cancel = async (game: GameCreateResponse) => {
  const response = await fetch(`${baseUrl}/api/games/${game.gameId}/abort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: game.hostToken }),
  });
  expect(response.status).toBe(200);
};

/** A lobby socket that records every "games" frame it gets. */
const openLobby = () =>
  new Promise<{ frames: LobbyGame[][]; close: () => void }>(
    (resolve, reject) => {
      const frames: LobbyGame[][] = [];
      const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/lobby`, {
        headers: { Origin: "http://localhost:5173" },
      });
      ws.on("message", (data: Buffer) => {
        const message = JSON.parse(data.toString()) as {
          type: string;
          games?: LobbyGame[];
        };
        if (message.type === "games" && message.games) {
          frames.push(message.games);
        }
      });
      ws.on("error", reject);
      ws.on("open", () => resolve({ frames, close: () => ws.close() }));
    },
  );

/** The first "games" frame a new lobby socket gets. */
const readLobbyFrame = () =>
  new Promise<LobbyGame[]>((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/lobby`, {
      headers: { Origin: "http://localhost:5173" },
    });
    ws.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as {
        type: string;
        games?: LobbyGame[];
      };
      if (message.type !== "games" || !message.games) return;
      ws.close();
      resolve(message.games);
    });
    ws.on("error", reject);
  });

describe("the matchmaking lobby", () => {
  it("lets one requester keep 3 games waiting, and frees a slot on cancel", async () => {
    const source = "203.0.113.7";
    const waiting: GameCreateResponse[] = [];
    for (let i = 0; i < MAX_WAITING_MATCHMAKING_GAMES_PER_REQUESTER; i++) {
      const created = await createGame(source);
      expect(created.status).toBe(201);
      waiting.push(created.body);
    }

    const refused = await createGame(source);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe(
      "You already have 3 games waiting for an opponent. Cancel one first.",
    );

    // Another network, and a friend game from the same one, are not counted.
    expect((await createGame("198.51.100.9")).status).toBe(201);
    expect((await createGame(source, "friend")).status).toBe(201);

    await cancel(waiting[0]);
    expect((await createGame(source)).status).toBe(201);
  });

  it("counts an IPv6 client by its /64", async () => {
    for (let i = 0; i < MAX_WAITING_MATCHMAKING_GAMES_PER_REQUESTER; i++) {
      expect((await createGame(`2001:db8:7:7::${i + 1}`)).status).toBe(201);
    }
    expect((await createGame("2001:db8:7:7::ffff")).status).toBe(429);
  });

  it("sends a burst of creates as one lobby frame with every new game", async () => {
    const lobby = await openLobby();
    await Bun.sleep(300); // the frame every new lobby socket gets on open
    const before = lobby.frames.length;

    const created = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => createGame(`192.0.2.${100 + n}`)),
    );
    await Bun.sleep(700);
    lobby.close();

    const burstFrames = lobby.frames.slice(before);
    expect(burstFrames).toHaveLength(1);
    const listed = new Set(burstFrames[0].map((game) => game.id));
    for (const { body } of created) expect(listed.has(body.gameId)).toBe(true);
  });

  it("lists a waiting game without its starting layout", async () => {
    const created = await createGame("192.0.2.44");
    expect(created.status).toBe(201);

    const lobbyRow = (await readLobbyFrame()).find(
      (game) => game.id === created.body.gameId,
    );
    expect(lobbyRow?.config).toEqual({
      variant: "standard",
      randomStart: false,
      timeControl: config.timeControl,
      rated: false,
      boardWidth: 8,
      boardHeight: 8,
    });

    const listed = (await (
      await fetch(`${baseUrl}/api/games/matchmaking`)
    ).json()) as { games: LobbyGame[] };
    const listedRow = listed.games.find(
      (game) => game.id === created.body.gameId,
    );
    expect(listedRow?.config).toEqual(lobbyRow?.config);
  });
});
