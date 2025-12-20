import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Trophy } from "lucide-react";
import { Board, type BoardProps, type BoardPawn } from "@/components/board";
import type {
  PlayerId,
  WallOrientation,
} from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";

type WallPositionWithState = NonNullable<BoardProps["walls"]>[number];

interface GamePlayer {
  id: string;
  playerId: PlayerId;
  name: string;
  rating: number;
  color: PlayerColor;
  type: string;
  isOnline: boolean;
  catSkin?: string;
  mouseSkin?: string;
}

interface ScoreboardEntry {
  id: number;
  name: string;
  score: number;
}

interface RematchResponseSummary {
  label: string;
  response: "pending" | "accepted" | "declined";
}

interface BoardPanelProps {
  // Container styling
  adjustedBoardContainerHeight: number;

  // Game state
  gameStatus: "playing" | "finished" | "aborted";
  gameState: {
    status: "playing" | "finished" | "aborted";
    turn: PlayerId;
  } | null;
  isMultiplayerMatch: boolean;
  isSpectator: boolean;
  isLoadingConfig: boolean;
  loadError: string | null;

  // Game over overlay
  winnerPlayer: GamePlayer | null;
  winReason: string;
  scoreboardEntries: ScoreboardEntry[];
  rematchState: {
    status: "idle" | "pending" | "starting" | "declined";
    responses: Record<PlayerId, "pending" | "accepted" | "declined">;
    requestId: number;
    decliner?: PlayerId;
    offerer?: PlayerId;
  };
  rematchResponseSummary: RematchResponseSummary[];
  rematchStatusText: string;
  spectatorRematchGameId?: string | null;
  primaryLocalPlayerId: PlayerId | null;
  userRematchResponse: "pending" | "accepted" | "declined" | null;
  handleAcceptRematch: () => void;
  handleDeclineRematch: () => void;
  handleProposeRematch: () => void;
  openRematchWindow: () => void;
  handleFollowSpectatorRematch?: () => void;
  handleExitAfterMatch: () => void;

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
  stagedActionsCount: number;
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
  activeLocalPlayerId: PlayerId | null;
  hasActionMessage: boolean;
  actionError: string | null;
  actionStatusText: string | null;
  clearStagedActions: () => void;
  commitStagedActions: () => void;
}

