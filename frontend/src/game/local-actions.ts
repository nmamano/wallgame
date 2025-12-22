import type {
  Action,
  PlayerId,
  PawnType,
} from "../../../shared/domain/game-types";
import type { GameState } from "../../../shared/domain/game-state";
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
  const index = queue.findIndex((existing) => actionsEqual(existing, action));
  if (index === -1) {
    return [...queue, cloneAction(action)];
  }
  return queue.filter((_, idx) => idx !== index);
};

const resolvePawnCell = (
  state: GameState,
  playerId: PlayerId,
  pawnType: PawnType,
) => {
  const pawns = state.pawns[playerId];
  return pawnType === "cat" ? pawns.cat : pawns.mouse;
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
  const paths = buildDoubleStepPaths(
    action.type as PawnType,
    currentCell,
    action.target,
  );
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
