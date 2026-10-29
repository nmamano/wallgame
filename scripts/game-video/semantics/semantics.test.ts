import { describe, expect, test } from "bun:test";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { EngineFacts, GameFacts, HuntChange, PlyFacts } from "./facts";
import { labelGame } from "./labels";
import { checkSentence, factsOf, writeSentences } from "./sentences";

/*
 * Standard has two hunts: P1's cat to P2's mouse (walk1), P2's cat to P1's
 * mouse (walk2). A ply is written as the two walks before and after, the
 * mover's win chance before and after, and the walls.
 */
interface PlySpec {
  w1: [number, number];
  w2: [number, number];
  wc?: [number, number];
  walls?: string[];
  best?: string;
  bestWalls?: string[];
  bestWalks?: [number, number];
  mouseRan?: boolean;
  end?: boolean;
}

const hunt = (
  hunter: PlayerId,
  [before, after]: [number, number],
  mouseRan = false,
): HuntChange => ({
  hunter: { player: hunter, type: "cat" },
  target: { player: hunter === 1 ? 2 : 1, type: "mouse" },
  before,
  after,
  hunterFrom: "a1",
  hunterTo: "a2",
  targetFrom: "h8",
  targetTo: mouseRan ? "h7" : "h8",
});

const gameOf = (
  specs: PlySpec[],
  winner: PlayerId | null = null,
): GameFacts => ({
  game: {
    gameId: "T",
    variant: "standard",
    boardWidth: 8,
    boardHeight: 8,
    initialState: {} as GameFacts["game"]["initialState"],
    moves: specs.map(() => "Ca2"),
    seats: [
      { playerOrder: 1, kind: "guest", name: "Guest Ferret" },
      { playerOrder: 2, kind: "official bot", name: "Normal Bot" },
    ],
  },
  winner,
  engineBotId: "dw-transformer",
  plies: specs.map((s, ply): PlyFacts => {
    const mover: PlayerId = ply % 2 === 0 ? 1 : 2;
    const engine: EngineFacts | null = s.wc
      ? {
          before: s.wc[0],
          after: s.wc[1],
          delta: s.wc[1] - s.wc[0],
          afterFromResult: false,
          bestMove: s.best ?? "Ca2",
          playedBest: !s.best,
          bestWalls: s.bestWalls ?? [],
          bestWalks: s.bestWalks ?? null,
        }
      : null;
    return {
      ply,
      moveNumber: ply + 1,
      mover,
      notation: "Ca2",
      steps: [{ type: "cat", from: "a1", to: "a2" }],
      walls: s.walls ?? [],
      hunts: [
        hunt(1, s.w1, mover === 2 && s.mouseRan),
        hunt(2, s.w2, mover === 1 && s.mouseRan),
      ],
      engine,
      end: s.end ? { winner: mover, reason: "capture" } : null,
    };
  }),
});

const labels = (specs: PlySpec[], winner: PlayerId | null = null) =>
  labelGame(gameOf(specs, winner));

describe("labelGame", () => {
  test("a cat within 2 is a threat only when the engine agrees", () => {
    const routine = labels([{ w1: [4, 2], w2: [8, 8], wc: [0.5, 0.5] }]);
    expect(routine.plies[0].label).toBe("quiet");
    const real = labels([{ w1: [4, 2], w2: [8, 8], wc: [0.5, 0.8] }]);
    expect(real.plies[0].label).toBe("threat");
    expect(real.plies[0].focus).toMatchObject({ before: 4, after: 2 });
  });

  test("no engine, no threat and no blunder", () => {
    const l = labels([{ w1: [4, 2], w2: [8, 8] }]);
    expect(l.plies[0].label).toBe("quiet");
  });

  test("a save answers a threat, and is linked to it", () => {
    const l = labels([
      { w1: [4, 2], w2: [8, 8], wc: [0.5, 0.8] },
      { w1: [2, 9], w2: [8, 8], wc: [0.2, 0.25], walls: ["^a1"] },
    ]);
    expect(l.plies[1].label).toBe("save");
    expect(l.links).toContainEqual({ kind: "threat-save", from: 0, to: 1 });
  });

  test("the same wall with no threat before it is a detour", () => {
    const l = labels([
      { w1: [6, 4], w2: [8, 8], wc: [0.5, 0.5] },
      { w1: [4, 9], w2: [8, 8], wc: [0.5, 0.5], walls: ["^a1"] },
    ]);
    expect(l.plies[1].label).toBe("detour");
  });

  test("an escape: the mouse runs from next to the cat to 4 or more", () => {
    const l = labels([
      { w1: [3, 1], w2: [8, 8], wc: [0.5, 0.5] },
      { w1: [1, 4], w2: [8, 8], wc: [0.5, 0.5], mouseRan: true },
    ]);
    expect(l.plies[1].label).toBe("escape");
  });

  test("a blunder and its punish are linked; the flip that holds is a turn", () => {
    const l = labels([
      {
        w1: [6, 6],
        w2: [6, 4],
        wc: [0.7, 0.2],
        best: ">c4.^c3",
        bestWalls: [">c4", "^c3"],
      },
      { w1: [6, 6], w2: [4, 4], wc: [0.8, 0.82] },
    ]);
    expect(l.plies[0].label).toBe("turn");
    expect(l.plies[0].tags).toContain("missed-wall");
    expect(l.plies[1].label).toBe("punish");
    expect(l.plies[1].strength).toBe(1);
    expect(l.links).toContainEqual({ kind: "blunder-punish", from: 0, to: 1 });
  });

  test("a flip given back at once is a blunder, the reply a missed punish", () => {
    const l = labels([
      { w1: [6, 6], w2: [6, 6], wc: [0.9, 0.1] },
      { w1: [6, 6], w2: [6, 4], wc: [0.9, 0.1] },
      { w1: [6, 6], w2: [4, 12], wc: [0.9, 0.92], walls: [">b3"] },
    ]);
    expect(l.plies[0].label).toBe("blunder");
    expect(l.plies[1].label).toBe("turn");
    expect(l.plies[1].tags).toContain("missed-punish");
    expect(l.plies[2].label).toBe("punish");
  });

  test("own walls that lengthen the mover's own walk are a self-trap", () => {
    const l = labels([
      { w1: [4, 8], w2: [8, 9], wc: [0.5, 0.48], walls: ["^a1"] },
    ]);
    expect(l.plies[0].label).toBe("self-trap");
  });

  test("the move that reaches the mouse is the capture", () => {
    const l = labels([{ w1: [2, 0], w2: [5, 5], wc: [1, 1], end: true }], 1);
    expect(l.plies[0].label).toBe("capture");
  });
});

