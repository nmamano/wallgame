import type {
  GameConfiguration,
  PlayerId,
  SerializedGameState,
} from "../../../shared/domain/game-types";
import { normalizeFreestyleConfig } from "../../../shared/domain/freestyle-setup";
import { Grid } from "../../../shared/domain/grid";
import { GameState } from "../../../shared/domain/game-state";
import { moveFromStandardNotation } from "../../../shared/domain/standard-notation";

export const buildGameConfigurationFromSerialized = (
  serialized: SerializedGameState,
): GameConfiguration => {
  return normalizeFreestyleConfig(serialized.config);
};

export const hydrateGameStateFromSerialized = (
  serialized: SerializedGameState,
  baseConfig: GameConfiguration,
): GameState => {
  const resolvedVariant =
    serialized.config.variant ?? baseConfig.variant ?? "standard";
  const rated = baseConfig.rated;
  const timeControl = serialized.config.timeControl;

  // Use variantConfig from serialized state, falling back to baseConfig
  const variantConfig =
    serialized.config.variantConfig ?? baseConfig.variantConfig;

  const config: GameConfiguration = {
    boardWidth: serialized.config.boardWidth,
    boardHeight: serialized.config.boardHeight,
    variant: resolvedVariant,
    timeControl,
    rated,
    variantConfig,
  };
  const normalizedConfig = normalizeFreestyleConfig(config);

  const state = new GameState(normalizedConfig, Date.now());
  state.turn = serialized.turn;
  state.moveCount = serialized.moveCount;
  state.status = serialized.status;
  state.result = serialized.result;
  state.timeLeft = {
    1: serialized.timeLeft[1] ?? normalizedConfig.timeControl.initialSeconds,
    2: serialized.timeLeft[2] ?? normalizedConfig.timeControl.initialSeconds,
  };
  state.lastMoveTime = serialized.lastMoveTime;

  const grid = new Grid(
    normalizedConfig.boardWidth,
    normalizedConfig.boardHeight,
    normalizedConfig.variant,
  );
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
    const orderedHistory = [...serialized.history].sort(
      (a, b) => a.index - b.index,
    );
    let replayState: GameState = new GameState(normalizedConfig, Date.now());
    state.history = orderedHistory.map((entry) => {
      const move = moveFromStandardNotation(
        entry.notation,
        normalizedConfig.boardHeight,
      );
      const playerId = (entry.index % 2 === 1 ? 1 : 2) as PlayerId;
      const nextState = replayState.applyGameAction({
        kind: "move",
        move,
        playerId,
        timestamp: Date.now(),
      });
      replayState = nextState;

      return {
        index: entry.index,
        move,
        grid: nextState.grid.clone(),
        catPos: [
          [nextState.pawns[1].cat[0], nextState.pawns[1].cat[1]],
          [nextState.pawns[2].cat[0], nextState.pawns[2].cat[1]],
        ],
        mousePos: [
          [nextState.pawns[1].mouse[0], nextState.pawns[1].mouse[1]],
          [nextState.pawns[2].mouse[0], nextState.pawns[2].mouse[1]],
        ],
        timeLeftSeconds: [nextState.timeLeft[1], nextState.timeLeft[2]],
        distances: [0, 0],
        wallCounts: [0, 0],
      };
    });
  } catch {
    state.history = [];
  }

  return state;
};
