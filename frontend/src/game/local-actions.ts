import type {
  Action,
  PlayerId,
  GamePawnType,
} from "../../../shared/domain/game-types";
import type { GameState } from "../../../shared/domain/game-state";
import { requirePawnCell } from "../../../shared/domain/pawns";
import { actionsEqual, buildDoubleStepPaths } from "@/lib/gameViewModel";

export type LocalAction = Action;
export type LocalQueue = LocalAction[];

export const MAX_LOCAL_ACTIONS = 2;

export interface EnqueueContext {
  state: GameState | null;
  playerId: PlayerId | null;
  queue: LocalQueue;
  action: LocalAction;
  maxActions?: number;
}

export interface PromoteOptions {
  state: GameState | null;
  playerId: PlayerId | null;
  current: LocalQueue;
  pending: LocalQueue;
  maxActions?: number;
}

export interface PromoteResult {
  stagedNext: LocalQueue;
  accepted: LocalQueue;
  dropped: LocalQueue;
  premoveCleared: boolean;
}

export interface DoubleStepOptions {
  state: GameState | null;
  playerId: PlayerId | null;
  action: LocalAction;
}

export type ResolvedLocalIntent =
  | { kind: "add"; nextQueue: LocalQueue; autoCommit: boolean }
  | { kind: "remove"; nextQueue: LocalQueue }
  | { kind: "commit-double-step"; actions: LocalQueue }
  | { kind: "reject"; reason: string }
  | { kind: "no-op" };

export interface ResolveLocalIntentOptions extends EnqueueContext {
  mode: "staged" | "premove";
  currentCell?: readonly [number, number];
  originalCell?: readonly [number, number];
  pawnBlocked?: boolean;
  blockedReason?: string;
}

export const cloneAction = (action: LocalAction): LocalAction => {
  const target: LocalAction["target"] = [action.target[0], action.target[1]];
  if (action.type === "wall") {
    return {
      ...action,
      target,
      wallOrientation: action.wallOrientation,
    };
  }
  return {
    ...action,
    target,
  };
};

export const cloneQueue = (queue: LocalQueue): LocalQueue =>
  queue.map(cloneAction);

const simulateActions = (
  state: GameState,
  playerId: PlayerId,
  actions: LocalQueue,
): GameState | null => {
  try {
    const workingState =
      state.turn === playerId
        ? state
        : (() => {
            const clone = state.clone();
            clone.turn = playerId;
            clone.actionsRemaining = MAX_LOCAL_ACTIONS;
            clone.previousPawnPosition = undefined;
            return clone;
          })();
    return workingState.applyGameAction({
      kind: "move",
      move: { actions: cloneQueue(actions) },
      playerId,
      timestamp: Date.now(),
    });
  } catch {
    return null;
  }
};

export const canEnqueue = ({
  state,
  playerId,
  queue,
  action,
  maxActions = MAX_LOCAL_ACTIONS,
}: EnqueueContext): boolean => {
  if (!state || !playerId) {
    return false;
  }
  if (queue.length >= maxActions) {
    return false;
  }
  const candidate = [...queue, cloneAction(action)];
  return Boolean(simulateActions(state, playerId, candidate));
};

export const enqueueToggle = (
  queue: LocalQueue,
  action: LocalAction,
): LocalQueue => {
  // Check if exact same action exists (toggle off)
  const exactIndex = queue.findIndex((existing) =>
    actionsEqual(existing, action),
  );
  if (exactIndex !== -1) {
    return queue.filter((_, idx) => idx !== exactIndex);
  }

  // Otherwise add the action. Pawn moves append like anything else: a turn is
  // two actions and both may be steps of the same pawn, so a second step for an
  // already-queued pawn extends the queue into a double step rather than
  // retargeting the first step. `canEnqueue` validates the same appended queue.
  return [...queue, cloneAction(action)];
};

const resolvePawnCell = (
  state: GameState,
  playerId: PlayerId,
  pawnType: GamePawnType,
) => {
  return requirePawnCell(state.pawns, playerId, pawnType);
};

