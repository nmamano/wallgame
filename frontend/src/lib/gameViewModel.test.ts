import { describe, expect, it } from "bun:test";
import { requirePawnCell } from "../../../shared/domain/pawns";
import {
  colorizeLastMoves,
  colorizeLastWalls,
  computeLastMoveDiffs,
  computeLastMoves,
  computeLastWallDiffs,
  formatWinReason,
  resignCauseWords,
} from "./gameViewModel";
import type { PlayerColor } from "./player-colors";
import { GameState } from "../../../shared/domain/game-state";
import type {
  Cell,
  GameConfiguration,
  PlayerId,
  WallPosition,
} from "../../../shared/domain/game-types";
import { buildStandardInitialState } from "../../../shared/domain/standard-setup";
import { buildSavedPuzzleSeedRows } from "../../../shared/domain/saved-puzzles";
import { generateCustomSetupCandidates } from "../../../shared/domain/generated-custom-setup-candidates";
import verdictFile from "../../../shared/domain/generated-custom-setup-verdicts.json";
import type { CandidateVerdictFile } from "../../../shared/domain/custom-setup-verdicts";
import { resolveSavedPuzzleLaunch } from "../../../shared/domain/puzzle-lead-in";

/**
 * S-P3: last-move/wall identity is cached colorless; colors are applied at
 * render time from the CURRENT color map. This pins the reported bug (a P2
 * puzzle's bot lead-in arrow wore the human's color on first join because
 * the update-arrival color map was frozen into the cache) and the wall
 * ownership attribution (stored grid ownership, not history-index parity).
 *
 * Lives in the frontend project (dedicated tsconfig.test.json) because it
 * exercises frontend modules whose "@/" alias only resolves here; run with
 * `bun test frontend/src/lib/gameViewModel.test.ts` and type-check with
 * `bun x tsc --noEmit -p tsconfig.test.json` from frontend/.
 */

const TIME = { initialSeconds: 600, incrementSeconds: 0 };

const seedRows = buildSavedPuzzleSeedRows(
  generateCustomSetupCandidates(),
  verdictFile as CandidateVerdictFile,
);

/** A P2 puzzle right after the bot's real ply-0 lead-in. */
const leadInArrivalState = (): GameState => {
  const p2Row = seedRows.find(
    (row) => row.config.initialState.turn.playerId === 2,
  )!;
  const launch = resolveSavedPuzzleLaunch(p2Row);
  const preState = new GameState(
    { ...launch.config, timeControl: TIME } as GameConfiguration,
    0,
  );
  return preState.applyGameAction({
    kind: "move",
    playerId: 1,
    move: launch.leadInMove!,
    timestamp: 1,
  });
};

describe("lead-in arrival arrows (the reported bug)", () => {
  it("attributes the ply-0 diff to player 1 (the bot)", () => {
    const diffs = computeLastMoveDiffs(leadInArrivalState());
    expect(diffs).not.toBeNull();
    expect(diffs!.every((diff) => diff.playerId === 1)).toBe(true);
  });

  it("re-colorizes cached diffs when the color map changes WITHOUT a new game-state update", () => {
    // Exactly the first-join race: the diff is cached while colors are
    // still defaults, then the local seat resolves and the map changes.
    const cachedDiffs = computeLastMoveDiffs(leadInArrivalState());
    const defaults: Record<PlayerId, PlayerColor> = { 1: "red", 2: "blue" };
    const settled: Record<PlayerId, PlayerColor> = { 1: "green", 2: "red" };

    const beforeSeatResolves = colorizeLastMoves(cachedDiffs, defaults);
    const afterSeatResolves = colorizeLastMoves(cachedDiffs, settled);

    expect(beforeSeatResolves![0].playerColor).toBe("red");
    // Same cached identity, current map: the bot's arrow now wears the
    // bot's settled color — not whatever was frozen at arrival.
    expect(afterSeatResolves![0].playerColor).toBe("green");
    expect(afterSeatResolves![0].playerColor).not.toBe(settled[2]);
  });
});

describe("wall attribution from stored grid ownership", () => {
  const config: GameConfiguration = {
    timeControl: { ...TIME, preset: "rapid" },
    variant: "standard",
    rated: false,
    boardWidth: 5,
    boardHeight: 5,
    variantConfig: buildStandardInitialState(5, 5),
  } as GameConfiguration;

  const playFirstWallMove = (): GameState => {
    const state = new GameState(config, 0);
    // Find any legal single-wall first move for P1.
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 4; col++) {
        try {
          return state.applyGameAction({
            kind: "move",
            playerId: 1,
            move: {
              actions: [
                {
                  type: "wall",
                  target: [row, col],
                  wallOrientation: "vertical",
                },
              ],
            },
            timestamp: 1,
          });
        } catch {
          continue;
        }
      }
    }
    throw new Error("no legal wall move found");
  };

  it("history entry index is 1-based (evidence for retiring the parity formula)", () => {
    const next = playFirstWallMove();
    expect(next.history).toHaveLength(1);
    expect(next.history[0].index).toBe(1);
    // The old formula ((index % 2) + 1) therefore attributed the FIRST
    // move to player 2 — incorrect cached attribution (no consumer
    // rendered it yet; this slice makes it correct before one does).
  });

  it("attributes the first wall to player 1 via the history grid's ownership", () => {
    const next = playFirstWallMove();
    const diffs = computeLastWallDiffs(next);
    expect(diffs).not.toBeNull();
    expect(diffs).toHaveLength(1);
    expect(diffs![0].playerId).toBe(1);

    const colored = colorizeLastWalls(diffs, { 1: "green", 2: "red" });
    expect(colored![0].playerColor).toBe("green");
  });
});