export function BoardPanel({
  adjustedBoardContainerHeight,
  gameStatus,
  gameState,
  isMultiplayerMatch,
  isSpectator,
  isLoadingConfig,
  loadError,
  winnerPlayer,
  winReason,
  scoreboardEntries,
  rematchState,
  rematchResponseSummary,
  rematchStatusText,
  spectatorRematchGameId,
  primaryLocalPlayerId,
  userRematchResponse,
  handleAcceptRematch,
  handleDeclineRematch,
  handleProposeRematch,
  openRematchWindow,
  handleFollowSpectatorRematch,
  handleExitAfterMatch,
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
  stagedActionsCount,
  actionablePlayerId,
  onCellClick,
  onWallClick,
  onPawnClick,
  onPawnDragStart,
  onPawnDragEnd,
  onCellDrop,
  stagedActions,
  activeLocalPlayerId,
  hasActionMessage,
  actionError,
  actionStatusText,
  clearStagedActions,
  commitStagedActions,
}: BoardPanelProps) {
  const followSpectatorRematch =
    handleFollowSpectatorRematch ?? (() => undefined);
  const isIncomingMultiplayerOffer =
    isMultiplayerMatch &&
    rematchState.status === "pending" &&
    primaryLocalPlayerId != null &&
    rematchState.offerer != null &&
    rematchState.offerer !== primaryLocalPlayerId;

  const isOutgoingMultiplayerOffer =
    isMultiplayerMatch &&
    rematchState.status === "pending" &&
    primaryLocalPlayerId != null &&
    rematchState.offerer === primaryLocalPlayerId;

  const hasLocalPlayer = primaryLocalPlayerId != null;
  const canProposeMultiplayerRematch =
    hasLocalPlayer && isMultiplayerMatch && rematchState.status === "idle";
  const showStagedActionControls = hasLocalPlayer;
  const forceReadOnlyBoard = !hasLocalPlayer;

  return (
    <div
      className="flex flex-col items-center justify-center bg-card/50 backdrop-blur rounded-xl border border-border shadow-sm p-2 lg:p-4 relative h-auto lg:h-[var(--board-panel-height)]"
      style={
        {
          "--board-panel-height": `${adjustedBoardContainerHeight}rem`,
        } as React.CSSProperties
      }
    >
      {/* Game Over Overlay */}
      {gameStatus === "finished" && (
        <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center rounded-xl">
          <Card className="p-8 max-w-md w-full text-center space-y-6 shadow-2xl border-primary/20">
            <Trophy className="w-16 h-16 mx-auto text-yellow-500" />
            <div>
              <h2 className="text-3xl font-bold mb-2">
                {winnerPlayer ? `${winnerPlayer.name} won` : "Draw"}
              </h2>
              <p className="text-muted-foreground text-lg">
                {winReason
                  ? winReason.charAt(0).toUpperCase() + winReason.slice(1)
                  : ""}
              </p>
            </div>
            {scoreboardEntries.length === 2 && (
              <div className="space-y-3">
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground font-semibold">
                  <Trophy className="w-4 h-4" />
                  <span>Match score</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {scoreboardEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-lg border border-dashed border-border/60 px-3 py-2"
                    >
                      <div className="text-xs text-muted-foreground">
                        {entry.name}
                      </div>
                      <div className="text-2xl font-semibold">
                        {entry.score}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-3">
              {isSpectator ? (
                spectatorRematchGameId ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                      Players started a rematch.
                    </p>
                    <Button onClick={followSpectatorRematch}>
                      Watch rematch
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Waiting to see if players rematch.
                  </p>
                )
              ) : isMultiplayerMatch && rematchState.status === "idle" ? (
                <p className="text-sm text-muted-foreground">
                  Propose a rematch to play again.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {rematchStatusText}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {rematchResponseSummary.map((entry, idx) => (
                      <div
                        key={`${entry.label}-${idx}`}
                        className="rounded-lg border border-border/60 px-3 py-2 text-left"
                      >
                        <div className="text-xs text-muted-foreground">
                          {entry.label}
                        </div>
                        <Badge
                          variant={
                            entry.response === "accepted"
                              ? "default"
                              : entry.response === "declined"
                                ? "destructive"
                                : "secondary"
                          }
                          className="mt-1"
                        >
                          {entry.response === "pending"
                            ? "Pending"
                            : entry.response.charAt(0).toUpperCase() +
                              entry.response.slice(1)}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {!isSpectator && canProposeMultiplayerRematch && (
                <div className="flex justify-center">
                  <Button onClick={handleProposeRematch}>
                    {rematchState.status === "declined"
                      ? "Propose rematch again"
                      : "Propose rematch"}
                  </Button>
                </div>
              )}

              {isOutgoingMultiplayerOffer && (
                <div className="flex justify-center">
                  <Button disabled>Rematch proposed</Button>
                </div>
              )}

              {((rematchState.status === "pending" && !isMultiplayerMatch) ||
                isIncomingMultiplayerOffer) && (
                <div className="flex justify-center gap-3">
                  <Button
                    onClick={handleAcceptRematch}
                    disabled={
                      !primaryLocalPlayerId ||
                      userRematchResponse === "accepted"
                    }
                  >
                    {userRematchResponse === "accepted"
                      ? "Accepted"
                      : "Accept rematch"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleDeclineRematch}
                    disabled={userRematchResponse === "declined"}
                  >
                    {userRematchResponse === "declined"
                      ? "Declined"
                      : "Decline"}
                  </Button>
                </div>
              )}
              {rematchState.status === "declined" && !isMultiplayerMatch && (
                <div className="flex justify-center">
                  <Button
                    variant="ghost"
                    onClick={openRematchWindow}
                    className="text-sm"
                  >
                    Offer rematch again
                  </Button>
                </div>
              )}
              {rematchState.status === "starting" && (
                <p className="text-sm text-muted-foreground">
                  Setting up the next game...
                </p>
              )}
            </div>
            <div className="flex justify-center gap-3">
              <Button variant="outline" onClick={handleExitAfterMatch}>
                Exit
              </Button>
            </div>
          </Card>
        </div>
      )}

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
        stagedActionsCount={stagedActionsCount}
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
                disabled={stagedActions.length === 0}
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
