import type {
  GameConfiguration,
  PlayerId,
  SerializedGameState,
} from "../../../shared/domain/game-types";
import { Grid } from "../../../shared/domain/grid";
import { clonePawns } from "../../../shared/domain/pawns";
import { GameState } from "../../../shared/domain/game-state";
import { moveFromStandardNotation } from "../../../shared/domain/standard-notation";

export const buildGameConfigurationFromSerialized = (
  serialized: SerializedGameState,
): GameConfiguration => {
  return serialized.config;
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
  const state = new GameState(config, Date.now());
  state.turn = serialized.turn;
  state.moveCount = serialized.moveCount;
  if (serialized.moveCount > 0) {
    state.actionsRemaining = 2;
    state.previousPawnPosition = undefined;
  }
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

  state.pawns = clonePawns(serialized.pawns);

  try {
    const orderedHistory = [...serialized.history].sort(
      (a, b) => a.index - b.index,
    );
    let replayState: GameState = new GameState(config, Date.now());
    state.history = orderedHistory.map((entry) => {
      const move = moveFromStandardNotation(entry.notation, config.boardHeight);
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
        pawns: clonePawns(nextState.pawns),
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
