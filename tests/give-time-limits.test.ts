/**
 * Limits on a gift of time (board task 264caffe).
 *
 * A gift had only a lower bound. One huge gift put a clock past the 32-bit
 * range of setTimeout, which then fired after about 1 ms; the timer saw time
 * left, rescheduled, and did that again every millisecond for the rest of the
 * game. Started timed games are left to their clock by the abandon and idle
 * policies, so such a game also stayed in memory after both players left.
 *
 * Needs no database: every game here is a guest game, held in memory.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { WebSocket } from "ws";
import {
  MAX_TIME_GIFT_SECONDS,
  giveTimePayloadSchema,
} from "../shared/contracts/controller-actions";
import type { GameCreateResponse } from "../shared/contracts/games";
import type { PartialGameConfiguration } from "../server/games/store";
import type { PlayerId } from "../shared/domain/game-types";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:9/unused";

let store: typeof import("../server/games/store");

beforeAll(async () => {
  store = await import("../server/games/store");
});

describe("the payload of a gift", () => {
  const accepts = (seconds: unknown) =>
    giveTimePayloadSchema.safeParse({ seconds }).success;

  it("takes a normal gift and the largest one", () => {
    expect(accepts(60)).toBe(true);
    expect(accepts(MAX_TIME_GIFT_SECONDS)).toBe(true);
  });

  it("refuses a huge, negative, zero, NaN or infinite gift", () => {
    for (const seconds of [
      MAX_TIME_GIFT_SECONDS + 1,
      1e300,
      -60,
      0,
      NaN,
      Infinity,
      JSON.parse("1e400") as number,
    ]) {
      expect(accepts(seconds)).toBe(false);
    }
  });

  it("refuses a gift that is not a number", () => {
    expect(accepts("60")).toBe(false);
    expect(giveTimePayloadSchema.safeParse(undefined).success).toBe(false);
  });
});

const TIMED: PartialGameConfiguration = {
  boardHeight: 8,
  boardWidth: 8,
  rated: false,
  variant: "standard",
  timeControl: { initialSeconds: 60, incrementSeconds: 0 },
};

/** A timed game in which each seat has played one turn, so the clock runs. */
const runningGame = () => {
  const { session } = store.createGameSession({
    config: TIMED,
    matchType: "friend",
    hostDisplayName: "Host",
    hostIsPlayer1: true,
  });
  store.joinGameSession({ id: session.id, displayName: "Friend" });
  const playTurn = (playerId: PlayerId, col: number) =>
    store.applyPlayerMove({
      id: session.id,
      playerId,
      move: {
        actions: [
          { type: "wall", target: [0, col], wallOrientation: "vertical" },
          { type: "wall", target: [2, col], wallOrientation: "vertical" },
        ],
      },
      timestamp: Date.now(),
    });
  playTurn(1, 0);
  playTurn(2, 1);
  return session.id;
};

describe("a gift in the store", () => {
  it("adds a normal gift to the opponent's clock", () => {
    const id = runningGame();
    const before = store.getSession(id).gameState.timeLeft[2];
    store.giveTime({ id, playerId: 1, seconds: 60 });
    expect(store.getSession(id).gameState.timeLeft[2]).toBe(before + 60);
    store.clearTimeoutTimer(id);
  });

  it("stops a clock at the cap, however many gifts come", () => {
    const id = runningGame();
    for (let i = 0; i < 10; i++) {
      store.giveTime({ id, playerId: 1, seconds: MAX_TIME_GIFT_SECONDS });
    }
    expect(store.getSession(id).gameState.timeLeft[2]).toBe(
      store.MAX_CLOCK_AFTER_GIFT_SECONDS,
    );
    store.clearTimeoutTimer(id);
  });
});

describe("the timeout timer", () => {
  it("waits at most the longest delay setTimeout takes, and does not spin", async () => {
    const id = runningGame();
    // A clock far past the timer range, as increments alone could in theory
    // build: the gift cap is not what keeps the timer safe.
    const state = store.getSession(id).gameState;
    state.timeLeft[state.turn] = 1e9;

    const timers = spyOn(globalThis, "setTimeout");
    const info = spyOn(console, "info");
    try {
      store.scheduleTimeoutTimer(id);
      const delay = timers.mock.calls.at(-1)?.[1];
      expect(delay).toBe(store.MAX_TIMER_DELAY_MS);

      await Bun.sleep(100);
      const firedEarly = info.mock.calls.filter(
        ([line]) => line === "[timeout-timer] timer fired early - rescheduling",
      );
      expect(firedEarly).toEqual([]);
    } finally {
      timers.mockRestore();
      info.mockRestore();
      store.clearTimeoutTimer(id);
    }
  });
});

describe("a gift frame on the game socket", () => {
  let server: ReturnType<typeof Bun.serve>;
  let ws: WebSocket;
  const replies = new Map<string, { type: string; code?: string }>();

  beforeAll(async () => {
    const { createApp } = await import("../server/app");
    const { app, websocket } = createApp();
    server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });

    const response = await fetch(`http://localhost:${server.port}/api/games`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: { ...TIMED, randomStart: false },
        matchType: "friend",
        hostDisplayName: "Guest",
        anonymousId: crypto.randomUUID(),
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as GameCreateResponse;

    ws = new WebSocket(
      `ws://localhost:${server.port}/ws/games/${created.gameId}?token=${created.socketToken}`,
      { headers: { Origin: "http://localhost:5173" } },
    );
    ws.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as {
        type: string;
        requestId?: string;
        code?: string;
      };
      if (message.requestId) replies.set(message.requestId, message);
    });
    await new Promise((resolve) => ws.on("open", resolve));
  });

  afterAll(async () => {
    ws.close();
    await server.stop(true);
  });

  /** Sends one raw gift frame and resolves with the server's answer. */
  const gift = async (requestId: string, payload: string) => {
    ws.send(
      `{"type":"action-request","requestId":"${requestId}","action":"giveTime","payload":${payload}}`,
    );
    for (let i = 0; i < 50 && !replies.has(requestId); i++) {
      await Bun.sleep(20);
    }
    return replies.get(requestId);
  };

  it("refuses an infinite, huge, negative or text gift", async () => {
    const payloads = [
      '{"seconds":1e400}',
      '{"seconds":1e308}',
      `{"seconds":${MAX_TIME_GIFT_SECONDS + 1}}`,
      '{"seconds":-60}',
      '{"seconds":"60"}',
      "null",
    ];
    for (const [i, payload] of payloads.entries()) {
      expect(await gift(`bad${i}`, payload)).toMatchObject({
        type: "actionNack",
        code: "INVALID_SECONDS",
      });
    }
  });

  it("takes a normal gift", async () => {
    expect(await gift("good", '{"seconds":60}')).toMatchObject({
      type: "actionAck",
    });
  });
});
