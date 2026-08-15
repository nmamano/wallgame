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
  GameConfiguration,
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
    name: "p2-cat-elephant-8x8",
    width: 8,
    height: 8,
    state: buildAnimalCycleInitialState(8, 8),
    playerId: 2,
    probes: ["Cb7", "Eg2", "---"],
  },
  {
    name: "fixed-5x5",
    width: 5,
    height: 5,
    state: buildAnimalCycleInitialState(5, 5),
    probes: ["Da2", "Me4", ">b3", "---"],
  },
  {
    name: "seeded-random-8x8",
    width: 8,
    height: 8,
    state: generateAnimalCycleRandomInitialState(8, 8, seeded(20260815)),
    probes: ["Db2", "Mg7", "^d5", "---"],
  },
  {
    name: "authored-12x10",
    width: 12,
    height: 10,
    state: {
      pawns: {
        p1: { dog: [8, 1], mouse: [1, 10] },
        p2: { cat: [1, 1], elephant: [8, 10] },
      },
      walls: [
        { cell: [5, 4], orientation: "vertical" },
        { cell: [6, 7], orientation: "horizontal" },
      ],
    },
    probes: ["Db3", "Mj9", ">f5", "---"],
  },
  {
    name: "endpoint-and-crossing",
    width: 8,
    height: 8,
    state: {
      pawns: {
        p1: { dog: [2, 1], mouse: [2, 2] },
        p2: { cat: [2, 4], elephant: [7, 7] },
      },
      walls: [],
    },
    probes: ["Dc6", "Dd6", "Db5", "---"],
  },
  {
    name: "capture-precedence",
    width: 8,
    height: 8,
    state: {
      pawns: {
        p1: { dog: [2, 1], mouse: [4, 1] },
        p2: { cat: [2, 2], elephant: [4, 2] },
      },
      walls: [],
    },
    probes: ["Dc6.Mc4", "Mc4.Dc6"],
  },
  {
    name: "four-directed-path-wall",
    width: 4,
    height: 4,
    state: {
      pawns: {
        p1: { dog: [0, 0], mouse: [3, 3] },
        p2: { cat: [0, 2], elephant: [3, 1] },
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
        p1: { dog: [2, 1], mouse: [7, 0] },
        p2: { cat: [2, 2], elephant: [7, 7] },
      },
      walls: [],
    },
    probes: ["Dc6"],
  },
  {
    name: "cat-captures-mouse",
    width: 8,
    height: 8,
    playerId: 2,
    state: {
      pawns: {
        p1: { dog: [0, 0], mouse: [2, 1] },
        p2: { cat: [2, 2], elephant: [7, 7] },
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
        p1: { dog: [0, 0], mouse: [2, 1] },
        p2: { cat: [0, 7], elephant: [2, 2] },
      },
      walls: [],
    },
    probes: ["Mc6"],
  },
  {
    name: "elephant-captures-dog",
    width: 8,
    height: 8,
    playerId: 2,
    state: {
      pawns: {
        p1: { dog: [2, 1], mouse: [7, 0] },
        p2: { cat: [0, 7], elephant: [2, 2] },
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
    name: "dog-cat-before-cat-mouse",
    pawns: {
      kind: "animal-cycle" as const,
      pawns: {
        1: {
          dog: [2, 2] as [number, number],
          mouse: [2, 2] as [number, number],
        },
        2: {
          cat: [2, 2] as [number, number],
          elephant: [7, 7] as [number, number],
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
          dog: [4, 4] as [number, number],
          mouse: [4, 4] as [number, number],
        },
        2: {
          cat: [0, 0] as [number, number],
          elephant: [4, 4] as [number, number],
        },
      },
    },
  },
].map(({ name, pawns }) => ({
  name,
  pawns,
  winner: animalCycleCaptureWinner(pawns),
}));

const rendered = await format(JSON.stringify({ positions: corpus, stacked }), {
  parser: "json",
});
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
