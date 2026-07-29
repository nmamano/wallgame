/**
 * Route guards on the solo-campaign completion API (S-CAMP), exercised
 * through the real Hono route.
 *
 * These are the branches that answer BEFORE any database work: an anonymous
 * progress read is refused, and an unknown or malformed level id is rejected
 * whether or not the caller is logged in. That is what makes them runnable on
 * a box with no Docker and no Postgres — the rest of the feature (rows,
 * idempotency, the transitional union read) needs a real database and lives
 * in `tests/integration/campaign-progress.test.ts`.
 *
 * Validating the level id matters because the write is OPEN: without it, an
 * unauthenticated caller could insert arbitrary rows.
 */

import { describe, expect, it, beforeAll } from "bun:test";
import { Hono } from "hono";

// postgres-js connects lazily, so a placeholder URL is enough to import the
// server modules. Nothing here reaches the database.
process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/testdb";
process.env.NODE_ENV = "test";

let app: Hono;

beforeAll(async () => {
  const { campaignRoute } = await import("../../server/routes/campaign");
  app = new Hono().route("/api/campaign", campaignRoute);
});

const post = (body: unknown, authUserId?: string) =>
  app.request("/api/campaign/complete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authUserId ? { "x-test-user-id": authUserId } : {}),
    },
    body: JSON.stringify(body),
  });

describe("campaign progress read", () => {
  it("refuses an anonymous caller instead of answering empty", async () => {
    // 401 rather than {completedLevels: []}, so "no identity" is never
    // confused with "authenticated, nothing completed".
    const response = await app.request("/api/campaign/progress");
    expect(response.status).toBe(401);
  });
});

describe("campaign completion write", () => {
  it("rejects an unknown level from an anonymous caller", async () => {
    const response = await post({ levelId: "not-a-level" });
    expect(response.status).toBe(400);
  });

  it("rejects an unknown level from a logged-in caller too", async () => {
    // The known-set check is authoritative and runs before identity is
    // resolved; being logged in does not buy the right to invent levels.
    const response = await post({ levelId: "not-a-level" }, "auth-test-user");
    expect(response.status).toBe(400);
  });

  it("rejects a body that is not a level report", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ levelId: "" })).status).toBe(400);
    expect((await post({ levelId: "1", admin: true })).status).toBe(400);
  });
});
