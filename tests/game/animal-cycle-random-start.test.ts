import { describe, expect, it } from "bun:test";
import {
  buildAnimalCycleInitialState,
  animalCycleWallOrbit,
  generateAnimalCycleRandomInitialState,
  hasImmediateAnimalCycleCapture,
  rotateAnimalCycleWall,
} from "../../shared/domain/animal-cycle-setup";
import { GameState } from "../../shared/domain/game-state";
import { Grid } from "../../shared/domain/grid";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import {
  handleEndGameSession,
  handleEvaluatePosition,
  handleStartGameSession,
} from "../../official-custom-bot-client/src/dumb-bot";
import type { WallPosition } from "../../shared/domain/game-types";

const SIZES: [number, number][] = [
  [8, 8],
  [9, 9],
  [8, 10],
  [5, 10],
];

const wallKey = (wall: WallPosition): string =>
  `${wall.orientation}:${wall.cell[0]}:${wall.cell[1]}`;

const seededRng = (seed: number): (() => number) => {
  let state = (seed + 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

describe("Animal Cycle Random Start", () => {
  for (const [boardWidth, boardHeight] of SIZES) {
    it(`keeps the fixed opening unchanged on ${boardWidth}x${boardHeight}`, () => {
      expect(buildAnimalCycleInitialState(boardWidth, boardHeight)).toEqual({
        pawns: {
          p1: {
            dog: [boardHeight - 1, 0],
            mouse: [0, boardWidth - 1],
          },
          p2: {
            cat: [0, 0],
            elephant: [boardHeight - 1, boardWidth - 1],
          },
        },
        walls: [],
      });
    });

    it(`is centered, legal, capture-safe, and C4-invariant on ${boardWidth}x${boardHeight}`, () => {
      for (let sample = 0; sample < 50; sample += 1) {
        const initialState = generateAnimalCycleRandomInitialState(
          boardWidth,
          boardHeight,
        );
        const { pawns, walls } = initialState;
        const top = pawns.p2.cat[0];
        const left = pawns.p2.cat[1];
        const size = pawns.p1.dog[0] - top + 1;
        const square = { top, left, size };

        expect(pawns).toEqual({
          p1: {
            dog: [top + size - 1, left],
            mouse: [top, left + size - 1],
          },
          p2: {
            cat: [top, left],
            elephant: [top + size - 1, left + size - 1],
          },
        });
        expect(size).toBeGreaterThanOrEqual(4);
        expect(size).toBeLessThanOrEqual(Math.min(boardWidth, boardHeight));
        expect(top).toBe(Math.floor((boardHeight - size) / 2));
        expect(left).toBe(Math.floor((boardWidth - size) / 2));
        expect(Math.abs(2 * top + size - boardHeight)).toBeLessThanOrEqual(1);
        expect(Math.abs(2 * left + size - boardWidth)).toBeLessThanOrEqual(1);
        if (boardWidth % 2 === boardHeight % 2) {
          expect(2 * top + size).toBe(boardHeight);
          expect(2 * left + size).toBe(boardWidth);
        } else {
          const rowAsymmetry = Math.abs(2 * top + size - boardHeight);
          const columnAsymmetry = Math.abs(2 * left + size - boardWidth);
          expect([rowAsymmetry, columnAsymmetry].sort()).toEqual([0, 1]);
        }

        const keys = new Set(walls.map(wallKey));
        expect(keys.size).toBe(walls.length);
        const grid = new Grid(boardWidth, boardHeight, "animal-cycle");
        for (const wall of walls) {
          const [row, column] = wall.cell;
          expect(row).toBeGreaterThanOrEqual(0);
          expect(column).toBeGreaterThanOrEqual(0);
          expect(row).toBeLessThan(boardHeight);
          expect(column).toBeLessThan(boardWidth);
          if (wall.orientation === "vertical") {
            expect(column).toBeLessThan(boardWidth - 1);
          } else {
            expect(row).toBeGreaterThan(0);
          }
          expect(keys.has(wallKey(rotateAnimalCycleWall(wall, square)))).toBe(
            true,
          );
          expect(animalCycleWallOrbit(wall, square)).toHaveLength(4);
          let rotated = wall;
          for (let turn = 0; turn < 4; turn += 1) {
            rotated = rotateAnimalCycleWall(rotated, square);
          }
          expect(rotated).toEqual(wall);
          grid.addWall(wall);
        }
        expect(hasImmediateAnimalCycleCapture(grid, pawns)).toBe(false);
        expect(grid.distance(pawns.p1.dog, pawns.p2.cat)).toBeGreaterThan(0);
        expect(
          grid.distance(pawns.p1.mouse, pawns.p2.elephant),
        ).toBeGreaterThan(0);
        expect(grid.distance(pawns.p2.cat, pawns.p1.mouse)).toBeGreaterThan(0);
        expect(grid.distance(pawns.p2.elephant, pawns.p1.dog)).toBeGreaterThan(
          0,
        );
      }
    });
  }

  it("varies the centered square size and rejects dimensions below four", () => {
    expect(
      generateAnimalCycleRandomInitialState(10, 10, () => 0).pawns.p1.dog,
    ).toEqual([6, 3]);
    expect(
      generateAnimalCycleRandomInitialState(10, 10, () => 0.999).pawns.p1.dog,
    ).toEqual([8, 1]);
    expect(() => generateAnimalCycleRandomInitialState(3, 8)).toThrow(
      "requires both board dimensions to be at least 4",
    );
  });

  it("always forms an exactly centered pawn square on 8x8", () => {
    for (let sample = 0; sample < 200; sample += 1) {
      const { pawns, walls } = generateAnimalCycleRandomInitialState(
        8,
        8,
        seededRng(sample),
      );
      const top = pawns.p2.cat[0];
      const bottom = pawns.p1.dog[0];
      const left = pawns.p2.cat[1];
      const right = pawns.p1.mouse[1];
      expect(bottom - top).toBe(right - left);
      expect(top + bottom).toBe(7);
      expect(left + right).toBe(7);
      expect([4, 6]).toContain(bottom - top + 1);
      expect(walls.length).toBeGreaterThanOrEqual(8);
      expect(walls.length).toBeLessThanOrEqual(12);
    }
  });

  it("can place a complete 8x8 orbit outside the pawn square", () => {
    let foundOutsideSquare = false;
    for (let seed = 0; seed < 100 && !foundOutsideSquare; seed += 1) {
      const { pawns, walls } = generateAnimalCycleRandomInitialState(
        8,
        8,
        seededRng(seed),
      );
      const top = pawns.p2.cat[0];
      const bottom = pawns.p1.dog[0];
      const left = pawns.p2.cat[1];
      const right = pawns.p1.mouse[1];
      foundOutsideSquare = walls.some(
        ({ cell: [row, column] }) =>
          row < top || row > bottom || column < left || column > right,
      );
    }
    expect(foundOutsideSquare).toBe(true);
  });

  it("accepts every wall in a complete orbit or none of it", () => {
    for (let sample = 0; sample < 100; sample += 1) {
      const initialState = generateAnimalCycleRandomInitialState(8, 10);
      const { pawns, walls } = initialState;
      const square = {
        top: pawns.p2.cat[0],
        left: pawns.p2.cat[1],
        size: pawns.p1.dog[0] - pawns.p2.cat[0] + 1,
      };
      const keys = new Set(walls.map(wallKey));
      for (const wall of walls) {
        for (const member of animalCycleWallOrbit(wall, square)) {
          expect(keys.has(wallKey(member))).toBe(true);
        }
      }
    }
  });

  it("the Animal Cycle Dumb Bot accepts and plays arbitrary generated openings", () => {
    for (const [index, [boardWidth, boardHeight]] of SIZES.entries()) {
      const initialState = generateAnimalCycleRandomInitialState(
        boardWidth,
        boardHeight,
      );
      const bgsId = `random-animal-${index}`;
      expect(
        handleStartGameSession({
          type: "start_game_session",
          bgsId,
          botId: "animal-cycle-dumb",
          config: {
            variant: "animal-cycle",
            boardWidth,
            boardHeight,
            initialState,
          },
        }).success,
      ).toBe(true);
      const evaluated = handleEvaluatePosition({
        type: "evaluate_position",
        bgsId,
        expectedPly: 0,
      });
      expect(evaluated.success).toBe(true);
      const config = {
        variant: "animal-cycle" as const,
        randomStart: true,
        rated: false,
        timeControl: { initialSeconds: 0, incrementSeconds: 0 },
        boardWidth,
        boardHeight,
        variantConfig: initialState,
      };
      const state = new GameState(config, 0);
      const move = moveFromStandardNotation(evaluated.bestMove, boardHeight);
      expect(() =>
        state.applyGameAction({
          kind: "move",
          move,
          playerId: 1,
          timestamp: 1,
        }),
      ).not.toThrow();
      handleEndGameSession({ type: "end_game_session", bgsId });
    }
  });
});
