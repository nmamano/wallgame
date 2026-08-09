/**
 * A refused backtrack must leave no trace, and rows that already hold one must
 * still replay.
 *
 * Two halves of board task 59a8c5a2, and they pull in opposite directions on
 * purpose:
 *
 *   FORWARD  - the authoritative move path now refuses a pawn that steps to a
 *              neighbour and back inside one submitted move. Refusing it is not
 *              enough: the point of the fix is that the zero-distance term which
 *              made four stored rows unreplayable can never be WRITTEN again. So
 *              this file drives a real session, attempts the incident move,
 *              finishes the game and reads the persisted row back out of the
 *              database.
 *   BACKWARD - 20 rows written before the rule was tightened hold a backtrack in
 *              the older per-step form and replay today (measured 2026-08-09).
 *              Replay opts into stored-history mode so they keep replaying. A
 *              reader shows what happened; it does not re-adjudicate it.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database. Needs Docker.
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
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { GameState } from "../../shared/domain/game-state";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import { timeControlConfigFromPreset } from "../../shared/domain/game-utils";
import type {
  GameConfiguration,
  Move,
  PlayerId,
} from "../../shared/domain/game-types";
import type { PartialGameConfiguration } from "../../server/games/store";

const NO_RETURN = "A pawn cannot immediately return to its previous cell";

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let db: typeof import("../../server/db").db;
let createApp: typeof import("../../server/app").createApp;
let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let resignGame: typeof import("../../server/games/store").resignGame;
let getSession: typeof import("../../server/games/store").getSession;
let persistCompletedGame: typeof import("../../server/games/persistence").persistCompletedGame;
let gamesTable: typeof import("../../server/db/schema/games").gamesTable;
let gameDetailsTable: typeof import("../../server/db/schema/game-details").gameDetailsTable;
let eq: typeof import("drizzle-orm").eq;

const CONFIG: PartialGameConfiguration = {
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
  timeControl: timeControlConfigFromPreset("unlimited"),
  rated: false,
};

/**
 * The census predicate that found this class, inlined.
 *
 * A term names an ABSOLUTE destination, so detecting a backtrack needs no board
 * rules and no replay: a ply whose LAST term for a pawn names the cell that pawn
 * already stands on is a backtrack. Correct in both notation eras - before the
 * serialiser collapsed same-pawn steps a backtrack read "Cc5.Cc4", after it
 * reads "Cc4", and either way the last term names the occupied cell.
 *
 * Inlined rather than imported because the original lives in a gitignored
 * ops-private/ script (`dupmove-backtrack-scan.mjs`, 2026-08-09) and a committed
 * test must not depend on it.
 */
const findBacktracks = (moves: string[]) => {
  const found: { ply: number; pawn: string; token: string }[] = [];
  const cell: Record<string, string>[] = [{}, {}];

  moves.forEach((token, index) => {
    if (typeof token !== "string" || token === "---") return;
    const seat = index % 2;
    const last: Record<string, string> = {};
    for (const term of token.split(".")) {
      if (term.startsWith("C")) last.cat = term.slice(1);
      else if (term.startsWith("M")) last.mouse = term.slice(1);
    }
    for (const pawn of ["cat", "mouse"]) {
      const destination = last[pawn];
      if (destination === undefined) continue;
      if (cell[seat][pawn] === destination) {
        found.push({ ply: index, pawn, token });
      }
      cell[seat][pawn] = destination;
    }
  });

  return found;
};

/** Open a two-seat friend game and return its id. */
const openGame = (): string => {
  const { session } = createGameSession({
    config: CONFIG,
    matchType: "friend",
    hostDisplayName: "host",
    hostIsPlayer1: true,
  });
  joinGameSession({ id: session.id, displayName: "joiner" });
  return session.id;
};

const move = (id: string, playerId: PlayerId, actions: Move["actions"]) =>
  applyPlayerMove({ id, playerId, move: { actions }, timestamp: Date.now() });

/**
 * Walk both cats one step inwards. Leaves p1's cat on [0,1] with its previous
 * cell [0,0], which is the position the backtrack below returns to.
 */
const playOpening = (id: string) => {
  move(id, 1, [{ type: "cat", target: [0, 1] }]);
  move(id, 2, [{ type: "cat", target: [0, 6] }]);
};

/** p1's cat steps back to [0,0] and returns to [0,1] - the incident shape. */
const BACKTRACK: Move["actions"] = [
  { type: "cat", target: [0, 0] },
  { type: "cat", target: [0, 1] },
];

async function seedStoredGame(gameId: string, moves: string[]): Promise<void> {
  await db.insert(gamesTable).values({
    gameId,
    variant: "standard",
    timeControl: "unlimited",
    rated: false,
    matchType: "friend",
    boardWidth: 8,
    boardHeight: 8,
    startedAt: new Date(),
    // The showcase filters on this column (`moves_count >= 10`), not on the
    // length of the move list, so a short fixture still has to clear the bar.
    movesCount: 12,
  });
  await db.insert(gameDetailsTable).values({
    gameId,
    configParameters: { initialState: buildStandardInitialState(8, 8) },
    moves,
  });
}

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;

  const dbModule = await import("../../server/db");
  const serverModule = await import("../../server/app");
  const storeModule = await import("../../server/games/store");
  const persistenceModule = await import("../../server/games/persistence");
  const gamesSchemaModule = await import("../../server/db/schema/games");
  const detailsSchemaModule =
    await import("../../server/db/schema/game-details");
  const drizzleOrm = await import("drizzle-orm");

  db = dbModule.db;
  createApp = serverModule.createApp;
  createGameSession = storeModule.createGameSession;
  joinGameSession = storeModule.joinGameSession;
  applyPlayerMove = storeModule.applyPlayerMove;
  resignGame = storeModule.resignGame;
  getSession = storeModule.getSession;
  persistCompletedGame = persistenceModule.persistCompletedGame;
  gamesTable = gamesSchemaModule.gamesTable;
  gameDetailsTable = detailsSchemaModule.gameDetailsTable;
  eq = drizzleOrm.eq;

  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}, 120_000);

