/**
 * The anonymous id on the wire: what the request schemas accept, and whether
 * the frontend actually attaches it.
 *
 * The second half is the one worth having. The id is attached centrally in
 * frontend/src/lib/api.ts precisely so a new callsite cannot forget it - but
 * "attached centrally" is a claim about code that only a test driving the real
 * request builders can check. So these stub `fetch` and read what would have
 * gone out.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createGameSchema,
  joinGameSchema,
  createBotGameSchema,
} from "../shared/contracts/games";

const VALID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const MALFORMED = [
  "not-a-uuid",
  "",
  "6ba7b810-9dad-11d1-80b4-00c04fd430c8", // v1, not v4
  "6BA7B810-9DAD-41D1-80B4-00C04FD430C8", // uppercase
  "6ba7b810-9dad-41d1-80b4-00c04fd430c",
];

const CONFIG = {
  timeControl: { preset: "blitz", initialSeconds: 300, incrementSeconds: 3 },
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
};

/** The four request shapes that carry a seat, and a minimal valid body for each. */
const SHAPES = [
  {
    name: "create game",
    schema: createGameSchema,
    body: { config: CONFIG, matchType: "friend" },
  },
  { name: "join game", schema: joinGameSchema, body: {} },
  {
    name: "bot game, direct",
    schema: createBotGameSchema,
    body: {
      botId: "client:bot",
      config: { variant: "standard", boardWidth: 8, boardHeight: 8 },
    },
  },
  {
    name: "bot game, saved puzzle",
    schema: createBotGameSchema,
    body: { botId: "client:bot", puzzleId: "S-42" },
  },
];

describe("the request schemas", () => {
  for (const { name, schema, body } of SHAPES) {
    it(`${name}: accepts a valid id`, () => {
      expect(schema.safeParse({ ...body, anonymousId: VALID }).success).toBe(
        true,
      );
    });

    it(`${name}: accepts no id at all`, () => {
      // A browser that cannot store one sends nothing, and that must remain a
      // perfectly ordinary request rather than a validation failure.
      expect(schema.safeParse(body).success).toBe(true);
    });

    it(`${name}: rejects a malformed id`, () => {
      for (const value of MALFORMED) {
        expect(schema.safeParse({ ...body, anonymousId: value }).success).toBe(
          false,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

const captured: CapturedRequest[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  // A storage the id can actually live in, since these run outside a browser.
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
    location: { origin: "http://localhost" },
  };

  globalThis.fetch = (async (
    input: Request | string | URL,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw =
      (input instanceof Request ? await input.clone().text() : undefined) ??
      (typeof init?.body === "string" ? init.body : "{}");
    captured.push({
      url,
      body: JSON.parse(raw || "{}") as CapturedRequest["body"],
    });

    return new Response(JSON.stringify({ role: "spectator", snapshot: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("the frontend attaches the id to every seat-creating request", () => {
  it("does so for create, join, bot game and puzzle launch", async () => {
    const api = await import("../frontend/src/lib/api");

    const attempts: [string, () => Promise<unknown>][] = [
      [
        "createGameSession",
        () =>
          api.createGameSession({
            config: CONFIG as never,
            matchType: "friend",
          }),
      ],
      ["joinGameSession", () => api.joinGameSession({ gameId: "abc12345" })],
      [
        "playVsBot",
        () =>
          api.playVsBot({
            botId: "client:bot",
            config: CONFIG as never,
          }),
      ],
      [
        "playPuzzle",
        () => api.playPuzzle({ botId: "client:bot", puzzleId: "S-42" }),
      ],
    ];

    for (const [, call] of attempts) {
      captured.length = 0;
      // The response shape does not matter; only what went out does.
      await call().catch(() => undefined);

      expect(captured.length).toBeGreaterThan(0);
      // Every one of these creates or claims a seat, so every one must carry
      // the id. A callsite that forgot would show up here as undefined.
      expect(captured[0]?.body.anonymousId).toBe(
        (
          globalThis as unknown as { window: { localStorage: Storage } }
        ).window.localStorage.getItem("wall-game-anonymous-id")!,
      );
    }
  });
});