export const resolveDoubleStep = ({
  state,
  playerId,
  action,
}: DoubleStepOptions): LocalQueue | null => {
  if (!state || !playerId) {
    return null;
  }
  if (action.type === "wall") {
    return null;
  }
  const currentCell = resolvePawnCell(state, playerId, action.type);
  const distance =
    Math.abs(currentCell[0] - action.target[0]) +
    Math.abs(currentCell[1] - action.target[1]);
  if (distance !== 2) {
    return null;
  }
  const paths = buildDoubleStepPaths(action.type, currentCell, action.target);
  if (!paths.length) {
    return null;
  }
  for (const path of paths) {
    if (simulateActions(state, playerId, path)) {
      return cloneQueue(path);
    }
  }
  return null;
};

/**
 * Resolves the exact queue effect shared by taps, mouse drops and touch
 * previews. Callers execute this result; they must not reinterpret the action.
 */
export const resolveLocalIntent = ({
  state,
  playerId,
  queue,
  action,
  maxActions = MAX_LOCAL_ACTIONS,
  mode,
  currentCell,
  originalCell,
  pawnBlocked = false,
  blockedReason = "Illegal move.",
}: ResolveLocalIntentOptions): ResolvedLocalIntent => {
  if (!state || !playerId) return { kind: "no-op" };

  if (action.type !== "wall") {
    if (pawnBlocked) return { kind: "reject", reason: blockedReason };
    if (
      currentCell?.[0] === action.target[0] &&
      currentCell[1] === action.target[1]
    ) {
      return { kind: "no-op" };
    }

    const existing = queue.find((queued) => queued.type === action.type);
    if (existing && originalCell) {
      if (
        originalCell[0] === action.target[0] &&
        originalCell[1] === action.target[1]
      ) {
        return {
          kind: "remove",
          nextQueue: queue.filter((queued) => queued.type !== action.type),
        };
      }
      const distance =
        Math.abs(existing.target[0] - action.target[0]) +
        Math.abs(existing.target[1] - action.target[1]);
      if (distance > 1) {
        return {
          kind: "reject",
          reason:
            "You can only move 1 cell when you already have a staged action.",
        };
      }
    } else {
      const doubleStep = resolveDoubleStep({ state, playerId, action });
      if (doubleStep) {
        if (mode === "staged" && maxActions < 2) {
          return {
            kind: "reject",
            reason: "Only one action remains in this turn.",
          };
        }
        if (queue.length > 0) {
          return {
            kind: "reject",
            reason:
              "You can't make a double move after staging another action.",
          };
        }
        return mode === "staged"
          ? { kind: "commit-double-step", actions: doubleStep }
          : {
              kind: "add",
              nextQueue: doubleStep,
              autoCommit: false,
            };
      }
    }
  }

  const nextQueue = enqueueToggle(queue, action);
  if (nextQueue.length < queue.length) {
    return { kind: "remove", nextQueue };
  }
  if (!canEnqueue({ state, playerId, queue, action, maxActions })) {
    return {
      kind: "reject",
      reason:
        mode === "premove"
          ? action.type === "wall"
            ? "Premove wall placement is illegal."
            : "Premove is illegal."
          : action.type === "wall"
            ? "Illegal wall placement."
            : "Illegal move.",
    };
  }
  return {
    kind: "add",
    nextQueue,
    autoCommit: mode === "staged" && nextQueue.length === maxActions,
  };
};

export const promote = ({
  state,
  playerId,
  current,
  pending,
  maxActions = MAX_LOCAL_ACTIONS,
}: PromoteOptions): PromoteResult => {
  if (!pending.length) {
    return {
      stagedNext: cloneQueue(current),
      accepted: [],
      dropped: [],
      premoveCleared: false,
    };
  }
  if (!state || !playerId) {
    return {
      stagedNext: cloneQueue(current),
      accepted: [],
      dropped: cloneQueue(pending),
      premoveCleared: true,
    };
  }
  let stagedNext = cloneQueue(current);
  const accepted: LocalQueue = [];
  const dropped: LocalQueue = [];
  pending.forEach((action) => {
    if (
      !canEnqueue({
        state,
        playerId,
        queue: stagedNext,
        action,
        maxActions,
      })
    ) {
      dropped.push(cloneAction(action));
      return;
    }
    stagedNext = [...stagedNext, cloneAction(action)];
    accepted.push(cloneAction(action));
  });
  return {
    stagedNext,
    accepted,
    dropped,
    premoveCleared: accepted.length + dropped.length === pending.length,
  };
};
