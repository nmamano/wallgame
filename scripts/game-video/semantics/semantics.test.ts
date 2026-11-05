import { describe, expect, test } from "bun:test";
import type { PlayerId } from "../../../shared/domain/game-types";
import type {
  Defence,
  EngineFacts,
  GameFacts,
  HuntChange,
  PlyFacts,
} from "./facts";
import { readFileSync } from "node:fs";
import { siteMoveNumber } from "../site-move.mjs";
import { gameFacts, type EngineData, type SemanticGame } from "./facts";
import {
  countersShow,
  isMoment,
  labelGame,
  movesToCatch,
  raceWords,
} from "./labels";
import {
  checkSentence,
  factsOf,
  renderTable,
  writeSentences,
} from "./sentences";
import { checkSeen } from "./vision";

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
  bestSteps?: { pawn: "cat" | "mouse"; to: string }[];
  bestWalks?: [number, number];
  mouseRan?: boolean;
  /** The other side's mouse room before and after (default 40 -> 40). */
  room?: [number, number];
  end?: boolean;
  /** A move of walls only: no pawn step. */
  noStep?: boolean;
  /** How the other side can answer (default out-of-reach). */
  defence?: Defence;
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
    result: winner
      ? { winner, reason: "capture" }
      : { reason: "draw-agreement" },
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
          bestSteps: s.bestSteps ?? (s.best ? [] : [{ pawn: "cat", to: "a2" }]),
          bestWalks: s.bestWalks ?? null,
        }
      : null;
    return {
      ply,
      moveNumber: siteMoveNumber(ply),
      mover,
      notation: "Ca2",
      steps: s.noStep ? [] : [{ type: "cat", from: "a1", to: "a2" }],
      walls: s.walls ?? [],
      hunts: [
        hunt(1, s.w1, mover === 2 && s.mouseRan),
        hunt(2, s.w2, mover === 1 && s.mouseRan),
      ],
      rooms: [
        {
          target: { player: mover === 1 ? 2 : 1, type: "mouse" },
          hunters: [{ player: mover, type: "cat" }],
          before: (s.room ?? [40, 40])[0],
          after: (s.room ?? [40, 40])[1],
        },
      ],
      engine,
      end: s.end ? { winner: mover, reason: "capture" } : null,
      defence: s.end ? null : (s.defence ?? "out-of-reach"),
    };
  }),
});

const labels = (specs: PlySpec[], winner: PlayerId | null = null) =>
  labelGame(gameOf(specs, winner));

describe("labelGame", () => {
  test("a cat within 2 is a threat, whatever the engine says (ymU8fqsF ply 14)", () => {
    const losing = labels([{ w1: [4, 2], w2: [8, 8], wc: [0.4, 0.3] }]);
    expect(losing.plies[0].label).toBe("threat");
    expect(losing.plies[0].strength).toBe(0.2);
    expect(losing.plies[0].tags).toContain("engine-losing");
    const real = labels([{ w1: [4, 2], w2: [8, 8], wc: [0.5, 0.8] }]);
    expect(real.plies[0].label).toBe("threat");
    expect(real.plies[0].focus).toMatchObject({ before: 4, after: 2 });
    expect(real.plies[0].tags).not.toContain("engine-losing");
    const far = labels([{ w1: [5, 3], w2: [8, 8], wc: [0.5, 0.8] }]);
    expect(far.plies[0].label).toBe("quiet");
  });

  test("no engine: a threat from the board, no blunder", () => {
    const l = labels([{ w1: [4, 2], w2: [8, 8] }]);
    expect(l.plies[0].label).toBe("threat");
  });

  test("a save of a threat the engine calls losing is still a save", () => {
    const l = labels([
      { w1: [4, 2], w2: [8, 8], wc: [0.4, 0.3] },
      { w1: [2, 10], w2: [8, 8], wc: [0.7, 0.68], walls: ["^a1"] },
    ]);
    expect(l.plies[1].label).toBe("save");
    expect(l.links).toContainEqual({ kind: "threat-save", from: 0, to: 1 });
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
      { w1: [10, 8], w2: [8, 8], wc: [0.5, 0.5] },
      { w1: [8, 13], w2: [8, 8], wc: [0.5, 0.6], walls: ["^a1"] },
    ]);
    expect(l.plies[1].label).toBe("detour");
    // The same wall that the engine does not move beyond its noise: quiet.
    const flat = labels([
      { w1: [10, 8], w2: [8, 8], wc: [0.5, 0.5] },
      { w1: [8, 13], w2: [8, 8], wc: [0.5, 0.55], walls: ["^a1"] },
    ]);
    expect(flat.plies[1].label).toBe("quiet");
    expect(flat.plies[1].tags).toContain("detour");
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
      { w1: [6, 11], w2: [4, 4], wc: [0.8, 0.82], walls: ["^a3"] },
    ]);
    expect(l.plies[0].label).toBe("turn");
    expect(l.plies[0].tags).toContain("missed-wall");
    expect(l.plies[1].label).toBe("punish");
    expect(l.plies[1].strength).toBe(1);
    expect(l.links).toContainEqual({
      kind: "blunder-punish",
      from: 0,
      to: 1,
      costShown: true,
    });
  });

  test("a wall punish whose cost the board does not show is no punish (C36 C)", () => {
    const l = labels([
      {
        w1: [6, 6],
        w2: [6, 4],
        wc: [0.7, 0.2],
        best: ">c4.^c3",
        bestWalls: [">c4", "^c3"],
      },
      { w1: [6, 9], w2: [4, 4], wc: [0.8, 0.82], walls: ["^a3"] },
    ]);
    expect(l.plies[1].label).not.toBe("punish");
    expect(l.plies[1].tags).toContain("kept-gain");
    expect(l.links.filter((k) => k.kind === "blunder-punish")).toEqual([]);
  });

  test("a reply that keeps the gain but shows nothing is no punish (VR1 B1)", () => {
    const l = labels([
      { w1: [12, 12], w2: [12, 12], wc: [0.75, 0.28] },
      // Both walks stay at 12: the gain is kept, nothing is seen.
      { w1: [12, 12], w2: [12, 12], wc: [0.72, 0.76], walls: ["^a3", "^b3"] },
      { w1: [12, 12], w2: [12, 12], wc: [0.25, 0.25] },
    ]);
    expect(l.plies[1].label).toBe("quiet");
    expect(l.plies[1].tags).toContain("kept-gain");
    expect(l.links).toEqual([]);
    // The mover's own cat coming within reach is seen.
    const reach = labels([
      { w1: [6, 6], w2: [6, 6], wc: [0.75, 0.28] },
      { w1: [6, 6], w2: [4, 2], wc: [0.72, 0.76] },
    ]);
    expect(reach.plies[1].label).toBe("punish");
    expect(reach.plies[1].focus).toMatchObject({ before: 4, after: 2 });
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

  test("a mouse that steps onto the cat is the capture too", () => {
    // Ply 1 is P2's move: P1's cat walk (w1) to P2's mouse goes 2 -> 0.
    const game = gameOf([
      { w1: [3, 2], w2: [5, 5], wc: [0.9, 0.95] },
      { w1: [2, 0], w2: [5, 5], wc: [0.05, 0], end: true },
    ]);
    game.plies[1].end = { winner: 1, reason: "capture" };
    const l = labelGame(game);
    expect(l.plies[1].label).toBe("capture");
    expect(factsOf(game, l, 1).find((f) => f.id === "1.end")!.text).toBe(
      "Normal Bot's mouse steps onto Guest Ferret's cat (a capture): Guest Ferret wins.",
    );
  });

  test("the move that reaches the mouse is the capture", () => {
    const l = labels([{ w1: [2, 0], w2: [5, 5], wc: [1, 1], end: true }], 1);
    expect(l.plies[0].label).toBe("capture");
  });
});

