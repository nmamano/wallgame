import type { GameStatus, PlayerId } from "../../../shared/domain/game-types";

export interface ControllerSelectorState {
  historyCursor: number | null;
  isReadOnlySession: boolean;
  controllerAllowsInteraction: boolean;
  gameStatus: GameStatus | null;
  gameTurn: PlayerId | null;
  actionablePlayerId: PlayerId | null;
  activeLocalPlayerId: PlayerId | null;
}

export const isViewingHistory = (
  state: Pick<ControllerSelectorState, "historyCursor">,
): boolean => state.historyCursor !== null;

export interface ActiveLocalPlayerInput {
  /**
   * The seat this page holds in an ONLINE game, or null when there is none -
   * local play, a spectator, a replay.
   */
  remoteSeatPlayerId: PlayerId | null;
  /** Whose turn the server says it is. */
  gameTurn: PlayerId | null;
  /**
   * The alternating active player of a LOCAL game, where two people share one
   * device and the page itself decides whose turn is being played.
   */
  localActivePlayerId: PlayerId | null;
}

/**
 * Who this page is currently allowed to act as.
 *
 * For an online seat this is DERIVED, not remembered. It used to be a cached
 * copy that only an inbound websocket state message could refresh, and board
 * 97f9d99c is what that cost: clear the cache while the socket is down and
 * nothing can put it back, because the only thing that would is the opponent
 * moving - which cannot happen while it is your turn. The page then treated
 * every click as a premove on a turn that was genuinely yours.
 *
 * Deriving it makes that state unrepresentable rather than guarded. A local
 * game keeps its own cache, because there the active player really does
 * alternate under the page's control and no server statement describes it.
 */
export const resolveActiveLocalPlayerId = (
  input: ActiveLocalPlayerInput,
): PlayerId | null => {
  if (input.remoteSeatPlayerId !== null) {
    return input.gameTurn === input.remoteSeatPlayerId
      ? input.remoteSeatPlayerId
      : null;
  }
  return input.localActivePlayerId;
};

export const canActNow = (state: ControllerSelectorState): boolean => {
  if (state.isReadOnlySession) return false;
  if (!state.controllerAllowsInteraction) return false;
  if (state.gameStatus !== "playing") return false;
  if (isViewingHistory(state)) return false;
  if (state.gameTurn == null) return false;
  if (!state.activeLocalPlayerId || !state.actionablePlayerId) return false;
  if (state.actionablePlayerId !== state.activeLocalPlayerId) return false;
  return state.gameTurn === state.activeLocalPlayerId;
};

export const shouldQueueAsPremove = (
  state: ControllerSelectorState,
): boolean => {
  if (state.isReadOnlySession) return false;
  if (!state.controllerAllowsInteraction) return false;
  if (state.gameStatus !== "playing") return false;
  if (isViewingHistory(state)) return false;
  return Boolean(state.actionablePlayerId);
};
