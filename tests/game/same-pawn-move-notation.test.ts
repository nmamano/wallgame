import { describe, expect, it } from "bun:test";
import {
  moveFromStandardNotation,
  moveToStandardNotation,
} from "../../shared/domain/standard-notation";
import type { Move } from "../../shared/domain/game-types";

/**
 * Official notation names where a pawn ENDED, not every square it touched.
 *
 * We emitted a term per step ("Md6.Mc6") while the engine emits and expects the
 * collapsed form ("Mc6"). That looked cosmetic — it only showed in the move
 * list — but the same string is what `apply_move` sends the engine, and the
 * engine resolves each term by path-finding to it. Two terms can therefore cost
 * more than the two actions a turn allows, and the engine answers "Move has too
 * many actions for the current turn state" and refuses the move. The server
 * treats a refused apply_move as engine failure and forfeits the bot, so a
 * notation slip ends a real game (see game 99q94y29, 2026-08-02).
 *
 * The collapsed form is also what makes the intermediate square OUR business
 * rather than the wire's: naming only the destination lets each side route the
 * pawn by its own rules instead of committing the other to a path.
 */

const cat = (row: number, col: number) =>
  ({ type: "cat", target: [row, col] }) as const;
const mouse = (row: number, col: number) =>
  ({ type: "mouse", target: [row, col] }) as const;
const wall = (row: number, col: number, o: "vertical" | "horizontal") =>
  ({ type: "wall", target: [row, col], wallOrientation: o }) as const;

const ROWS = 8;

describe("same-pawn double moves in standard notation", () => {
  it("collapses two mouse steps to the destination", () => {
    // The exact move that broke game 99q94y29: mouse e6 -> d6 -> c6.
    const move: Move = { actions: [mouse(2, 3), mouse(2, 2)] };
    expect(moveToStandardNotation(move, ROWS)).toBe("Mc6");
  });

  it("collapses two cat steps to the destination", () => {
    const move: Move = { actions: [cat(1, 5), cat(1, 4)] };
    expect(moveToStandardNotation(move, ROWS)).toBe("Ce7");
  });

  it("never emits two terms for one pawn", () => {
    // The property, stated directly: whatever the actions, a pawn gets at most
    // one term. A term-per-step regression fails here however it is written.
    const move: Move = { actions: [mouse(2, 3), mouse(2, 2)] };
    const terms = moveToStandardNotation(move, ROWS).split(".");
    expect(terms.filter((t) => t.startsWith("M")).length).toBe(1);
    expect(terms.length).toBe(1);
  });

  it("keeps different pawns as separate terms", () => {
    const move: Move = { actions: [cat(1, 5), mouse(2, 2)] };
    expect(moveToStandardNotation(move, ROWS)).toBe("Cf7.Mc6");
  });

  it("keeps a pawn step and a wall as separate terms", () => {
    const move: Move = { actions: [cat(1, 6), wall(1, 0, "vertical")] };
    expect(moveToStandardNotation(move, ROWS)).toBe("Cg7.>a7");
  });

  it("keeps two walls as separate terms, vertical first", () => {
    const move: Move = {
      actions: [wall(1, 2, "vertical"), wall(0, 2, "vertical")],
    };
    expect(moveToStandardNotation(move, ROWS)).toBe(">c8.>c7");
  });

  it("still writes a pass as ---", () => {
    expect(moveToStandardNotation({ actions: [] }, ROWS)).toBe("---");
  });

  describe("round trip", () => {
    it("reads a collapsed pawn move back as one action on the far cell", () => {
      // The collapsed term must survive the trip home: one action whose target
      // is two cells away, which GameState charges as two actions.
      const parsed = moveFromStandardNotation("Mc6", ROWS);
      expect(parsed.actions).toHaveLength(1);
      expect(parsed.actions[0].type).toBe("mouse");
      expect(parsed.actions[0].target).toEqual([2, 2]);
    });

    it("is stable: collapsing an already-collapsed move changes nothing", () => {
      for (const notation of ["Mc6", "Ce7", "Cg7.>a7", ">c8.>c7", "---"]) {
        expect(
          moveToStandardNotation(
            moveFromStandardNotation(notation, ROWS),
            ROWS,
          ),
        ).toBe(notation);
      }
    });

    it("still reads the OLD expanded form, so stored games remain readable", () => {
      // Games recorded before this change hold "Md6.Mc6" in game_details.moves.
      // Those records are not rewritten, so the parser must keep accepting them.
      const parsed = moveFromStandardNotation("Md6.Mc6", ROWS);
      expect(parsed.actions).toHaveLength(2);
      expect(parsed.actions[1].target).toEqual([2, 2]);
      // And re-serialising an old record now yields the official form.
      expect(moveToStandardNotation(parsed, ROWS)).toBe("Mc6");
    });
  });
});
