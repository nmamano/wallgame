/**
 * Length limits on what a client sends: the arrays in client messages and
 * request bodies, and the size of one websocket frame.
 *
 * An over-long array must be refused after one length check, not after a
 * parse of each element, so the cost of a refusal does not grow with the
 * array. The frame limit is checked on a real server.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { z } from "zod";
import { clientMessageSchema } from "../shared/contracts/websocket-messages";
import {
  BOARD_SIDE_MAX,
  MAX_WALLS_ON_A_BOARD,
  createGameSchema,
} from "../shared/contracts/games";
import { ACTIONS_PER_TURN } from "../shared/domain/game-utils";
import { buildStandardInitialState } from "../shared/domain/standard-setup";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:9/unused";

const catStep = { type: "cat", target: [0, 1] };

describe("the actions of a submitted move", () => {
  it("accepts as many as a turn has", () => {
    const move = Array.from({ length: ACTIONS_PER_TURN }, () => catStep);
    expect(
      clientMessageSchema.safeParse({
        type: "submit-move",
        move: { actions: move },
      }).success,
    ).toBe(true);
  });

  it("refuses one more than a turn has", () => {
    const move = Array.from({ length: ACTIONS_PER_TURN + 1 }, () => catStep);
    expect(
      clientMessageSchema.safeParse({
        type: "submit-move",
        move: { actions: move },
      }).success,
    ).toBe(false);
  });

  it("refuses a very long list with one issue, before it reads any element", () => {
    const result = clientMessageSchema.safeParse({
      type: "submit-move",
      move: { actions: Array.from({ length: 100_000 }, () => 0) },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe("too_big");
  });
});

/** A game to create on the largest board, with the largest time control. */
const gameToCreate = (walls: unknown[]) => ({
  config: {
    timeControl: { initialSeconds: 3_600, incrementSeconds: 60 },
    variant: "standard",
    randomStart: false,
    rated: false,
    boardWidth: BOARD_SIDE_MAX,
    boardHeight: BOARD_SIDE_MAX,
    initialState: {
      ...buildStandardInitialState(BOARD_SIDE_MAX, BOARD_SIDE_MAX),
      walls,
      turn: { playerId: 1, actionsTaken: [] },
    },
  },
  matchType: "friend",
});

/**
 * Every issue of a failed parse, with the issues of each union branch
 * listed too, as their paths start below the union.
 */
const allIssues = (issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] =>
  issues.flatMap((issue) =>
    issue.code === "invalid_union"
      ? [issue, ...issue.errors.flatMap((branch) => allIssues(branch))]
      : [issue],
  );

describe("the walls of a game to create", () => {
  it("accepts a legal custom setup, so the body above is a real one", () => {
    const wall = { cell: [0, 0], orientation: "vertical" };
    expect(createGameSchema.safeParse(gameToCreate([wall])).success).toBe(true);
  });

  it("caps them at every wall slot of the largest board", () => {
    expect(MAX_WALLS_ON_A_BOARD).toBe(760);
  });

  it("refuses more walls than the largest board has slots, before it reads any wall", () => {
    const result = createGameSchema.safeParse(
      gameToCreate(Array.from({ length: 100_000 }, () => 0)),
    );
    expect(result.success).toBe(false);
    // One length issue for each setup shape the union tries, and none for
    // an element: an element issue would have the wall's index in its path.
    const wallIssues = allIssues(result.error?.issues ?? []).filter((issue) =>
      issue.path.includes("walls"),
    );
    expect(wallIssues.length).toBeGreaterThan(0);
    for (const issue of wallIssues) {
      expect(issue.code).toBe("too_big");
      expect(issue.path.at(-1)).toBe("walls");
    }
  });
});

describe("one websocket frame", () => {
  let server: ReturnType<typeof Bun.serve>;
  let maxFrameBytes: number;

  beforeAll(async () => {
    const appModule = await import("../server/app");
    maxFrameBytes = appModule.MAX_WEBSOCKET_FRAME_BYTES;
    const { app, websocket } = appModule.createApp();
    server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  });

  afterAll(async () => {
    await server.stop(true);
  });

  /** Opens the bot socket, sends one frame, and resolves with how it ended. */
  const sendFrame = (bytes: number) =>
    new Promise<{ closed: boolean; code?: number }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws/custom-bot`);
      const timer = setTimeout(() => {
        ws.close();
        resolve({ closed: false });
      }, 1_000);
      ws.onopen = () => ws.send("x".repeat(bytes));
      ws.onclose = (event) => {
        clearTimeout(timer);
        resolve({ closed: true, code: event.code });
      };
      ws.onerror = () => undefined;
      setTimeout(() => reject(new Error("no answer")), 5_000);
    });

  it("is 64 KiB at most", () => {
    expect(maxFrameBytes).toBe(64 * 1024);
  });

  it("closes the socket on a longer frame, with code 1009 (too big)", async () => {
    expect(await sendFrame(maxFrameBytes + 1)).toEqual({
      closed: true,
      code: 1009,
    });
  });

  it("reads a frame of the largest size and keeps the socket open", async () => {
    expect(await sendFrame(maxFrameBytes)).toEqual({ closed: false });
  });
});
