import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { configFileSchema } from "../../official-custom-bot-client/src/config-schema";
import {
  classifySeat,
  evalBarEngineFor,
  gameEligibility,
  MIN_PLIES,
  NIL_USER_ID,
  rankCandidates,
  swingsOf,
  winChance,
  type StoredGameSummary,
  type StoredSeat,
} from "./daily-candidates";

const seat = (over: Partial<StoredSeat>): StoredSeat => ({
  playerOrder: 1,
  playerConfigType: "matched user",
  displayName: "Guest Tuatara",
  userId: null,
  botId: null,
  botIsOfficial: null,
  outcomeRank: 1,
  outcomeReason: "knockout",
  ...over,
});

const guest = seat({});
const nil = seat({
  playerConfigType: "you",
  displayName: "nil",
  userId: NIL_USER_ID,
});
const member = seat({
  playerConfigType: "matched user",
  displayName: "someone",
  userId: NIL_USER_ID + 1,
});
const officialBot = seat({
  playerConfigType: "bot",
  displayName: "Superhuman",
  botId: "official:dw-transformer",
  botIsOfficial: true,
});
const customBot = seat({
  playerConfigType: "custom bot",
  displayName: "Someone's Bot",
  botId: "someone:bot",
  botIsOfficial: false,
});

const game = (
  a: StoredSeat,
  b: StoredSeat,
  over: Partial<StoredGameSummary> = {},
): StoredGameSummary => ({
  gameId: "g1",
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
  movesCount: 30,
  puzzleId: null,
  seats: [
    { ...a, playerOrder: 1, outcomeRank: 1 },
    { ...b, playerOrder: 2, outcomeRank: 2 },
  ],
  ...over,
});

describe("seat eligibility", () => {
  test("a guest, Nil and an official bot are each allowed", () => {
    expect(classifySeat(guest)).toEqual({ ok: true, kind: "guest" });
    expect(classifySeat(nil)).toEqual({ ok: true, kind: "nil" });
    expect(classifySeat(officialBot)).toEqual({
      ok: true,
      kind: "official bot",
    });
  });

  test("another signed-in member and a non-official bot are refused", () => {
    expect(classifySeat(member).ok).toBe(false);
    expect(classifySeat(customBot).ok).toBe(false);
  });

  test("one member seat takes the whole game out, from either seat", () => {
    expect(gameEligibility(game(guest, officialBot))).toEqual({
      eligible: true,
      seatKinds: ["guest", "official bot"],
    });
    expect(gameEligibility(game(nil, guest)).eligible).toBe(true);
    expect(gameEligibility(game(member, guest)).eligible).toBe(false);
    expect(gameEligibility(game(guest, member)).eligible).toBe(false);
    expect(gameEligibility(game(nil, member)).eligible).toBe(false);
  });

  test("a game won on the clock is out; a capture or a resignation is in", () => {
    const ended = (outcomeReason: string) =>
      game({ ...guest, outcomeReason }, { ...officialBot, outcomeReason });
    expect(gameEligibility(ended("timeout"))).toEqual({
      eligible: false,
      reason: "ended by timeout",
    });
    expect(gameEligibility(ended("capture")).eligible).toBe(true);
    expect(gameEligibility(ended("resignation")).eligible).toBe(true);
  });

  test("short games and puzzle attempts are out", () => {
    expect(
      gameEligibility(game(guest, guest, { movesCount: MIN_PLIES })).eligible,
    ).toBe(true);
    expect(
      gameEligibility(game(guest, guest, { movesCount: MIN_PLIES - 1 }))
        .eligible,
    ).toBe(false);
    expect(
      gameEligibility(game(guest, officialBot, { puzzleId: "p1" })).eligible,
    ).toBe(false);
  });
});

describe("evaluation-bar engine lookup", () => {
  const config = configFileSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../official-custom-bot-client/transformer.prod.config.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

  test("picks the opponent analysis bot, never the puzzle one", () => {
    expect(evalBarEngineFor(config, "standard", 8, 8)?.botId).toBe(
      "dw-transformer",
    );
    expect(evalBarEngineFor(config, "classic", 8, 8)?.botId).toBe(
      "dw-transformer",
    );
    expect(evalBarEngineFor(config, "animal-cycle", 7, 7)?.botId).toBe(
      "experimental-animal-115",
    );
  });

  test("has no engine where the site has no bar", () => {
    expect(evalBarEngineFor(config, "survival", 8, 8)).toBeNull();
    expect(evalBarEngineFor(config, "standard", 13, 8)).toBeNull();
  });
});

describe("swings", () => {
  test("win chance is the bar's (value + 1) / 2, flipped for player 2", () => {
    expect(winChance(0.5, 1)).toBeCloseTo(0.75);
    expect(winChance(0.5, 2)).toBeCloseTo(0.25);
    expect(winChance(1.2, 1)).toBe(1);
  });

  test("a swing is measured from the mover's side, so a blunder is negative for either player", () => {
    // P1 moves 0 -> +0.2 (good, +10 points), P2 then blunders +0.2 -> +0.9:
    // the bar rises, which is P2's chance falling from 40% to 5%.
    const swings = swingsOf([0, 0.2, 0.9, 0.8], ["a", "b", "c"], [1, 2, 1]);
    expect(swings.map((s) => s.ply)).toEqual([1, 0, 2]);
    expect(swings[0].mover).toBe(2);
    expect(swings[0].moverBefore).toBeCloseTo(0.4);
    expect(swings[0].moverAfter).toBeCloseTo(0.05);
    expect(swings[0].delta).toBeCloseTo(-0.35);
    expect(swings[0].size).toBeCloseTo(0.35);
    expect(swings[1].delta).toBeCloseTo(0.1);
    expect(swings[2].delta).toBeCloseTo(-0.05);
  });

  test("movers come from the caller, so a setup where player 2 starts is scored right", () => {
    const [top] = swingsOf([0, 0.6], ["a"], [2]);
    expect(top.delta).toBeCloseTo(-0.3);
  });

  test("refuses evaluation and move lists that do not line up", () => {
    expect(() => swingsOf([0, 0.1], ["a", "b"], [1, 2])).toThrow();
    expect(() => swingsOf([0, 0.1, 0.2], ["a", "b"], [1])).toThrow();
  });

  test("candidates rank by their largest swing, then the next one", () => {
    const withSizes = (gameId: string, sizes: number[]) => ({
      gameId,
      topSwings: sizes.map((size, ply) => ({
        ...swingsOf([0, 0], ["x"], [1])[0],
        ply,
        size,
      })),
    });
    const ranked = rankCandidates([
      withSizes("small", [0.2, 0.1]),
      withSizes("big-b", [0.6, 0.3]),
      withSizes("big-a", [0.6, 0.4]),
    ]);
    expect(ranked.map((c) => c.gameId)).toEqual(["big-a", "big-b", "small"]);
  });
});
