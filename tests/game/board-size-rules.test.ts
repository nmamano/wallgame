import { describe, expect, it } from "bun:test";
import {
  ANIMAL_CYCLE_RANDOM_START_MIN_SIDE,
  BOARD_SIDE_MAX,
  BOARD_SIDE_MIN,
  clampBoardSizeForVariant,
  createGameSchema,
  minimumBoardSideFor,
} from "../../shared/contracts/games";
import { updateVariantParametersSchema } from "../../shared/contracts/settings";

/**
 * Board c8e27470 part (a). Nil got a 400 creating an Animal Cycle game while
 * a friend did not.
 *
 * Measured on 2026-08-16: the settings write path ACCEPTED and stored
 * {boardWidth:3, boardHeight:3, randomStart:true} for Animal Cycle (HTTP
 * 200), while POST /api/games REJECTED exactly that config (HTTP 400). One
 * quantity, two schemas, disagreeing - so an account could hold a saved
 * default that game creation refused, and the variant picker loaded it the
 * moment Animal Cycle was chosen.
 */

const animalCycle3x3 = {
  variant: "animal-cycle" as const,
  randomStart: true,
  boardWidth: 3,
  boardHeight: 3,
};

describe("the smallest legal board", () => {
  it("needs four a side for Animal Cycle Random Start", () => {
    expect(minimumBoardSideFor(animalCycle3x3)).toBe(
      ANIMAL_CYCLE_RANDOM_START_MIN_SIDE,
    );
  });

  it("needs only the general minimum otherwise", () => {
    expect(
      minimumBoardSideFor({ variant: "animal-cycle", randomStart: false }),
    ).toBe(BOARD_SIDE_MIN);
    expect(
      minimumBoardSideFor({ variant: "standard", randomStart: true }),
    ).toBe(BOARD_SIDE_MIN);
  });
});

describe("a stored board that the rules do not allow", () => {
  /**
   * The half that repairs an account which ALREADY holds a bad value.
   * Bounding the write path alone would only stop new ones, leaving the
   * player who has one stuck on an error every time they pick that variant.
   */
  it("loads as a legal config instead of failing", () => {
    expect(clampBoardSizeForVariant(animalCycle3x3)).toEqual({
      boardWidth: 4,
      boardHeight: 4,
    });
  });

  it("produces a config that game creation now accepts", () => {
    const clamped = clampBoardSizeForVariant(animalCycle3x3);
    const parsed = createGameSchema.safeParse({
      config: {
        timeControl: { initialSeconds: 600, incrementSeconds: 2 },
        rated: false,
        variant: "animal-cycle",
        randomStart: true,
        ...clamped,
      },
      matchType: "friend",
    });
    expect(parsed.success).toBe(true);
  });

  /** The known-bad half: without the clamp the same stored value is refused. */
  it("is still refused unclamped, which is the bug Nil hit", () => {
    const parsed = createGameSchema.safeParse({
      config: {
        timeControl: { initialSeconds: 600, incrementSeconds: 2 },
        rated: false,
        ...animalCycle3x3,
      },
      matchType: "friend",
    });
    expect(parsed.success).toBe(false);
  });

  it("leaves a legal board alone and keeps the maximum", () => {
    expect(
      clampBoardSizeForVariant({
        variant: "standard",
        randomStart: true,
        boardWidth: 8,
        boardHeight: 8,
      }),
    ).toEqual({ boardWidth: 8, boardHeight: 8 });
    expect(
      clampBoardSizeForVariant({
        variant: "standard",
        randomStart: true,
        boardWidth: 99,
        boardHeight: 99,
      }),
    ).toEqual({ boardWidth: BOARD_SIDE_MAX, boardHeight: BOARD_SIDE_MAX });
  });
});

describe("the settings write path", () => {
  it("no longer stores a board that game creation would refuse", () => {
    const parsed = updateVariantParametersSchema.safeParse({
      variant: "animal-cycle",
      parameters: { boardWidth: 3, boardHeight: 3, randomStart: true },
    });
    expect(parsed.success).toBe(false);
  });

  it("still stores a legal one", () => {
    expect(
      updateVariantParametersSchema.safeParse({
        variant: "animal-cycle",
        parameters: { boardWidth: 4, boardHeight: 4, randomStart: true },
      }).success,
    ).toBe(true);
    // The same small board is fine without Random Start.
    expect(
      updateVariantParametersSchema.safeParse({
        variant: "animal-cycle",
        parameters: { boardWidth: 3, boardHeight: 3, randomStart: false },
      }).success,
    ).toBe(true);
  });
});
