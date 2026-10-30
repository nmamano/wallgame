import { describe, expect, test } from "bun:test";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { EngineFacts, GameFacts, HuntChange, PlyFacts } from "./facts";
import { readFileSync } from "node:fs";
import { gameFacts, type EngineData, type SemanticGame } from "./facts";
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
  /** The other side's mouse room before and after (default 40 -> 40). */
  room?: [number, number];
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
      { w1: [6, 9], w2: [4, 4], wc: [0.8, 0.82], walls: ["^a3"] },
    ]);
    expect(l.plies[0].label).toBe("turn");
    expect(l.plies[0].tags).toContain("missed-wall");
    expect(l.plies[1].label).toBe("punish");
    expect(l.plies[1].strength).toBe(1);
    expect(l.links).toContainEqual({
      kind: "blunder-punish",
      from: 0,
      to: 1,
      costShown: false,
    });
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
    expect(asked[1]).not.toContain("does not say the box-in");
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
    { w1: [6, 9], w2: [4, 4], wc: [0.8, 0.82], walls: ["^a3"] },
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
