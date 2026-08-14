import { describe, expect, it } from "bun:test";

describe("Animal Cycle UI legality wiring", () => {
  it("filters board highlights through simulated move legality on both layouts", async () => {
    const [board, interactions, route] = await Promise.all([
      Bun.file("frontend/src/components/board.tsx").text(),
      Bun.file("frontend/src/hooks/use-board-interactions.ts").text(),
      Bun.file("frontend/src/routes/game.$id.tsx").text(),
    ]);

    const filter =
      "if (isCellDropValid && !isCellDropValid(pawn.id, row, col))";
    expect(board).toContain(filter);
    expect(board.indexOf(filter)).toBeLessThan(
      board.indexOf("validCells.add(`${row}-${col}`)"),
    );
    expect(interactions).toContain("const isCellDropValid = useCallback(");
    expect(interactions).toContain("resolveDoubleStep({");
    expect(interactions).toContain("return canEnqueue({");
    expect(interactions).toContain("fillsActionBudget(");
    expect(route.match(/isCellDropValid=/g)).toHaveLength(2);
  });
});
