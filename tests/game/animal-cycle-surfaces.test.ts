import { describe, expect, it } from "bun:test";
import { variantDisplayName } from "../../shared/domain/game-types";
import {
  createBotGameDirectSchema,
  createGameSchema,
  variantValues,
} from "../../shared/contracts/games";
import { botConfigBaseSchema } from "../../shared/contracts/custom-bot-config-schema";
import { updatePawnSchema } from "../../shared/contracts/settings";

const directConfig = {
  variant: "animal-cycle",
  randomStart: false,
  boardWidth: 8,
  boardHeight: 8,
};

describe("Animal Cycle public surfaces", () => {
  it("is accepted by ordinary and direct-bot creation contracts", () => {
    expect(variantValues).toContain("animal-cycle");
    expect(
      createGameSchema.safeParse({
        config: {
          ...directConfig,
          rated: false,
          timeControl: { initialSeconds: 180, incrementSeconds: 2 },
        },
        matchType: "friend",
      }).success,
    ).toBe(true);
    expect(
      createBotGameDirectSchema.safeParse({
        botId: "naive-cycle",
        config: directConfig,
      }).success,
    ).toBe(true);
  });

  it("allows a naive bot registration to advertise Animal Cycle", () => {
    const parsed = botConfigBaseSchema.safeParse({
      botId: "naive-cycle",
      name: "Naive Animal Cycle",
      username: null,
      appearance: {
        dogStyle: "dog-puppy-07.svg",
        elephantStyle: "elephant-19.svg",
      },
      variants: {
        "animal-cycle": {
          boardWidth: { min: 4, max: 20 },
          boardHeight: { min: 4, max: 20 },
          recommended: [{ boardWidth: 8, boardHeight: 8 }],
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.appearance).toEqual({
      dogStyle: "dog-puppy-07.svg",
      elephantStyle: "elephant-19.svg",
    });
  });

  it("accepts Dog and Elephant account-setting updates", () => {
    expect(
      updatePawnSchema.parse({
        pawnType: "dog",
        pawnShape: "dog-puppy-07.svg",
      }),
    ).toEqual({ pawnType: "dog", pawnShape: "dog-puppy-07.svg" });
    expect(
      updatePawnSchema.parse({
        pawnType: "elephant",
        pawnShape: "elephant-19.svg",
      }),
    ).toEqual({ pawnType: "elephant", pawnShape: "elephant-19.svg" });
  });

  it("uses the exact player-facing name", () => {
    expect(variantDisplayName("animal-cycle" as never)).toBe("Animal Cycle");
  });

  it("exposes the selector, exact rule copy, and four animal silhouettes", async () => {
    const playSource = await Bun.file("frontend/src/routes/play.tsx").text();
    expect(playSource).toContain(
      '<SelectItem value="animal-cycle">Animal Cycle</SelectItem>',
    );
    expect(playSource).toContain(
      "Bigger beats smaller, except the mouse scares the elephant. First capture wins.",
    );

    for (const animal of ["dog", "cat", "mouse", "elephant"]) {
      expect(
        await Bun.file(
          `frontend/public/pawns/animal-cycle/${animal}.svg`,
        ).exists(),
      ).toBe(true);
    }
  });
});