describe("huh (C43)", () => {
  test("a cat 1 or 2 from the mouse that does not take it", () => {
    const l = labels([{ w1: [2, 1], w2: [8, 8], wc: [0.99, 0.99] }]);
    expect(l.plies[0].tags).toContain("huh");
    expect(l.plies[0].huh).toEqual({
      kind: "missed-capture",
      walk: 2,
      shown: false,
    });
    expect(isMoment(l.plies[0])).toBe(true);
    const took = labels([{ w1: [2, 0], w2: [8, 8], end: true }], 1);
    expect(took.plies[0].tags).not.toContain("huh");
  });

  test("a threatened mouse that stays when the best move steps it away", () => {
    const run = { pawn: "mouse" as const, to: "h7" };
    const l = labels([
      {
        w1: [8, 6],
        w2: [2, 2],
        wc: [0.1, 0.0],
        best: "Mh7",
        bestSteps: [run],
        bestWalks: [8, 4],
      },
    ]);
    expect(l.plies[0].huh).toEqual({
      kind: "ignored-threat",
      walk: 2,
      shown: false,
    });
    // bestWalks is in hunts order (VR1, review 133 N1): the step that saves
    // P1's mouse must raise hunts[1] (P2's cat), not hunts[0].
    const other = labels([
      {
        w1: [8, 6],
        w2: [2, 2],
        wc: [0.1, 0.0],
        best: "Mh7",
        bestSteps: [run],
        bestWalks: [8, 2],
      },
    ]);
    expect(other.plies[0].tags).not.toContain("huh");
    // The best move is a wall: no step a viewer sees.
    const wall = labels([
      {
        w1: [8, 6],
        w2: [2, 2],
        wc: [0.1, 0.0],
        best: ">g7",
        bestWalks: [8, 4],
      },
    ]);
    expect(wall.plies[0].tags).not.toContain("huh");
    // No engine: no way to know a step out of reach exists.
    expect(labels([{ w1: [8, 6], w2: [2, 2] }]).plies[0].tags).not.toContain(
      "huh",
    );
  });

  test("walls that change no counter are no huh (C45, X-TQBFZA ply 11)", () => {
    const l = labels([
      { w1: [5, 5], w2: [3, 3], walls: ["^a1", "^b1"], noStep: true },
    ]);
    expect(l.plies[0].tags).not.toContain("huh");
    expect(fixtureLabels("X-TQBFZA").plies[11].tags).not.toContain("huh");
  });

  test("a forced move after a trap is no huh (Director, 2026-11-05)", () => {
    // P2 moves at ply 1; its mouse runs into the cat's reach (4 -> 1).
    const run = {
      w1: [4, 1] as [number, number],
      w2: [8, 8] as [number, number],
      mouseRan: true,
    };
    const free = labels([{ w1: [5, 4], w2: [8, 8] }, run]);
    expect(free.plies[1].huh?.kind).toBe("mouse-into-reach");
    const trapped = labels([
      { w1: [5, 4], w2: [8, 8], defence: "no-answer" },
      run,
    ]);
    expect(trapped.plies[1].tags).not.toContain("huh");
  });

  test("a mouse that steps into the cat's reach", () => {
    // P1 moves; hunt 2 is P2's cat on P1's mouse, which runs 4 -> 2.
    const l = labels([{ w1: [8, 8], w2: [4, 2], mouseRan: true }]);
    expect(l.plies[0].huh).toEqual({
      kind: "mouse-into-reach",
      walk: 2,
      shown: false,
    });
  });
});

