/**
 * A position from a stored game, launched as a puzzle (task a03b8f5c): the
 * launch must reproduce the game's position at ply N exactly, with the human
 * to move, and refuse every position that is not a playable puzzle.
 */

import { describe, expect, it } from "bun:test";
import {
  GamePositionUnavailable,
  recordSeatLooks,
  resolveGamePositionLaunch,
  videoSeatColors,
  type StoredGame,
} from "../../shared/domain/game-position-puzzle";
import { GameState } from "../../shared/domain/game-state";
import type { GameConfiguration } from "../../shared/domain/game-types";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import { STORED_GAME, STORED_MOVES } from "../fixtures/stored-standard-game";

/** The game's own replay to `ply`, as the past-games page shows it. */
const replayTo = (game: StoredGame, ply: number): GameState => {
  let state = new GameState(game.config, 0, {
    allowStoredHistoryBacktracks: true,
  });
  for (let index = 0; index < ply; index++) {
    state = state.applyGameAction({
      kind: "move",
      move: moveFromStandardNotation(game.moves[index], 8),
      playerId: state.turn,
      timestamp: index,
    });
  }
  return state;
};

const board = (state: GameState) => ({
  pawns: state.pawns,
  walls: state.grid.getWalls(),
});

/** The state a launched game opens on: its config plus the lead-in. */
const opened = (ply: number): GameState => {
  const launch = resolveGamePositionLaunch(STORED_GAME, ply);
  const config: GameConfiguration = {
    ...STORED_GAME.config,
    ...launch.config,
  };
  const state = new GameState(config, 0);
  return launch.leadInMove
    ? state.applyGameAction({
        kind: "move",
        move: launch.leadInMove,
        playerId: 1,
        timestamp: 0,
      })
    : state;
};

describe("resolveGamePositionLaunch", () => {
  it("P1 to move: the game starts on the position, the human is P1", () => {
    const launch = resolveGamePositionLaunch(STORED_GAME, 10);
    expect(launch.humanIsPlayer1).toBe(true);
    expect(launch.leadInMove).toBeNull();
    expect(launch.config.variantConfig.turn).toEqual({
      playerId: 1,
      actionsTaken: [],
    });
    expect(board(opened(10))).toEqual(board(replayTo(STORED_GAME, 10)));
  });

  it("P2 to move: the game's real move N-1 is the bot's first move", () => {
    const launch = resolveGamePositionLaunch(STORED_GAME, 11);
    expect(launch.humanIsPlayer1).toBe(false);
    expect(launch.leadInMove).toEqual(
      moveFromStandardNotation(STORED_MOVES[10], 8),
    );
    const state = opened(11);
    expect(state.turn).toBe(2);
    expect(state.history).toHaveLength(1);
    expect(board(state)).toEqual(board(replayTo(STORED_GAME, 11)));
  });

  it("walls keep the colour of the player who placed them", () => {
    const { walls } = resolveGamePositionLaunch(STORED_GAME, 20).config
      .variantConfig;
    const owners = new Set(walls.map((wall) => wall.playerId));
    // The six start walls are neutral; the game added walls of both players.
    expect(owners).toEqual(new Set([undefined, 1, 2]));
    expect(walls.filter((wall) => wall.playerId === undefined)).toHaveLength(6);
    for (const wall of walls) {
      expect("playerId" in wall).toBe(wall.playerId !== undefined);
    }
  });

  it("the position before the last ply is still a puzzle", () => {
    const state = opened(27);
    expect(state.status).toBe("playing");
    expect(state.turn).toBe(2);
  });

  for (const ply of [-1, 1.5, 28, 29]) {
    it(`refuses ply ${ply} (no move follows it in the game)`, () => {
      expect(() => resolveGamePositionLaunch(STORED_GAME, ply)).toThrow(
        GamePositionUnavailable,
      );
    });
  }

  it("refuses a variant no puzzle bot plays", () => {
    const game: StoredGame = {
      config: { ...STORED_GAME.config, variant: "animal-cycle" },
      moves: STORED_MOVES,
    };
    expect(() => resolveGamePositionLaunch(game, 4)).toThrow(
      GamePositionUnavailable,
    );
  });

  it("refuses a stored game that does not replay", () => {
    const game: StoredGame = {
      config: STORED_GAME.config,
      moves: ["Ca1", ...STORED_MOVES.slice(1)],
    };
    expect(() => resolveGamePositionLaunch(game, 6)).toThrow(
      GamePositionUnavailable,
    );
  });
});

describe("videoSeatColors", () => {
  it("is the daily video's seat colour rule (a puzzle looks like its video)", async () => {
    const { dailySeatColors } =
      (await import("../../scripts/game-video/edl.mjs")) as {
        dailySeatColors: (
          isBot: Record<1 | 2, boolean>,
        ) => Record<1 | 2, "red" | "blue">;
      };
    for (const isBot of [
      { 1: false, 2: false },
      { 1: false, 2: true },
      { 1: true, 2: false },
    ]) {
      expect(videoSeatColors(isBot)).toEqual(dailySeatColors(isBot));
    }
  });

  it("gives each seat the record's pawns in those colours", () => {
    const looks = recordSeatLooks({
      1: { isBot: false, appearance: { pawnColor: "green", catSkin: "a" } },
      2: { isBot: true, appearance: { pawnColor: "pink", catSkin: "b" } },
    });
    expect(looks).toEqual({
      1: { pawnColor: "blue", catSkin: "a" },
      2: { pawnColor: "red", catSkin: "b" },
    });
  });
});
