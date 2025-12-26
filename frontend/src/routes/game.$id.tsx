import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { MatchingStagePanel } from "@/components/matching-stage-panel";
import { PlayerTimerCard } from "@/components/player-timer-card";
import { ActionsPanel } from "@/components/actions-panel";
import { BoardPanel } from "@/components/board-panel";
import { GameInfoPanel } from "@/components/game-info-panel";
import { MoveListAndChatPanel } from "@/components/move-list-and-chat-panel";
import { useGamePageController } from "@/hooks/use-game-page-controller";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useAnnotations } from "@/hooks/use-annotations";

export const Route = createFileRoute("/game/$id")({
  component: GamePage,
});

function GamePage() {
  const { id } = Route.useParams();
  const controller = useGamePageController(id);
  const {
    accessKind,
    isReadOnly,
    matching,
    board,
    timers,
    actions,
    chat,
    info,
  } = controller;
  const isSpectator = accessKind === "spectator";
  const isReplay = accessKind === "replay";

  // Detect if screen is large (lg breakpoint = 1024px)
  const isLargeScreen = useMediaQuery("(min-width: 1024px)");

  // Annotations (only for non-touch devices)
  const {
    annotations,
    hasAnnotations,
    previewAnnotation,
    toggleWallAnnotation,
    clearAnnotations,
    startArrowDrag,
    updateArrowDrag,
    endArrowDrag,
    finalizeArrowDrag,
  } = useAnnotations();

  // Clear annotations when a move is committed (detected by turn change)
  const prevTurnRef = useRef(board.gameState?.turn);
  useEffect(() => {
    const currentTurn = board.gameState?.turn;
    if (
      prevTurnRef.current !== undefined &&
      currentTurn !== prevTurnRef.current &&
      hasAnnotations
    ) {
      clearAnnotations();
    }
    prevTurnRef.current = currentTurn;
  }, [board.gameState?.turn, hasAnnotations, clearAnnotations]);

  // Annotation handlers
  const handleWallSlotRightClick = useCallback(
    (row: number, col: number, orientation: "horizontal" | "vertical") => {
      toggleWallAnnotation(row, col, orientation);
    },
    [toggleWallAnnotation],
  );

  const handleCellRightClickDragStart = useCallback(
    (row: number, col: number) => {
      startArrowDrag(row, col);
    },
    [startArrowDrag],
  );

  const handleCellRightClickDragMove = useCallback(
    (row: number, col: number) => {
      updateArrowDrag(row, col);
    },
    [updateArrowDrag],
  );

  const handleCellRightClickDragEnd = useCallback(
    (row: number, col: number) => {
      endArrowDrag(row, col);
    },
    [endArrowDrag],
  );

  // ============================================================================
  // Layout Calculations
  // ============================================================================
  const rows = board.rows ?? 8;
  const cols = board.cols ?? 8;

  // Board sizing constants - responsive based on screen size
  const maxCellSize = 3;
  const gapSize = 0.9;
  const boardPadding = isLargeScreen ? 2 : 1;
  const containerMargin = isLargeScreen ? 1 : 0.5;
  const boardWidth = cols * maxCellSize + (cols - 1) * gapSize + boardPadding;
  const boardHeight = rows * maxCellSize + (rows - 1) * gapSize + boardPadding;

  // Calculate board container dimensions (board + margin)
  // Ensure minimum width of 25rem (400px) to accommodate button text and timer cards
  const minBoardContainerWidth = 25;
  const boardContainerWidth = Math.max(
    boardWidth + containerMargin * 2,
    minBoardContainerWidth,
  );

  // Fixed component heights
  const timerHeight = 4;
  const infoCardHeight = 6.5;
  const actionButtonsHeight = 6.3;
  const chatTabsHeight = 3;
  const chatInputHeight = 4;
  const chatChannelsHeight = 2.5;
  const stagedActionsButtonsHeight = 3.5; // Space for buttons below board (mt-4 + button height)

  // Minimum heights for adjustable components
  const minBoardContainerHeight =
    boardHeight + containerMargin * 2 + stagedActionsButtonsHeight;
  const minChatScrollableHeight = 12;

  // Calculate gap size - responsive based on screen size
  const gap = isLargeScreen ? 1 : 0.5;

  // Right column max width
  const rightColumnMaxWidth = 25;

  // Left column total height = timer + gap + board container + gap + timer
  const leftColumnHeight =
    timerHeight + gap + minBoardContainerHeight + gap + timerHeight;

  // Right column total height = info + gap + buttons + gap + chat card
  // Chat card total includes: tabs + (channels + scrollable content + input)
  const minChatCardHeight =
    chatTabsHeight +
    chatChannelsHeight +
    minChatScrollableHeight +
    chatInputHeight;
  const rightColumnHeight =
    infoCardHeight + gap + actionButtonsHeight + gap + minChatCardHeight;

  // Determine which component needs to grow to match column heights
  const heightDiff = leftColumnHeight - rightColumnHeight;
  const adjustedBoardContainerHeight =
    heightDiff < 0
      ? minBoardContainerHeight - heightDiff
      : minBoardContainerHeight;

  // When chat card grows, only the scrollable content area grows (not tabs, channels, or input)
  // Cap the scrollable height to prevent the panel from becoming too tall
  const maxChatScrollableHeight = 10.95;
  const adjustedChatScrollableHeight = Math.min(
    heightDiff > 0
      ? minChatScrollableHeight + heightDiff
      : minChatScrollableHeight,
    maxChatScrollableHeight,
  );
  const adjustedChatCardHeight =
    chatTabsHeight +
    chatChannelsHeight +
    adjustedChatScrollableHeight +
    chatInputHeight;

  return (
    <>
      <div className="min-h-screen bg-background flex flex-col">
        {/* Spectator indicator banner */}
        {isSpectator && (
          <div className="bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-center py-2 text-sm font-medium border-b border-amber-200 dark:border-amber-800">
            <span className="mr-2">👁️</span>
            Spectating
          </div>
        )}
        {isReplay && (
          <div className="bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-center py-2 text-sm font-medium border-b border-amber-200 dark:border-amber-800">
            Replay
          </div>
        )}

        {/* Only show matching panel for players */}
        {!isReadOnly && (
          <>
            {console.debug("[game-page] matching panel state", {
              isMultiplayerMatch: info.isMultiplayerMatch,
              matchTypeHint: matching.matchType,
              authoritativeLifecycle: matching.lifecycle,
              accessKind: matching.accessKind,
            })}
            <MatchingStagePanel
              isOpen={matching.isOpen}
              players={matching.players}
              shareUrl={matching.shareUrl}
              statusMessage={matching.statusMessage}
              canAbort={matching.canAbort}
              onAbort={matching.onAbort}
              primaryAction={matching.primaryAction}
              matchTypeHint={matching.matchType}
              localRole={matching.localRole}
              onJoinerDismiss={matching.onJoinerDismiss}
              showShareInstructions={matching.showShareInstructions}
              waitingReason={matching.waitingReason}
            />
          </>
        )}

        <div
          className="flex-1 py-2 lg:py-4 px-2 lg:px-4 flex flex-col lg:grid items-center lg:items-start justify-start lg:justify-center mx-auto w-full lg:w-fit"
          style={{
            gridTemplateColumns: `${boardContainerWidth}rem ${rightColumnMaxWidth}rem`,
            gap: `${gap}rem`,
          }}
        >
          {/* Left Column: Timers & Board */}
          <div
            className="flex flex-col w-full"
            style={{
              maxWidth: `${boardContainerWidth}rem`,
              gap: `${gap}rem`,
            }}
          >
            {board.shouldRender ? (
              <>
                {/* Top Player (Opponent) Timer */}
                {timers.topPlayer && (
                  <PlayerTimerCard
                    player={timers.topPlayer}
                    isActive={timers.gameTurn === timers.topPlayer.playerId}
                    timeLeft={
                      timers.displayedTimeLeft[timers.topPlayer.playerId] ?? 0
                    }
                    isThinking={
                      timers.thinkingPlayer?.playerId ===
                      timers.topPlayer.playerId
                    }
                    score={timers.getPlayerMatchScore(timers.topPlayer)}
                    gameStatus={board.gameStatus}
                  />
                )}

                {/* Board Container */}
                <BoardPanel
                  adjustedBoardContainerHeight={adjustedBoardContainerHeight}
                  gameState={board.gameState}
                  isLoadingConfig={board.isLoadingConfig}
                  loadError={board.loadError}
                  primaryLocalPlayerId={board.primaryLocalPlayerId}
                  rows={board.rows}
                  cols={board.cols}
                  boardPawns={board.boardPawns}
                  boardWalls={board.boardWalls}
                  stagedArrows={board.stagedArrows}
                  playerColorsForBoard={board.playerColorsForBoard}
                  interactionLocked={board.interactionLocked}
                  lastMove={board.lastMove}
                  draggingPawnId={board.draggingPawnId}
                  selectedPawnId={board.selectedPawnId}
                  disableMousePawnInteraction={
                    board.disableMousePawnInteraction
                  }
                  actionablePlayerId={board.actionablePlayerId}
                  onCellClick={board.onCellClick}
                  onWallClick={board.onWallClick}
                  onPawnClick={board.onPawnClick}
                  onPawnDragStart={board.onPawnDragStart}
                  onPawnDragEnd={board.onPawnDragEnd}
                  onCellDrop={board.onCellDrop}
                  stagedActions={board.stagedActions}
                  premovedActions={board.premovedActions}
                  pendingActionsCount={board.pendingActionsCount}
                  activeLocalPlayerId={board.activeLocalPlayerId}
                  hasActionMessage={board.hasActionMessage}
                  actionError={board.actionError}
                  actionStatusText={board.actionStatusText}
                  clearStagedActions={board.clearStagedActions}
                  commitStagedActions={board.commitStagedActions}
                  annotations={annotations}
                  previewAnnotation={previewAnnotation}
                  onWallSlotRightClick={handleWallSlotRightClick}
                  onCellRightClickDragStart={handleCellRightClickDragStart}
                  onCellRightClickDragMove={handleCellRightClickDragMove}
                  onCellRightClickDragEnd={handleCellRightClickDragEnd}
                  onArrowDragFinalize={finalizeArrowDrag}
                />

                {/* Bottom Player (You) Timer */}
                {timers.bottomPlayer && (
                  <PlayerTimerCard
                    player={timers.bottomPlayer}
                    isActive={timers.gameTurn === timers.bottomPlayer.playerId}
                    timeLeft={
                      timers.displayedTimeLeft[timers.bottomPlayer.playerId] ??
                      0
                    }
                    isThinking={
                      timers.thinkingPlayer?.playerId ===
                      timers.bottomPlayer.playerId
                    }
                    score={timers.getPlayerMatchScore(timers.bottomPlayer)}
                    gameStatus={board.gameStatus}
                  />
                )}
              </>
            ) : (
              <div
                className="flex flex-1 items-center justify-center rounded border border-dashed border-border/50 bg-muted/30 text-center text-sm text-muted-foreground p-6"
                style={{
                  minHeight: `${adjustedBoardContainerHeight}rem`,
                }}
              >
                {matching.waitingMessage ?? "Waiting for players to join..."}
              </div>
            )}
          </div>

          {/* Right Column: Info, Actions & Chat */}
          <div
            className="flex flex-col w-full"
            style={{
              gap: `${gap}rem`,
              maxWidth: `${rightColumnMaxWidth}rem`,
            }}
          >
            <div className="order-3 lg:order-1">
              <GameInfoPanel
                config={info.config}
                defaultVariant={info.defaultVariant}
                defaultTimeControlPreset={info.defaultTimeControlPreset}
                sfxEnabled={info.sfxEnabled}
                onSfxToggle={info.onSfxToggle}
                musicEnabled={info.musicEnabled}
                onMusicToggle={info.onMusicToggle}
                interactionLocked={info.interactionLocked}
                isMultiplayerMatch={info.isMultiplayerMatch}
                unsupportedPlayers={info.unsupportedPlayers}
                placeholderCopy={info.placeholderCopy}
              />
            </div>

            <div className="order-1 lg:order-2">
              <ActionsPanel live={actions.live} endgame={actions.endgame} />
            </div>

            <div className="order-2 lg:order-3">
              <MoveListAndChatPanel
                adjustedChatCardHeight={adjustedChatCardHeight}
                activeTab={chat.activeTab}
                onTabChange={chat.onTabChange}
                formattedHistory={chat.formattedHistory}
                historyNav={chat.historyNav}
                hasNewMovesWhileRewound={chat.hasNewMovesWhileRewound}
                historyTabHighlighted={chat.historyTabHighlighted}
                chatTabHighlighted={chat.chatTabHighlighted}
                chatChannel={chat.chatChannel}
                messages={chat.messages}
                chatInput={chat.chatInput}
                onChannelChange={chat.onChannelChange}
                onInputChange={chat.onInputChange}
                onSendMessage={chat.onSendMessage}
                isSpectator={chat.isSpectator}
                isReplay={chat.isReplay}
                isTeamVariant={chat.isTeamVariant}
                isSending={chat.isSending}
                isOnlineGame={chat.isOnlineGame}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
