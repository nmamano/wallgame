import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import type {
  GameConfiguration,
  PlayerId,
  Move,
} from "../../shared/domain/game-types";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { buildSurvivalInitialState } from "../../shared/domain/survival-setup";

/**
 * `moveCount` must equal the number of moves the game actually holds, including
 * the move that ended it.
 *
 * It did not. `applyMove` pushed the history entry for move N and committed the
 * board, then returned early on every TERMINAL branch - the mover's cat taking
 * the mouse, the mover's mouse walking onto the enemy cat, the one-move-rule
 * draw, and the survival limit - before reaching the `this.moveCount =
 * nextMoveIndex` line at the bottom. That line sat with the TURN HANDOFF
 * (`turn`, `actionsRemaining`, `previousPawnPosition`), which a finished game
 * correctly skips, rather than with the committed move state it describes. So
 * every game decided by a move reported N-1 while holding N.
 *
 * Measured 2026-08-09 on 47c9b0a: 200+ rows in `games.moves_count` are one short of their
 * own stored move array. Those rows are not backfilled (see
 * ops-private/showcase-500-investigation.md); this pins the behaviour forward.
 *
 * One test per terminal branch, because they are four separate early returns
 * and one shared assignment - a fix that reached only three of them would still
 * look green from any single case.
 */

const standardConfig = (size: number): GameConfiguration => ({
  boardHeight: size,
  boardWidth: size,
  rated: false,
  variant: "standard",
  timeControl: { initialSeconds: 180, incrementSeconds: 0, preset: "blitz" },
  variantConfig: buildStandardInitialState(size, size),
});

const turn = (
  state: GameState,
  playerId: PlayerId,
  actions: Move["actions"],
): GameState =>
  state.applyGameAction({
    kind: "move",
    move: { actions },
    playerId,
    timestamp: Date.now(),
  });

/**
 * The assertion the whole file exists for: the count the game REPORTS and the
 * number of moves it HOLDS are the same number, and the last entry agrees.
 */
const expectCountMatchesHistory = (state: GameState, expected: number) => {
  expect(state.history.length).toBe(expected);
  expect(state.moveCount).toBe(expected);
  expect(state.history.at(-1)?.index).toBe(state.moveCount);
};

describe("moveCount on a game decided by a move", () => {
  it("counts the capture that ends it (the mover's cat takes the mouse)", () => {
    // 5x5, not 3x3: on the smallest board a capture also satisfies the
    // one-move-rule, which is a DIFFERENT early return. Here the p2 cat stays
    // seven or eight steps from its goal, so this is a plain capture.
    let state = new GameState(standardConfig(5), 0);

    // p1 cat [0,0] walks to the p2 mouse at [4,4]; p2 shuffles its cat along
    // the top row, which never brings it within two of its own goal at [4,0].
    state = turn(state, 1, [
      { type: "cat", target: [1, 0] },
      { type: "cat", target: [2, 0] },
    ]);
    state = turn(state, 2, [{ type: "cat", target: [0, 3] }]);
    state = turn(state, 1, [
      { type: "cat", target: [3, 0] },
      { type: "cat", target: [3, 1] },
    ]);
    state = turn(state, 2, [{ type: "cat", target: [0, 4] }]);
    state = turn(state, 1, [
      { type: "cat", target: [3, 2] },
      { type: "cat", target: [3, 3] },
    ]);
    state = turn(state, 2, [{ type: "cat", target: [0, 3] }]);
    expect(state.status).toBe("playing");
    expectCountMatchesHistory(state, 6);

    // ply 7 - the capture. THIS is the move that used to go uncounted.
    state = turn(state, 1, [
      { type: "cat", target: [3, 4] },
      { type: "cat", target: [4, 4] },
    ]);

    expect(state.status).toBe("finished");
    expect(state.result).toEqual({ winner: 1, reason: "capture" });
    expectCountMatchesHistory(state, 7);
  });

  it("counts the move that walks the mover's own mouse onto the enemy cat", () => {
    // The other capture branch, `opCatCaught`: the mover LOSES by putting its
    // own mouse where the opponent's cat stands. Separate early return.
    let state = new GameState(standardConfig(3), 0);

    state = turn(state, 1, [
      { type: "mouse", target: [1, 0] },
      { type: "mouse", target: [1, 1] },
    ]);
    expectCountMatchesHistory(state, 1);

    state = turn(state, 2, [
      { type: "wall", target: [2, 0], wallOrientation: "horizontal" },
      { type: "wall", target: [2, 1], wallOrientation: "horizontal" },
    ]);
    expectCountMatchesHistory(state, 2);

    // ply 3 - p1's mouse steps onto the p2 cat at [0,2] and loses.
    state = turn(state, 1, [
      { type: "mouse", target: [0, 1] },
      { type: "mouse", target: [0, 2] },
    ]);

    expect(state.status).toBe("finished");
    expect(state.result).toEqual({ winner: 2, reason: "capture" });
    expectCountMatchesHistory(state, 3);
  });

  it("counts the move that ends it by the one-move rule", () => {
    // On a 3x3 board p1's capture arrives while the p2 cat is within two steps
    // of its own goal, so the game is a draw by the one-move rule instead of a
    // win. That is the third early return, and it has no winner at all.
    let state = new GameState(standardConfig(3), 0);

    state = turn(state, 1, [
      { type: "cat", target: [1, 0] },
      { type: "cat", target: [1, 1] },
    ]);
    state = turn(state, 2, [
      { type: "cat", target: [0, 1] },
      { type: "cat", target: [0, 0] },
    ]);
    expectCountMatchesHistory(state, 2);

    state = turn(state, 1, [
      { type: "cat", target: [1, 2] },
      { type: "cat", target: [2, 2] },
    ]);

    expect(state.status).toBe("finished");
    expect(state.result).toEqual({ reason: "one-move-rule" });
    expectCountMatchesHistory(state, 3);
  });

  it("counts the move that ends it by the survival limit", () => {
    // The fourth early return. `turnsToSurvive: 1` means p1's first move is
    // already the last one, so this also pins the count at the very first ply.
    let state = new GameState(
      {
        boardHeight: 3,
        boardWidth: 3,
        rated: false,
        variant: "survival",
        timeControl: {
          initialSeconds: 180,
          incrementSeconds: 0,
          preset: "blitz",
        },
        variantConfig: buildSurvivalInitialState({
          boardWidth: 3,
          boardHeight: 3,
          turnsToSurvive: 1,
          mouseCanMove: false,
        }),
      },
      0,
    );

    state = turn(state, 1, [{ type: "cat", target: [1, 0] }]);

    expect(state.status).toBe("finished");
    expect(state.result).toEqual({ winner: 2, reason: "survival" });
    expectCountMatchesHistory(state, 1);
  });

  it("counts an ordinary move too, which is what always worked", () => {
    // The control. A non-terminal move reached the assignment at the bottom all
    // along, so this number is unchanged by the fix. It is here so a later
    // change that breaks the ordinary path cannot hide behind the terminal ones.
    let state = new GameState(standardConfig(5), 0);
    state = turn(state, 1, [{ type: "cat", target: [1, 0] }]);
    expect(state.status).toBe("playing");
    expectCountMatchesHistory(state, 1);
  });
});
