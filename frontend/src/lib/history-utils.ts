import {
  GameState,
  type MoveInHistory,
} from "../../../shared/domain/game-state";
import type {
  Cell,
  GameConfiguration,
  PlayerId,
} from "../../../shared/domain/game-types";

interface BuildHistoryStateOptions {
  config: GameConfiguration;
  historyEntries: MoveInHistory[];
  cursor: number;
}

const cloneCell = (cell: Cell): Cell => [cell[0], cell[1]] as Cell;

const nextTurnAfter = (moveIndex: number): PlayerId => {
  // moveIndex is 1-based, matching GameState.moveCount snapshots
  return moveIndex % 2 === 0 ? 1 : 2;
};

export function buildHistoryState({
  config,
  historyEntries,
  cursor,
}: BuildHistoryStateOptions): GameState | null {
  if (cursor === null || cursor < -1) {
    return null;
  }

  if (cursor >= historyEntries.length) {
    return null;
  }

  const snapshot = new GameState(config, 0);

  if (cursor === -1) {
    snapshot.history = [];
    snapshot.turn = 1;
    snapshot.moveCount = 0;
    return snapshot;
  }

  const entry = historyEntries[cursor];
  if (!entry) {
    return null;
  }

  snapshot.grid = entry.grid.clone();
  snapshot.pawns = {
    1: {
      cat: cloneCell(entry.catPos[0]),
      mouse: cloneCell(entry.mousePos[0]),
    },
    2: {
      cat: cloneCell(entry.catPos[1]),
      mouse: cloneCell(entry.mousePos[1]),
    },
  };
  snapshot.timeLeft = {
    1: entry.timeLeftSeconds[0],
    2: entry.timeLeftSeconds[1],
  };
  snapshot.turn = nextTurnAfter(entry.index);
  snapshot.moveCount = entry.index;
  snapshot.history = historyEntries.slice(0, cursor + 1);
  snapshot.status = "playing";
  snapshot.result = undefined;
  snapshot.lastMoveTime = 0;

  return snapshot;
}
