/**
 * A frame that is valid JSON but not a message must cost at most its own
 * socket (board task 2f33f2ad).
 *
 * The eval socket read `message.type` from whatever JSON.parse returned, so
 * the 4-byte frame `null` threw inside an async handler that nothing caught,
 * and Bun ends the process on an unhandled rejection: every game in memory
 * ended with it. Each socket route gets each such frame here, and the server
 * must still answer afterwards with no uncaught error.
 *
 * Needs no database: the one game is a guest friend game, held in memory.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { WebSocket } from "ws";
import type { GameCreateResponse } from "../shared/contracts/games";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:9/unused";

const FRAMES = ["null", "1", '"x"', "[]", "{}"];

/** How long a socket that ignores a frame is watched before it counts as open. */
const QUIET_MS = 300;

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let wsBase: string;
let playerPath: string;

/** Every error that reached the process instead of a handler. */
const uncaught: unknown[] = [];
const recordUncaught = (error: unknown) => {
  uncaught.push(error);
};

beforeAll(async () => {
  process.on("unhandledRejection", recordUncaught);
  process.on("uncaughtException", recordUncaught);

  const { createApp } = await import("../server/app");
  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
  wsBase = `ws://localhost:${server.port}`;

  const response = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: {
        timeControl: { initialSeconds: 300, incrementSeconds: 5 },
        variant: "standard",
        randomStart: false,
        rated: false,
        boardWidth: 9,
        boardHeight: 9,
      },
      matchType: "friend",
      hostDisplayName: "Guest",
      anonymousId: crypto.randomUUID(),
    }),
  });
  expect(response.status).toBe(201);
  const created = (await response.json()) as GameCreateResponse;
  playerPath = `/ws/games/${created.gameId}?token=${created.socketToken}`;

  // A second guest joins, so the game is ready and takes spectators too.
  const joined = await fetch(`${baseUrl}/api/games/${created.gameId}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName: "Guest 2",
      anonymousId: crypto.randomUUID(),
    }),
  });
  expect(joined.status).toBe(200);
  const ready = await fetch(`${baseUrl}/api/games/${created.gameId}/ready`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: created.hostToken }),
  });
  expect(ready.status).toBe(200);
});

afterAll(async () => {
  await server.stop(true);
  process.off("unhandledRejection", recordUncaught);
  process.off("uncaughtException", recordUncaught);
});

/**
 * Opens a socket, sends one frame, and resolves with how it ended: closed by
 * the server, or still open after QUIET_MS.
 */
const sendFrame = (path: string, frame: string) =>
  new Promise<"closed" | "open">((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${path}`, {
      headers: { Origin: "http://localhost:5173" },
    });
    let quiet: ReturnType<typeof setTimeout> | undefined;
    ws.on("open", () => {
      ws.send(frame);
      quiet = setTimeout(() => {
        ws.close();
        resolve("open");
      }, QUIET_MS);
    });
    ws.on("close", () => {
      clearTimeout(quiet);
      resolve("closed");
    });
    ws.on("unexpected-response", (_request, res) => {
      reject(new Error(`${path} refused the upgrade: ${res.statusCode}`));
    });
    ws.on("error", () => undefined);
  });

const routes = (): [string, string][] => [
  ["eval", "/ws/eval/someGame1"],
  ["custom-bot", "/ws/custom-bot"],
  ["lobby", "/ws/lobby"],
  ["live-games", "/ws/live-games"],
  ["game (player)", playerPath],
  ["game (spectator)", playerPath.split("?")[0]],
];

describe("a frame that is JSON but not a message", () => {
  for (const frame of FRAMES) {
    it(`frame ${frame}: every socket route ignores it or closes, and the server keeps serving`, async () => {
      for (const [, path] of routes()) {
        expect(["closed", "open"]).toContain(await sendFrame(path, frame));
      }
      // Lets a rejection that nothing caught reach the process listener.
      await Bun.sleep(50);
      expect(uncaught).toEqual([]);
      expect((await fetch(`${baseUrl}/api/games/live`)).status).toBe(200);
    });
  }
});
