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
  resolveLocalIntent,
  type LocalQueue,
} from "../../frontend/src/game/local-actions";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";

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
  variantConfig: buildStandardInitialState(9, 9),
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

  it("appends a second step for the same pawn instead of retargeting the first", () => {
    const state = buildState();
    const firstStep = { type: "cat", target: [0, 1] } as const;
    const secondStep = { type: "cat", target: [0, 2] } as const;

    const queue = enqueueToggle([], firstStep);
    const extended = enqueueToggle(queue, secondStep);

    expect(extended.length).toBe(2);
    expect(canEnqueue({ state, playerId: 1, queue, action: secondStep })).toBe(
      true,
    );
    // Stepping twice must produce the same move as dragging straight to the
    // destination, so the turn's action budget fills and the move commits.
    expect(extended).toEqual(
      resolveDoubleStep({ state, playerId: 1, action: secondStep })!,
    );
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

describe("resolveLocalIntent", () => {
  it("resolves add and exact toggle removal from the same action", () => {
    const state = buildState();
    const action = {
      type: "wall",
      target: [4, 4],
      wallOrientation: "vertical",
    } as const;
    const add = resolveLocalIntent({
      state,
      playerId: 1,
      queue: [],
      action,
      mode: "staged",
    });
    expect(add.kind).toBe("add");
    if (add.kind !== "add") throw new Error("expected add");
    expect(add.nextQueue).toEqual([action]);

    const remove = resolveLocalIntent({
      state,
      playerId: 1,
      queue: add.nextQueue,
      action,
      mode: "staged",
    });
    expect(remove).toEqual({ kind: "remove", nextQueue: [] });
  });

  it("resolves a direct two-cell pawn target to the exact double-step commit", () => {
    const result = resolveLocalIntent({
      state: buildState(),
      playerId: 1,
      queue: [],
      action: { type: "cat", target: [0, 2] },
      mode: "staged",
      currentCell: [0, 0],
      originalCell: [0, 0],
    });
    expect(result.kind).toBe("commit-double-step");
    if (result.kind !== "commit-double-step") {
      throw new Error("expected double-step");
    }
    expect(result.actions).toHaveLength(2);
    expect(result.actions[1]?.target).toEqual([0, 2]);
  });

  it("resolves undo-to-origin and rejects a jump after an existing pawn step", () => {
    const state = buildState();
    const queue = [{ type: "cat", target: [0, 1] }] as LocalQueue;
    const common = {
      state,
      playerId: 1 as const,
      queue,
      mode: "staged" as const,
      currentCell: [0, 1] as const,
      originalCell: [0, 0] as const,
    };
    expect(
      resolveLocalIntent({
        ...common,
        action: { type: "cat", target: [0, 0] },
      }),
    ).toEqual({ kind: "remove", nextQueue: [] });
    expect(
      resolveLocalIntent({
        ...common,
        action: { type: "cat", target: [0, 3] },
      }).kind,
    ).toBe("reject");
  });

  it("appends a legal second pawn step and makes its exact next queue authoritative", () => {
    const queue = [{ type: "cat", target: [0, 1] }] as LocalQueue;
    const result = resolveLocalIntent({
      state: buildState(),
      playerId: 1,
      queue,
      action: { type: "cat", target: [0, 2] },
      mode: "staged",
      currentCell: [0, 1],
      originalCell: [0, 0],
    });
    expect(result.kind).toBe("add");
    if (result.kind !== "add") throw new Error("expected add");
    expect(result.nextQueue).toEqual([
      { type: "cat", target: [0, 1] },
      { type: "cat", target: [0, 2] },
    ]);
    expect(result.autoCommit).toBe(true);
  });

  it("resolves the same double-step as a premove without immediate commit", () => {
    const result = resolveLocalIntent({
      state: buildState(),
      playerId: 1,
      queue: [],
      action: { type: "cat", target: [0, 2] },
      mode: "premove",
      currentCell: [0, 0],
      originalCell: [0, 0],
    });
    expect(result.kind).toBe("add");
    if (result.kind !== "add") throw new Error("expected premove add");
    expect(result.nextQueue).toHaveLength(2);
    expect(result.autoCommit).toBe(false);
  });

  it("returns the same non-committing rejection shape for an occupied wall", () => {
    const action = {
      type: "wall",
      target: [4, 4],
      wallOrientation: "vertical",
    } as const;
    const occupied = applyMoveSequence(buildState(), 1, [action]);
    expect(
      resolveLocalIntent({
        state: occupied,
        playerId: 1,
        queue: [],
        action,
        mode: "staged",
      }),
    ).toEqual({ kind: "reject", reason: "Illegal wall placement." });
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
