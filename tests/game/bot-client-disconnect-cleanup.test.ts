/**
 * The bot client's session bookkeeping must not survive a disconnect
 * (board task 738977d0).
 *
 * The server tells the client a game is over with end_game_session. It cannot
 * deliver that while the socket is down, so a game that FINISHES during an
 * outage leaves its naive-bot session in dumb-bot.ts' module-level map and its
 * route in the client's sessionRoutes, for the life of the process. Nothing
 * else ever collects them, so it is a slow leak: bounded per affected game,
 * cleared only by a restart.
 *
 * Dropping them on disconnect is safe because a reattach rebuilds every game
 * that is still playing - the server calls resyncBgsFromHistory, which sends a
 * fresh start_game_session and replays the history - and if the disconnect
 * grace expires instead, the server resigns those games. Either way what is
 * left behind at disconnect time is exactly what would have leaked.
 *
 * This drives the REAL BotClient against a throwaway WebSocket server in this
 * same process, which is what makes the naive bot's session map observable:
 * both the client and the map live here, so the test can see the leak directly
 * rather than inferring it from a log line.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BotClient } from "../../official-custom-bot-client/src/ws-client";
import {
  hasSession,
  clearAllSessions,
} from "../../official-custom-bot-client/src/dumb-bot";
import type { BotConfig } from "../../shared/contracts/custom-bot-protocol";

const BGS_ID = "bgs-disconnect-leak";
const BOT_ID = "leak-bot";

const BOT: BotConfig = {
  botId: BOT_ID,
  name: "Leak Bot",
  username: null,
  variants: {
    standard: {
      boardWidth: { min: 3, max: 15 },
      boardHeight: { min: 3, max: 15 },
      recommended: [{ boardWidth: 5, boardHeight: 5 }],
    },
  },
};

const START_SESSION = {
  type: "start_game_session" as const,
  bgsId: BGS_ID,
  botId: BOT_ID,
  config: {
    variant: "standard" as const,
    boardWidth: 5,
    boardHeight: 5,
    initialState: {
      pawns: {
        p1: {
          cat: [0, 0] as [number, number],
          home: [4, 4] as [number, number],
        },
        p2: {
          cat: [0, 4] as [number, number],
          home: [4, 0] as [number, number],
        },
      },
      walls: [],
    },
  },
};

let server: ReturnType<typeof Bun.serve> | null = null;
let client: BotClient | null = null;

/**
 * A server that accepts any attach, then opens one game session and hands back
 * a socket-closing handle. Deliberately minimal: the only server behaviour this
 * test needs is "a session exists, and then the connection drops".
 */
function startFakeServer(): { port: number; sessionOpened: Promise<void> } {
  let openSession: () => void;
  const sessionOpened = new Promise<void>((resolve) => {
    openSession = resolve;
  });

  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "attach") {
          ws.send(
            JSON.stringify({
              type: "attached",
              protocolVersion: 3,
              serverTime: Date.now(),
              server: { name: "fake", version: "0" },
              limits: {
                maxMessageBytes: 1_000_000,
                minClientMessageIntervalMs: 0,
              },
            }),
          );
          ws.send(JSON.stringify(START_SESSION));
          return;
        }
        if (msg.type === "game_session_started") openSession();
      },
    },
  });

  return { port: server.port, sessionOpened };
}

beforeEach(() => {
  clearAllSessions();
});

afterEach(async () => {
  client?.close();
  client = null;
  await server?.stop(true);
  server = null;
});

describe("bot client session bookkeeping across a disconnect", () => {
  it("drops the naive bot's session when the socket closes", async () => {
    const { port, sessionOpened } = startFakeServer();

    // No engine command, so the naive bot serves this bot directly and its
    // session is the one that would leak.
    client = new BotClient({
      serverUrl: `http://127.0.0.1:${port}`,
      clientId: "test-disconnect-cleanup",
      bots: [BOT],
      engineCommands: new Map(),
    });

    await client.connect();
    await sessionOpened;

    // Guard the premise. Without this the test could pass simply because the
    // session was never created, which exercises nothing.
    expect(hasSession(BGS_ID)).toBe(true);

    // Drop the connection the way a server restart or network blip would,
    // WITHOUT the end_game_session the server would normally send first.
    await server!.stop(true);

    // The client cleans up in its socket onclose handler, which runs on a
    // later tick than the server-side close.
    await Bun.sleep(200);

    expect(hasSession(BGS_ID)).toBe(false);
  });
});
