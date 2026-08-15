import { describe, expect, test } from "bun:test";

const rulesVariantOptions: [string, string][] = [
  ["all", "All"],
  ["standard", "Standard"],
  ["animal-cycle", "Animal Cycle"],
  ["classic", "Classic"],
];

const selectItems = (source: string): [string, string][] =>
  [
    ...source.matchAll(/<SelectItem value="([^"]+)">([^<]+)<\/SelectItem>/g),
  ].map(([, value, label]) => [value, label]);

describe("game-history rules variants", () => {
  test.each([
    ["Past Games", "frontend/src/routes/past-games.tsx", "row.variant"],
    ["Live Games", "frontend/src/routes/live-games.tsx", "game.variant"],
  ])("%s hides Random Start metadata", async (_page, path, variantValue) => {
    const source = await Bun.file(path).text();

    expect(source).toContain(`variantDisplayName(${variantValue})`);
    expect(source).not.toContain(
      `variantDisplayName(${variantValue}, ${variantValue.split(".")[0]}.randomStart)`,
    );
    expect(selectItems(source).slice(0, 4)).toEqual(rulesVariantOptions);
  });
});
