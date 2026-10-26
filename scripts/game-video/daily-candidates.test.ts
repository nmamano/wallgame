import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { configFileSchema } from "../../official-custom-bot-client/src/config-schema";
import { buildAnimalCycleInitialState } from "../../shared/domain/animal-cycle-setup";
import { buildClassicInitialState } from "../../shared/domain/classic-setup";
import type { CustomSetupStandardInitialState } from "../../shared/domain/game-types";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import {
  classifySeat,
  describeJump,
  evalBarEngineFor,
  gameEligibility,
  jumpsOf,
  minJumpFor,
  MIN_PLIES,
  NIL_USER_ID,
  pickJumps,
  rankCandidates,
  replayDistances,
  swingsOf,
  winChance,
  type DistanceJump,
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
});

describe("distance jumps", () => {
  // Distances on an open board are Manhattan distances, so every expected
  // number below can be counted by hand.
  test("each variant's start: every hunter's walk, the shortest per player", () => {
    const at = (variant: string, w: number, h: number, initialState: never) =>
      replayDistances({
        variant,
        boardWidth: w,
        boardHeight: h,
        initialState,
        moves: [],
      }).distances[0];
    // Standard 8x8: cat a8 [0,0] to the mouse h1 [7,7], and back: 7 + 7.
    expect(
      at("standard", 8, 8, buildStandardInitialState(8, 8) as never),
    ).toEqual({ 1: 14, 2: 14 });
    // Classic 8x8: each cat to its own home in the far corner.
    expect(
      at("classic", 8, 8, buildClassicInitialState(8, 8) as never),
    ).toEqual({ 1: 14, 2: 14 });
    // Animal Cycle 7x7: two hunters each, both 6 away (cat [0,0] to mouse [0,6], ...).
    expect(
      at("animal-cycle", 7, 7, buildAnimalCycleInitialState(7, 7) as never),
    ).toEqual({ 1: 6, 2: 6 });
  });

  // 4x4, player 2 to move. P1's cat [0,0] is 3 steps from P2's mouse [0,3]
  // along the top row; P2's cat [3,0] is 3 from P1's mouse [3,3].
  const corridor: CustomSetupStandardInitialState = {
    pawns: {
      p1: { cat: [0, 0], mouse: [3, 3] },
      p2: { cat: [3, 0], mouse: [0, 3] },
    },
    walls: [],
    turn: { playerId: 2, actionsTaken: [] },
  };
  // >a4 and >a3 close the cat's two right-hand edges at [0,0] and [1,0], so it
  // must walk down two rows first: 2 down + 3 right + 2 up = 7.
  const game = {
    variant: "standard",
    boardWidth: 4,
    boardHeight: 4,
    initialState: corridor,
    moves: [">a4.>a3", "Ca2"],
  };

  test("a wall that forces a walk-around is a big jump; a plain advance is +2", () => {
    const { movers, distances } = replayDistances(game);
    expect(movers).toEqual([2, 1]);
    expect(distances).toEqual([
      { 1: 3, 2: 3 },
      { 1: 7, 2: 3 },
      { 1: 5, 2: 3 },
    ]);
    const jumps = jumpsOf(distances, game.moves, movers);
    expect(jumps[0]).toMatchObject({
      mover: 2,
      opponentBefore: 3,
      opponentAfter: 7,
      jump: 4,
    });
    expect(jumps[1]).toMatchObject({
      mover: 1,
      ownBefore: 7,
      ownAfter: 5,
      jump: 2,
    });
  });

  test("the pick floor is one more than any move without a wall", () => {
    expect(minJumpFor("standard")).toBe(3);
    expect(minJumpFor("classic")).toBe(3);
    expect(minJumpFor("survival")).toBe(3);
    // Each Animal Cycle pawn hunts and is hunted: one step moves two walks.
    expect(minJumpFor("animal-cycle")).toBe(5);
  });

  test("an ordinary Animal Cycle cat move scores +4 and is not a pick", () => {
    // 7x7, P1 to move. P2's dog [3,0] is 1 from P1's cat [3,1]; the cat is 5
    // from P2's mouse [3,6]; P1's elephant [6,6] is 9 from the dog and 3 from
    // the mouse. P1 walks min(5, 9) = 5, P2 min(1, 3) = 1.
    const ac = {
      variant: "animal-cycle",
      boardWidth: 7,
      boardHeight: 7,
      initialState: {
        pawns: {
          p1: { cat: [3, 1], elephant: [6, 6] },
          p2: { mouse: [3, 6], dog: [3, 0] },
        },
        walls: [],
      } as never,
      // Cd4: the cat steps 2 right to [3,3]: 3 from the mouse, 3 from the dog.
      moves: ["Cd4"],
    };
    const { movers, distances } = replayDistances(ac);
    expect(distances).toEqual([
      { 1: 5, 2: 1 },
      { 1: 3, 2: 3 },
    ]);
    const jumps = jumpsOf(distances, ac.moves, movers);
    expect(jumps[0].jump).toBe(4);
    expect(pickJumps(jumps, minJumpFor("animal-cycle"))).toEqual([]);
    expect(pickJumps(jumps, minJumpFor("standard")).length).toBe(1);
  });

  test("only jumps of the floor or more are picks", () => {
    const { movers, distances } = replayDistances(game);
    expect(
      pickJumps(
        jumpsOf(distances, game.moves, movers),
        minJumpFor("standard"),
      ).map((j) => j.ply),
    ).toEqual([0]);
  });

  const jump = (ply: number, value: number): DistanceJump => ({
    ply,
    moveNumber: ply + 1,
    mover: ply % 2 === 0 ? 1 : 2,
    notation: "x",
    ownBefore: 5,
    ownAfter: 5,
    opponentBefore: 5,
    opponentAfter: 5,
    jump: value,
    size: Math.abs(value),
  });

  test("picks take the largest, at most three, never two adjacent plies", () => {
    const picks = pickJumps(
      [
        jump(3, 6),
        jump(4, 5),
        jump(8, -4),
        jump(10, 4),
        jump(12, 3),
        jump(13, 2),
      ],
      3,
    );
    // 4 is next to 3, so it goes; -4 is a self-inflicted jump and counts by size.
    expect(picks.map((p) => p.ply)).toEqual([3, 8, 10]);
  });

  test("each pick has a plain line of what a viewer sees", () => {
    const names = { 1: "Guest Cormorant", 2: "Normal Bot" } as const;
    const pick = (over: Partial<DistanceJump>): DistanceJump => ({
      ...jump(15, 6),
      mover: 2,
      notation: "^a4.^h4",
      ...over,
    });
    expect(
      describeJump(
        pick({
          ownBefore: 3,
          ownAfter: 3,
          opponentBefore: 2,
          opponentAfter: 8,
        }),
        names,
      ),
    ).toBe(
      "Normal Bot's walls make Guest Cormorant walk 6 extra squares (2 to 8).",
    );
    expect(
      describeJump(
        pick({
          notation: ">f4.Cg4",
          ownBefore: 5,
          ownAfter: 4,
          opponentBefore: 1,
          opponentAfter: 5,
        }),
        names,
      ),
    ).toBe(
      "Normal Bot's wall makes Guest Cormorant walk 4 extra squares (1 to 5).",
    );
    expect(
      describeJump(
        pick({
          notation: ">b2.>b3",
          ownBefore: 3,
          ownAfter: 7,
          opponentBefore: 5,
          opponentAfter: 5,
        }),
        names,
      ),
    ).toBe(
      "Normal Bot's own walls make Normal Bot walk 4 extra squares (3 to 7).",
    );
  });

  test("candidates rank by their largest pick, then the next one", () => {
    const withSizes = (gameId: string, sizes: number[]) => ({
      gameId,
      picks: sizes.map((size, i) => jump(i * 2, size)),
    });
    const ranked = rankCandidates([
      withSizes("small", [4, 3]),
      withSizes("none", []),
      withSizes("big-b", [6, 3]),
      withSizes("big-a", [6, 4]),
    ]);
    expect(ranked.map((c) => c.gameId)).toEqual([
      "big-a",
      "big-b",
      "small",
      "none",
    ]);
  });
});
