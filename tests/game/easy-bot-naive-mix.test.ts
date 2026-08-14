/**
 * The shadow naive session behind Easy Bot's naiveMoveRate (board task
 * 9c0ac857).
 *
 * Easy Bot plays its engine's move most of the time and the built-in naive
 * move the rest of the time. The naive policy is STATEFUL — board, pawns and
 * ply — so it cannot be consulted for the first time on the move it is asked
 * to play. It shadows the whole game instead: it is fed every apply_move,
 * including the moves it did not choose, and is only asked for a move on the
 * turns the coin flip picks it.
 *
 * That makes state drift the failure that matters. A shadow one ply behind, or
 * missing a wall, answers with a move that is legal on ITS board and illegal on
 * the real one — and the server applies a bot's move without a second look, so
 * the game would end on an exception rather than a bad move. These tests pin
 * the two properties the client relies on:
 *
 *   1. a shadow fed every move stays legal, checked against a REAL GameState
 *      rather than against the naive bot's own opinion of the board;
 *   2. a shadow that misses a move says so (success: false) instead of
 *      answering from a stale position — that is what the client keys its
 *      retire-the-shadow path off.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import type {
  GameConfiguration,
  PlayerId,
} from "../../shared/domain/game-types";
import {
  handleStartGameSession,
  handleApplyMove,
  handleEvaluatePosition,
  clearAllSessions,
} from "../../official-custom-bot-client/src/dumb-bot";

const BOARD = 8;
const BGS_ID = "bgs-naive-mix";

const CONFIG: GameConfiguration = {
  boardWidth: BOARD,
  boardHeight: BOARD,
  rated: false,
  variant: "standard",
  randomStart: false,
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
  variantConfig: buildStandardInitialState(BOARD, BOARD),
};

const startShadow = (state: GameState) =>
  handleStartGameSession({
    type: "start_game_session",
    bgsId: BGS_ID,
    botId: "dw-easy",
    config: {
      variant: "standard",
      boardWidth: BOARD,
      boardHeight: BOARD,
      initialState: state.getInitialState(),
    },
  });

const askShadow = (ply: number) =>
  handleEvaluatePosition({
    type: "evaluate_position",
    bgsId: BGS_ID,
    expectedPly: ply,
  });

const tellShadow = (ply: number, move: string) =>
  handleApplyMove({
    type: "apply_move",
    bgsId: BGS_ID,
    expectedPly: ply,
    move,
  });

/** Apply a move to the real game, or fail the test with the reason it was rejected. */
const play = (state: GameState, move: string, player: PlayerId): GameState =>
  state.applyGameAction({
    kind: "move",
    move: moveFromStandardNotation(move, BOARD),
    playerId: player,
    timestamp: 0,
  });

const isLegal = (state: GameState, move: string, player: PlayerId): boolean => {
  try {
    play(state, move, player);
    return true;
  } catch {
    return false;
  }
};

/**
 * A stand-in for a move the ENGINE would pick and the naive policy never
 * would: a wall. Walls are what the shadow has to absorb without ever having
 * chosen one, and a missed wall is exactly the drift that produces an illegal
 * naive move later. The first legal candidate is taken so the test does not
 * depend on hand-checked coordinates.
 */
const pickWallMove = (state: GameState, player: PlayerId): string | null => {
  for (let row = 0; row < BOARD; row++) {
    for (let col = 0; col < BOARD; col++) {
      for (const symbol of [">", "^"]) {
        const notation = `${symbol}${String.fromCharCode(97 + col)}${BOARD - row}`;
        if (isLegal(state, notation, player)) return notation;
      }
    }
  }
  return null;
};

describe("the naive shadow session tracks a game it is not playing", () => {
  beforeEach(() => {
    clearAllSessions();
  });

  it("proposes a move the REAL game accepts at every ply", () => {
    let state = new GameState(CONFIG, 0);
    expect(startShadow(state).success).toBe(true);

    // Long enough for both sides to have moved several times and for walls to
    // have accumulated on the board, which is when a drifting shadow would
    // start proposing moves through a wall it never saw.
    for (let ply = 0; ply < 12; ply++) {
      const player: PlayerId = state.turn;

      const proposal = askShadow(ply);
      expect(proposal.success).toBe(true);
      expect(proposal.ply).toBe(ply);
      // "---" is a legal pass, so an unusable naive answer would slip past a
      // legality check. The client treats it as "no move" for that reason.
      expect(proposal.bestMove).not.toBe("---");
      expect(isLegal(state, proposal.bestMove, player)).toBe(true);

      // Alternate who actually decides: the naive proposal on even plies, a
      // wall on odd ones. The wall plies are the point — the shadow must end
      // up on a board it did not choose.
      const wall = ply % 2 === 1 ? pickWallMove(state, player) : null;
      const played = wall ?? proposal.bestMove;

      state = play(state, played, player);
      const applied = tellShadow(ply, played);
      expect(applied.success).toBe(true);
      expect(applied.ply).toBe(ply + 1);
    }
  });

  it("refuses to answer from a stale position when a move is missed", () => {
    const state = new GameState(CONFIG, 0);
    expect(startShadow(state).success).toBe(true);

    const first = askShadow(0);
    expect(first.success).toBe(true);

    // The move happens in the real game but never reaches the shadow — the
    // shape of every drift, whether the cause is a dropped message or a
    // takeback the shadow was not told about.
    const next = play(state, first.bestMove, state.turn);
    expect(next.getPawns()).not.toEqual(state.getPawns());

    const stale = askShadow(1);
    expect(stale.success).toBe(false);
    expect(stale.error).toMatch(/[Pp]ly mismatch/);
    expect(stale.bestMove).toBe("");
  });

  it("reports a ply the client can compare against the engine's", () => {
    // The client retires a shadow whose ply diverges from the engine's reply,
    // so move_applied has to carry the post-move ply on the success path.
    const state = new GameState(CONFIG, 0);
    expect(startShadow(state).success).toBe(true);

    const move = askShadow(0).bestMove;
    expect(tellShadow(0, move).ply).toBe(1);
    // A rejected apply must NOT advance the shadow, or a single bad message
    // would silently put it one ply ahead of the engine forever.
    expect(tellShadow(0, move).success).toBe(false);
    expect(tellShadow(1, move).ply).toBe(2);
  });
});
