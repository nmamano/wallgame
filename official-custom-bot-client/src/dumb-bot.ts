/**
 * Dumb Bot - A simple fallback AI for testing
 *
 * This bot walks its cat towards the opponent's mouse without placing walls.
 * It's used when no external engine is provided.
 */

import type {
  SerializedGameState,
  Cell,
  PlayerId,
} from "../../shared/domain/game-types";
import { Grid } from "../../shared/domain/grid";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import { computeDummyAiMove } from "../../shared/domain/dummy-ai";
import type { EngineRequest, EngineResponse } from "./engine-api";
import { ENGINE_API_VERSION } from "./engine-api";
import { logger } from "./logger";

/**
 * Reconstruct a Grid from SerializedGameState
 */
function reconstructGrid(state: SerializedGameState): Grid {
  const grid = new Grid(
    state.config.boardWidth,
    state.config.boardHeight,
    state.config.variant,
  );

  for (const wall of state.walls) {
    grid.addWall(wall);
  }

  return grid;
}

/**
 * Get the cat goal based on variant
 */
function getCatGoal(state: SerializedGameState, myPlayerId: PlayerId): Cell {
  const opponentId: PlayerId = myPlayerId === 1 ? 2 : 1;
  const variant = state.config.variant;

  if (variant === "classic") {
    // In classic mode, the goal is the opponent's home corner
    // Player 1 starts on the left, so their home is top-left
    // Player 2 starts on the right, so their home is top-right
    // The cat's goal is the opponent's home corner
    const rows = state.config.boardHeight;
    const cols = state.config.boardWidth;
    if (myPlayerId === 1) {
      // My cat starts at top-left, goal is opponent's home (top-right)
      return [0, cols - 1];
    } else {
      // My cat starts at top-right, goal is opponent's home (top-left)
      return [0, 0];
    }
  }

  // For standard and freestyle, the goal is the opponent's mouse
  return state.pawns[opponentId].mouse as Cell;
}

/**
 * Handle a request from the official client
 */
export function handleDumbBotRequest(request: EngineRequest): EngineResponse {
  logger.debug("Dumb bot processing request:", request.kind);

  if (request.kind === "draw") {
    // Always decline draws
    return {
      engineApiVersion: ENGINE_API_VERSION,
      requestId: request.requestId,
      response: { action: "decline-draw" },
    };
  }

  // kind === "move"
  const state = request.state;
  const myPlayerId = request.seat.playerId;

  const grid = reconstructGrid(state);
  const myCatPos = state.pawns[myPlayerId].cat as Cell;
  const goalPos = getCatGoal(state, myPlayerId);

  logger.debug("Computing move:", {
    myCatPos,
    goalPos,
    variant: state.config.variant,
  });

  const move = computeDummyAiMove(grid, myCatPos, goalPos);
  const moveNotation = moveToStandardNotation(move, state.config.boardHeight);

  logger.debug("Dumb bot chose move:", moveNotation);

  return {
    engineApiVersion: ENGINE_API_VERSION,
    requestId: request.requestId,
    response: { action: "move", moveNotation },
  };
}
