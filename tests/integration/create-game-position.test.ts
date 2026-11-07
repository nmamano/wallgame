/**
 * A game made with POST /api/games always starts from the layout the rules
 * generate. Before 55b7f954 the body could carry a hand-written starting
 * position, even for a rated game listed in the lobby, so a host could offer a
 * rated game that was decided before it started. The contract now has no such
 * field, and Zod strips it like any other unknown key: the request still
 * creates its game, from the rule-generated layout. A written position is
 * played only against a bot (POST /api/bots/play).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";

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
  timeControl: { initialSeconds: 180, incrementSeconds: 2 },
  rated: false,
  variant: "standard",
  randomStart: false,
  boardWidth: 8,
  boardHeight: 8,
};

/** A start that favours the host: P1's cat beside P2's mouse, walls around it. */
const writtenStart = () => {
  const start = buildStandardInitialState(8, 8);
  start.pawns.p1.cat = [6, 7];
  start.walls.push(
    { cell: [7, 6], orientation: "vertical" },
    { cell: [7, 7], orientation: "horizontal" },
  );
  return { ...start, turn: { playerId: 1, actionsTaken: [] } };
};

const createGame = async (body: unknown, userId?: string) => {
  const response = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(userId ? { "x-test-user-id": userId } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      snapshot?: { config: { rated: boolean; variantConfig?: unknown } };
    },
  };
};

describe("a written starting position on POST /api/games", () => {
  const { pawns, walls } = buildStandardInitialState(8, 8);

  it("never reaches a rated lobby game: it starts from the rule-generated layout", async () => {
    const { status, body } = await createGame(
      {
        config: { ...config, rated: true, initialState: writtenStart() },
        matchType: "matchmaking",
        hostIsPlayer1: true,
      },
      "written-start-host",
    );

    expect(status).toBe(201);
    expect(body.snapshot?.config.rated).toBe(true);
    expect(body.snapshot?.config.variantConfig).toMatchObject({ pawns, walls });
  });

  it("never reaches an unrated game either", async () => {
    const { status, body } = await createGame({
      config: { ...config, initialState: writtenStart() },
      matchType: "friend",
    });

    expect(status).toBe(201);
    expect(body.snapshot?.config.variantConfig).toMatchObject({ pawns, walls });
  });
});

describe("the creates the site sends", () => {
  for (const variant of ["standard", "classic", "animal-cycle"]) {
    for (const randomStart of [false, true]) {
      it(`still work: ${variant}${randomStart ? " Random Start" : ""}`, async () => {
        const { status, body } = await createGame({
          config: { ...config, variant, randomStart },
          matchType: "friend",
        });

        expect(status).toBe(201);
        expect(body.snapshot?.config.variantConfig).toBeDefined();
      });
    }
  }
});