describe("strong and weak threats (2026-11-01)", () => {
  test("z5S6UPIi 37: only a full turn answers Nil's threat: strong", () => {
    const l = fixtureLabels("z5S6UPIi");
    expect(l.plies[37].label).toBe("threat");
    expect(l.plies[37].tags).toContain("strong-threat");
  });

  test("FTFHyntE 32: the guest captures first: weak", () => {
    const l = fixtureLabels("FTFHyntE");
    expect(l.plies[32].tags).toContain("threat");
    expect(l.plies[32].tags).toContain("weak-threat");
    expect(l.plies[33].label).toBe("capture");
  });

  test("a threat one action answers has neither tag", () => {
    const l = labels([
      { w1: [4, 2], w2: [8, 8], wc: [0.5, 0.8], defence: "one-action" },
    ]);
    expect(l.plies[0].tags).not.toContain("strong-threat");
    expect(l.plies[0].tags).not.toContain("weak-threat");
  });
});

describe("trap-closes on the board (Director, 2026-11-01)", () => {
  test("the move after which the other side first has no safe reply", () => {
    const l = labels([
      { w1: [5, 3], w2: [8, 8] },
      { w1: [3, 3], w2: [8, 8] },
      { w1: [3, 1], w2: [8, 8], defence: "no-answer" },
      { w1: [1, 1], w2: [8, 8] },
    ]);
    expect(l.plies[2].label).toBe("trap-closes");
    expect(l.plies[2].tags).toContain("no-escape");
    expect(l.plies[0].tags).not.toContain("no-escape");
  });

  test("a trap that was already closed is not closed again", () => {
    const l = labels([
      { w1: [3, 1], w2: [8, 8], defence: "no-answer" },
      { w1: [1, 1], w2: [8, 8] },
      { w1: [1, 1], w2: [8, 8], defence: "no-answer" },
    ]);
    expect(l.plies[0].label).toBe("trap-closes");
    expect(l.plies[2].tags).not.toContain("no-escape");
  });

  test("JbpdRM9D: the cat on f2, the only way out of g2, closes it (ply 20)", () => {
    const l = fixtureLabels("JbpdRM9D");
    const closed = l.plies.filter((p) => p.tags.includes("no-escape"));
    expect(closed.map((p) => p.ply)).toEqual([20]);
    expect(l.plies[20].label).toBe("trap-closes");
    // Ply 15: the cat 1 from the mouse, but the bot walls it off.
    expect(l.plies[15].tags).not.toContain("no-escape");
  });
});

describe("trap words", () => {
  test("a self-trap allows a trap of one's own cat, not of the other side", () => {
    const game = gameOf([
      { w1: [4, 8], w2: [8, 9], wc: [0.5, 0.48], walls: ["^a1"] },
    ]);
    const l = labelGame(game);
    const facts = factsOf(game, l, 0);
    const cite = ["0.play", "0.label", "0.walk2"];
    const seats = ["Guest Ferret", "Normal Bot"];
    expect(
      checkSentence(
        "Guest Ferret traps its own cat with ^a1.",
        cite,
        facts,
        seats,
      ),
    ).toEqual([]);
    expect(
      checkSentence(
        "Guest Ferret traps Normal Bot with ^a1.",
        cite,
        facts,
        seats,
      ),
    ).toEqual([
      '"traps" needs a cited fact that says trap-closes or seal or box in',
    ]);
    // "own" elsewhere in the sentence does not make the trap the mover's.
    expect(
      checkSentence(
        "Guest Ferret traps Normal Bot's mouse in its own corner with ^a1.",
        cite,
        facts,
        seats,
      ),
    ).toEqual([
      '"traps" needs a cited fact that says trap-closes or seal or box in',
    ]);
  });
});

