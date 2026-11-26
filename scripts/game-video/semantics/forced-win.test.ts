/*
 * The two slow reference tests (a whole no-win tree, and defenceOf with and
 * without the far walls) run only with FORCED_WIN_SLOW=1 (PM, 2026-11-26:
 * the pre-push hook timed out game-video tests under load). Run them once
 * after each change to forced-win.ts or defenceOf, and before each landing:
 *
 *   FORCED_WIN_SLOW=1 bun test scripts/game-video/semantics/forced-win.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { GameState } from "../../../shared/domain/game-state";
import { moveFromStandardNotation } from "../../../shared/domain/standard-notation";
import { replayDistances } from "../race-replay";
import { defenceOf } from "./facts";
import type { SemanticGame } from "./facts";
import {
  everyReplyLoses,
  forcedWinAt,
  type ForcedWin,
  movesOf,
  sameMove,
  winningMoves,
} from "./forced-win";

const slow = process.env.FORCED_WIN_SLOW === "1";

const fixture = (id: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`fixtures/${id}.json`, import.meta.url), "utf8"),
    ) as { game: SemanticGame }
  ).game;
const before = (id: string, ply: number) => {
  const game = fixture(id);
  return { game, state: replayDistances(game).states[ply] };
};
const play = (s: GameState, m: string) =>
  s.applyGameAction({
    kind: "move",
    move: moveFromStandardNotation(m, s.config.boardHeight),
    playerId: s.turn,
    timestamp: 0,
  });

describe("forced wins (exact search on the game rules)", () => {
  test("qKeMIIRp 39: one first move forces the capture in 2 turns, and the played Ca6 only delayed it", () => {
    const { game, state } = before("qKeMIIRp", 39);
    const f = forcedWinAt(state, 39, game.moves[39]);
    expect(f).toMatchObject({
      covered: true,
      mover: 2,
      turns: 2,
      winningCount: 1,
      winning: ["Ca5.^a7"],
      played: "Ca6",
      playedVerdict: "delayed",
    });
    expect(f.legalCount).toBeGreaterThan(1000);
  });

  test("KqbeyXIF 14 (the /go/2 puzzle): the live search gives the stored result", () => {
    const { game, state } = before("KqbeyXIF", 14);
    const stored = (
      JSON.parse(
        readFileSync(
          new URL("fixtures/KqbeyXIF.json", import.meta.url),
          "utf8",
        ),
      ) as { forced: ForcedWin[] }
    ).forced.find((f) => f.ply === 14);
    expect(forcedWinAt(state, 14, game.moves[14])).toEqual(stored!);
  });

  test("EDP5pYum 38: Ch2.Mb2 (the engine's line) forces a capture in 3 turns", () => {
    const { state } = before("EDP5pYum", 38);
    expect(everyReplyLoses(play(state, "Ch2.Mb2"), 1)).toBe(true);
    // The played Cg2 does not.
    expect(everyReplyLoses(play(state, "Cg2"), 1)).toBe(false);
  }, 120_000);

  test("a reply that walks the defender's mouse onto the mover's cat loses (EDP5pYum 38, Mh2)", () => {
    const { state } = before("EDP5pYum", 38);
    const end = play(play(state, "Ch2.Mb2"), "Mh2");
    expect(end.status).toBe("finished");
    expect(end.result?.winner).toBe(1);
  });

  test.skipIf(!slow)(
    "4CRXWe_w 35: the value net's 94% -> 13% is no forced capture in 3 turns",
    () => {
      const { game, state } = before("4CRXWe_w", 35);
      expect(forcedWinAt(state, 35, game.moves[35]).turns).toBeNull();
    },
    120_000,
  );

  test("the defender's counter-threat refutes the attack (JbpdRM9D 11)", () => {
    const { state } = before("JbpdRM9D", 11);
    // A cat step brings the mover's cat within reach, but the defender's own
    // cat is in reach then and captures first.
    expect(defenceOf(play(state, "Cb4"), state.turn)).toBe("wins-first");
    expect(winningMoves(state, state.turn, 2)).toEqual([]);
  });

  test("the pruned 2-turn search finds what the full one finds", () => {
    for (const [id, ply] of [
      ["qKeMIIRp", 39],
      ["JbpdRM9D", 11],
      ["G0Oa_TzU", 31],
      ["EDP5pYum", 38],
    ] as const) {
      const { state } = before(id, ply);
      const pruned = winningMoves(state, state.turn, 2).map((m) =>
        m.split(".").sort().join("."),
      );
      const full = winningMoves(state, state.turn, 2, false).map((m) =>
        m.split(".").sort().join("."),
      );
      expect(pruned.sort()).toEqual(full.sort());
    }
  }, 120_000);

  test("a one-turn win is no puzzle, and a variant with no test is not covered", () => {
    const { game, state } = before("qKeMIIRp", 42);
    expect(forcedWinAt(state, 42, game.moves[42])).toMatchObject({
      covered: true,
      turns: null,
    });
    const classic = {
      ...state,
      config: { ...state.config, variant: "classic" },
    };
    expect(
      forcedWinAt(classic as unknown as GameState, 42, game.moves[42]).covered,
    ).toBe(false);
  });

  test("past the time cap a ply is not known, never a no", () => {
    const { game, state } = before("EDP5pYum", 38);
    expect(forcedWinAt(state, 38, game.moves[38], 1)).toMatchObject({
      timedOut: true,
      turns: null,
    });
  });

  test.skipIf(!slow)(
    "defenceOf without the far walls gives the same answer as with all walls",
    () => {
      // Every position after a cat-led move that brings a cat within reach,
      // over 2 stored games with traps and counter-threats.
      let checked = 0;
      for (const id of ["JbpdRM9D", "qKeMIIRp"]) {
        const game = fixture(id);
        const states = replayDistances(game).states;
        for (let p = 0; p < game.moves.length; p++) {
          const s = states[p];
          for (const m of movesOf(s, true)) {
            let n: GameState;
            try {
              n = play(s, m);
            } catch {
              continue;
            }
            if (n.status !== "playing") continue;
            const fast = defenceOf(n, s.turn);
            if (fast === "out-of-reach") continue;
            expect(defenceOf(n, s.turn, true)).toBe(fast);
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(50);
    },
    120_000,
  );

  test("the same move with its actions in another order is one move", () => {
    expect(sameMove("Ch2.Mb2", "Mb2.Ch2")).toBe(true);
    expect(sameMove("Ch2.Mb2", "Ch2.Mb3")).toBe(false);
  });
});
