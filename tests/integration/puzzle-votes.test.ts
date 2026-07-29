/**
 * Integration tests for puzzle likes and dislikes (S-G4), driven through the
 * real Hono route so authentication, the earned check, and the public
 * listing are exercised as shipped.
 *
 * Uses Testcontainers for an ephemeral PostgreSQL, following
 * `puzzle-progress.test.ts`. These CANNOT run on the auntie box (no Docker);
 * they run in Nil's environment and CI. Saved puzzles and votes exist only in
 * Postgres, so almost everything here needs a real database — the only
 * assertions that do not are in `tests/game/puzzle-vote-guards.test.ts`.
 *
 * The property that carries the feature: a vote is EARNED. Only a DECISIVE
 * win qualifies, which is why the draw case below matters as much as the win
 * — `buildOutcomeRank` gives BOTH players rank 1 when a game has no winner,
 * so a rank-1 test would let every draw vote.
 */

import {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  expect,
} from "bun:test";
import { Hono } from "hono";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import { generateCustomSetupCandidates } from "../../shared/domain/generated-custom-setup-candidates";
import { buildSavedPuzzleSeedRows } from "../../shared/domain/saved-puzzles";
import type { CandidateVerdictFile } from "../../shared/domain/custom-setup-verdicts";
import committedVerdicts from "../../shared/domain/generated-custom-setup-verdicts.json";
import type {
  GameConfiguration,
  PlayerId,
} from "../../shared/domain/game-types";

let container: StartedTestContainer | undefined;

let db: typeof import("../../server/db").db;
let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let resignGame: typeof import("../../server/games/store").resignGame;
let acceptDraw: typeof import("../../server/games/store").acceptDraw;
let persistCompletedGame: typeof import("../../server/games/persistence").persistCompletedGame;
let gamesTable: typeof import("../../server/db/schema/games").gamesTable;
let usersTable: typeof import("../../server/db/schema/users").usersTable;
let userAuthTable: typeof import("../../server/db/schema/users").userAuthTable;
let savedPuzzlesTable: typeof import("../../server/db/schema/saved-puzzles").savedPuzzlesTable;
let puzzleVotesTable: typeof import("../../server/db/schema/puzzle-votes").puzzleVotesTable;
let eq: typeof import("drizzle-orm").eq;
let app: Hono;

const PUZZLE_A = "test-puzzle-a";
const PUZZLE_B = "test-puzzle-b";
const RETIRED = "test-puzzle-retired";

const CONFIG: GameConfiguration = {
  timeControl: { initialSeconds: 120, incrementSeconds: 0, preset: "rapid" },
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
  rated: false,
};

async function importServerModules() {
  db = (await import("../../server/db")).db;
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  applyPlayerMove = store.applyPlayerMove;
  resignGame = store.resignGame;
  acceptDraw = store.acceptDraw;
  persistCompletedGame = (await import("../../server/games/persistence"))
    .persistCompletedGame;
  gamesTable = (await import("../../server/db/schema/games")).gamesTable;
  const users = await import("../../server/db/schema/users");
  usersTable = users.usersTable;
  userAuthTable = users.userAuthTable;
  savedPuzzlesTable = (await import("../../server/db/schema/saved-puzzles"))
    .savedPuzzlesTable;
  puzzleVotesTable = (await import("../../server/db/schema/puzzle-votes"))
    .puzzleVotesTable;
  eq = (await import("drizzle-orm")).eq;
  const { puzzlesRoute } = await import("../../server/routes/puzzles");
  app = new Hono().route("/api/puzzles", puzzlesRoute);
}

async function seedUser(displayName: string): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      displayName,
      capitalizedDisplayName: displayName.toUpperCase(),
      authProvider: "test",
    })
    .returning({ userId: usersTable.userId });
  await db.insert(userAuthTable).values({
    userId: user.userId,
    authProvider: "test",
    authUserId: `auth-${displayName}`,
  });
  return user.userId;
}

/**
 * Rows must be FULLY schema-valid: the listing route parses every row through
 * `savedPuzzleDbRowSchema` and fails the whole request closed on the first
 * corrupted one, so a stub row would make the listing tests assert against a
 * 500 rather than the behaviour under test. These come from the same
 * candidates + committed verdicts the seeder uses, which keeps the config,
 * provenance, fingerprint and lead-in invariants intact by construction;
 * `index`
 * picks a distinct row, since sortIndex and sourceFingerprint are UNIQUE.
 */
const seedRows = buildSavedPuzzleSeedRows(
  generateCustomSetupCandidates(),
  committedVerdicts as CandidateVerdictFile,
);

async function seedPuzzleRow(id: string, index: number, enabled = true) {
  await db
    .insert(savedPuzzlesTable)
    .values({ ...seedRows[index], id, enabled })
    .onConflictDoNothing();
}

