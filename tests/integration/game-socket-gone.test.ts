/**
 * A player socket for a game the server no longer holds (board task 78c5a88d).
 *
 * After the 2026-11-03 deploy, open tabs reconnected to games the restart had
 * dropped. resolveSessionForSocketToken threw "Game session not found" out of
 * the upgrade middleware: 78 stack traces and 500s in 13 minutes, and each tab
 * kept retrying, because a browser cannot read the HTTP status of a refused
 * upgrade. The server now opens the socket only to close it with
 * GAME_SOCKET_GONE_CLOSE_CODE, which the client reads and stops on.
 *
 * Needs no database: no game is ever stored here.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { WebSocket } from "ws";
import { GAME_SOCKET_GONE_CLOSE_CODE } from "../../shared/contracts/websocket-messages";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:9/unused";

let server: ReturnType<typeof Bun.serve>;
let wsBase: string;

beforeAll(async () => {
  const { createApp } = await import("../../server/app");
  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  wsBase = `ws://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

/** How the socket ended: its close code, or the HTTP status that refused it. */
const connect = (path: string): Promise<{ close?: number; status?: number }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}${path}`, {
      headers: { Origin: "http://localhost:5173" },
    });
    ws.on("unexpected-response", (_request, response) => {
      resolve({ status: response.statusCode });
    });
    ws.on("close", (code) => resolve({ close: code }));
    ws.on("error", () => undefined);
  });

describe("game socket for a game the server no longer holds", () => {
  it("closes a player socket with the gone code, and logs no error", async () => {
    const errors = spyOn(console, "error");
    try {
      const result = await connect("/ws/games/goneGame1?token=stale-token");
      expect(result).toEqual({ close: GAME_SOCKET_GONE_CLOSE_CODE });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("still answers a spectator socket with a plain 404", async () => {
    expect(await connect("/ws/games/goneGame2")).toEqual({ status: 404 });
  });
});
