/**
 * Dumb Bot - A simple fallback AI for testing
 *
 * This bot walks its cat towards the opponent's mouse without placing walls.
 * It's used when no external engine is provided.
 */

import type { Cell, PlayerId } from "../../shared/domain/game-types";
import { computeDummyAiMove } from "../../shared/domain/dummy-ai";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import {
  getCatGoal,
  reconstructGrid,
} from "../../shared/custom-bot/dummy-engine-utils";
import type {
  EngineRequest,
  EngineResponse,
} from "../../shared/custom-bot/engine-api";
import { ENGINE_API_VERSION } from "../../shared/custom-bot/engine-api";
import { logger } from "./logger";

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
  const myPlayerId = request.playerId;

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
