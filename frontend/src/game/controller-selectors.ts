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
