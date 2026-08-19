/*
An `appliedNotation` that holds the same terms as the C++ oracle in a DIFFERENT
ORDER is expected, not a regression.

Since 2026-08-19 `moveToStandardNotation` writes the terms in the order the turn
was played; only walls among themselves stay sorted. The C++ emitter,
`Move::standard_notation` in deep-wallwars/src/gamestate.cpp, still writes the
pawns in the fixed order Dog, Cat, Mouse, Elephant and every wall after them. Two
kinds of difference therefore show up here, and both are the C++ side being
behind:

- two pawns, written in the played order here and in the fixed animal order
  there ("Eg5.Cf5" against "Cf5.Eg5");
- a wall and a pawn, written in the played order here and always pawn-first
  there (">e4.Ce3" against "Ce3.>e4").

The order carries meaning in both cases, because both readers apply the terms in
sequence. A pawn that follows its teammate into a cell has to be written second,
or the cell is still occupied when it arrives; the fixed order sent the follower
in first and cost a real game (qYrQ6B1I, 2026-08-19). A wall has to stay in front
of a capturing pawn, because a capture stops the move and a term behind it is
never reached. The same two defects are still in the C++ emitter for the engine's
own moves; they are tracked separately, because a change there needs a GPU build.

Compare the POSITION and the winner, not the string, when the terms match and
only their order does not.
*/

import { GameState } from "../shared/domain/game-state";
import { format } from "prettier";
import {
  buildAnimalCycleInitialState,
  generateAnimalCycleRandomInitialState,
} from "../shared/domain/animal-cycle-setup";
import { animalCycleCaptureWinner } from "../shared/domain/animal-cycle";
import {
  moveFromStandardNotation,
  moveToStandardNotation,
} from "../shared/domain/standard-notation";
import type {
  AnimalCycleInitialState,
  Cell,
  GameConfiguration,
  GamePawnType,
  PlayerId,
} from "../shared/domain/game-types";

const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => (state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32;
};

const config = (
  width: number,
  height: number,
  initialState: AnimalCycleInitialState,
  playerId: PlayerId = 1,
): GameConfiguration => ({
  variant: "animal-cycle",
  randomStart: false,
  boardWidth: width,
  boardHeight: height,
  rated: false,
  timeControl: { initialSeconds: 180, incrementSeconds: 0, preset: "blitz" },
  variantConfig: {
    ...initialState,
    turn: { playerId, actionsTaken: [] },
  },
});

const positions: {
  name: string;
  width: number;
  height: number;
  state: AnimalCycleInitialState;
  probes: string[];
  playerId?: PlayerId;
}[] = [
  {
    name: "p2-mouse-dog-8x8",
    width: 8,
    height: 8,
    state: buildAnimalCycleInitialState(8, 8),
    playerId: 2,
    probes: ["Mg7", "Db2", "---"],
  },
  {
    name: "fixed-5x5",
    width: 5,
    height: 5,
    state: buildAnimalCycleInitialState(5, 5),
    probes: ["Ca4", "Ee2", ">b3", "---"],
  },
  {
    name: "seeded-random-8x8",
    width: 8,
    height: 8,
    state: generateAnimalCycleRandomInitialState(8, 8, seeded(20260815)),
    probes: ["Cc5", "Ef2", "^d5", "---"],
  },
  {
    name: "authored-12x10",
    width: 12,
    height: 10,
    state: {
      pawns: {
        p1: { cat: [1, 1], elephant: [8, 10] },
        p2: { mouse: [1, 10], dog: [8, 1] },
      },
      walls: [
        { cell: [5, 4], orientation: "vertical" },
        { cell: [6, 7], orientation: "horizontal" },
      ],
    },
    probes: ["Cb8", "Ek1", ">f5", "---"],
  },
  {
    name: "endpoint-and-crossing",
    width: 8,
    height: 8,
    state: {
      pawns: {
        p1: { cat: [2, 4], elephant: [7, 7] },
        p2: { mouse: [2, 2], dog: [2, 1] },
      },
      walls: [],
    },
    probes: ["Ce5", "Eg2", "Db5", "---"],
  },
  {
    name: "capture-precedence",
    width: 8,
    height: 8,
    state: {
      pawns: {
        p1: { cat: [4, 2], elephant: [2, 2] },
        p2: { mouse: [4, 1], dog: [2, 1] },
      },
      walls: [],
    },
    probes: ["Cb4.Eb6", "Eb6.Cb4"],
  },
  {
    name: "four-directed-path-wall",
    width: 4,
    height: 4,
    state: {
      pawns: {
        p1: { cat: [0, 2], elephant: [3, 1] },
        p2: { mouse: [3, 3], dog: [0, 0] },
      },
      walls: [{ cell: [1, 0], orientation: "horizontal" }],
    },
    probes: [">a4"],
  },
  {
    name: "dog-captures-cat",
    width: 8,
    height: 8,
    state: {
      pawns: {
        p1: { cat: [2, 2], elephant: [7, 7] },
        p2: { mouse: [7, 0], dog: [2, 1] },
      },
      walls: [],
    },
    playerId: 2,
    probes: ["Dc6"],
  },
  {
    name: "cat-captures-mouse",
    width: 8,
    height: 8,
    state: {
      pawns: {
        p1: { cat: [2, 2], elephant: [7, 7] },
        p2: { mouse: [2, 1], dog: [0, 0] },
      },
      walls: [],
    },
    probes: ["Cb6"],
  },
  {
    name: "mouse-captures-elephant",
    width: 8,
    height: 8,
    state: {
      pawns: {
        p1: { cat: [0, 7], elephant: [2, 2] },
        p2: { mouse: [2, 1], dog: [0, 0] },
      },
      walls: [],
    },
    playerId: 2,
    probes: ["Mc6"],
  },
  {
    name: "elephant-captures-dog",
    width: 8,
    height: 8,
    state: {
      pawns: {
        p1: { cat: [0, 7], elephant: [2, 2] },
        p2: { mouse: [7, 0], dog: [2, 1] },
      },
      walls: [],
    },
    probes: ["Eb6"],
  },
];

