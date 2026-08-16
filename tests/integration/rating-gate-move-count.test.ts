/**
 * A rating must never move for a game that leaves no record behind it.
 *
 * Nil ruled on 2026-08-16 (board 733c18e6) that a game ending below the
 * threshold vanishes: an abandoned lobby SHOULD leave no row. That is only safe
 * while nothing else records the game either - a rating change with no row to
 * explain it is the one outcome nobody can audit.
 *
 * Two gates enforce it and they had drifted apart. `persistCompletedGame` skips
 * on the move count AND on an uncounted result; `processRatingUpdate` asked
 * only the second. Those agree for resign, timeout and draw, which share one
 * `isAbort` in game-state.ts, and NOT for the win conditions inside
 * `applyMove`, which return a counted result at any move count. So a game could
 * end on ply 1 with {reason: "survival"}, be dropped by persistence, and be
 * rated here. Measured 2026-08-16 with the real domain code.
 *
 * These tests drive `processRatingUpdate` directly with a hand-built session,
 * which is the only way to gate the rating consumer - the domain-level rules
 * are already pinned in tests/game/abort-threshold.test.ts, and pinning them
 * again could not notice a consumer that fails to read them. Deliberately NOT
 * an end-to-end rated ply-1 game: whether today's product flow can reach one is
 * a separate question, and the gate must hold either way.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { PartialGameConfiguration } from "../../server/games/store";
import type { PlayerId, Move } from "../../shared/domain/game-types";
import { buildSurvivalInitialState } from "../../shared/domain/survival-setup";

let container: StartedTestContainer | undefined;

let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let getSession: typeof import("../../server/games/store").getSession;
let processRatingUpdate: typeof import("../../server/games/store").processRatingUpdate;
let ensureUserExists: typeof import("../../server/db/user-helpers").ensureUserExists;

const PLAYER_A = "rating-gate-account-a";
const PLAYER_B = "rating-gate-account-b";

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;

  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  applyPlayerMove = store.applyPlayerMove;
  getSession = store.getSession;
  processRatingUpdate = store.processRatingUpdate;
  ensureUserExists = (await import("../../server/db/user-helpers"))
    .ensureUserExists;

  // Both accounts must resolve, or applyRatingsForFinishedGame bails as "not a
  // ratable pairing" and every case below would pass for the wrong reason.
  for (const id of [PLAYER_A, PLAYER_B]) {
    await ensureUserExists({
      id,
      given_name: "Rating",
      family_name: "Gate",
      email: `${id}@example.com`,
      picture: null,
    });
  }
}, 120_000);

afterAll(async () => {
  await teardownEphemeralDb(container);
}, 60_000);

/** A rated session with BOTH seats authenticated - the only shape that rates. */
const ratedSession = (config: PartialGameConfiguration) => {
  const { session } = createGameSession({
    config,
    matchType: "matchmaking",
    hostDisplayName: "Host",
    hostIsPlayer1: true,
    hostAuthUserId: PLAYER_A,
  });
  joinGameSession({
    id: session.id,
    displayName: "Joiner",
    authUserId: PLAYER_B,
  });
  return session;
};

const turn = (id: string, playerId: PlayerId, actions: Move["actions"]) =>
  applyPlayerMove({ id, playerId, move: { actions }, timestamp: Date.now() });

const RATED_SURVIVAL: PartialGameConfiguration = {
  boardHeight: 3,
  boardWidth: 3,
  rated: true,
  variant: "survival",
  timeControl: { initialSeconds: 180, incrementSeconds: 0, preset: "blitz" },
  variantConfig: buildSurvivalInitialState({
    boardWidth: 3,
    boardHeight: 3,
    // The whole game is one ply, which is what puts a COUNTED result below the
    // threshold.
    turnsToSurvive: 1,
    mouseCanMove: false,
  }),
};

const RATED_STANDARD: PartialGameConfiguration = {
  boardHeight: 3,
  boardWidth: 3,
  rated: true,
  variant: "standard",
  timeControl: { initialSeconds: 180, incrementSeconds: 0, preset: "blitz" },
};

describe("the rating gate and the move-count threshold", () => {
  it("does not rate a counted win that ended on ply 1", async () => {
    const session = ratedSession(RATED_SURVIVAL);
    turn(session.id, 1, [{ type: "cat", target: [1, 0] }]);

    const state = getSession(session.id).gameState;
    // The state that makes this worth testing: finished, ONE move, and a result
    // that is NOT an abort. Asserted rather than assumed, because if a future
    // change made this game abort instead, the test below would pass while
    // exercising nothing.
    expect(state.status).toBe("finished");
    expect(state.moveCount).toBe(1);
    expect(state.result).toEqual({ winner: 2, reason: "survival" });

    expect(await processRatingUpdate(session.id)).toBeUndefined();
  });

  it("still rates a game that ran past the threshold", async () => {
    // The control. Without it the fix is satisfied by a gate that refuses
    // everything, which would quietly stop ratings working at all.
    const session = ratedSession(RATED_STANDARD);
    turn(session.id, 1, [
      { type: "mouse", target: [1, 0] },
      { type: "mouse", target: [1, 1] },
    ]);
    turn(session.id, 2, [
      { type: "wall", target: [2, 0], wallOrientation: "horizontal" },
      { type: "wall", target: [2, 1], wallOrientation: "horizontal" },
    ]);
    // Player 1 walks their own mouse onto player 2's cat and loses on ply 3.
    turn(session.id, 1, [
      { type: "mouse", target: [0, 1] },
      { type: "mouse", target: [0, 2] },
    ]);

    const state = getSession(session.id).gameState;
    expect(state.status).toBe("finished");
    expect(state.moveCount).toBe(3);
    expect(state.result).toEqual({ winner: 2, reason: "capture" });

    const applied = await processRatingUpdate(session.id);
    expect(applied).toBeDefined();
    // BOTH ratings must have MOVED off the 1500 start. The inequality below is
    // kept but is not enough on its own: two unchanged-or-fabricated values
    // that merely differ would satisfy it, so it cannot support the claim that
    // a real write path ran for each player. Deliberately not pinning the
    // resulting numbers - this test owns the GATE, not the rating formula.
    expect(applied?.player1NewElo).not.toBe(1500);
    expect(applied?.player2NewElo).not.toBe(1500);
    expect(applied?.player1NewElo).not.toBe(applied?.player2NewElo);
  });
});