describe("factsOf", () => {
  test("the best move's walk is told only where it is better for the mover", () => {
    const best = (bestWalks: [number, number]) => {
      const game = gameOf([
        {
          w1: [6, 6],
          w2: [6, 4],
          wc: [0.7, 0.2],
          best: ">c4",
          bestWalls: [">c4"],
          bestWalks,
        },
      ]);
      return factsOf(game, labelGame(game), 0).find((f) => f.id === "0.best")!
        .text;
    };
    // The other side's cat 4 -> 9 with the best move: that is why it is best.
    expect(best([6, 9])).toContain("Normal Bot's cat would need 9 steps");
    // The mover's own cat longer (a wall that guards its mouse): not told.
    expect(best([8, 4])).not.toContain("would need");
  });
});

describe("checkSentence", () => {
  const game = gameOf([
    {
      w1: [6, 6],
      w2: [6, 4],
      wc: [0.7, 0.2],
      best: ">c4.^c3",
      bestWalls: [">c4", "^c3"],
    },
    { w1: [6, 6], w2: [4, 4], wc: [0.8, 0.82] },
  ]);
  const l = labelGame(game);
  const facts = [...factsOf(game, l, 0), ...factsOf(game, l, 1)];
  const seats = ["Guest Ferret", "Normal Bot"];
  const ids = (...names: string[]) => names.map((n) => `0.${n}`);

  test("a sentence made of cited facts passes", () => {
    expect(
      checkSentence(
        "Guest Ferret misses the walls >c4 and ^c3, and the win chance falls from 70% to 20%: a blunder.",
        ids("best", "engine", "label", "play"),
        facts,
        seats,
      ),
    ).toEqual([]);
  });

  test("a number, a cell or a name the facts do not hold fails", () => {
    const reasons = checkSentence(
      "Guest Raven's cat needs 9 steps from e5.",
      ids("play", "walk1"),
      facts,
      seats,
    );
    expect(reasons.join("; ")).toContain("number 9");
    expect(reasons.join("; ")).toContain("e5");
    expect(reasons.join("; ")).toContain("Guest Raven");
  });

  test("a judgment word needs a cited fact that says it", () => {
    expect(
      checkSentence(
        "Guest Ferret punishes the bot.",
        ids("play"),
        facts,
        seats,
      ),
    ).toEqual(['"punishes" needs a cited fact that says punish']);
    expect(
      checkSentence(
        "Normal Bot punishes the blunder.",
        ["1.play", "1.link1"],
        facts,
        seats,
      ),
    ).toEqual([]);
  });

  test("intent and feeling fail, and so does a fact of another move", () => {
    const reasons = checkSentence(
      "Guest Ferret panics.",
      ["7.play"],
      facts,
      seats,
    );
    expect(reasons.join("; ")).toContain("7.play");
    expect(reasons.join("; ")).toContain("panics");
  });

  test("a sentence that fails twice is replaced by the play fact", () => {
    let calls = 0;
    const out = writeSentences(game, l, () => {
      calls++;
      return [
        {
          ply: 0,
          sentence: "Guest Ferret wants 99 walls.",
          factIds: ["0.play"],
        },
        {
          ply: 1,
          sentence: "Normal Bot punishes the blunder.",
          factIds: ["1.play", "1.link1"],
        },
      ];
    });
    expect(calls).toBe(2);
    expect(out.sentences![0].fallback).toBe(true);
    expect(out.sentences![0].sentence).toBe(factsOf(game, l, 0)[0].text);
    expect(out.sentences![1]).toMatchObject({
      fallback: false,
      sentence: "Normal Bot punishes the blunder.",
    });
  });
});
