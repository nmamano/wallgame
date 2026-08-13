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

### Freestyle

A randomized setup with neutral starting walls.
`);
    expect(
      [...(variants?.matchAll(/^### (.+)$/gm) ?? [])].map((match) => match[1]),
    ).toEqual(["Standard", "Classic", "Freestyle", "Animal Cycle"]);
    expect(variants).toContain(
      "Player 1 controls the Dog and Mouse. Player 2 controls the Cat and Elephant.",
    );
    expect(variants).toContain(
      "Dog beats Cat, Cat beats Mouse, Mouse beats Elephant, and Elephant beats Dog.",
    );
    expect(variants).toContain(
      "The first capture wins. Movement and wall placement follow the standard rules.",
    );
  });
});