beforeEach(async () => {
  await db.delete(gamesTable);
});

afterAll(async () => {
  if (server) {
    await server.stop(true);
  }
  await teardownEphemeralDb(container);
}, 60_000);

describe("a backtrack submitted to a live game", () => {
  it("is refused by the authoritative move path", () => {
    const id = openGame();
    playOpening(id);

    expect(() => move(id, 1, BACKTRACK)).toThrow(NO_RETURN);
  });

  it("leaves the authoritative state untouched", () => {
    const id = openGame();
    playOpening(id);

    const before = getSession(id).gameState;
    const historyBefore = before.history.length;
    const notationBefore = before.history.at(-1)?.move;

    expect(() => move(id, 1, BACKTRACK)).toThrow(NO_RETURN);

    const after = getSession(id).gameState;
    expect(after.history).toHaveLength(historyBefore);
    expect(after.moveCount).toBe(historyBefore);
    // The turn did not pass: it is still the player who attempted the move.
    expect(after.turn).toBe(1);
    expect(after.status).toBe("playing");
    // The tail is the same move object, so nothing was appended AND nothing was
    // rewritten in place.
    expect(after.history.at(-1)?.move).toBe(notationBefore);
  });

  it("persists no zero-distance term when the game is later stored", async () => {
    const id = openGame();
    playOpening(id);
    expect(() => move(id, 1, BACKTRACK)).toThrow(NO_RETURN);

    resignGame({ id, playerId: 1, timestamp: Date.now() });
    await persistCompletedGame(getSession(id));

    const [details] = await db
      .select()
      .from(gameDetailsTable)
      .where(eq(gameDetailsTable.gameId, id));
    const [game] = await db
      .select()
      .from(gamesTable)
      .where(eq(gamesTable.gameId, id));

    const moves = details.moves as string[];
    // Two accepted moves, and nothing else. The refusal added no ply.
    expect(moves).toHaveLength(2);
    expect(game.movesCount).toBe(2);

    // The class fingerprint, checked with the predicate that found it: no ply
    // term names the cell its pawn already occupied.
    expect(findBacktracks(moves)).toEqual([]);

    // Stated separately because it is the exact shape of the four stored rows:
    // the last term equalling the same seat's previous term for that pawn.
    const p1CatTerms = moves
      .filter((_, index) => index % 2 === 0)
      .flatMap((ply) => ply.split("."))
      .filter((term) => term.startsWith("C"));
    expect(new Set(p1CatTerms).size).toBe(p1CatTerms.length);

    // The bot forfeit this class caused cannot be recorded either.
    expect(details.botResignCause).toBeNull();
  });

  it("still persists a legal move, so the refusal is not the harness failing", async () => {
    // Positive control. Without it, a harness that silently stored nothing would
    // pass every assertion above.
    const id = openGame();
    playOpening(id);
    move(id, 1, [{ type: "cat", target: [0, 2] }]);

    resignGame({ id, playerId: 2, timestamp: Date.now() });
    await persistCompletedGame(getSession(id));

    const [details] = await db
      .select()
      .from(gameDetailsTable)
      .where(eq(gameDetailsTable.gameId, id));
    expect(details.moves as string[]).toHaveLength(3);
    expect(findBacktracks(details.moves as string[])).toEqual([]);
  });
});

describe("a stored row that already holds a backtrack", () => {
  // The per-step form, exactly as the 20 pre-e83484c rows hold it: the cat is on
  // b8, steps to a8 and back, so the ply's last term names the cell it is on.
  const STORED = ["Cb8", "Cg8", "Ca8.Cb8"];

  it("is refused by the live rules, which is why replay needs its own mode", () => {
    // The control for the test below. Without it, a passing replay would not
    // show that stored-history mode is what saved the row.
    const config: GameConfiguration = {
      variant: "standard",
      timeControl: timeControlConfigFromPreset("unlimited"),
      rated: false,
      boardWidth: 8,
      boardHeight: 8,
      variantConfig: buildStandardInitialState(8, 8),
    };
    let state = new GameState(config, 0);
    expect(() => {
      STORED.forEach((notation, index) => {
        state = state.applyGameAction({
          kind: "move",
          move: moveFromStandardNotation(notation, 8),
          playerId: state.turn,
          timestamp: index + 1,
        });
      });
    }).toThrow(NO_RETURN);
  });

  it("still replays, so the fix strands no stored game", async () => {
    await seedStoredGame("backtrack-01", STORED);

    const response = await fetch(`${baseUrl}/api/games/backtrack-01`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      matchStatus: { id: string };
      state: { history: { notation: string }[] };
    };
    expect(body.matchStatus.id).toBe("backtrack-01");
    // Every stored ply is present, including the backtrack, written as stored.
    expect(body.state.history.map((entry) => entry.notation)).toEqual(STORED);
  });

  it("is still served by the showcase alongside ordinary games", async () => {
    await seedStoredGame("backtrack-02", STORED);
    await seedStoredGame("ordinary-01", ["Cb8", "Cg8", "Cc8"]);

    const response = await fetch(`${baseUrl}/api/games/showcase?count=20`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      games: { matchStatus: { id: string } }[];
    };
    expect(body.games.map((game) => game.matchStatus.id).sort()).toEqual([
      "backtrack-02",
      "ordinary-01",
    ]);
  });
});
