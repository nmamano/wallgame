import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { Board, type BoardProps, type BoardPawn } from "@/components/board";
import type {
  PlayerId,
  WallOrientation,
} from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";

type WallPositionWithState = NonNullable<BoardProps["walls"]>[number];

interface BoardPanelProps {
  // Container styling
  adjustedBoardContainerHeight: number;

  // Game state
  gameState: {
    status: "playing" | "finished" | "aborted";
    turn: PlayerId;
  } | null;
  isLoadingConfig: boolean;
  loadError: string | null;

  primaryLocalPlayerId: PlayerId | null;

  // Board props
  rows: number;
  cols: number;
  boardPawns: BoardPawn[];
  boardWalls: WallPositionWithState[];
  stagedArrows: BoardProps["arrows"];
  playerColorsForBoard: Record<PlayerId, PlayerColor>;
  interactionLocked: boolean;
  lastMove: BoardProps["lastMove"] | BoardProps["lastMoves"];
  draggingPawnId: string | null;
  selectedPawnId: string | null;
  actionablePlayerId: PlayerId | null;

  // Board handlers
  onCellClick: (row: number, col: number) => void;
  onWallClick: (row: number, col: number, orientation: WallOrientation) => void;
  onPawnClick: (pawnId: string) => void;
  onPawnDragStart: (pawnId: string) => void;
  onPawnDragEnd: () => void;
  onCellDrop: (pawnId: string, targetRow: number, targetCol: number) => void;

  // Staged actions
  stagedActions: unknown[];
  premovedActions: unknown[];
  pendingActionsCount: number;
  activeLocalPlayerId: PlayerId | null;
  hasActionMessage: boolean;
  actionError: string | null;
  actionStatusText: string | null;
  clearStagedActions: () => void;
  commitStagedActions: () => void;
}

export function BoardPanel({
  adjustedBoardContainerHeight,
  gameState,
  isLoadingConfig,
  loadError,
  primaryLocalPlayerId,
  rows,
  cols,
  boardPawns,
  boardWalls,
  stagedArrows,
  playerColorsForBoard,
  interactionLocked,
  lastMove,
  draggingPawnId,
  selectedPawnId,
  actionablePlayerId,
  onCellClick,
  onWallClick,
  onPawnClick,
  onPawnDragStart,
  onPawnDragEnd,
  onCellDrop,
  stagedActions,
  premovedActions,
  pendingActionsCount,
  activeLocalPlayerId,
  hasActionMessage,
  actionError,
  actionStatusText,
  clearStagedActions,
  commitStagedActions,
}: BoardPanelProps) {
  const hasLocalPlayer = primaryLocalPlayerId != null;
  const showStagedActionControls = hasLocalPlayer;
  const forceReadOnlyBoard = !hasLocalPlayer;
  const hasPendingActions =
    stagedActions.length > 0 || premovedActions.length > 0;

  return (
    <div
      className="flex flex-col items-center justify-center bg-card/50 backdrop-blur rounded-xl border border-border shadow-sm p-2 lg:p-4 relative h-auto lg:h-[var(--board-panel-height)]"
      style={
        {
          "--board-panel-height": `${adjustedBoardContainerHeight}rem`,
        } as React.CSSProperties
      }
    >
      <div className="absolute top-2 left-4 right-4 flex flex-col gap-2 text-sm text-muted-foreground">
        {isLoadingConfig && (
          <div className="flex items-center gap-2 text-xs">
            <AlertCircle className="w-4 h-4" />
            Loading game settings...
          </div>
        )}
        {loadError && (
          <div className="flex items-center gap-2 text-xs text-amber-600">
            <AlertCircle className="w-4 h-4" />
            {loadError}
          </div>
        )}
      </div>

      <Board
        rows={rows}
        cols={cols}
        pawns={boardPawns}
        walls={boardWalls}
        arrows={stagedArrows}
        className="p-0"
        maxWidth="max-w-full"
        playerColors={playerColorsForBoard}
        onCellClick={onCellClick}
        onWallClick={onWallClick}
        onPawnClick={onPawnClick}
        onPawnDragStart={interactionLocked ? undefined : onPawnDragStart}
        onPawnDragEnd={onPawnDragEnd}
        onCellDrop={interactionLocked ? undefined : onCellDrop}
        lastMove={!Array.isArray(lastMove) ? lastMove : undefined}
        lastMoves={Array.isArray(lastMove) ? lastMove : undefined}
        draggingPawnId={draggingPawnId}
        selectedPawnId={selectedPawnId}
        stagedActionsCount={pendingActionsCount}
        controllablePlayerId={actionablePlayerId ?? undefined}
        forceReadOnly={forceReadOnlyBoard}
      />

      {/* Action messaging + staged action buttons */}
      <div
        className={`mt-2 lg:mt-4 w-full ${
          showStagedActionControls
            ? "grid grid-cols-[1fr_auto_1fr] items-center gap-2 lg:gap-3"
            : "flex items-center justify-start"
        }`}
      >
        <div className="flex items-center text-[10px] lg:text-xs text-muted-foreground min-h-[1rem] lg:min-h-[1.25rem] justify-self-start">
          {hasActionMessage && (
            <>
              <AlertCircle
                className={`w-3 h-3 lg:w-4 lg:h-4 mr-1 lg:mr-2 ${
                  actionError ? "text-red-500" : "text-muted-foreground"
                }`}
              />
              <span className={actionError ? "text-red-500" : undefined}>
                {actionStatusText}
              </span>
            </>
          )}
        </div>
        {showStagedActionControls && (
          <>
            <div className="flex gap-1.5 lg:gap-3 justify-center">
              <Button
                size="sm"
                variant="outline"
                className="h-7 lg:h-9 px-2 lg:px-3 text-[11px] lg:text-sm"
                onClick={clearStagedActions}
                disabled={!hasPendingActions}
              >
                Clear staged actions
              </Button>
              <Button
                size="sm"
                className="h-7 lg:h-9 px-2 lg:px-3 text-[11px] lg:text-sm"
                onClick={() => commitStagedActions()}
                disabled={
                  gameState?.status !== "playing" ||
                  gameState?.turn !== activeLocalPlayerId
                }
              >
                Finish move
              </Button>
            </div>
            <div />
          </>
        )}
      </div>
    </div>
  );
}
