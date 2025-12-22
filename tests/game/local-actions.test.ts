import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import type {
  GameConfiguration,
  PlayerId,
  Move,
} from "../../shared/domain/game-types";
import {
  canEnqueue,
  enqueueToggle,
  promote,
  resolveDoubleStep,
  type LocalQueue,
} from "../../frontend/src/game/local-actions";

const TEST_CONFIG: GameConfiguration = {
  boardHeight: 9,
  boardWidth: 9,
  rated: false,
  variant: "standard",
  timeControl: {
    initialSeconds: 180,
    incrementSeconds: 2,
    preset: "blitz",
  },
};

const buildState = () => new GameState(TEST_CONFIG, 0);

const applyMoveSequence = (
  state: GameState,
  playerId: PlayerId,
  actions: Move["actions"],
) =>
  state.applyGameAction({
    kind: "move",
    move: { actions },
    playerId,
    timestamp: Date.now(),
  });

describe("enqueueToggle", () => {
  it("adds a new action and removes it on toggle", () => {
    const action = { type: "cat", target: [1, 0] } as const;
    const queue = enqueueToggle([], action);
    expect(queue.length).toBe(1);
    expect(queue[0]).not.toBe(action);

    const cleared = enqueueToggle(queue, action);
    expect(cleared.length).toBe(0);
  });
});

describe("canEnqueue", () => {
  it("returns true for a legal single-step move", () => {
    const state = buildState();
    const action = { type: "cat", target: [1, 0] } as const;
    expect(
      canEnqueue({
        state,
        playerId: 1,
        queue: [],
        action,
      }),
    ).toBe(true);
  });

  it("returns false when the queue already meets the limit", () => {
    const state = buildState();
    const queue: LocalQueue = [
      { type: "cat", target: [1, 0] },
      { type: "mouse", target: [7, 0] },
    ];
    const action = {
      type: "wall",
      target: [0, 0],
      wallOrientation: "vertical",
    } as const;
    expect(
      canEnqueue({
        state,
        playerId: 1,
        queue,
        action,
      }),
    ).toBe(false);
  });

  it("returns false for an illegal wall placement", () => {
    const base = buildState();
    const wallAction = {
      type: "wall" as const,
      target: [4, 4] as const,
      wallOrientation: "vertical" as const,
    };
    const occupied = applyMoveSequence(base, 1, [wallAction]);
    expect(
      canEnqueue({
        state: occupied,
        playerId: 1,
        queue: [],
        action: wallAction,
      }),
    ).toBe(false);
  });
});

describe("resolveDoubleStep", () => {
  it("returns the path for a legal double move", () => {
    const state = buildState();
    const action = { type: "cat", target: [0, 2] } as const;
    const path = resolveDoubleStep({ state, playerId: 1, action });
    expect(path).not.toBeNull();
    expect(path?.length).toBe(2);
    expect(path?.[1].target).toEqual([0, 2]);
  });

  it("returns null when the move is not a double step", () => {
    const state = buildState();
    const action = { type: "cat", target: [0, 1] } as const;
    expect(resolveDoubleStep({ state, playerId: 1, action })).toBeNull();
  });
});

describe("promote", () => {
  it("applies pending actions sequentially and drops the rest", () => {
    const state = buildState();
    const current: LocalQueue = [{ type: "cat", target: [1, 0] }];
    const pending: LocalQueue = [
      { type: "mouse", target: [7, 0] },
      { type: "wall", target: [0, 0], wallOrientation: "vertical" },
    ];
    const result = promote({
      state,
      playerId: 1,
      current,
      pending,
    });
    expect(result.stagedNext.length).toBe(2);
    expect(result.accepted.length).toBe(1);
    expect(result.dropped.length).toBe(1);
    expect(result.premoveCleared).toBe(true);
  });

  it("drops everything when state is unavailable", () => {
    const pending: LocalQueue = [{ type: "cat", target: [1, 0] }];
    const result = promote({
      state: null,
      playerId: null,
      current: [],
      pending,
    });
    expect(result.accepted.length).toBe(0);
    expect(result.dropped.length).toBe(1);
    expect(result.stagedNext.length).toBe(0);
    expect(result.premoveCleared).toBe(true);
  });
});
