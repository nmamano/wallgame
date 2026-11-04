import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import { Grid } from "../../shared/domain/grid";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { buildClassicInitialState } from "../../shared/domain/classic-setup";
import { buildAnimalCycleInitialState } from "../../shared/domain/animal-cycle-setup";
import { pawnCell } from "../../shared/domain/pawns";
import { playerWalks } from "../../shared/domain/walks";
import type {
  Cell,
  GameConfiguration,
  PlayerId,
  Variant,
} from "../../shared/domain/game-types";

const stateFor = (
  variant: Variant,
  variantConfig: GameConfiguration["variantConfig"],
): GameState =>
  new GameState(
    {
      variant,
      randomStart: false,
      boardWidth: 8,
      boardHeight: 8,
      rated: false,
      timeControl: {
        initialSeconds: 180,
        incrementSeconds: 2,
        preset: "blitz",
      },
      variantConfig,
    } as GameConfiguration,
    0,
  );

/** A fixed pseudo-random sequence, so a failing board can be found again. */
const lcg = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};

const isStep = (grid: Grid, from: Cell, to: Cell) =>
  grid.accessibleNeighbors(from).some((c) => c[0] === to[0] && c[1] === to[1]);

describe("Grid.shortestPath", () => {
  it("is as long as distance and takes only legal steps", () => {
    const random = lcg(7);
    for (let n = 0; n < 300; n++) {
      const width = 4 + Math.floor(random() * 6);
      const height = 4 + Math.floor(random() * 6);
      const grid = new Grid(width, height, "standard");
      const cell = (): Cell => [
        Math.floor(random() * height),
        Math.floor(random() * width),
      ];
      for (let w = 0; w < width * height * 0.4; w++) {
        grid.addWall({
          cell: cell(),
          orientation: random() < 0.5 ? "vertical" : "horizontal",
        });
      }
      const start = cell();
      const target = cell();
      const distance = grid.distance(start, target);
      const path = grid.shortestPath(start, target);
      if (distance === -1) {
        expect(path).toBeNull();
        continue;
      }
      expect(path).not.toBeNull();
      expect(path!.length - 1).toBe(distance);
      expect(path![0]).toEqual(start);
      expect(path![path!.length - 1]).toEqual(target);
      for (let i = 1; i < path!.length; i++) {
        expect(isStep(grid, path![i - 1], path![i])).toBe(true);
      }
    }
  });

  it("is the start cell alone when the start is the target", () => {
    const grid = new Grid(4, 4, "standard");
    expect(grid.shortestPath([1, 1], [1, 1])).toEqual([[1, 1]]);
  });

  it("goes around an avoided cell when a walk as short does", () => {
    const grid = new Grid(4, 4, "standard");
    // Two shortest walks from (0,0) to (1,1): through (0,1) or (1,0).
    expect(grid.shortestPath([0, 0], [1, 1], [[0, 1]])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(grid.shortestPath([0, 0], [1, 1], [[1, 0]])).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
    ]);
  });

  it("goes through an avoided cell when no walk as short goes around it", () => {
    const grid = new Grid(4, 4, "standard");
    expect(grid.shortestPath([0, 0], [0, 2], [[0, 1]])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
    ]);
  });
});

describe("playerWalks", () => {
  const walkOf = (state: GameState, playerId: PlayerId) =>
    playerWalks(state).find((w) => w.playerId === playerId)?.cells;

  it("Standard: each cat walks to the other player's mouse", () => {
    const state = stateFor("standard", buildStandardInitialState(8, 8));
    const walks = playerWalks(state);
    expect(walks.map((w) => w.playerId)).toEqual([1, 2]);
    for (const [player, other] of [
      [1, 2],
      [2, 1],
    ] as const) {
      const cells = walkOf(state, player)!;
      expect(cells[0]).toEqual(pawnCell(state.pawns, player, "cat")!);
      expect(cells[cells.length - 1]).toEqual(
        pawnCell(state.pawns, other, "mouse")!,
      );
      expect(cells.length - 1).toBe(14);
    }
  });

  it("Classic: each cat walks to its own home", () => {
    const state = stateFor("classic", buildClassicInitialState(8, 8));
    for (const player of [1, 2] as const) {
      const cells = walkOf(state, player)!;
      expect(cells[0]).toEqual(pawnCell(state.pawns, player, "cat")!);
      expect(cells[cells.length - 1]).toEqual(
        pawnCell(state.pawns, player, "home")!,
      );
    }
  });

  it("Animal Cycle: each player walks its shorter hunt", () => {
    const state = stateFor("animal-cycle", buildAnimalCycleInitialState(8, 8));
    const hunts = {
      1: [
        ["cat", 2, "mouse"],
        ["elephant", 2, "dog"],
      ],
      2: [
        ["mouse", 1, "elephant"],
        ["dog", 1, "cat"],
      ],
    } as const;
    for (const player of [1, 2] as const) {
      const lengths = hunts[player].map(([hunter, owner, target]) =>
        state.grid.distance(
          pawnCell(state.pawns, player, hunter)!,
          pawnCell(state.pawns, owner, target)!,
        ),
      );
      const cells = walkOf(state, player)!;
      expect(cells.length - 1).toBe(Math.min(...lengths));
      const own = hunts[player].map(
        ([hunter]) => pawnCell(state.pawns, player, hunter)!,
      );
      expect(own).toContainEqual(cells[0]);
    }
  });

  it("a player whose target cannot be reached has no walk", () => {
    const setup = buildStandardInitialState(8, 8);
    // Box in player 2's mouse at (7,7): a wall on its left and one above.
    setup.walls = [
      { cell: [7, 6], orientation: "vertical" },
      { cell: [7, 7], orientation: "horizontal" },
    ];
    const state = stateFor("standard", setup);
    if (state.grid.distance([0, 0], [7, 7]) !== -1) {
      throw new Error("the walls do not box in (7,7)");
    }
    expect(playerWalks(state).map((w) => w.playerId)).toEqual([2]);
  });
});