describe("colored wrappers (showcase/history consumers) stay equivalent", () => {
  it("computeLastMoves(state, colors) equals colorize(computeLastMoveDiffs(state))", () => {
    const state = leadInArrivalState();
    const colors: Record<PlayerId, PlayerColor> = { 1: "purple", 2: "pink" };
    expect(computeLastMoves(state, colors)).toEqual(
      colorizeLastMoves(computeLastMoveDiffs(state), colors),
    );
  });

  it("second-move diffs attribute player 2 (ordinary parity preserved)", () => {
    const arrival = leadInArrivalState();
    // Human (P2) cat makes any legal single step.
    const humanCat = requirePawnCell(arrival.pawns, 2, "cat");
    const steps: [number, number][] = [
      [humanCat[0] + 1, humanCat[1]],
      [humanCat[0] - 1, humanCat[1]],
      [humanCat[0], humanCat[1] + 1],
      [humanCat[0], humanCat[1] - 1],
    ];
    let next: GameState | null = null;
    for (const target of steps) {
      if (target[0] < 0 || target[0] > 5 || target[1] < 0 || target[1] > 5)
        continue;
      try {
        next = arrival.applyGameAction({
          kind: "move",
          playerId: 2,
          move: { actions: [{ type: "cat", target }] },
          timestamp: 2,
        });
        break;
      } catch {
        continue;
      }
    }
    expect(next).not.toBeNull();
    const diffs = computeLastMoveDiffs(next);
    expect(diffs!.every((diff) => diff.playerId === 2)).toBe(true);
  });
});

describe("the corner of a diagonal 2-step move", () => {
  const standard = (walls: WallPosition[] = []): GameConfiguration => ({
    timeControl: { ...TIME, preset: "rapid" },
    variant: "standard",
    randomStart: false,
    rated: false,
    boardWidth: 5,
    boardHeight: 5,
    variantConfig: { ...buildStandardInitialState(5, 5), walls },
  });

  /** Player 1's cat leaves a5 [0,0] in one action; the diff of that move. */
  const catMove = (config: GameConfiguration, target: Cell) =>
    computeLastMoveDiffs(
      new GameState(config, 0).applyGameAction({
        kind: "move",
        playerId: 1,
        move: { actions: [{ type: "cat", target }] },
        timestamp: 1,
      }),
    )![0];

  it("turns along the row first when both corners are open", () => {
    expect(catMove(standard(), [1, 1]).via).toEqual([0, 1]);
  });

  it("takes the column corner when a wall blocks the row corner", () => {
    const wall: WallPosition = { cell: [0, 0], orientation: "vertical" };
    expect(catMove(standard([wall]), [1, 1]).via).toEqual([1, 0]);
  });

  it("gives straight moves no corner", () => {
    expect(catMove(standard(), [0, 2]).via).toBeUndefined();
    expect(catMove(standard(), [0, 1]).via).toBeUndefined();
  });

  it("never turns on the Animal Cycle teammate's cell", () => {
    const config: GameConfiguration = {
      timeControl: { ...TIME, preset: "rapid" },
      variant: "animal-cycle",
      randomStart: false,
      rated: false,
      boardWidth: 5,
      boardHeight: 5,
      variantConfig: {
        // The elephant stands on the row corner of the cat's move.
        pawns: {
          p1: { cat: [0, 0], elephant: [0, 1] },
          p2: { mouse: [0, 4], dog: [4, 0] },
        },
        walls: [],
      },
    };
    expect(catMove(config, [1, 1]).via).toEqual([1, 0]);
  });
});

describe("the words for why a resignation happened", () => {
  it("names a disconnect and an idle timeout", () => {
    expect(
      resignCauseWords({
        winner: 2,
        reason: "resignation",
        resignCause: "disconnect",
      }),
    ).toBe("opponent left");
    expect(
      resignCauseWords({
        winner: 2,
        reason: "resignation",
        resignCause: "idle",
      }),
    ).toBe("opponent stopped moving");
  });

  it("keeps plain resignation for a click, a bot forfeit and an old game", () => {
    for (const resignCause of ["player", "bot-forfeit"] as const) {
      expect(
        resignCauseWords({ winner: 1, reason: "resignation", resignCause }),
      ).toBeNull();
    }
    expect(resignCauseWords({ winner: 1, reason: "resignation" })).toBeNull();
    expect(formatWinReason("resignation")).toBe("resignation");
  });

  it("says nothing for any other ending", () => {
    expect(resignCauseWords({ winner: 1, reason: "timeout" })).toBeNull();
    expect(resignCauseWords(undefined)).toBeNull();
  });
});
