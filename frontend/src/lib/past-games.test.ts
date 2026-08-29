import { describe, expect, it } from "bun:test";
import type { PastGameSummary } from "../../../shared/contracts/games";
import {
  buildPastGamesFilterQuery,
  defaultPastGamesFilters,
  presentPastGameRow,
} from "./past-games";

const game = {
  gameId: "identity-proof",
  variant: "standard",
  randomStart: false,
  rated: true,
  timeControl: "blitz",
  boardWidth: 8,
  boardHeight: 8,
  movesCount: 24,
  startedAt: Date.UTC(2026, 7, 29, 12),
  views: 3,
  players: [
    {
      playerOrder: 1,
      displayName: "Guest Fox",
      ratingAtStart: null,
      outcomeRank: 2,
      outcomeReason: "resignation",
      playerKind: "guest",
    },
    {
      playerOrder: 2,
      displayName: "Ruthless Bot",
      ratingAtStart: 1800,
      outcomeRank: 1,
      outcomeReason: "resignation",
      playerKind: "bot",
    },
  ],
} as PastGameSummary;

describe("presentPastGameRow", () => {
  it("combines the variant and exact dimensions in one display label", () => {
    expect(presentPastGameRow(game).variantLabel).toBe("Standard (8x8)");
  });

  it("preserves the authoritative identity kind for each player", () => {
    expect(
      presentPastGameRow(game).players.map((player) => player.kind),
    ).toEqual(["guest", "bot"]);
  });

  it("preserves a bot's full display name", () => {
    expect(presentPastGameRow(game).players[1]?.label).toBe(
      "Ruthless Bot (1800)",
    );
  });

  it("keeps variant and board-size filters as independent query keys", () => {
    expect(
      buildPastGamesFilterQuery({
        ...defaultPastGamesFilters,
        variant: "standard",
        boardSize: "medium",
      }),
    ).toEqual({ variant: "standard", boardSize: "medium" });
  });
});
