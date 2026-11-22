/**
 * A puzzle from a stored game: the position at ply N, played to a win against
 * the puzzle bot (task a03b8f5c, the daily videos' puzzle ending).
 *
 * The position is rebuilt from the game's own record (its start position and
 * its moves), so a video puzzle needs no new data and no answer key: the rules
 * decide who wins, and the puzzle bot answers every move.
 *
 * The launch follows the saved-puzzle rule that P1 moves first (S-P1). When
 * the side to move at ply N is P2, the game starts at ply N-1 and the game's
 * real move N-1 is the bot's first move, so the human's first view is the
 * position at ply N with the human to move.
 */

import { GameState } from "./game-state";
import type {
  CustomSetupClassicInitialState,
  CustomSetupStandardInitialState,
  GameConfiguration,
  WallPosition,
} from "./game-types";
import { moveFromStandardNotation } from "./standard-notation";
import type { PuzzleLaunch } from "./puzzle-lead-in";

/** A finished game as the database keeps it. */
export interface StoredGame {
  config: GameConfiguration;
  /** One standard-notation string per ply. */
  moves: readonly string[];
}

/** Why a game position cannot be played as a puzzle. */
export class GamePositionUnavailable extends Error {}

/**
 * Replays the stored history. Stored-history mode: a few old rows hold a
 * backtrack within a move that today's rules refuse, and a reader shows what
 * happened instead of judging it again (as the replay does).
 */
const replayTo = (game: StoredGame, ply: number): GameState => {
  try {
    let state = new GameState(game.config, 0, {
      allowStoredHistoryBacktracks: true,
    });
    for (let index = 0; index < ply; index++) {
      state = state.applyGameAction({
        kind: "move",
        move: moveFromStandardNotation(
          game.moves[index],
          game.config.boardHeight,
        ),
        playerId: state.turn,
        timestamp: index,
      });
    }
    return state;
  } catch (error) {
    throw new GamePositionUnavailable(
      `the stored game does not replay to ply ${ply}: ${String(error)}`,
    );
  }
};

/** Each wall with its owner, and no `playerId` key for a neutral wall. */
const wallsOf = (state: GameState): WallPosition[] =>
  state.grid
    .getWalls()
    .map(({ cell, orientation, playerId }) =>
      playerId === undefined
        ? { cell, orientation }
        : { cell, orientation, playerId },
    );

/** The position of `state` as a start position with P1 to move. */
const startPositionOf = (
  state: GameState,
): CustomSetupStandardInitialState | CustomSetupClassicInitialState => {
  const turn = { playerId: 1 as const, actionsTaken: [] as [] };
  const walls = wallsOf(state);
  if (state.pawns.kind === "standard") {
    const { 1: p1, 2: p2 } = state.pawns.pawns;
    return {
      pawns: {
        p1: { cat: [...p1.cat], mouse: [...p1.mouse] },
        p2: { cat: [...p2.cat], mouse: [...p2.mouse] },
      },
      walls,
      turn,
    };
  }
  if (state.pawns.kind === "classic") {
    const { 1: p1, 2: p2 } = state.pawns.pawns;
    return {
      pawns: {
        p1: { cat: [...p1.cat], home: [...p1.home] },
        p2: { cat: [...p2.cat], home: [...p2.home] },
      },
      walls,
      turn,
    };
  }
  throw new GamePositionUnavailable(
    `a ${state.pawns.kind} position cannot be a puzzle`,
  );
};

/** The board of a state, for an exact comparison. */
const boardKey = (state: GameState): string =>
  JSON.stringify({ pawns: state.pawns, walls: wallsOf(state) });

/**
 * The launch for the position of `game` at `ply` (the plies played before it).
 * Throws GamePositionUnavailable when that position is not a playable puzzle.
 */
export const resolveGamePositionLaunch = (
  game: StoredGame,
  ply: number,
): PuzzleLaunch => {
  const { variant, boardWidth, boardHeight } = game.config;
  if (variant !== "standard" && variant !== "classic") {
    throw new GamePositionUnavailable(`no puzzle bot plays ${variant}`);
  }
  // A move must follow the position: the last ply ends the game.
  if (!Number.isInteger(ply) || ply < 0 || ply >= game.moves.length) {
    throw new GamePositionUnavailable(
      `ply ${ply} is outside 0..${game.moves.length - 1}`,
    );
  }

  const at = replayTo(game, ply);
  if (at.status !== "playing" || at.actionsRemaining !== 2) {
    throw new GamePositionUnavailable(`the game is over at ply ${ply}`);
  }
  const launchFrom = (
    state: GameState,
  ): Omit<PuzzleLaunch, "humanIsPlayer1" | "leadInMove"> => ({
    config: {
      variant,
      boardWidth,
      boardHeight,
      randomStart: false,
      variantConfig: startPositionOf(state),
    },
  });

  if (at.turn === 1) {
    return { ...launchFrom(at), humanIsPlayer1: true, leadInMove: null };
  }

  // P2 to move: the game's real move N-1 is the bot's first move.
  if (ply === 0) {
    throw new GamePositionUnavailable("P2 moves first in this game");
  }
  const before = replayTo(game, ply - 1);
  if (before.turn !== 1) {
    throw new GamePositionUnavailable(`P1 is not to move at ply ${ply - 1}`);
  }
  const leadInMove = moveFromStandardNotation(game.moves[ply - 1], boardHeight);
  const launch: PuzzleLaunch = {
    ...launchFrom(before),
    humanIsPlayer1: false,
    leadInMove,
  };

  // Fail closed: the launch must land exactly on the position at ply N,
  // under today's rules (the game session applies the move the same way).
  let landed: GameState;
  try {
    landed = new GameState(
      { ...game.config, variantConfig: launch.config.variantConfig },
      0,
    ).applyGameAction({
      kind: "move",
      move: leadInMove,
      playerId: 1,
      timestamp: 0,
    });
  } catch (error) {
    throw new GamePositionUnavailable(
      `the move before ply ${ply} is refused: ${String(error)}`,
    );
  }
  if (
    landed.status !== "playing" ||
    landed.turn !== 2 ||
    boardKey(landed) !== boardKey(at)
  ) {
    throw new GamePositionUnavailable(
      `the move before ply ${ply} does not reproduce the position`,
    );
  }
  return launch;
};