describe("label words", () => {
  test('the tag "missed-punish" does not let a sentence say "punishes"', () => {
    const game = gameOf([
      { w1: [6, 6], w2: [6, 6], wc: [0.9, 0.1] },
      { w1: [6, 6], w2: [6, 4], wc: [0.9, 0.1] },
      { w1: [6, 6], w2: [4, 12], wc: [0.9, 0.92], walls: [">b3"] },
    ]);
    const l = labelGame(game);
    expect(l.plies[1].tags).toContain("missed-punish");
    const facts = factsOf(game, l, 1);
    expect(
      checkSentence(
        "Normal Bot punishes the blunder.",
        ["1.play", "1.label"],
        facts,
        ["Guest Ferret", "Normal Bot"],
      ),
    ).toEqual(['"punishes" needs a cited fact that says punish']);
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

describe("box-in", () => {
  test("walls that cut a mouse's room by 40% and to 25 or fewer box it in", () => {
    const l = labels([
      {
        w1: [9, 9],
        w2: [9, 9],
        wc: [0.5, 0.5],
        walls: [">f4", "^g3"],
        room: [42, 20],
      },
    ]);
    expect(l.plies[0].label).toBe("box-in");
    // Not enough of a cut, or still too much room: no box-in.
    const small = labels([
      {
        w1: [9, 9],
        w2: [9, 9],
        wc: [0.5, 0.5],
        walls: [">f4"],
        room: [30, 20],
      },
    ]);
    expect(small.plies[0].tags).not.toContain("box-in");
    const roomy = labels([
      {
        w1: [9, 9],
        w2: [9, 9],
        wc: [0.5, 0.5],
        walls: [">f4"],
        room: [60, 30],
      },
    ]);
    expect(roomy.plies[0].tags).not.toContain("box-in");
  });

  test("under a blunder it is a tag, and the sentence may say boxes in", () => {
    const game = gameOf([
      {
        w1: [9, 9],
        w2: [9, 9],
        wc: [0.77, 0.36],
        walls: [">f4", "^g3"],
        room: [42, 20],
      },
    ]);
    const l = labelGame(game);
    expect(l.plies[0].label).toBe("blunder");
    expect(l.plies[0].tags).toContain("box-in");
    const facts = factsOf(game, l, 0);
    expect(facts.find((f) => f.id === "0.box")!.text).toBe(
      "The walls >f4 and ^g3 box in Normal Bot's mouse: the cells it reaches before Guest Ferret's cat fall from 42 to 20.",
    );
    const seats = ["Guest Ferret", "Normal Bot"];
    expect(
      checkSentence(
        "Guest Ferret's walls >f4 and ^g3 box in Normal Bot's mouse, from 42 to 20 cells.",
        ["0.box", "0.play"],
        facts,
        seats,
      ),
    ).toEqual([]);
    expect(
      checkSentence(
        "Guest Ferret boxes in the board.",
        ["0.play"],
        facts,
        seats,
      ),
    ).toEqual(['"boxes in" needs a cited fact that says box in']);
  });
});

describe("writeSentences and box-in", () => {
  test("a sentence on a box-in move that does not cite the box is retried", () => {
    const game = gameOf([
      {
        w1: [9, 9],
        w2: [9, 9],
        wc: [0.77, 0.36],
        walls: [">f4", "^g3"],
        room: [42, 20],
      },
    ]);
    const l = labelGame(game);
    const asked: string[] = [];
    const out = writeSentences(game, l, (input) => {
      asked.push(input);
      return asked.length === 1
        ? [
            {
              ply: 0,
              sentence: "Guest Ferret places >f4 and ^g3.",
              factIds: ["0.play"],
            },
          ]
        : [
            {
              ply: 0,
              sentence:
                "Guest Ferret's walls >f4 and ^g3 box in Normal Bot's mouse.",
              factIds: ["0.box", "0.play"],
            },
          ];
    });
    expect(asked[1]).toContain("does not tell the box-in (cite 0.box)");
    // A wall alone does not say it (VR1, 2026-10-30)...
    expect(asked[1]).toContain("does not say the box-in");
    expect(out.sentences![0]).toMatchObject({
      fallback: false,
      factIds: ["0.box", "0.play"],
    });
  });
});

describe("a box-in sentence says the box", () => {
  test("citing the box fact is not enough: the words must say it", () => {
    const game = gameOf([
      {
        w1: [9, 9],
        w2: [9, 9],
        wc: [0.5, 0.5],
        walls: [">f4", "^g3"],
        room: [42, 20],
      },
    ]);
    const l = labelGame(game);
    const asked: string[] = [];
    const out = writeSentences(game, l, (input) => {
      asked.push(input);
      return [
        {
          ply: 0,
          sentence:
            asked.length === 1
              ? "Guest Ferret plays a wall move."
              : "Guest Ferret's walls box in Normal Bot's mouse.",
          factIds: ["0.box", "0.play"],
        },
      ];
    });
    expect(asked[1]).toContain(
      'does not say the box-in (\\"box in\\" or its walls >f4, ^g3)',
    );
    expect(out.sentences![0].fallback).toBe(false);
  });
});

/** A stored game with the engine's scores of 2026-10-29, labelled. */
const fixtureLabels = (gameId: string) => {
  const fixture = JSON.parse(
    readFileSync(new URL(`fixtures/${gameId}.json`, import.meta.url), "utf8"),
  ) as { game: SemanticGame; engine: EngineData };
  return labelGame(gameFacts(fixture.game, fixture.engine));
};

describe("the stored result over the replay's", () => {
  // A capture by P1 that the one-move rule (before 2026-09-01) made a draw:
  // the replay under today's rules calls it a win.
  const fixture = JSON.parse(
    readFileSync(new URL("fixtures/VX-IPenv.json", import.meta.url), "utf8"),
  ) as { game: SemanticGame; engine: EngineData };
  const draw = gameFacts(
    { ...fixture.game, result: { reason: "one-move-rule" } },
    fixture.engine,
  );

  test("a stored draw has no winner, and its last move says the rule", () => {
    // The same moves stored as a capture win: the replay is not asked.
    expect(fixture.game.result).toEqual({ winner: 1, reason: "capture" });
    expect(gameFacts(fixture.game, fixture.engine).winner).toBe(1);
    expect(draw.winner).toBeNull();
    const last = draw.plies.at(-1)!;
    expect(last.end).toEqual({ winner: null, reason: "one-move-rule" });
    const labels = labelGame(draw);
    expect(labels.plies.at(-1)!.label).toBe("capture");
    const end = factsOf(draw, labels, last.ply).find((f) =>
      f.id.endsWith(".end"),
    )!.text;
    expect(end).toContain("(a capture), but the other cat could catch");
    expect(end).not.toContain("wins");
  });

  test("the table's title says the draw", () => {
    const title = renderTable({
      facts: draw,
      labels: labelGame(draw),
      sentences: null,
      seen: null,
    }).split("\n")[0];
    expect(title).toEndWith(
      "27 plies (the site's move list ends at 14.), a draw (one-move-rule)",
    );
  });
});

/*
 * Regression fixtures: what a move of a real game means, by game id and ply
 * (0-based) only. Each one was a review finding on a daily video.
 */
describe("fixtures: what a move means", () => {
  test("v-lQeZ8T: the walls of ply 4 box in the mouse (a tag under the blunder)", () => {
    const l = fixtureLabels("v-lQeZ8T");
    expect(l.plies[4].label).toBe("blunder");
    expect(l.plies[4].tags).toContain("box-in");
  });

  test("v-lQeZ8T: the mouse's step at ply 25 (cat 1 -> 3) is no escape", () => {
    const l = fixtureLabels("v-lQeZ8T");
    expect(l.plies[25].label).toBe("quiet");
    expect(l.plies[25].focus).toMatchObject({ before: 1, after: 3 });
  });

  test("v-lQeZ8T: ply 33, the mouse steps onto the cat, is the capture", () => {
    const l = fixtureLabels("v-lQeZ8T");
    expect(l.plies[33].label).toBe("capture");
    expect(l.plies[33].mover).toBe(2);
    expect(l.plies[33].focus.hunter).toEqual({ player: 1, type: "cat" });
  });

  test("VX-IPenv: the threat at ply 14 is on the guest's mouse", () => {
    const l = fixtureLabels("VX-IPenv");
    expect(l.plies[14].label).toBe("threat");
    expect(l.plies[14].focus.target).toEqual({ player: 2, type: "mouse" });
  });

  test("8FroT1GU: the capture at ply 44, no turn after ply 7, no trap-closes (C36)", () => {
    const l = fixtureLabels("8FroT1GU");
    expect(l.plies[44].label).toBe("capture");
    // The engine crosses 90% on a move that swings it by under 15 points:
    // nothing a viewer sees, so no seal and no sealed-capture link. The trap
    // on the board closes at ply 42 (the cat's Cf2), two plies before.
    expect(
      l.plies.filter((p) => p.label === "trap-closes").map((p) => p.ply),
    ).toEqual([42]);
    expect(l.plies[42].tags).toContain("no-escape");
    expect(l.links.filter((k) => k.kind === "sealed-capture")).toEqual([]);
    expect(l.plies.filter((p) => p.ply > 7 && p.tags.includes("turn"))).toEqual(
      [],
    );
    expect(l.links.filter((k) => k.kind === "blunder-punish")).toEqual([]);
  });
});

describe("a box-in told by its walls", () => {
  test("a wall with the boxed mouse's owner says it; the own-walk form passes", () => {
    const game = gameOf([
      {
        w1: [9, 9],
        w2: [9, 9],
        wc: [0.5, 0.5],
        walls: [">f4", "^g3"],
        room: [42, 20],
      },
    ]);
    const l = labelGame(game);
    const out = writeSentences(game, l, () => [
      {
        ply: 0,
        sentence:
          "Guest Ferret's walls >f4 and ^g3 close Normal Bot's mouse in a corner.",
        factIds: ["0.box", "0.play"],
      },
    ]);
    expect(out.sentences![0].fallback).toBe(false);
    const facts = factsOf(game, l, 0);
    expect(
      checkSentence(
        "Guest Ferret's own cat walk stays at 9 steps.",
        ["0.walk1"],
        facts,
        ["Guest Ferret", "Normal Bot"],
      ),
    ).toEqual([]);
  });
});

describe("the race and its moments (2Xnv0iiY, engine of 2026-10-31; C36)", () => {
  const l = fixtureLabels("2Xnv0iiY");
  const names = { 1: "P1", 2: "P2" } as const;

  test("every ply carries the race before and after it, in words", () => {
    expect(l.plies[26].race.before).toEqual({
      walks: { 1: 9, 2: 9 },
      toMove: 1,
    });
    expect(raceWords(l.plies[26].race.before, names)).toBe(
      "tied 9-9, P1 to move",
    );
    expect(raceWords(l.plies[26].race.after, names)).toBe(
      "P1 leads by 2 (9-11, P2 to move)",
    );
    // A plain cat step keeps the race; walls that add 4 gain 2.
    expect(l.plies[28].raceGain).toBe(0);
    expect(l.plies[10].raceGain).toBe(2);
  });

  test("the counters show a tie turned into the mover's lead", () => {
    expect(countersShow(l.plies[26])).toBe(true);
    // A cat step from a lead to a bigger lead flips nothing.
    expect(countersShow(l.plies[38])).toBe(false);
  });

  test("a wall-war answer is quiet with a detour tag", () => {
    // Ply 9: the bot's +4 on P1's cat, given back by P1's +4 at once.
    expect(l.plies[9].label).toBe("quiet");
    expect(l.plies[9].tags).toContain("detour");
  });

  test("own-wall: the bot's cat stops at its own wall >b2 of ply 7", () => {
    expect(l.plies[37].tags).toContain("own-wall");
    expect(l.plies[37].ownWall).toEqual({ wall: ">b2", ply: 7 });
    expect(isMoment(l.plies[37])).toBe(true);
  });

  test("dodge: P1's mouse steps behind a wall (b3 -> b2)", () => {
    expect(l.plies[34].tags).toContain("dodge");
    expect(isMoment(l.plies[34])).toBe(true);
    expect(l.plies[33].tags).not.toContain("dodge");
  });

  test("ply 26 is no trap-closes: it swings neither the race nor the engine", () => {
    // 9-9 with P1 to move, then 9-11 with P2 to move: the same race as a
    // plain step (7-9); the engine 89% -> 90%.
    expect(l.plies[26].raceGain).toBe(0);
    expect(l.plies[26].label).toBe("quiet");
    expect(l.turningPoint).toContain("from ply 9 (move 5..., Superhuman Bot)");
    expect(l.turningPoint).toContain("the capture at ply 40");
  });

  test("a near miss: the cat steps to a new cell beside the mouse (ply 39)", () => {
    expect(l.plies[39].label).toBe("standoff");
  });

  test("a save by the race: the bot's ^g1 at G0Oa_TzU ply 31", () => {
    const g = fixtureLabels("G0Oa_TzU");
    // It also leaves the guest no reply that stops the capture: the trap
    // label outranks the save, which stays a tag.
    expect(g.plies[31].label).toBe("trap-closes");
    expect(g.plies[31].tags).toContain("save");
    expect(g.plies[31].tags).toContain("race-save");
    expect(g.plies[31].raceWinner).toEqual({ plainStep: 1, played: 2 });
    // The opening wall war flips the walk-only race too, far from the end.
    expect(g.plies[3].tags).not.toContain("race-save");
  });
});

describe("costShown (VX-IPenv, engine of 2026-10-29)", () => {
  test("a punish that a wall undoes next move shows no cost; 2 -> 16 does", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("fixtures/VX-IPenv.json", import.meta.url), "utf8"),
    ) as { game: SemanticGame; engine: EngineData };
    const l = labelGame(gameFacts(fixture.game, fixture.engine));
    const link = (from: number) =>
      l.links.find((k) => k.kind === "blunder-punish" && k.from === from);
    // Ply 9: Normal Bot's cat 2 -> 4, Guest Jackal's 3 -> 2; walled back at once.
    expect(link(8)).toMatchObject({ to: 9, costShown: false });
    // Ply 12: ^a1 ^b1, Guest Jackal's cat 2 -> 16.
    expect(link(11)).toMatchObject({ to: 12, costShown: true });
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
    { w1: [6, 11], w2: [4, 4], wc: [0.8, 0.82], walls: ["^a3"] },
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

  test('"best" needs the top-choice fact, "misses" the preferred fact (VR1 B2)', () => {
    // Move 1 is the engine's top choice; move 0 is not (see the game above).
    const top = ["1.best", "1.play"];
    const notTop = ["0.best", "0.play"];
    expect(
      checkSentence("Normal Bot plays the best move.", top, facts, seats),
    ).toEqual([]);
    expect(
      checkSentence("Guest Ferret plays the best move.", notTop, facts, seats),
    ).toEqual(['"best" needs a cited fact that says top choice']);
    expect(
      checkSentence("Guest Ferret misses >c4.", notTop, facts, seats),
    ).toEqual([]);
    expect(
      checkSentence("Normal Bot skips a wall.", top, facts, seats),
    ).toEqual(['"skips" needs a cited fact that says preferred']);
  });

  test("engine notation is refused; the preferred move is told in words", () => {
    expect(
      checkSentence(
        "Guest Ferret misses Cg5 with >c4.",
        ["0.best", "0.play"],
        facts,
        seats,
      ),
    ).toContain("uses engine notation Cg5; say the pawn step in words");
    const game = gameOf([
      {
        w1: [6, 6],
        w2: [6, 6],
        wc: [0.7, 0.2],
        best: "Cg5.Mh4.>e7",
        bestWalls: [">e7"],
        bestSteps: [
          { pawn: "cat", to: "g5" },
          { pawn: "mouse", to: "h4" },
        ],
      },
    ]);
    const best = factsOf(game, labelGame(game), 0).find(
      (f) => f.id === "0.best",
    )!.text;
    expect(best).toBe(
      "Instead of this move, the engine preferred a cat step to g5 and a mouse step to h4 and the wall >e7.",
    );
  });

  test('number words are checked, "one" before a unit too (VR1 B3)', () => {
    const check = (sentence: string) =>
      checkSentence(sentence, ids("walk2"), facts, seats);
    expect(check("Normal Bot's cat is one step from the mouse.")).toEqual([
      '"one step" (1) is not in the cited facts',
    ]);
    expect(check("Normal Bot's cat needs seventeen steps.")).toEqual([
      '"seventeen" (17) is not in the cited facts',
    ]);
    expect(check("Normal Bot's cat needs thirty steps.")).toHaveLength(1);
    expect(check("Normal Bot's cat needs four steps.")).toEqual([]);
    expect(check("One of the walls is >c4.")).toHaveLength(1); // >c4 uncited
  });

  test('"from N to M" must be a cited before/after pair, in order', () => {
    const check = (sentence: string) =>
      checkSentence(sentence, ids("walk2", "engine"), facts, seats);
    expect(check("Normal Bot's walk falls from 6 to 4.")).toEqual([]);
    expect(check("Normal Bot's walk grows from 4 to 6.")).toEqual([
      '"from 4 to 6" is not a before/after pair of the cited facts',
    ]);
    expect(check("Guest Ferret's chance falls from 70% to 20%.")).toEqual([]);
    // Normal Bot's numbers under Guest Ferret's name (VR1: owner swaps).
    expect(
      checkSentence(
        "Guest Ferret's walk falls from 6 to 4.",
        ids("walk1", "walk2"),
        facts,
        seats,
      ),
    ).toEqual([`"from 6 to 4" is not Guest Ferret's walk in the cited facts`]);
  });

  test("colour words and uppercase cells are checked", () => {
    const check = (sentence: string) =>
      checkSentence(sentence, ids("play"), facts, seats);
    expect(check("Red's cat moves.")).toEqual([
      '"Red" is not in the cited facts',
    ]);
    expect(check("Guest Ferret goes to C5.")).toEqual([
      "C5 is not in the cited facts",
    ]);
  });

  test("a walk names its owner", () => {
    const check = (sentence: string) =>
      checkSentence(sentence, ids("walk2", "play"), facts, seats);
    expect(check("Normal Bot's walk falls from 6 to 4.")).toEqual([]);
    expect(check("Normal Bot's cat walk falls from 6 to 4.")).toEqual([]);
    expect(check("Guest Ferret leaves the walk at 4 steps.")).toEqual([
      '"walk" must follow its owner\'s name ("<player>\'s walk")',
    ]);
    expect(check("Normal Bot cuts its walk to 4.")).toHaveLength(1);
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

describe("checkSeen (the image check)", () => {
  test("asks about labelled plies only, with their two tiles; a missing answer is not seen", () => {
    const game = gameOf([
      { w1: [9, 9], w2: [9, 9], wc: [0.5, 0.5] },
      {
        w1: [9, 9],
        w2: [9, 9],
        wc: [0.5, 0.5],
        walls: [">f4", "^g3"],
        room: [42, 20],
      },
      { w1: [9, 7], w2: [9, 9], wc: [0.5, 0.5] },
    ]);
    const labels = labelGame(game);
    let asked = "";
    const seen = checkSeen(
      { facts: game, labels, sentences: null, seen: null },
      "/tmp/tiles",
      (input) => {
        asked = input;
        return { plies: [], costUsd: 0 };
      },
    );
    expect(labels.plies.map((p) => p.label)).toEqual([
      "quiet",
      "box-in",
      "quiet",
    ]);
    expect(seen).toEqual([
      { ply: 1, seen: false, reason: "the model gave no answer" },
    ]);
    expect(asked).toContain(
      "ply 1: tiles tile-ply-0.png (before) and tile-ply-1.png (after)",
    );
    expect(asked).toContain("fall from 42 to 20");
    expect(asked).toContain("Normal Bot plays red");
    expect(asked).not.toContain("ply 0:");
  });

  test("the counters make a gain seen, never a mistake (C36 D)", () => {
    // Ply 1: P2's walls turn the 8-8 tie into P2's lead (8 vs 12 for P1).
    const run = (wc: [number, number]) => {
      const game = gameOf([
        { w1: [10, 8], w2: [10, 8], wc: [0.5, 0.5] },
        { w1: [8, 12], w2: [8, 8], wc, walls: [">f4", "^g3"] },
      ]);
      const labels = labelGame(game);
      return {
        label: labels.plies[1].label,
        seen: checkSeen(
          { facts: game, labels, sentences: null, seen: null },
          "/tmp/tiles",
          () => ({
            plies: [{ ply: 1, seen: false, reason: "no" }],
            costUsd: 0,
          }),
        ).find((x) => x.ply === 1)?.seen,
      };
    };
    expect(run([0.5, 0.6])).toEqual({ label: "detour", seen: true });
    expect(run([0.7, 0.4])).toEqual({ label: "blunder", seen: false });
  });
});

describe("CASES from C16 on: what a move means (2026-11-01)", () => {
  test("C17 ZJPRJ_kq: 1 step at ply 37 is one move; 3 steps at the end are two", () => {
    const l = fixtureLabels("ZJPRJ_kq");
    expect(l.plies[37].label).toBe("threat");
    expect(l.plies[37].focus.after).toBe(1);
    expect(movesToCatch(l.plies[37].focus.after)).toBe(1);
    // The ending bar's board: the guest's cat 3 steps from the mouse.
    const end = l.plies[42];
    expect(end.label).toBe("capture");
    expect(end.race.before.walks[2]).toBe(3);
    expect(movesToCatch(3)).toBe(2);
  });

  test("C28 NxKhTj4H: the guest's cat on its own mouse, then a run into the cat", () => {
    const l = fixtureLabels("NxKhTj4H");
    const odd = l.plies.filter((p) => p.huh).map((p) => [p.ply, p.huh!.kind]);
    expect(odd).toEqual([
      [3, "cat-on-own-mouse"],
      [7, "cat-on-own-mouse"],
      [15, "cat-on-own-mouse"],
      [21, "mouse-into-reach"],
    ]);
  });

  test("C56 BInRtf1_: the engine's seal at ply 28 changes a walk by 2, so it is no trap-closes", () => {
    const l = fixtureLabels("BInRtf1_");
    expect(l.plies[28].label).not.toBe("trap-closes");
    expect(l.plies[28].destroys).toBe(false);
    expect(l.links.filter((k) => k.kind === "sealed-capture")).toEqual([]);
    // A seal whose wall changes a walk by 10 stays (PnGQWON1 ply 20).
    expect(fixtureLabels("PnGQWON1").plies[20].label).toBe("trap-closes");
  });

  test("qbh10ebA: a cat that passes its own mouse on the engine's best move is no huh", () => {
    const p = fixtureLabels("qbh10ebA").plies[21];
    expect(p.huh).toBeUndefined();
    expect(p.destroys).toBe(true);
  });

  test("C32 PnGQWON1: the bot's cat beside the mouse at 13 and 19 is a threat; 20 saves", () => {
    const l = fixtureLabels("PnGQWON1");
    expect(l.plies[13].tags).toContain("threat");
    expect(l.plies[19].label).toBe("threat");
    expect(l.plies[20].tags).toContain("save");
  });

  test("C36: opening walls the other side matched are no moment; the deciding move is", () => {
    const y = fixtureLabels("YGlYwnRu");
    expect(isMoment(y.plies[4])).toBe(false);
    expect(isMoment(y.plies[21])).toBe(true);
    expect(isMoment(fixtureLabels("9L8BLuex").plies[8])).toBe(false);
    expect(isMoment(fixtureLabels("G0Oa_TzU").plies[11])).toBe(false);
  });

  test("C37 YGlYwnRu 24: the bot's cat stopped by its own wall; nothing ends", () => {
    const l = fixtureLabels("YGlYwnRu");
    expect(l.plies[24].label).toBe("standoff");
    expect(l.plies[24].tags).toContain("own-wall");
    expect(l.plies[24].tags).not.toContain("capture");
    expect(l.plies[24].tags).not.toContain("blunder");
  });
});

describe("CASES from C46 on: what a move means (2026-11-04)", () => {
  test("C46 z5S6UPIi: plies 0-14 hold only engine verdicts (blunders), no board moment", () => {
    const l = fixtureLabels("z5S6UPIi");
    const early = l.plies.filter((p) => p.ply <= 14 && p.label !== "quiet");
    expect(early.length).toBeGreaterThan(0);
    for (const p of early) expect(["blunder", "turn"]).toContain(p.label);
  });

  test("C47 FTFHyntE 31: a catch at walk 2 is a huh the board does not show", () => {
    const l = fixtureLabels("FTFHyntE");
    expect(l.plies[31].huh).toEqual({
      kind: "missed-capture",
      walk: 2,
      shown: false,
    });
  });

  test("C47 qKtSFAbX 76-80: a cat beside the mouse that does not take it is shown", () => {
    const l = fixtureLabels("qKtSFAbX");
    expect(l.plies[74].huh?.shown).toBe(false);
    for (const ply of [76, 78, 80]) {
      expect(l.plies[ply].huh).toEqual({
        kind: "missed-capture",
        walk: 1,
        shown: true,
      });
    }
  });

  test("C28/C47 NxKhTj4H 3: a cat on its own mouse is shown", () => {
    expect(fixtureLabels("NxKhTj4H").plies[3].huh?.shown).toBe(true);
  });

  test("C45 X-TQBFZA 13: a gift only the strip shows is no shown missed punish", () => {
    const l = fixtureLabels("X-TQBFZA");
    expect(l.plies[13].tags).toContain("missed-punish");
    expect(l.plies[13].missedPunishShown).toBe(false);
  });

  test("a missed punish with the mover's cat beside an animal is shown", () => {
    const l = labels([
      { w1: [8, 8], w2: [4, 1], wc: [0.7, 0.2] },
      // P2 moves: its cat (hunt 2) stands 1 from P1's mouse, and it blunders.
      { w1: [8, 8], w2: [1, 1], wc: [0.8, 0.3] },
    ]);
    expect(l.plies[1].tags).toContain("missed-punish");
    expect(l.plies[1].missedPunishShown).toBe(true);
  });

  test("C49 Sz58lFo0 20: the bot's walls take the guest's walk 13 -> 35: destroys", () => {
    const l = fixtureLabels("Sz58lFo0");
    expect(l.plies[20].destroys).toBe(true);
    expect(l.plies.filter((p) => p.destroys).map((p) => p.ply)).toEqual([20]);
    // A closed trap destroys too.
    expect(fixtureLabels("JbpdRM9D").plies[20].destroys).toBe(true);
  });
});
