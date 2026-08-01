/**
 * Integration tests for puzzle completion tracking (S-G3), extended in S-FOLD
 * when campaign levels joined this same read.
 *
 * Uses Testcontainers for an ephemeral PostgreSQL, following
 * `past-games.test.ts`. These CANNOT run on the auntie box (no Docker); they
 * run in Nil's environment and CI. That is deliberate: the completion rule is
 * SQL, and asserting it against anything other than a real database would be
 * pretending.
 *
 * The rule under test: a generated puzzle counts as solved only when the user
 * won DECISIVELY. `buildOutcomeRank` gives BOTH players rank 1 when a game
 * has no winner, so "my row is rank 1" silently counts every draw as a solve
 * — production holds real drawn puzzle games. The draw case below is the
 * regression that pins this.
 */

import {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  expect,
} from "bun:test";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
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
let readPuzzleProgress: typeof import("../../server/games/puzzle-progress").readPuzzleProgress;
let hasSolvedGeneratedPuzzle: typeof import("../../server/games/puzzle-progress").hasSolvedGeneratedPuzzle;
let recordScriptedCompletion: typeof import("../../server/games/puzzle-progress").recordScriptedCompletion;
let gamesTable: typeof import("../../server/db/schema/games").gamesTable;
let gamePlayersTable: typeof import("../../server/db/schema/game-players").gamePlayersTable;
let usersTable: typeof import("../../server/db/schema/users").usersTable;
let userAuthTable: typeof import("../../server/db/schema/users").userAuthTable;
let savedPuzzlesTable: typeof import("../../server/db/schema/saved-puzzles").savedPuzzlesTable;
let scriptedPuzzleCompletionsTable: typeof import("../../server/db/schema/scripted-puzzle-completions").scriptedPuzzleCompletionsTable;
let campaignLevelCompletionsTable: typeof import("../../server/db/schema/campaign-level-completions").campaignLevelCompletionsTable;
let campaignProgressTable: typeof import("../../server/db/schema/campaign-progress").campaignProgressTable;
let recordCampaignCompletion: typeof import("../../server/games/campaign-progress").recordCampaignCompletion;
let eq: typeof import("drizzle-orm").eq;

const PUZZLE_A = "test-puzzle-a";
const PUZZLE_B = "test-puzzle-b";

const CONFIG: GameConfiguration = {
  timeControl: { initialSeconds: 120, incrementSeconds: 0, preset: "rapid" },
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
  rated: false,
};

async function importServerModules() {
  const dbModule = await import("../../server/db");
  db = dbModule.db;
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  applyPlayerMove = store.applyPlayerMove;
  resignGame = store.resignGame;
  acceptDraw = store.acceptDraw;
  persistCompletedGame = (await import("../../server/games/persistence"))
    .persistCompletedGame;
  const progress = await import("../../server/games/puzzle-progress");
  readPuzzleProgress = progress.readPuzzleProgress;
  hasSolvedGeneratedPuzzle = progress.hasSolvedGeneratedPuzzle;
  recordScriptedCompletion = progress.recordScriptedCompletion;
  gamesTable = (await import("../../server/db/schema/games")).gamesTable;
  gamePlayersTable = (await import("../../server/db/schema/game-players"))
    .gamePlayersTable;
  const users = await import("../../server/db/schema/users");
  usersTable = users.usersTable;
  userAuthTable = users.userAuthTable;
  savedPuzzlesTable = (await import("../../server/db/schema/saved-puzzles"))
    .savedPuzzlesTable;
  scriptedPuzzleCompletionsTable = (
    await import("../../server/db/schema/scripted-puzzle-completions")
  ).scriptedPuzzleCompletionsTable;
  campaignLevelCompletionsTable = (
    await import("../../server/db/schema/campaign-level-completions")
  ).campaignLevelCompletionsTable;
  campaignProgressTable = (
    await import("../../server/db/schema/campaign-progress")
  ).campaignProgressTable;
  recordCampaignCompletion = (
    await import("../../server/games/campaign-progress")
  ).recordCampaignCompletion;
  eq = (await import("drizzle-orm")).eq;
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

async function seedPuzzleRow(id: string, sortIndex: number) {
  await db
    .insert(savedPuzzlesTable)
    .values({
      id,
      displayName: `Test Puzzle ${sortIndex}`,
      sortIndex,
      config: {},
      source: {},
      sourceFingerprint: `fingerprint-${id}`,
    })
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

/**
 * Builds a finished, persisted game. Both players move first so the game
 * clears `MIN_MOVES_FOR_A_COUNTED_GAME` and is stored at all.
 */
async function createFinishedGame(args: {
  puzzleId?: string;
  hostAuthUserId?: string;
  /** "host" and "joiner" resign the named side; "draw" ends without a winner. */
  ending: "host-resigns" | "joiner-resigns" | "draw";
}): Promise<string> {
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
    // A draw is the path that produces a winner-less result, which is exactly
    // what gives two rank-1 rows. One call finishes the game: the offer/accept
    // handshake lives in the socket layer, and store-level acceptDraw applies
    // the agreed draw outright. Calling it for both seats throws.
    acceptDraw({ id: session.id, playerId: 1 });
  } else {
    resignGame({
      id: session.id,
      playerId: args.ending === "host-resigns" ? 1 : 2,
      timestamp: t + 2000,
    });
  }

  await persistCompletedGame(session);
  return session.id;
}

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;
  await importServerModules();
  await seedPuzzleRow(PUZZLE_A, 1);
  await seedPuzzleRow(PUZZLE_B, 2);
}, 120_000);

