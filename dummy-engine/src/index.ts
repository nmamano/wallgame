#!/usr/bin/env bun
/**
 * Wall Game Dummy Engine
 *
 * Reads an EngineRequest from stdin and writes an EngineResponse to stdout.
 * Uses the shared dummy AI to move the cat toward its goal.
 */

import { computeDummyAiMove } from "../../shared/domain/dummy-ai";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import type {
  EngineRequest,
  EngineResponse,
} from "../../shared/custom-bot/engine-api";
import { ENGINE_API_VERSION } from "../../shared/custom-bot/engine-api";
import {
  getCatGoal,
  reconstructGrid,
} from "../../shared/custom-bot/dummy-engine-utils";

function handleRequest(request: EngineRequest): EngineResponse {
  // In V2, draw requests are auto-declined by the client, but we handle them anyway
  if (request.kind === "draw") {
    return {
      engineApiVersion: ENGINE_API_VERSION,
      requestId: request.requestId,
      response: { action: "decline-draw" },
    };
  }

  const state = request.state;
  const myPlayerId = request.playerId;

  const grid = reconstructGrid(state);
  const myCatPos = state.pawns[myPlayerId].cat;
  const goalPos = getCatGoal(state, myPlayerId);

  const move = computeDummyAiMove(grid, myCatPos, goalPos);
  const moveNotation = moveToStandardNotation(move, state.config.boardHeight);

  return {
    engineApiVersion: ENGINE_API_VERSION,
    requestId: request.requestId,
    response: { action: "move", moveNotation, evaluation: 0 },
  };
}

async function main(): Promise<void> {
  const input = await Bun.stdin.text();
  if (!input.trim()) {
    throw new Error("No engine request provided on stdin.");
  }

  const request = JSON.parse(input) as EngineRequest;
  const response = handleRequest(request);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Dummy engine error: ${message}`);
  process.exit(1);
});
