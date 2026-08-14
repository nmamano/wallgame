import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import type {
  AnimalCycleInitialState,
  GameConfiguration,
  PlayerId,
  Move,
} from "../../shared/domain/game-types";
import {
  canEnqueue,
  enqueueToggle,
  promote,
  promotePremovesAtTurnStart,
  resolveDoubleStep,
  type LocalQueue,
} from "../../frontend/src/game/local-actions";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";

const TEST_CONFIG: GameConfiguration = {
  boardHeight: 9,
  boardWidth: 9,
  rated: false,
  variant: "standard",
  randomStart: false,
  timeControl: {
    initialSeconds: 180,
    incrementSeconds: 2,
    preset: "blitz",
  },
  variantConfig: buildStandardInitialState(9, 9),
};

const buildState = () => new GameState(TEST_CONFIG, 0);

const buildAnimalState = (
  pawns: AnimalCycleInitialState["pawns"],
  walls: AnimalCycleInitialState["walls"] = [],
) =>
  new GameState(
    {
      ...TEST_CONFIG,
      boardHeight: 8,
      boardWidth: 8,
      variant: "animal-cycle",
      variantConfig: { pawns, walls },
    },
    0,
  );

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
    // Standard keeps its established expanded two-step UI encoding.
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

  it("emits one atomic action for direct Animal crossing of an opponent", () => {
    const state = buildAnimalState({
      p1: { dog: [2, 1], mouse: [7, 0] },
      p2: { cat: [2, 2], elephant: [7, 7] },
    });
    const action = { type: "dog", target: [2, 3] } as const;
    expect(resolveDoubleStep({ state, playerId: 1, action })).toEqual([action]);
    expect(applyMoveSequence(state, 1, [action]).result).toBeUndefined();
  });

  it("does not stage forbidden Animal teammate endpoints or crossing routes", () => {
    const straight = buildAnimalState({
      p1: { dog: [2, 1], mouse: [2, 2] },
      p2: { cat: [0, 7], elephant: [7, 7] },
    });
    expect(
      canEnqueue({
        state: straight,
        playerId: 1,
        queue: [],
        action: { type: "dog", target: [2, 2] },
      }),
    ).toBe(false);
    expect(
      resolveDoubleStep({
        state: straight,
        playerId: 1,
        action: { type: "dog", target: [2, 3] },
      }),
    ).toBeNull();

    const blockedL = buildAnimalState(
      {
        p1: { dog: [2, 2], mouse: [2, 3] },
        p2: { cat: [0, 7], elephant: [7, 7] },
      },
      [{ cell: [3, 2], orientation: "horizontal" }],
    );
    expect(
      resolveDoubleStep({
        state: blockedL,
        playerId: 1,
        action: { type: "dog", target: [3, 3] },
      }),
    ).toBeNull();

    const openL = buildAnimalState({
      p1: { dog: [2, 2], mouse: [2, 3] },
      p2: { cat: [0, 7], elephant: [7, 7] },
    });
    expect(
      resolveDoubleStep({
        state: openL,
        playerId: 1,
        action: { type: "dog", target: [3, 3] },
      }),
    ).toEqual([{ type: "dog", target: [3, 3] }]);
  });

  it("returns null when the move is not a double step", () => {
    const state = buildState();
    const action = { type: "cat", target: [0, 1] } as const;
    expect(resolveDoubleStep({ state, playerId: 1, action })).toBeNull();
  });
});

describe("promote", () => {
  it("auto-sends one atomic Animal distance-two premove when its turn begins", () => {
    const state = buildAnimalState({
      p1: { dog: [2, 1], mouse: [7, 0] },
      p2: { cat: [2, 2], elephant: [7, 7] },
    });
    const atomic = { type: "dog", target: [2, 3] } as const;
    const promotion = promotePremovesAtTurnStart({
      state,
      playerId: 1,
      current: [],
      pending: [atomic],
      maxActions: 2,
    });
    const sent: Move["actions"][] = [];
    if (promotion.autoCommit) {
      sent.push(promotion.stagedNext);
    }

    expect(promotion.accepted).toEqual([atomic]);
    expect(sent).toEqual([[atomic]]);
    const after = applyMoveSequence(state, 1, sent[0]);
    expect(after.status).toBe("playing");
    expect(after.result).toBeUndefined();
    expect(after.history[0].move.actions).toEqual([atomic]);
  });

  it("keeps an ordinary one-step premove staged until the action budget is full", () => {
    const state = buildAnimalState({
      p1: { dog: [2, 1], mouse: [7, 0] },
      p2: { cat: [0, 7], elephant: [7, 7] },
    });
    const step = { type: "dog", target: [2, 2] } as const;
    const promotion = promotePremovesAtTurnStart({
      state,
      playerId: 1,
      current: [],
      pending: [step],
      maxActions: 2,
    });

    expect(promotion.accepted).toEqual([step]);
    expect(promotion.autoCommit).toBe(false);
    expect(promotion.stagedNext).toEqual([step]);
  });

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