const openingMove = (playerId: PlayerId) =>
  playerId === 1
    ? {
        actions: [
          { type: "cat" as const, target: [0, 1] as [number, number] },
          { type: "mouse" as const, target: [6, 0] as [number, number] },
        ],
      }
    : {
        actions: [
          { type: "cat" as const, target: [0, 6] as [number, number] },
          { type: "mouse" as const, target: [6, 7] as [number, number] },
        ],
      };

/** A finished, persisted puzzle game. Both players move so it is counted. */
async function playPuzzleGame(args: {
  puzzleId: string;
  hostAuthUserId: string;
  ending: "host-resigns" | "joiner-resigns" | "draw";
}) {
  const { session } = createGameSession({
    config: CONFIG,
    matchType: "friend",
    hostDisplayName: "host",
    hostIsPlayer1: true,
    hostAuthUserId: args.hostAuthUserId,
    puzzleId: args.puzzleId,
  });
  joinGameSession({ id: session.id, displayName: "joiner" });

  const t = Date.now();
  applyPlayerMove({
    id: session.id,
    playerId: 1,
    move: openingMove(1),
    timestamp: t,
  });
  applyPlayerMove({
    id: session.id,
    playerId: 2,
    move: openingMove(2),
    timestamp: t + 1000,
  });

  if (args.ending === "draw") {
    acceptDraw({ id: session.id, playerId: 1 });
    acceptDraw({ id: session.id, playerId: 2 });
  } else {
    resignGame({
      id: session.id,
      playerId: args.ending === "host-resigns" ? 1 : 2,
      timestamp: t + 2000,
    });
  }

  await persistCompletedGame(session);
}