const corpus = positions.map(
  ({ name, width, height, state, probes, playerId = 1 }) => ({
    name,
    config: {
      variant: "animal-cycle",
      boardWidth: width,
      boardHeight: height,
      initialState: {
        ...state,
        turn: { playerId, actionsTaken: [] },
      },
    },
    probes: probes.map((notation) => {
      const before = new GameState(config(width, height, state, playerId), 0);
      try {
        const after = before.applyGameAction({
          kind: "move",
          move: moveFromStandardNotation(notation, height),
          playerId,
          timestamp: 1,
        });
        return {
          notation,
          accepted: true,
          winner: after.result?.winner ?? null,
          appliedNotation: moveToStandardNotation(
            after.history[0].move,
            height,
          ),
          appliedActions: after.history[0].move.actions.length,
        };
      } catch (error) {
        return {
          notation,
          accepted: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  }),
);

const stacked = [
  {
    name: "cat-mouse-before-dog-cat",
    pawns: {
      kind: "animal-cycle" as const,
      pawns: {
        1: {
          cat: [2, 2] as [number, number],
          elephant: [7, 7] as [number, number],
        },
        2: {
          mouse: [2, 2] as [number, number],
          dog: [2, 2] as [number, number],
        },
      },
    },
  },
  {
    name: "mouse-elephant-before-elephant-dog",
    pawns: {
      kind: "animal-cycle" as const,
      pawns: {
        1: {
          cat: [0, 0] as [number, number],
          elephant: [4, 4] as [number, number],
        },
        2: {
          mouse: [4, 4] as [number, number],
          dog: [4, 4] as [number, number],
        },
      },
    },
  },
].map(({ name, pawns }) => ({
  name,
  pawns,
  winner: animalCycleCaptureWinner(pawns),
}));

/*
The two EMITTERS, compared across the languages.

The `positions` corpus above compares the two PARSERS, and the C++ side of it
writes its own local string from the parsed actions. So neither half ever ran
`Move::standard_notation`, which is the function the engine uses to announce the
bot's OWN move (bgs_session.cpp). That is the direction that reaches the server,
and until 2026-08-19 it wrote a fixed animal order the server cannot always apply.

Each case below is a move the ENGINE could pick. TypeScript plays it, writes it,
and records whether the server accepts the result; the C++ test builds the same
Move on the same board, calls `Move::standard_notation`, and must produce the same
string. One side generates, the other is checked against it.

The board is 7x7, the size Animal Cycle is served at in production, and the cases
are stated in game coordinates with no padding, so the two coordinate systems
agree and a difference here is a difference in ORDER, not in geometry. Walls are
vertical for the same reason: a vertical wall is the one shape both notations name
by the same cell.
*/
const botMoveCases: {
  name: string;
  pawns: AnimalCycleInitialState["pawns"];
  playerId: PlayerId;
  actions: {
    type: GamePawnType | "wall";
    target: Cell;
    wallOrientation?: "vertical";
  }[];
}[] = [
  {
    name: "elephant-vacates-cat-follows",
    pawns: {
      p1: { cat: [3, 3], elephant: [3, 4] },
      p2: { mouse: [0, 0], dog: [6, 0] },
    },
    playerId: 1,
    actions: [
      { type: "elephant", target: [3, 5] },
      { type: "cat", target: [3, 4] },
    ],
  },
  {
    name: "cat-vacates-elephant-follows",
    pawns: {
      p1: { cat: [3, 4], elephant: [3, 5] },
      p2: { mouse: [0, 0], dog: [6, 0] },
    },
    playerId: 1,
    actions: [
      { type: "cat", target: [3, 3] },
      { type: "elephant", target: [3, 4] },
    ],
  },
  {
    name: "mouse-vacates-dog-follows",
    pawns: {
      p1: { cat: [0, 6], elephant: [6, 6] },
      p2: { mouse: [3, 3], dog: [3, 2] },
    },
    playerId: 2,
    actions: [
      { type: "mouse", target: [2, 3] },
      { type: "dog", target: [3, 3] },
    ],
  },
  {
    name: "wall-then-pawn",
    pawns: {
      p1: { cat: [3, 3], elephant: [6, 6] },
      p2: { mouse: [0, 0], dog: [0, 6] },
    },
    playerId: 1,
    actions: [
      { type: "wall", target: [3, 3], wallOrientation: "vertical" },
      { type: "cat", target: [4, 3] },
    ],
  },
  {
    /*
    The wall-first case that carries the HARM, not just the order.

    The one above has a non-capturing pawn, so both orders parse and both
    apply: it fails only on the string, which is a formatting mismatch. Here
    the cat CAPTURES, and a capture ends the move on both sides - the engine's
    parser returns as soon as the position has a winner. Written pawn-first,
    the wall is behind that stop and is never applied at all, so the parse
    yields ONE action where the move had two, and the wall the player built is
    simply gone. That is the engine-side harm, and it is what the C++ test
    checks by counting the parsed actions.
    */
    name: "wall-then-capturing-pawn",
    pawns: {
      p1: { cat: [3, 3], elephant: [6, 6] },
      p2: { mouse: [3, 2], dog: [0, 6] },
    },
    playerId: 1,
    actions: [
      { type: "wall", target: [0, 0], wallOrientation: "vertical" },
      { type: "cat", target: [3, 2] },
    ],
  },
  {
    name: "pawn-then-wall",
    pawns: {
      p1: { cat: [3, 3], elephant: [6, 6] },
      p2: { mouse: [0, 0], dog: [0, 6] },
    },
    playerId: 1,
    actions: [
      { type: "cat", target: [4, 3] },
      { type: "wall", target: [3, 3], wallOrientation: "vertical" },
    ],
  },
  {
    name: "two-walls-stay-sorted",
    pawns: {
      p1: { cat: [3, 3], elephant: [6, 6] },
      p2: { mouse: [0, 0], dog: [0, 6] },
    },
    playerId: 1,
    actions: [
      { type: "wall", target: [3, 3], wallOrientation: "vertical" },
      { type: "wall", target: [2, 3], wallOrientation: "vertical" },
    ],
  },
];

const botMoves = botMoveCases.map((testCase) => {
  const state = new GameState(
    {
      variant: "animal-cycle",
      randomStart: false,
      boardWidth: 7,
      boardHeight: 7,
      rated: false,
      timeControl: {
        initialSeconds: 0,
        incrementSeconds: 0,
        preset: "unlimited",
      },
      variantConfig: { pawns: testCase.pawns, walls: [] },
    },
    0,
  );
  state.turn = testCase.playerId;
  const after = state.applyGameAction({
    kind: "move",
    move: { actions: testCase.actions },
    playerId: testCase.playerId,
    timestamp: 1,
  });
  const notation = moveToStandardNotation(after.history[0].move, 7);

  // Is the string the emitter wrote one the server can actually apply? Measured
  // by replaying it, not asserted: a target string no reader accepts would be a
  // worthless thing to hold the engine to, and under the pre-2026-08-19 emitter
  // this field really does come back false for the vacate-then-follow cases.
  let serverAccepts = true;
  try {
    const replayState = new GameState(state.config, 0);
    replayState.turn = testCase.playerId;
    replayState.applyGameAction({
      kind: "move",
      move: moveFromStandardNotation(notation, 7),
      playerId: testCase.playerId,
      timestamp: 1,
    });
  } catch {
    serverAccepts = false;
  }

  return {
    name: testCase.name,
    rows: 7,
    columns: 7,
    player: testCase.playerId,
    pawns: testCase.pawns,
    actions: testCase.actions,
    notation,
    serverAccepts,
    // How many actions the notation actually names, taken from the move the
    // game RECORDED rather than from the list above: a capture ends a move, so
    // the two can differ. The C++ side counts the actions it parses out of the
    // engine's own string against this, which is how a dropped wall is caught.
    appliedActions: after.history[0].move.actions.length,
    winner: after.result?.winner ?? null,
  };
});

const rendered = await format(
  JSON.stringify({ positions: corpus, stacked, botMoves }),
  { parser: "json" },
);
const fixture = new URL(
  "../tests/fixtures/animal-cycle-cpp-oracle.json",
  import.meta.url,
);
if (process.argv.includes("--check")) {
  const existing = await Bun.file(fixture).text();
  if (existing !== rendered) {
    throw new Error("Animal Cycle C++ oracle fixture is stale");
  }
} else {
  process.stdout.write(rendered);
}
