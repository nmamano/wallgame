import { describe, expect, it, beforeAll } from "bun:test";
import {
  buildSavedPuzzleSeedRows,
  type SavedPuzzleSeedRowWithoutId,
} from "../../shared/domain/saved-puzzles";
import { generateCustomSetupCandidates } from "../../shared/domain/generated-custom-setup-candidates";
import verdictFile from "../../shared/domain/generated-custom-setup-verdicts.json";
import type { CandidateVerdictFile } from "../../shared/domain/custom-setup-verdicts";
import {
  buildLeadInLaunch,
  computeLeadIn,
  resolveSavedPuzzleLaunch,
  validateLeadInReplay,
} from "../../shared/domain/puzzle-lead-in";
import { GameState } from "../../shared/domain/game-state";
import { createBotGameSchema } from "../../shared/contracts/games";
import { BOT_GAME_TIME_CONTROL } from "../../shared/domain/game-utils";
import type { Cell, GameConfiguration } from "../../shared/domain/game-types";

/**
 * S-P1 "P1 moves first" axiom: every persisted human-as-P2 puzzle carries a
 * scripted bot lead-in that replays exactly onto the curated position, and
 * the launch resolver fails closed on every invariant violation.
 *
 * The session-level suite at the bottom uses the dummy-DATABASE_URL pattern
 * from aborted-game-session.test.ts: nothing issues a query.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

let createGameSession: typeof import("../../server/games/store").createGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;

beforeAll(async () => {
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  applyPlayerMove = store.applyPlayerMove;
});

const seedRows = buildSavedPuzzleSeedRows(
  generateCustomSetupCandidates(),
  verdictFile as CandidateVerdictFile,
);
const p1Rows = seedRows.filter(
  (row) => row.config.initialState.turn.playerId === 1,
);
const p2Rows = seedRows.filter(
  (row) => row.config.initialState.turn.playerId === 2,
);

describe("lead-in heuristic over the persisted batch", () => {
  // Census of the batch as of the decisively-winning rule (2026-07-29): 36
  // kept, of which 17 are P1. It was 22 P1 / 19 P2 before that rule rejected
  // five P1 candidates and one P2, and a re-evaluated best move admitted one
  // more P2 — so the P2 side happens to be unchanged at 19.
  it("covers every P2 row with a pawn lead-in (census: 17 P1 / 11 cat / 8 mouse)", () => {
    expect(p1Rows.length).toBe(17);
    expect(p2Rows.length).toBe(19);
    expect(p1Rows.every((row) => row.leadIn === null)).toBe(true);
    const pieces = p2Rows.map((row) => row.leadIn?.piece);
    expect(pieces.filter((piece) => piece === "cat").length).toBe(11);
    expect(pieces.filter((piece) => piece === "mouse").length).toBe(8);
  });

  it("every P2 lead-in replays exactly onto the curated position", () => {
    for (const row of p2Rows) {
      expect(row.leadIn).not.toBeNull();
      // Throws with a specific message on any mismatch.
      validateLeadInReplay(row.config, row.leadIn!);
    }
  });

  it("lead-ins are strict 2-step advances/flees (deterministic recompute)", () => {
    for (const row of p2Rows) {
      expect(computeLeadIn(row.config)).toEqual(row.leadIn);
    }
  });
});

describe("resolveSavedPuzzleLaunch (fail-closed launch boundary)", () => {
  const p2Row = p2Rows[0];
  const p1Row = p1Rows[0];

  it("derives the pre-position, P2 seat, and ply-0 move for a P2 puzzle", () => {
    const launch = resolveSavedPuzzleLaunch(p2Row);
    expect(launch.humanIsPlayer1).toBe(false);
    expect(launch.leadInMove).not.toBeNull();
    expect(launch.config.variantConfig.turn).toEqual({
      playerId: 1,
      actionsTaken: [],
    });
    // The move's target is the curated cell of the lead-in piece.
    expect(launch.leadInMove!.actions).toHaveLength(1);
    if (p2Row.config.variant !== "standard") {
      throw new Error("generated puzzles are standard");
    }
    expect(launch.leadInMove!.actions[0].target).toEqual(
      p2Row.config.initialState.pawns.p1[p2Row.leadIn!.piece],
    );
  });

  it("passes a P1 puzzle through unchanged with no lead-in", () => {
    const launch = resolveSavedPuzzleLaunch(p1Row);
    expect(launch.humanIsPlayer1).toBe(true);
    expect(launch.leadInMove).toBeNull();
    expect(launch.config).toEqual({
      variant: p1Row.config.variant,
      boardWidth: p1Row.config.boardWidth,
      boardHeight: p1Row.config.boardHeight,
      randomStart: false,
      variantConfig: p1Row.config.initialState,
    });
  });

  it("refuses a P2 puzzle with no lead-in (migration->population gap)", () => {
    expect(() =>
      resolveSavedPuzzleLaunch({ config: p2Row.config, leadIn: null }),
    ).toThrow(/refusing to launch/);
  });

  it("refuses a P1 puzzle carrying a lead-in", () => {
    expect(() =>
      resolveSavedPuzzleLaunch({ config: p1Row.config, leadIn: p2Row.leadIn }),
    ).toThrow(/refusing to launch/);
  });

  it("refuses a corrupted lead-in that does not land on the curated position", () => {
    const leadIn = p2Row.leadIn!;
    const shiftedFrom: Cell = [leadIn.from[0] === 0 ? 1 : 0, leadIn.from[1]];
    const corrupted = { ...leadIn, from: shiftedFrom };
    expect(() =>
      resolveSavedPuzzleLaunch({ config: p2Row.config, leadIn: corrupted }),
    ).toThrow();
  });
});

describe("createBotGameSchema union (no client-authoritative bypass)", () => {
  const directRequest = {
    botId: "client:bot",
    config: {
      variant: "standard",
      randomStart: false,
      boardWidth: 8,
      boardHeight: 8,
    },
    hostDisplayName: "human",
    hostIsPlayer1: true,
  };
  const puzzleRequest = { botId: "client:bot", puzzleId: "abc123" };

  it("accepts both valid variants", () => {
    expect(createBotGameSchema.safeParse(directRequest).success).toBe(true);
    expect(createBotGameSchema.safeParse(puzzleRequest).success).toBe(true);
  });

  it("rejects puzzleId + config (must not fall back to a direct launch)", () => {
    const mixed = { ...puzzleRequest, config: directRequest.config };
    expect(createBotGameSchema.safeParse(mixed).success).toBe(false);
  });

  it("rejects puzzleId + hostIsPlayer1 (seat is server-derived)", () => {
    const mixed = { ...puzzleRequest, hostIsPlayer1: false };
    expect(createBotGameSchema.safeParse(mixed).success).toBe(false);
  });

  it("rejects unknown keys on either variant", () => {
    expect(
      createBotGameSchema.safeParse({ ...puzzleRequest, extra: 1 }).success,
    ).toBe(false);
    expect(
      createBotGameSchema.safeParse({ ...directRequest, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("session-level lead-in launch (service path, no DB)", () => {
  const launchSession = (row: SavedPuzzleSeedRowWithoutId) => {
    const resolved = resolveSavedPuzzleLaunch(row);
    const { session } = createGameSession({
      config: {
        ...resolved.config,
        timeControl: BOT_GAME_TIME_CONTROL,
        rated: false,
      },
      matchType: "friend",
      hostDisplayName: "human",
      hostIsPlayer1: resolved.humanIsPlayer1,
      joinerConfig: { type: "bot", displayName: "PuzzleBot" },
    });
    session.players.joiner.ready = true;
    session.status = "ready";
    if (resolved.leadInMove) {
      applyPlayerMove({
        id: session.id,
        playerId: session.players.joiner.playerId,
        move: resolved.leadInMove,
        timestamp: Date.now(),
      });
    }
    return session;
  };

  it("a P2 puzzle opens with real ply-0 history and the human to move on the curated board", () => {
    const row = p2Rows[0];
    const session = launchSession(row);
    expect(session.players.host.playerId).toBe(2);
    expect(session.players.joiner.playerId).toBe(1);
    const state = session.gameState;
    expect(state.status).toBe("playing");
    expect(state.history).toHaveLength(1);
    expect(state.turn).toBe(2);
    expect(state.actionsRemaining).toBe(2);
    // Board equals a fresh state built from the CURATED config.
    const curated = new GameState(
      {
        ...row.config,
        randomStart: false,
        rated: false,
        timeControl: BOT_GAME_TIME_CONTROL,
        variantConfig: row.config.initialState,
      } as GameConfiguration,
      0,
    );
    expect(state.pawns).toEqual(curated.pawns);
    expect(state.grid.getWalls()).toEqual(curated.grid.getWalls());
    // The initial (replayable) config is the PRE-position, one lead-in
    // move behind the curated board.
    const { preConfig } = buildLeadInLaunch(row.config, row.leadIn!);
    expect(session.config.variantConfig).toEqual(preConfig.initialState);
  });

  it("a P1 puzzle opens with empty history and the human (P1) to move", () => {
    const row = p1Rows[0];
    const session = launchSession(row);
    expect(session.players.host.playerId).toBe(1);
    const state = session.gameState;
    expect(state.status).toBe("playing");
    expect(state.history).toHaveLength(0);
    expect(state.turn).toBe(1);
  });
});
