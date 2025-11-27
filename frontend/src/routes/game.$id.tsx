import { createFileRoute } from "@tanstack/react-router";
import { MatchingStagePanel } from "@/components/matching-stage-panel";
import { PlayerTimerCard } from "@/components/player-timer-card";
import { ActionsPanel } from "@/components/actions-panel";
import { BoardPanel } from "@/components/board-panel";
import { GameInfoPanel } from "@/components/game-info-panel";
import { MoveListAndChatPanel } from "@/components/move-list-and-chat-panel";
import { useGamePageController } from "@/hooks/use-game-page-controller";

export const Route = createFileRoute("/game/$id")({
  component: GamePage,
});

function GamePage() {
  const { id } = Route.useParams();
  const { matching, board, timers, actions, chat, info } =
    useGamePageController(id);

  // ============================================================================
  // Layout Calculations
  // ============================================================================
  const rows = board.rows ?? 8;
  const cols = board.cols ?? 8;

  // Board sizing constants (matching Board component internals)
  const maxCellSize = 3;
  const gapSize = 0.9;
  const boardPadding = 2;
  const containerMargin = 1;
  const boardWidth = cols * maxCellSize + (cols - 1) * gapSize + boardPadding;
  const boardHeight = rows * maxCellSize + (rows - 1) * gapSize + boardPadding;

  // Calculate board container dimensions (board + margin)
  const boardContainerWidth = boardWidth + containerMargin * 2;

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

  // Calculate gap size
  const gap = 1;

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
  const adjustedChatScrollableHeight =
    heightDiff > 0
      ? minChatScrollableHeight + heightDiff
      : minChatScrollableHeight;
  const adjustedChatCardHeight =
    chatTabsHeight +
    chatChannelsHeight +
    adjustedChatScrollableHeight +
    chatInputHeight;

  return (
    <>
      <div className="min-h-screen bg-background flex flex-col">
        <MatchingStagePanel
          isOpen={matching.isOpen}
          players={matching.players}
          shareUrl={matching.shareUrl}
          statusMessage={matching.statusMessage}
          canAbort={matching.canAbort}
          onAbort={matching.onAbort}
        />

        <div
          className="flex-1 py-4 px-4"
          style={{
            display: "grid",
            gridTemplateColumns: `${boardContainerWidth}rem ${rightColumnMaxWidth}rem`,
            gap: `${gap}rem`,
            alignItems: "start",
            justifyContent: "center",
            margin: "0 auto",
            width: "fit-content",
          }}
        >
          {/* Left Column: Timers & Board */}
          <div
            className="flex flex-col"
            style={{
              width: `${boardContainerWidth}rem`,
              gap: `${gap}rem`,
            }}
          >
            {/* Top Player (Opponent) Timer */}
            {timers.topPlayer && (
              <PlayerTimerCard
                player={timers.topPlayer}
                isActive={timers.gameTurn === timers.topPlayer.playerId}
                timeLeft={
                  timers.displayedTimeLeft[timers.topPlayer.playerId] ?? 0
                }
                isThinking={
                  timers.thinkingPlayer?.playerId === timers.topPlayer.playerId
                }
                score={timers.getPlayerMatchScore(timers.topPlayer)}
              />
            )}

            {/* Board Container */}
            <BoardPanel
              adjustedBoardContainerHeight={adjustedBoardContainerHeight}
              gameStatus={board.gameStatus}
              gameState={board.gameState}
              isLoadingConfig={board.isLoadingConfig}
              loadError={board.loadError}
              winnerPlayer={board.winnerPlayer}
              winReason={board.winReason}
              scoreboardEntries={board.scoreboardEntries}
              rematchState={board.rematchState}
              rematchResponseSummary={board.rematchResponseSummary}
              rematchStatusText={board.rematchStatusText}
              primaryLocalPlayerId={board.primaryLocalPlayerId}
              userRematchResponse={board.userRematchResponse}
              handleAcceptRematch={board.handleAcceptRematch}
              handleDeclineRematch={board.handleDeclineRematch}
              openRematchWindow={board.openRematchWindow}
              handleExitAfterMatch={board.handleExitAfterMatch}
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
              stagedActionsCount={board.stagedActionsCount}
              actionablePlayerId={board.actionablePlayerId}
              onCellClick={board.onCellClick}
              onWallClick={board.onWallClick}
              onPawnClick={board.onPawnClick}
              onPawnDragStart={board.onPawnDragStart}
              onPawnDragEnd={board.onPawnDragEnd}
              onCellDrop={board.onCellDrop}
              stagedActions={board.stagedActions}
              activeLocalPlayerId={board.activeLocalPlayerId}
              hasActionMessage={board.hasActionMessage}
              actionError={board.actionError}
              actionStatusText={board.actionStatusText}
              clearStagedActions={board.clearStagedActions}
              commitStagedActions={board.commitStagedActions}
            />

            {/* Bottom Player (You) Timer */}
            {timers.bottomPlayer && (
              <PlayerTimerCard
                player={timers.bottomPlayer}
                isActive={timers.gameTurn === timers.bottomPlayer.playerId}
                timeLeft={
                  timers.displayedTimeLeft[timers.bottomPlayer.playerId] ?? 0
                }
                isThinking={
                  timers.thinkingPlayer?.playerId ===
                  timers.bottomPlayer.playerId
                }
                score={timers.getPlayerMatchScore(timers.bottomPlayer)}
              />
            )}
          </div>

          {/* Right Column: Info, Actions & Chat */}
          <div
            className="flex flex-col"
            style={{
              gap: `${gap}rem`,
              maxWidth: `${rightColumnMaxWidth}rem`,
            }}
          >
            <GameInfoPanel
              config={info.config}
              defaultVariant={info.defaultVariant}
              defaultTimeControlPreset={info.defaultTimeControlPreset}
              soundEnabled={info.soundEnabled}
              onSoundToggle={info.onSoundToggle}
              interactionLocked={info.interactionLocked}
              isMultiplayerMatch={info.isMultiplayerMatch}
              unsupportedPlayers={info.unsupportedPlayers}
              placeholderCopy={info.placeholderCopy}
            />

            <ActionsPanel
              drawDecisionPrompt={actions.drawDecisionPrompt}
              takebackDecisionPrompt={actions.takebackDecisionPrompt}
              incomingPassiveNotice={actions.incomingPassiveNotice}
              getPlayerName={actions.getPlayerName}
              respondToDrawPrompt={actions.respondToDrawPrompt}
              respondToTakebackPrompt={actions.respondToTakebackPrompt}
              handleDismissIncomingNotice={actions.handleDismissIncomingNotice}
              resignFlowPlayerId={actions.resignFlowPlayerId}
              pendingDrawForLocal={actions.pendingDrawForLocal}
              pendingDrawOffer={actions.pendingDrawOffer}
              takebackPendingForLocal={actions.takebackPendingForLocal}
              pendingTakebackRequest={actions.pendingTakebackRequest}
              outgoingTimeInfo={actions.outgoingTimeInfo}
              canCancelDrawOffer={actions.canCancelDrawOffer}
              canCancelTakebackRequest={actions.canCancelTakebackRequest}
              handleCancelResign={actions.handleCancelResign}
              handleConfirmResign={actions.handleConfirmResign}
              handleCancelDrawOffer={actions.handleCancelDrawOffer}
              handleCancelTakebackRequest={actions.handleCancelTakebackRequest}
              handleDismissOutgoingInfo={actions.handleDismissOutgoingInfo}
              actionButtonsDisabled={actions.actionButtonsDisabled}
              manualActionsDisabled={actions.manualActionsDisabled}
              hasTakebackHistory={actions.hasTakebackHistory}
              handleStartResign={actions.handleStartResign}
              handleOfferDraw={actions.handleOfferDraw}
              handleRequestTakeback={actions.handleRequestTakeback}
              handleGiveTime={actions.handleGiveTime}
            />

            <MoveListAndChatPanel
              adjustedChatCardHeight={adjustedChatCardHeight}
              activeTab={chat.activeTab}
              onTabChange={chat.onTabChange}
              formattedHistory={chat.formattedHistory}
              chatChannel={chat.chatChannel}
              messages={chat.messages}
              chatInput={chat.chatInput}
              onChannelChange={chat.onChannelChange}
              onInputChange={chat.onInputChange}
              onSendMessage={chat.onSendMessage}
            />
          </div>
        </div>
      </div>
    </>
  );
}
