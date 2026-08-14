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

export interface TurnStartPromotion extends PromoteResult {
  autoCommit: boolean;
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

/** The action points consumed by a submitted queue from this exact state. */
export const actionPointsUsed = (
  state: GameState,
  playerId: PlayerId,
  actions: LocalQueue,
): number => {
  const positions = new Map<GamePawnType, [number, number]>();
  let used = 0;
  for (const action of actions) {
    if (action.type === "wall") {
      used += 1;
      continue;
    }
    const current =
      positions.get(action.type) ??
      resolvePawnCell(state, playerId, action.type);
    used +=
      Math.abs(current[0] - action.target[0]) +
      Math.abs(current[1] - action.target[1]);
    positions.set(action.type, [action.target[0], action.target[1]]);
  }
  return used;
};

export const fillsActionBudget = (
  state: GameState,
  playerId: PlayerId,
  actions: LocalQueue,
  availableActions: number,
): boolean =>
  actions.length > 0 &&
  actionPointsUsed(state, playerId, actions) === availableActions;

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
  if (state.config.variant === "animal-cycle") {
    // An Animal Cycle direct distance-two UI intent is one submitted action
    // that consumes two action points. Expanding it changes capture timing
    // because each submitted action is an endpoint.
    return simulateActions(state, playerId, [action])
      ? [cloneAction(action)]
      : null;
  }

  // Preserve the established Standard-family UI encoding.
  for (const path of buildDoubleStepPaths(
    action.type,
    currentCell,
    action.target,
  )) {
    if (simulateActions(state, playerId, path)) return cloneQueue(path);
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

/** Promote a premove queue and decide whether the turn's budget is complete. */
export const promotePremovesAtTurnStart = (
  options: PromoteOptions,
): TurnStartPromotion => {
  const promotion = promote(options);
  return {
    ...promotion,
    autoCommit: Boolean(
      options.state &&
      options.playerId &&
      fillsActionBudget(
        options.state,
        options.playerId,
        promotion.stagedNext,
        options.maxActions ?? MAX_LOCAL_ACTIONS,
      ),
    ),
  };
};
