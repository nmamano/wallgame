import { describe, expect, test } from "bun:test";

describe("Learn Animal Cycle variant entry", () => {
  test("adds only Animal Cycle after the existing variant copy", async () => {
    const source = await Bun.file("frontend/src/routes/learn.tsx").text();
    const variants = /const variantsContent = `([\s\S]*?)`;/.exec(source)?.[1];
    expect(variants).toBeDefined();
    expect(variants).toStartWith(`
### Standard

Cat and mouse pawns start in the corners.

### Classic

A traditional variant where the mice are called "goals" and are fixed in the bottom corners. You win by reaching the goal (the opposite corner) before the opponent reaches theirs.

### Standard · Random Start

A randomized setup with neutral starting walls.
`);
    expect(
      [...(variants?.matchAll(/^### (.+)$/gm) ?? [])].map((match) => match[1]),
    ).toEqual([
      "Standard",
      "Classic",
      "Standard · Random Start",
      "Animal Cycle",
    ]);
    expect(variants).toContain(
      "Player 1 controls the Dog and Mouse. Player 2 controls the Cat and Elephant.",
    );
    expect(variants).toContain(
      "Dog beats Cat, Cat beats Mouse, Mouse beats Elephant, and Elephant beats Dog.",
    );
    expect(variants).toContain(
      "The first capture wins immediately when an action ends on an opposing animal.",
    );
    expect(variants).toContain(
      "Your two animals can never share a cell or cross each other.",
    );
    expect(variants).toContain(
      "On an L-shaped two-cell move, one open route that avoids your other animal is enough.",
    );
    expect(variants).toContain(
      "You may cross an opposing animal without capturing it; only the cell where each action ends is checked for a capture.",
    );
    expect(variants).toContain(
      "You may also pass without taking an action. Walls follow the standard rules.",
    );
  });
});