const castVote = (
  puzzleId: string,
  value: 1 | -1 | null,
  authUserId?: string,
) =>
  app.request(`/api/puzzles/${puzzleId}/vote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authUserId ? { "x-test-user-id": authUserId } : {}),
    },
    body: JSON.stringify({ value }),
  });

const readVote = (puzzleId: string, authUserId?: string) =>
  app.request(`/api/puzzles/${puzzleId}/vote`, {
    headers: authUserId ? { "x-test-user-id": authUserId } : {},
  });

const listPuzzles = (authUserId?: string) =>
  app.request("/api/puzzles", {
    headers: authUserId ? { "x-test-user-id": authUserId } : {},
  });

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;
  await importServerModules();
}, 120_000);

beforeEach(async () => {
  await db.delete(puzzleVotesTable);
  await db.delete(gamesTable);
  await db.delete(savedPuzzlesTable);
  await db.delete(userAuthTable);
  await db.delete(usersTable);
  // Indices 0/1/2 carry sortIndex 1/2/3, which the listing order asserts on.
  await seedPuzzleRow(PUZZLE_A, 0);
  await seedPuzzleRow(PUZZLE_B, 1);
  await seedPuzzleRow(RETIRED, 2, false);
});

afterAll(async () => {
  await teardownEphemeralDb(container);
}, 60_000);

describe("earning a vote", () => {
  it("refuses a puzzle the caller has not beaten, and writes nothing", async () => {
    await seedUser("stranger");

    const response = await castVote(PUZZLE_A, 1, "auth-stranger");
    expect(response.status).toBe(403);
    expect(await db.select().from(puzzleVotesTable)).toHaveLength(0);
  });

  it("refuses after a DRAW, though both players hold outcome rank 1", async () => {
    await seedUser("drawer");
    await playPuzzleGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-drawer",
      ending: "draw",
    });

    expect((await castVote(PUZZLE_A, 1, "auth-drawer")).status).toBe(403);
    expect(await db.select().from(puzzleVotesTable)).toHaveLength(0);
  });

  it("refuses after a LOSS", async () => {
    await seedUser("loser");
    await playPuzzleGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-loser",
      ending: "host-resigns",
    });

    expect((await castVote(PUZZLE_A, 1, "auth-loser")).status).toBe(403);
  });

  it("refuses a vote on a DIFFERENT puzzle than the one beaten", async () => {
    await seedUser("winner");
    await playPuzzleGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-winner",
      ending: "joiner-resigns",
    });

    expect((await castVote(PUZZLE_B, 1, "auth-winner")).status).toBe(403);
  });

  it("accepts a decisive win", async () => {
    const userId = await seedUser("winner");
    await playPuzzleGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-winner",
      ending: "joiner-resigns",
    });

    const response = await castVote(PUZZLE_A, 1, "auth-winner");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      likes: 1,
      dislikes: 0,
      myVote: 1,
    });

    const rows = await db
      .select()
      .from(puzzleVotesTable)
      .where(eq(puzzleVotesTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(1);
  });
});

describe("the vote target", () => {
  it("is 404 for a puzzle that does not exist", async () => {
    await seedUser("winner");
    expect((await castVote("no-such-puzzle", 1, "auth-winner")).status).toBe(
      404,
    );
  });

  it("is 404 for a retired puzzle, matching launch semantics", async () => {
    await seedUser("winner");
    await playPuzzleGame({
      puzzleId: RETIRED,
      hostAuthUserId: "auth-winner",
      ending: "joiner-resigns",
    });

    expect((await castVote(RETIRED, 1, "auth-winner")).status).toBe(404);
    expect((await readVote(RETIRED, "auth-winner")).status).toBe(404);
  });
});

describe("changing a vote", () => {
  const setUp = async () => {
    const userId = await seedUser("winner");
    await playPuzzleGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-winner",
      ending: "joiner-resigns",
    });
    return userId;
  };

  it("flips without adding a second row", async () => {
    await setUp();
    await castVote(PUZZLE_A, 1, "auth-winner");

    const response = await castVote(PUZZLE_A, -1, "auth-winner");
    expect(await response.json()).toEqual({
      likes: 0,
      dislikes: 1,
      myVote: -1,
    });
    expect(await db.select().from(puzzleVotesTable)).toHaveLength(1);
  });

  it("is idempotent when the same vote is sent twice", async () => {
    await setUp();
    await castVote(PUZZLE_A, 1, "auth-winner");
    const response = await castVote(PUZZLE_A, 1, "auth-winner");

    expect(await response.json()).toEqual({
      likes: 1,
      dislikes: 0,
      myVote: 1,
    });
    expect(await db.select().from(puzzleVotesTable)).toHaveLength(1);
  });

  it("withdraws entirely on null", async () => {
    await setUp();
    await castVote(PUZZLE_A, -1, "auth-winner");

    const response = await castVote(PUZZLE_A, null, "auth-winner");
    expect(await response.json()).toEqual({
      likes: 0,
      dislikes: 0,
      myVote: null,
    });
    expect(await db.select().from(puzzleVotesTable)).toHaveLength(0);
  });

  it("survives a re-read, which is how the game page recovers it", async () => {
    await setUp();
    await castVote(PUZZLE_A, 1, "auth-winner");

    const response = await readVote(PUZZLE_A, "auth-winner");
    expect(await response.json()).toEqual({
      likes: 1,
      dislikes: 0,
      myVote: 1,
    });
  });
});

describe("aggregates across users", () => {
  const seedVoter = async (name: string, puzzleId: string) => {
    await seedUser(name);
    await playPuzzleGame({
      puzzleId,
      hostAuthUserId: `auth-${name}`,
      ending: "joiner-resigns",
    });
  };

  it("counts both players and reports each their own vote", async () => {
    await seedVoter("ana", PUZZLE_A);
    await seedVoter("bo", PUZZLE_A);
    await castVote(PUZZLE_A, 1, "auth-ana");
    await castVote(PUZZLE_A, -1, "auth-bo");

    expect(await (await readVote(PUZZLE_A, "auth-ana")).json()).toEqual({
      likes: 1,
      dislikes: 1,
      myVote: 1,
    });
    // Same counts, the other person's own vote — one caller's choice must
    // never be reported as another's.
    expect(await (await readVote(PUZZLE_A, "auth-bo")).json()).toEqual({
      likes: 1,
      dislikes: 1,
      myVote: -1,
    });
  });

  it("keeps the listing public, with counts and no personal vote", async () => {
    await seedVoter("ana", PUZZLE_A);
    await castVote(PUZZLE_A, 1, "auth-ana");

    const response = await listPuzzles();
    expect(response.status).toBe(200);
    const { puzzles } = (await response.json()) as {
      puzzles: {
        id: string;
        likes: number;
        dislikes: number;
        myVote: number | null;
        sortIndex: number;
      }[];
    };

    // The retired puzzle stays out of the listing, as before.
    expect(puzzles.map((p) => p.id)).toEqual([PUZZLE_A, PUZZLE_B]);
    expect(puzzles[0]).toMatchObject({ likes: 1, dislikes: 0, myVote: null });
    // A puzzle nobody voted on still answers with zeroes.
    expect(puzzles[1]).toMatchObject({ likes: 0, dislikes: 0, myVote: null });
    // sortIndex ships so the client can break "most liked" ties by number.
    expect(puzzles.map((p) => p.sortIndex)).toEqual([1, 2]);
  });

  it("adds the caller's own vote to the listing when logged in", async () => {
    await seedVoter("ana", PUZZLE_A);
    await seedVoter("bo", PUZZLE_A);
    await castVote(PUZZLE_A, 1, "auth-ana");
    await castVote(PUZZLE_A, -1, "auth-bo");

    const { puzzles } = (await (await listPuzzles("auth-bo")).json()) as {
      puzzles: {
        id: string;
        likes: number;
        dislikes: number;
        myVote: number | null;
      }[];
    };
    expect(puzzles[0]).toMatchObject({ likes: 1, dislikes: 1, myVote: -1 });
  });
});
