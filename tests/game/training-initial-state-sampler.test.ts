import { describe, expect, it } from "bun:test";
import {
  makeTrainingRng,
  sampleTrainingInitialStates,
  trainingGameSeed,
} from "../../deep-wallwars/scripts/generate_training_initial_states";
import { buildOrdinaryInitialState } from "../../shared/domain/game-configuration";

describe("training initial-state sampler", () => {
  it("is deterministic and emits the website dispatcher output byte-for-byte", () => {
    const seed = 730_117;
    const actual = sampleTrainingInitialStates(seed, 200);
    expect(actual).toEqual(sampleTrainingInitialStates(seed, 200));

    for (const record of actual) {
      const rng = makeTrainingRng(trainingGameSeed(seed, record.gameIndex));
      const variants = ["standard", "classic", "animal-cycle"] as const;
      expect(variants[Math.floor(rng() * 3)]).toBe(record.variant);
      const branch = Math.floor(rng() * 3);
      let width: number;
      let height: number;
      let dimensionMode: "low" | "high" | "random";
      if (record.variant === "animal-cycle") {
        [width, height, dimensionMode] =
          branch === 0
            ? [7, 7, "low"]
            : branch === 1
              ? [9, 9, "high"]
              : [
                  7 + Math.floor(rng() * 6),
                  7 + Math.floor(rng() * 4),
                  "random",
                ];
      } else {
        [width, height, dimensionMode] =
          branch === 0
            ? [8, 8, "low"]
            : branch === 1
              ? [12, 10, "high"]
              : [
                  8 + Math.floor(rng() * 5),
                  8 + Math.floor(rng() * 3),
                  "random",
                ];
      }
      expect([record.boardWidth, record.boardHeight]).toEqual([width, height]);
      expect(record.dimensionMode).toBe(dimensionMode);
      const randomStart = rng() < 0.5;
      expect(record.startMode).toBe(randomStart ? "random" : "traditional");
      const direct = buildOrdinaryInitialState(
        {
          variant: record.variant,
          randomStart,
          boardWidth: width,
          boardHeight: height,
        },
        rng,
      );
      expect(JSON.stringify(record.initialState)).toBe(JSON.stringify(direct));
    }
  });

  it("covers the requested distribution without treating balance as correctness", () => {
    const records = sampleTrainingInitialStates(730_117, 6_000);
    for (const variant of ["standard", "classic", "animal-cycle"] as const) {
      const share =
        records.filter((record) => record.variant === variant).length /
        records.length;
      expect(share).toBeGreaterThan(0.3);
      expect(share).toBeLessThan(0.36);
      const selected = records.filter((record) => record.variant === variant);
      for (const mode of ["low", "high", "random"] as const) {
        const modeShare =
          selected.filter((record) => record.dimensionMode === mode).length /
          selected.length;
        expect(modeShare).toBeGreaterThan(0.3);
        expect(modeShare).toBeLessThan(0.36);
      }
    }
    const randomShare =
      records.filter((record) => record.startMode === "random").length /
      records.length;
    expect(randomShare).toBeGreaterThan(0.47);
    expect(randomShare).toBeLessThan(0.53);

    const animal = records.filter(
      (record) => record.variant === "animal-cycle",
    );
    expect(
      animal.some(
        (record) => record.boardWidth === 7 && record.boardHeight === 7,
      ),
    ).toBeTrue();
    expect(
      animal.some(
        (record) => record.boardWidth === 9 && record.boardHeight === 9,
      ),
    ).toBeTrue();
    expect(
      animal.every(
        (record) => record.boardWidth >= 7 && record.boardWidth <= 12,
      ),
    ).toBeTrue();
    expect(
      animal.every(
        (record) => record.boardHeight >= 7 && record.boardHeight <= 10,
      ),
    ).toBeTrue();
  }, 20_000);

  it("keeps omitted-rng calls on Math.random", () => {
    const original = Math.random;
    Math.random = makeTrainingRng(17);
    try {
      expect(
        buildOrdinaryInitialState({
          variant: "standard",
          randomStart: true,
          boardWidth: 8,
          boardHeight: 8,
        }),
      ).toEqual(
        buildOrdinaryInitialState(
          {
            variant: "standard",
            randomStart: true,
            boardWidth: 8,
            boardHeight: 8,
          },
          makeTrainingRng(17),
        ),
      );
    } finally {
      Math.random = original;
    }
  });
});