beforeEach(async () => {
  await db.delete(gamesTable);
  await db.delete(scriptedPuzzleCompletionsTable);
  // Campaign completion is part of this read since S-FOLD, and it has TWO
  // tables because of the transitional union — both must be cleaned or a
  // legacy row leaks between tests.
  await db.delete(campaignLevelCompletionsTable);
  await db.delete(campaignProgressTable);
});

afterAll(async () => {
  await teardownEphemeralDb(container);
}, 60_000);

describe("generated puzzle completion (server-verified)", () => {
  it("counts a decisive win", async () => {
    const userId = await seedUser("winner");
    await createFinishedGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-winner",
      ending: "joiner-resigns",
    });

    const progress = await readPuzzleProgress(userId);
    expect(progress.solvedGeneratedIds).toEqual([PUZZLE_A]);
  });

  it("does NOT count a draw, though both players hold outcome rank 1", async () => {
    const userId = await seedUser("drawer");
    const gameId = await createFinishedGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-drawer",
      ending: "draw",
    });

    // Guard the premise. Without this, the test could pass because the draw
    // was never persisted, or because it produced a winner after all —
    // neither of which exercises the rule under test.
    const players = await db
      .select()
      .from(gamePlayersTable)
      .where(eq(gamePlayersTable.gameId, gameId));
    expect(players).toHaveLength(2);
    expect(players.map((row) => row.outcomeRank).sort()).toEqual([1, 1]);

    const progress = await readPuzzleProgress(userId);
    expect(progress.solvedGeneratedIds).toEqual([]);
  });

  it("does NOT count a loss", async () => {
    const userId = await seedUser("loser");
    await createFinishedGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-loser",
      ending: "host-resigns",
    });

    const progress = await readPuzzleProgress(userId);
    expect(progress.solvedGeneratedIds).toEqual([]);
  });

  it("does NOT count an ordinary game, which carries no puzzle id", async () => {
    const userId = await seedUser("ordinary");
    await createFinishedGame({
      hostAuthUserId: "auth-ordinary",
      ending: "joiner-resigns",
    });

    const progress = await readPuzzleProgress(userId);
    expect(progress.solvedGeneratedIds).toEqual([]);
  });

  it("reports each solved puzzle once, sorted, and ignores other users' wins", async () => {
    const userId = await seedUser("multi");
    const otherId = await seedUser("other");
    await createFinishedGame({
      puzzleId: PUZZLE_B,
      hostAuthUserId: "auth-multi",
      ending: "joiner-resigns",
    });
    await createFinishedGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-multi",
      ending: "joiner-resigns",
    });
    // Same puzzle beaten twice must not appear twice.
    await createFinishedGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-multi",
      ending: "joiner-resigns",
    });

    expect((await readPuzzleProgress(userId)).solvedGeneratedIds).toEqual([
      PUZZLE_A,
      PUZZLE_B,
    ]);
    expect((await readPuzzleProgress(otherId)).solvedGeneratedIds).toEqual([]);
  });
});

describe("scripted puzzle completion (client-asserted)", () => {
  it("is idempotent for a logged-in user", async () => {
    const userId = await seedUser("scripted");
    await recordScriptedCompletion({ userId, puzzleId: "3" });
    await recordScriptedCompletion({ userId, puzzleId: "3" });

    const rows = await db
      .select()
      .from(scriptedPuzzleCompletionsTable)
      .where(eq(scriptedPuzzleCompletionsTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect((await readPuzzleProgress(userId)).solvedScriptedIds).toEqual(["3"]);
  });

  it("accumulates anonymous completions as separate rows", async () => {
    await recordScriptedCompletion({ userId: null, puzzleId: "3" });
    await recordScriptedCompletion({ userId: null, puzzleId: "3" });

    const rows = await db.select().from(scriptedPuzzleCompletionsTable);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.userId === null)).toBe(true);
  });

  it("keeps one user's completions out of another's progress", async () => {
    const mine = await seedUser("mine");
    const theirs = await seedUser("theirs");
    await recordScriptedCompletion({ userId: mine, puzzleId: "7" });
    await recordScriptedCompletion({ userId: theirs, puzzleId: "2" });

    expect((await readPuzzleProgress(mine)).solvedScriptedIds).toEqual(["7"]);
    expect((await readPuzzleProgress(theirs)).solvedScriptedIds).toEqual(["2"]);
  });
});

