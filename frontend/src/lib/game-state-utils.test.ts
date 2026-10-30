import { describe, expect, it } from "bun:test";
import { GameState } from "../../../shared/domain/game-state";
import type { GameConfiguration } from "../../../shared/domain/game-types";
import { buildStandardInitialState } from "../../../shared/domain/standard-setup";
import { buildHistoryState } from "./history-utils";
import { clockViewFor, isClockLive } from "./game-state-utils";

const CONFIG: GameConfiguration = {
  boardHeight: 9,
  boardWidth: 9,
  rated: false,
  variant: "standard",
  randomStart: false,
  timeControl: { initialSeconds: 60, incrementSeconds: 0 },
  variantConfig: buildStandardInitialState(9, 9),
};

const live = new GameState(CONFIG, 0)
  .applyGameAction({
    kind: "move",
    playerId: 1,
    move: {
      actions: [{ type: "wall", target: [4, 4], wallOrientation: "vertical" }],
    },
    timestamp: 0,
  })
  .applyGameAction({
    kind: "move",
    playerId: 2,
    move: {
      actions: [{ type: "wall", target: [2, 2], wallOrientation: "vertical" }],
    },
    timestamp: 10_000,
  });
const finished = live.applyGameAction({
  kind: "resign",
  playerId: 1,
  timestamp: 20_000,
});
const pastOf = (state: GameState) =>
  buildHistoryState({
    config: CONFIG,
    historyEntries: state.history,
    cursor: 0,
  });

/** A replay of a game stored before clocks were recorded. */
const unrecorded = finished.clone();
unrecorded.history = unrecorded.history.map((entry) => ({
  ...entry,
  timeLeftSeconds: null,
}));

describe("clockViewFor", () => {
  it("keeps a player's running clocks while they look back in their own game", () => {
    const view = clockViewFor({
      gameState: live,
      historyState: pastOf(live),
      isReadOnlySession: false,
    });
    expect(view).toBe("current");
    expect(isClockLive(view, live)).toBe(true);
  });

  it("shows a spectator the past clocks at the cursor", () => {
    const view = clockViewFor({
      gameState: live,
      historyState: pastOf(live),
      isReadOnlySession: true,
    });
    expect(view).toBe("past");
    expect(isClockLive(view, live)).toBe(false);
  });

  it("shows a player the past clocks once their game is over", () => {
    expect(
      clockViewFor({
        gameState: finished,
        historyState: pastOf(finished),
        isReadOnlySession: false,
      }),
    ).toBe("past");
  });

  it("shows the final clocks of a replay at its end, and they are not live", () => {
    const view = clockViewFor({
      gameState: finished,
      historyState: null,
      isReadOnlySession: true,
    });
    expect(view).toBe("current");
    expect(isClockLive(view, finished)).toBe(false);
  });

  it("shows no clocks for a game whose clocks were never recorded", () => {
    for (const historyState of [null, pastOf(unrecorded)]) {
      const view = clockViewFor({
        gameState: unrecorded,
        historyState,
        isReadOnlySession: true,
      });
      expect(view).toBe("none");
      expect(isClockLive(view, unrecorded)).toBe(false);
    }
  });
});
