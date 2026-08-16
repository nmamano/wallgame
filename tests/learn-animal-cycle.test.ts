import { describe, expect, test } from "bun:test";

describe("Learn variant entries", () => {
  test("lists only the pawn-rules variants", async () => {
    const source = await Bun.file("frontend/src/routes/learn.tsx").text();
    const variants = /const variantsContent = `([\s\S]*?)`;/.exec(source)?.[1];
    expect(variants).toBeDefined();
    expect(variants).toStartWith(`
### Standard

Cat and mouse pawns start in the corners.

### Classic

A traditional variant where the mice are called "goals" and are fixed in the bottom corners. You win by reaching the goal (the opposite corner) before the opponent reaches theirs.
`);
    expect(
      [...(variants?.matchAll(/^### (.+)$/gm) ?? [])].map((match) => match[1]),
    ).toEqual(["Standard", "Classic", "Animal Cycle"]);
    expect(variants).not.toContain("Standard · Random Start");
    expect(variants).not.toContain(
      "A randomized setup with neutral starting walls.",
    );
    expect(variants).toContain(
      "Player 1 controls the Cat and Elephant. Player 2 controls the Mouse and Dog.",
    );
    expect(variants).toContain(
      "Cat beats Mouse, Mouse beats Elephant, Elephant beats Dog, and Dog beats Cat.",
    );
    expect(variants).toContain("The first capture wins.");
    expect(variants).toContain(
      "Your two animals can never share a cell or cross each other.",
    );
    expect(variants).not.toContain(
      "On an L-shaped two-cell move, one open route that avoids your other animal is enough.",
    );
    expect(variants).not.toContain(
      "You may cross an opposing animal without capturing it; only the cell where each action ends is checked for a capture.",
    );
    expect(variants).not.toContain(
      "You may also pass without taking an action. Walls follow the standard rules.",
    );
  });
});
