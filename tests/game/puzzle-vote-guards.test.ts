/**
 * Guards on the puzzle vote API (S-G4) that answer BEFORE any database work,
 * exercised through the real Hono route.
 *
 * Only two branches qualify: an anonymous caller is refused by the auth
 * middleware, and a malformed body is refused by the validator — both run
 * ahead of the handler. Everything else about voting (does the puzzle exist,
 * did this player beat it, what do the counts say) needs Postgres, because
 * saved puzzles and votes only exist there; those assertions live in
 * `tests/integration/puzzle-votes.test.ts`, which needs Docker and cannot run
 * on this box.
 */

import { describe, expect, it, beforeAll } from "bun:test";
import { Hono } from "hono";

// postgres-js connects lazily, so a placeholder URL is enough to import the
// server modules. Nothing here reaches the database.
process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/testdb";
process.env.NODE_ENV = "test";

let app: Hono;

beforeAll(async () => {
  const { puzzlesRoute } = await import("../../server/routes/puzzles");
  app = new Hono().route("/api/puzzles", puzzlesRoute);
});

const vote = (body: unknown, authUserId?: string) =>
  app.request("/api/puzzles/some-puzzle/vote", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authUserId ? { "x-test-user-id": authUserId } : {}),
    },
    body: JSON.stringify(body),
  });

describe("voting requires an identity", () => {
  it("refuses an anonymous write", async () => {
    expect((await vote({ value: 1 })).status).toBe(401);
  });

  it("refuses an anonymous read of a vote", async () => {
    const response = await app.request("/api/puzzles/some-puzzle/vote");
    expect(response.status).toBe(401);
  });
});

describe("vote bodies", () => {
  const AUTH = "auth-test-user";

  it("accepts only like, dislike, or withdrawal", async () => {
    // A value outside {1, -1, null} would break the aggregate, which counts
    // and sums this column — the DB CHECK is the backstop, this is the gate.
    expect((await vote({ value: 2 }, AUTH)).status).toBe(400);
    expect((await vote({ value: 0 }, AUTH)).status).toBe(400);
    expect((await vote({ value: "1" }, AUTH)).status).toBe(400);
  });

  it("rejects a body that is not a vote", async () => {
    expect((await vote({}, AUTH)).status).toBe(400);
    expect((await vote({ value: 1, userId: 7 }, AUTH)).status).toBe(400);
  });
});
