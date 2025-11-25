import type { GameConfiguration } from "../../../shared/game-types";
import { Grid } from "../../../shared/grid";
import { GameState } from "../../../shared/game-state";
import type { Action } from "../../../shared/game-types";
import { moveFromStandardNotation } from "../../../shared/standard-notation";
import type {
  GameActionPayload,
  SerializedGameState,
} from "../../../shared/game-types";

export const buildGameConfigurationFromSerialized = (
  serialized: SerializedGameState
): GameConfiguration => {
  return serialized.config;
};

export const hydrateGameStateFromSerialized = (
  serialized: SerializedGameState,
  baseConfig: GameConfiguration
): GameState => {
  const config: GameConfiguration = {
    boardWidth: serialized.config.boardWidth,
    boardHeight: serialized.config.boardHeight,
    variant: serialized.config.variant ?? baseConfig.variant ?? "standard",
    timeControl: serialized.config.timeControl,
    rated: baseConfig.rated,
  };

  const state = new GameState(config, Date.now());
  state.turn = serialized.turn;
  state.moveCount = serialized.moveCount;
  state.status = serialized.status;
  state.result = serialized.result;
  state.timeLeft = {
    1: serialized.timeLeft[1] ?? config.timeControl.initialSeconds,
    2: serialized.timeLeft[2] ?? config.timeControl.initialSeconds,
  };
  state.lastMoveTime = serialized.lastMoveTime;

  const grid = new Grid(config.boardWidth, config.boardHeight, config.variant);
  serialized.walls.forEach((wall) => {
    grid.addWall(wall);
  });
  state.grid = grid;

  state.pawns = {
    1: {
      cat: serialized.pawns[1].cat,
      mouse: serialized.pawns[1].mouse,
    },
    2: {
      cat: serialized.pawns[2].cat,
      mouse: serialized.pawns[2].mouse,
    },
  };

  try {
    state.history = serialized.history.map((entry) => ({
      index: entry.index,
      move: moveFromStandardNotation(entry.notation, config.boardHeight),
      grid: grid.clone(),
      catPos: [
        [state.pawns[1].cat[0], state.pawns[1].cat[1]],
        [state.pawns[2].cat[0], state.pawns[2].cat[1]],
      ],
      mousePos: [
        [state.pawns[1].mouse[0], state.pawns[1].mouse[1]],
        [state.pawns[2].mouse[0], state.pawns[2].mouse[1]],
      ],
      timeLeftSeconds: [state.timeLeft[1], state.timeLeft[2]],
      distances: [0, 0],
      wallCounts: [0, 0],
    }));
  } catch {
    state.history = [];
  }

  return state;
};

export const serializeActions = (actions: Action[]): GameActionPayload[] => {
  return actions.map((action) => ({
    type: action.type,
    cell: action.target,
    orientation: action.wallOrientation,
  }));
};
