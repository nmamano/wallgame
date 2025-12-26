import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { Board, type BoardProps, type BoardPawn } from "@/components/board";
import type {
  PlayerId,
  WallOrientation,
} from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";
import type { Annotation } from "@/hooks/use-annotations";

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
  disableMousePawnInteraction: boolean;
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

  // Annotations (optional - only for non-touch devices)
  annotations?: Annotation[];
  previewAnnotation?: Annotation | null;
  onWallSlotRightClick?: (
    row: number,
    col: number,
    orientation: WallOrientation,
  ) => void;
  onCellRightClickDragStart?: (row: number, col: number) => void;
  onCellRightClickDragMove?: (row: number, col: number) => void;
  onCellRightClickDragEnd?: (row: number, col: number) => void;
  onArrowDragFinalize?: () => void;
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
  disableMousePawnInteraction,
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
  annotations,
  previewAnnotation,
  onWallSlotRightClick,
  onCellRightClickDragStart,
  onCellRightClickDragMove,
  onCellRightClickDragEnd,
  onArrowDragFinalize,
}: BoardPanelProps) {
  const hasLocalPlayer = primaryLocalPlayerId != null;
  const showStagedActionControls = hasLocalPlayer;
  const forceReadOnlyBoard = !hasLocalPlayer;
  const hasPendingActions =
    stagedActions.length > 0 || premovedActions.length > 0;

  return (
    <div
      className="flex flex-col items-center justify-center bg-card/50 backdrop-blur rounded-xl border border-border shadow-sm p-2 lg:p-4 relative h-auto lg:h-[var(--board-panel-height)] min-w-[400px]"
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
        disableMousePawnInteraction={disableMousePawnInteraction}
        stagedActionsCount={pendingActionsCount}
        controllablePlayerId={actionablePlayerId ?? undefined}
        forceReadOnly={forceReadOnlyBoard}
        annotations={annotations}
        previewAnnotation={previewAnnotation}
        onWallSlotRightClick={onWallSlotRightClick}
        onCellRightClickDragStart={onCellRightClickDragStart}
        onCellRightClickDragMove={onCellRightClickDragMove}
        onCellRightClickDragEnd={onCellRightClickDragEnd}
        onArrowDragFinalize={onArrowDragFinalize}
      />

      {/* Action messaging + staged action buttons */}
      <div
        className={`mt-2 lg:mt-4 w-full ${
          showStagedActionControls
            ? "grid grid-cols-3 items-center gap-2 lg:gap-3"
            : "flex items-center justify-start"
        }`}
      >
        {showStagedActionControls && (
          <>
            <div className="flex justify-start min-w-0">
              <Button
                size="sm"
                variant="outline"
                className="h-7 lg:h-9 px-2 lg:px-3 text-[clamp(9px,1.1vw,11px)] lg:text-[clamp(10px,0.9vw,13px)] whitespace-nowrap w-full"
                onClick={clearStagedActions}
                disabled={!hasPendingActions}
              >
                <span className="truncate block">Clear staged actions</span>
              </Button>
            </div>
            <div className="flex items-center justify-center text-[clamp(8px,1.1vw,11px)] lg:text-[clamp(10px,0.85vw,13px)] text-muted-foreground h-[2.2rem] lg:h-[2.4rem] min-w-0 overflow-hidden text-center leading-snug">
              {hasActionMessage && (
                <span
                  className={`min-w-0 block whitespace-normal break-words ${
                    actionError ? "text-red-500" : ""
                  }`}
                  title={actionStatusText ?? undefined}
                >
                  {actionStatusText}
                </span>
              )}
            </div>
            <div className="flex justify-end min-w-0">
              <Button
                size="sm"
                variant="outline"
                className="h-7 lg:h-9 px-2 lg:px-3 text-[clamp(9px,1.1vw,11px)] lg:text-[clamp(10px,0.9vw,13px)] whitespace-nowrap w-full"
                onClick={() => commitStagedActions()}
                disabled={
                  gameState?.status !== "playing" ||
                  gameState?.turn !== activeLocalPlayerId
                }
              >
                <span className="truncate block">Finish move</span>
              </Button>
            </div>
          </>
        )}
        {!showStagedActionControls && (
          <div className="flex items-center text-[clamp(8px,1.1vw,11px)] lg:text-[clamp(10px,0.85vw,13px)] text-muted-foreground h-[2.2rem] lg:h-[2.4rem] min-w-0 overflow-hidden leading-snug">
            {hasActionMessage && (
              <span
                className={`min-w-0 block whitespace-normal break-words ${
                  actionError ? "text-red-500" : ""
                }`}
                title={actionStatusText ?? undefined}
              >
                {actionStatusText}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