/**
 * Campaign levels joined this read in S-FOLD, when the campaign list became
 * the first section of /puzzles. The point of these tests is that the unified
 * read does not quietly lose the TRANSITIONAL UNION: `readCampaignProgress`
 * reads both `campaign_level_completions` and the legacy `campaign_progress`,
 * and `readPuzzleProgress` must surface both, or a player whose rows predate
 * the backfill loses their markers.
 */
describe("campaign levels in the unified progress read", () => {
  it("reports a completion recorded in the current table", async () => {
    const userId = await seedUser("campaign-current");
    await recordCampaignCompletion({ userId, levelId: "1" });

    const progress = await readPuzzleProgress(userId);
    expect(progress.completedCampaignLevelIds).toEqual(["1"]);
    // The three namespaces stay separate: a campaign level must not appear as
    // a scripted puzzle of the same id.
    expect(progress.solvedScriptedIds).toEqual([]);
    expect(progress.solvedGeneratedIds).toEqual([]);
  });

  it("surfaces a level that exists only in the LEGACY table", async () => {
    // The transitional union, asserted through the unified read rather than
    // through readCampaignProgress directly — this is the path the page uses,
    // and it is the one that would silently drop the legacy half.
    const userId = await seedUser("campaign-legacy");
    await db.insert(campaignProgressTable).values({ userId, levelId: "2" });

    expect(
      (await readPuzzleProgress(userId)).completedCampaignLevelIds,
    ).toEqual(["2"]);
  });

  it("unions both tables without duplicating a level in both", async () => {
    const userId = await seedUser("campaign-both");
    await recordCampaignCompletion({ userId, levelId: "1" });
    await db.insert(campaignProgressTable).values({ userId, levelId: "1" });
    await db.insert(campaignProgressTable).values({ userId, levelId: "2" });

    expect(
      (await readPuzzleProgress(userId)).completedCampaignLevelIds,
    ).toEqual(["1", "2"]);
  });

  it("keeps one user's campaign levels out of another's progress", async () => {
    const mine = await seedUser("campaign-mine");
    const theirs = await seedUser("campaign-theirs");
    await recordCampaignCompletion({ userId: mine, levelId: "1" });
    await recordCampaignCompletion({ userId: theirs, levelId: "2" });

    expect((await readPuzzleProgress(mine)).completedCampaignLevelIds).toEqual([
      "1",
    ]);
    expect(
      (await readPuzzleProgress(theirs)).completedCampaignLevelIds,
    ).toEqual(["2"]);
  });

  it("excludes anonymous completions from every user's progress", async () => {
    const userId = await seedUser("campaign-anon");
    await recordCampaignCompletion({ userId: null, levelId: "1" });

    expect(
      (await readPuzzleProgress(userId)).completedCampaignLevelIds,
    ).toEqual([]);
    const rows = await db.select().from(campaignLevelCompletionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
  });
});

/**
 * The single-puzzle question voting is gated on (S-G4). It shares its SQL
 * with the progress read above, so the draw case is repeated here on purpose:
 * the shared query is where the rank-2 requirement lives, and a regression
 * there would open voting to every drawn game.
 */
describe("has this user solved ONE generated puzzle", () => {
  it("is true after a decisive win", async () => {
    const userId = await seedUser("single-winner");
    await createFinishedGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-single-winner",
      ending: "joiner-resigns",
    });

    expect(await hasSolvedGeneratedPuzzle(userId, PUZZLE_A)).toBe(true);
  });

  it("is false after a draw", async () => {
    const userId = await seedUser("single-drawer");
    await createFinishedGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-single-drawer",
      ending: "draw",
    });

    expect(await hasSolvedGeneratedPuzzle(userId, PUZZLE_A)).toBe(false);
  });

  it("does not answer for a puzzle the user beat a different one of", async () => {
    const userId = await seedUser("single-other");
    await createFinishedGame({
      puzzleId: PUZZLE_A,
      hostAuthUserId: "auth-single-other",
      ending: "joiner-resigns",
    });

    expect(await hasSolvedGeneratedPuzzle(userId, PUZZLE_B)).toBe(false);
  });
});
