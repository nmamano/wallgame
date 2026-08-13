import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useMemo, useRef, useState, useLayoutEffect } from "react";
import { MatchingStagePanel } from "@/components/matching-stage-panel";
import { PlayerTimerCard } from "@/components/player-timer-card";
import { ActionsPanel } from "@/components/actions-panel";
import { BoardPanel, type EvalBarProps } from "@/components/board-panel";
import { Board } from "@/components/board";
import { EvaluationBar } from "@/components/evaluation-bar";
import { GameInfoPanel } from "@/components/game-info-panel";
import { MoveListAndChatPanel } from "@/components/move-list-and-chat-panel";
import { MobileActionToolbar } from "@/components/mobile-action-toolbar";
import { MobileMoveBar } from "@/components/mobile-move-bar";
import { MobileGameDrawer } from "@/components/mobile-game-drawer";
import { PuzzleVoteControl } from "@/components/puzzle-vote-control";
import { useGamePageController } from "@/hooks/use-game-page-controller";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useEvalBar } from "@/hooks/use-eval-bar";
import { useMobileViewport } from "@/hooks/use-mobile-viewport";
import { parseBestMoveOverlay } from "@/lib/best-move-overlay";
import type { PlayerId } from "../../../shared/domain/game-types";
import { getGameHandshake, getPuzzleBannerName } from "@/lib/game-session";

export const Route = createFileRoute("/game/$id")({
  component: GamePage,
});

// Thin wrapper: key={id} forces React to remount the entire game page when the
// game ID changes (e.g., rematch). This ensures all hooks (eval bar, game
// controller, WebSocket connections) get a clean lifecycle per game instead of
// carrying stale state from the previous game.
function GamePage() {
  const { id } = Route.useParams();
  return <GamePageContent key={id} />;
}

function GamePageContent() {
  const { id } = Route.useParams();
  const controller = useGamePageController(id);
  const { accessKind, matching, board, timers, actions, chat, info } =
    controller;
  const isSpectator = accessKind === "spectator";
  const isReplay = accessKind === "replay";

  // The saved puzzle's name, carried client-side in the launch handshake
  // (doc §G: nothing on the game record). Spectators and shared links have
  // no handshake and fall back to the generic "Puzzle" label — correct.
  const puzzleName = useMemo(
    () => getPuzzleBannerName(getGameHandshake(id)),
    [id],
  );

  // Eval bar state
  const isActivePlayer =
    accessKind !== "spectator" &&
    accessKind !== "replay" &&
    board.gameStatus === "playing";

  const evalBar = useEvalBar({
    gameId: id,
    config: info.config,
    historyCursor: chat.historyNav.cursor,
    currentState: board.currentGameState,
    historyState: board.historyGameState,
    isRatedGame: info.config?.rated ?? false,
    isActivePlayer,
    isPuzzle: false,
  });

  // Build eval bar props for BoardPanel
  const evalBarProps = useMemo((): EvalBarProps | undefined => {
    // Show eval bar when displayMode is not "off"
    const isVisible =
      evalBar.displayMode !== "off" && evalBar.toggleState === "on";
    const player1Color = board.playerColorsForBoard[1 as PlayerId] ?? "red";
    const player2Color = board.playerColorsForBoard[2 as PlayerId] ?? "blue";

    return {
      evaluation: evalBar.evaluation,
      isPending: evalBar.isPending,
      isVisible,
      player1Color,
      player2Color,
    };
  }, [
    evalBar.displayMode,
    evalBar.toggleState,
    evalBar.evaluation,
    evalBar.isPending,
    board.playerColorsForBoard,
  ]);

  // Build best-move overlay when in "eval-and-best-move" mode
  const bestMoveOverlay = useMemo(() => {
    if (evalBar.displayMode !== "eval-and-best-move" || !evalBar.bestMove)
      return null;
    const displayState =
      chat.historyNav.cursor !== null
        ? board.historyGameState
        : board.currentGameState;
    if (displayState?.status !== "playing") return null;
    return parseBestMoveOverlay(evalBar.bestMove, displayState);
  }, [
    evalBar.displayMode,
    evalBar.bestMove,
    chat.historyNav.cursor,
    board.historyGameState,
    board.currentGameState,
  ]);

  // Detect if screen is large (lg breakpoint = 1024px)
  const isLargeScreen = useMediaQuery("(min-width: 1024px)");
  const { viewportHeight } = useMobileViewport();

  // Note: Annotations are now managed by the controller (via useBoardInteractions hook)
  // and passed through board.annotations, board.previewAnnotation, etc.

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

  // Minimum panel widths (rem)
  const minTimerPanelWidth = isLargeScreen ? 36 : 23;
  const minBoardPanelWidth = isLargeScreen ? 36 : 23;

  // Board width is based on board dimensions, with a minimum for action text.
  const minBoardContainerWidth = Math.max(
    boardWidth + containerMargin * 2,
    minBoardPanelWidth,
  );

  // Timers and board share the same width: max of their minimums.
  const leftColumnWidth = Math.max(minBoardContainerWidth, minTimerPanelWidth);

  // Fixed component heights
  const timerHeight = 4;
  const infoCardHeight = 6.5;
  const actionButtonsHeight = 6.3;
  const chatTabsHeight = 3;
  const chatInputHeight = 4;
  const chatChannelsHeight = 2.5;
  const stagedActionsButtonsHeight = 4.5; // Space for buttons below board (mt-4 + button height + mb-2)

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

  // ============================================================================
  // Mobile Layout: measure-then-size board via ResizeObserver
  // ============================================================================

  // Ref + ResizeObserver for the flex-1 board area container.
  // All external chrome (timers, toolbar, drawer tab bar) is shrink-0,
  // so the browser handles the height subtraction — no magic pixel constants.
  const boardAreaRef = useRef<HTMLDivElement>(null);
  const [boardAreaSize, setBoardAreaSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = boardAreaRef.current;
    if (!el) return;
    // Synchronous initial measurement (avoids layout flash)
    const rect = el.getBoundingClientRect();
    setBoardAreaSize({ w: rect.width, h: rect.height });
    // Track subsequent changes (orientation, resize, keyboard)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setBoardAreaSize({
          w: entry.contentRect.width,
          h: entry.contentRect.height,
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Banner stack shared by the mobile and desktop trees — defined once so the
  // two layouts cannot drift (the desktop tree used to be missing the puzzle
  // banner entirely). Compact is the mobile styling.
  const renderGameBanners = (compact: boolean) => (
    <>
      {/* Puzzles look exactly like an ordinary game, so say what the goal is.
          Without this there is no way to tell a draw you achieved from a win you
          missed. On desktop the banner also carries the "Back to puzzles" link,
          because the slim mobile nav that holds it on mobile does not exist
          there — desktop keeps the global site nav, which knows nothing about
          puzzles. Symmetric padding keeps the goal text centered independently
          of the absolutely-positioned link. */}
      {info.isPuzzle && (
        <div
          className={`relative bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 text-center font-medium border-b border-indigo-200 dark:border-indigo-800 shrink-0 ${
            compact ? "py-0.5 text-xs" : "px-36 py-2 text-sm"
          }`}
        >
          {puzzleName ? `${puzzleName} - ` : "Puzzle - "}
          catch PuzzleBot&apos;s mouse before it catches yours.
          {!compact && (
            <Link
              to="/puzzles"
              className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 hover:underline"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to puzzles
            </Link>
          )}
        </div>
      )}
      {isSpectator && (
        <div
          className={`bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-center font-medium border-b border-amber-200 dark:border-amber-800 shrink-0 ${
            compact ? "py-0.5 text-xs" : "py-2 text-sm"
          }`}
        >
          {!compact && <span className="mr-2">👁️</span>}
          Spectating
        </div>
      )}
      {isReplay && (
        <div
          className={`bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-center font-medium border-b border-amber-200 dark:border-amber-800 shrink-0 ${
            compact ? "py-0.5 text-xs" : "py-2 text-sm"
          }`}
        >
          Replay
        </div>
      )}
    </>
  );

  if (!isLargeScreen) {
    // Board renders flush (no padding) — the measured container IS the grid space.
    // For < 8 columns, use 8 as reference so cells don't grow oversized.
    const mobileGapSizePx = 12;
    const referenceColsForWidth = Math.max(cols, 8);
    // Chrome within the main content area that reduces available board space:
    // 2 compact timers (~30px each) + eval bar (~28px) + 3 flex gaps (12px)
    // + bottom timer mt-2 margin (8px) + container py-1 padding (8px)
    const mobileChromePx = 116;
    const mobileCellSizePx =
      boardAreaSize.w > 0
        ? Math.max(
            28, // minimum tappable size
            Math.min(
              (boardAreaSize.h -
                mobileChromePx -
                (rows - 1) * mobileGapSizePx) /
                rows,
              (boardAreaSize.w -
                (referenceColsForWidth - 1) * mobileGapSizePx) /
                referenceColsForWidth,
            ),
          )
        : 2 * 16; // 2rem fallback before first measurement
    const mobileGapSizeRem = mobileGapSizePx / 16;
    const mobileCellSizeRem = mobileCellSizePx / 16;

    const hasLocalPlayer = board.primaryLocalPlayerId != null;

    return (
      <>
        {/* Matching panel renders above everything */}
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

        <div
          className="flex flex-col bg-background overflow-hidden"
          style={{ height: `${viewportHeight}px` }}
        >
          {/* Slim top nav */}
          <div className="flex items-center px-2 py-1 border-b border-border shrink-0">
            {/* From a puzzle, "back" means back to the candidate list you came from,
                not out to the site root - otherwise trying the next one costs two
                navigations and a scroll. */}
            <Link
              to={info.isPuzzle ? "/puzzles" : "/"}
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="text-xs font-medium">
                {info.isPuzzle ? "Back to puzzles" : "Wall Game"}
              </span>
            </Link>
          </div>

          {renderGameBanners(true)}

          {/* Main content: timers + eval bar + board — centered as a group */}
          <div
            ref={boardAreaRef}
            className="flex flex-col flex-1 items-center justify-center min-h-0 gap-1 py-1"
          >
            {board.shouldRender ? (
              <>
                {/* Top compact timer */}
                {timers.topPlayer && (
                  <div className="w-full px-1 shrink-0">
                    <PlayerTimerCard
                      player={timers.topPlayer}
                      isActive={timers.gameTurn === timers.topPlayer.playerId}
                      timeLeft={
                        timers.displayedTimeLeft[timers.topPlayer.playerId] ?? 0
                      }
                      goalDistance={
                        timers.goalDistances[timers.topPlayer.playerId] ?? null
                      }
                      score={timers.getPlayerMatchScore(timers.topPlayer)}
                      gameStatus={board.gameStatus}
                      isUnlimited={timers.isUnlimited}
                      compact
                    />
                  </div>
                )}

                {/* Eval bar — outside the board, as a sibling */}
                {evalBarProps && (
                  <div className="w-full shrink-0">
                    <EvaluationBar
                      evaluation={evalBarProps.evaluation}
                      isPending={evalBarProps.isPending}
                      isVisible={evalBarProps.isVisible}
                      player1Color={evalBarProps.player1Color}
                      player2Color={evalBarProps.player2Color}
                    />
                  </div>
                )}

                {/* Board — flush, edge-to-edge, naturally sized */}
                <div className="flex items-center justify-center w-full shrink-0">
                  <Board
                    rows={rows}
                    cols={cols}
                    pawns={board.boardPawns}
                    walls={
                      bestMoveOverlay
                        ? [...board.boardWalls, ...bestMoveOverlay.walls]
                        : board.boardWalls
                    }
                    arrows={
                      bestMoveOverlay
                        ? [...board.stagedArrows, ...bestMoveOverlay.arrows]
                        : board.stagedArrows
                    }
                    className="p-0"
                    maxWidth="max-w-full"
                    playerColors={board.playerColorsForBoard}
                    onCellClick={board.onCellClick}
                    onWallClick={board.onWallClick}
                    onPawnClick={board.onPawnClick}
                    onPawnDragStart={
                      board.interactionLocked
                        ? undefined
                        : board.onPawnDragStart
                    }
                    onPawnDragEnd={board.onPawnDragEnd}
                    onCellDrop={
                      board.interactionLocked ? undefined : board.onCellDrop
                    }
                    resolveBoardIntent={
                      board.interactionLocked
                        ? undefined
                        : board.resolveBoardIntent
                    }
                    executeBoardIntent={
                      board.interactionLocked
                        ? undefined
                        : board.executeBoardIntent
                    }
                    projectBoardIntent={
                      board.interactionLocked
                        ? undefined
                        : board.projectBoardIntent
                    }
                    lastMove={
                      !Array.isArray(board.lastMove)
                        ? board.lastMove
                        : undefined
                    }
                    lastMoves={
                      Array.isArray(board.lastMove) ? board.lastMove : undefined
                    }
                    lastWalls={board.lastWalls}
                    draggingPawnId={board.draggingPawnId}
                    selectedPawnId={board.selectedPawnId}
                    disableMousePawnInteraction={
                      board.disableMousePawnInteraction
                    }
                    stagedActionsCount={board.pendingActionsCount}
                    controllablePlayerId={board.actionablePlayerId ?? undefined}
                    forceReadOnly={!hasLocalPlayer}
                    gapSizeRem={mobileGapSizeRem}
                    maxCellSizeRem={mobileCellSizeRem}
                    flush
                  />
                </div>

                {/* Bottom compact timer — mt-2 balances the eval bar gap above the board */}
                {timers.bottomPlayer && (
                  <div className="w-full px-1 shrink-0 mt-2">
                    <PlayerTimerCard
                      player={timers.bottomPlayer}
                      isActive={
                        timers.gameTurn === timers.bottomPlayer.playerId
                      }
                      timeLeft={
                        timers.displayedTimeLeft[
                          timers.bottomPlayer.playerId
                        ] ?? 0
                      }
                      goalDistance={
                        timers.goalDistances[timers.bottomPlayer.playerId] ??
                        null
                      }
                      score={timers.getPlayerMatchScore(timers.bottomPlayer)}
                      gameStatus={board.gameStatus}
                      isUnlimited={timers.isUnlimited}
                      compact
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded border border-dashed border-border/50 bg-muted/30 text-center text-sm text-muted-foreground p-6 w-full">
                {matching.waitingMessage ?? "Waiting for players to join..."}
              </div>
            )}
          </div>

          {/* Horizontal move bar */}
          <div className="shrink-0 border-t border-border">
            <MobileMoveBar
              formattedHistory={chat.formattedHistory}
              historyNav={chat.historyNav}
            />
          </div>

          {/* Rate the puzzle you just beat (S-G4). Its own strip rather than
              more buttons in the toolbar below: at 390px that bar's centred
              result text runs underneath anything else on the right. The
              board area is measured, so this strip costs it a few pixels
              rather than breaking a layout budget. */}
          {actions.endgame.puzzleVote && (
            <div className="shrink-0 flex items-center justify-between gap-2 border-t border-border bg-card/90 px-3 py-1.5">
              {/* The label carries the failure message rather than the strip
                  growing a second line: swapping text keeps the row the same
                  height and the same width at 390px. */}
              <span
                className={`text-xs ${actions.endgame.puzzleVote.failed ? "text-destructive" : "text-muted-foreground"}`}
              >
                {actions.endgame.puzzleVote.failed
                  ? "Could not save — tap again"
                  : "Rate this puzzle"}
              </span>
              <PuzzleVoteControl {...actions.endgame.puzzleVote} />
            </div>
          )}

          {/* Floating action toolbar */}
          <div className="shrink-0">
            <MobileActionToolbar
              live={actions.live}
              endgame={actions.endgame}
            />
          </div>

          {/* Bottom drawer tab bar + drawer */}
          <div className="shrink-0">
            <MobileGameDrawer
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
              evalToggleState={evalBar.toggleState}
              evalDisplayMode={evalBar.displayMode}
              evalToggleDisabled={evalBar.isDisabled}
              evalToggleDisabledReason={evalBar.disabledReason}
              onEvalToggle={evalBar.toggleEval}
              onBestMoveToggle={evalBar.toggleBestMove}
              evalErrorMessage={evalBar.errorMessage}
            />
          </div>
        </div>
      </>
    );
  }

  // ============================================================================
  // Desktop Layout (unchanged)
  // ============================================================================
  return (
    <>
      <div className="min-h-screen bg-background flex flex-col">
        {renderGameBanners(false)}

        {/* Matching panel renders null when isOpen is false */}
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

        <div
          className="flex-1 py-2 lg:py-4 px-2 lg:px-4 flex flex-col lg:grid items-center lg:items-start justify-start lg:justify-center mx-auto w-full lg:w-fit"
          style={{
            gridTemplateColumns: `${leftColumnWidth}rem ${rightColumnMaxWidth}rem`,
            gap: `${gap}rem`,
          }}
        >
          {/* Left Column: Timers & Board */}
          <div
            className="flex flex-col w-full"
            style={{
              maxWidth: `${leftColumnWidth}rem`,
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
                    minWidthRem={minTimerPanelWidth}
                    goalDistance={
                      timers.goalDistances[timers.topPlayer.playerId] ?? null
                    }
                    score={timers.getPlayerMatchScore(timers.topPlayer)}
                    gameStatus={board.gameStatus}
                    isUnlimited={timers.isUnlimited}
                  />
                )}

                {/* Board Container */}
                <BoardPanel
                  adjustedBoardContainerHeight={adjustedBoardContainerHeight}
                  minWidthRem={minBoardContainerWidth}
                  gameState={board.gameState}
                  isLoadingConfig={board.isLoadingConfig}
                  loadError={board.loadError}
                  primaryLocalPlayerId={board.primaryLocalPlayerId}
                  rows={board.rows}
                  cols={board.cols}
                  boardPawns={board.boardPawns}
                  boardWalls={
                    bestMoveOverlay
                      ? [...board.boardWalls, ...bestMoveOverlay.walls]
                      : board.boardWalls
                  }
                  stagedArrows={
                    bestMoveOverlay
                      ? [...board.stagedArrows, ...bestMoveOverlay.arrows]
                      : board.stagedArrows
                  }
                  playerColorsForBoard={board.playerColorsForBoard}
                  interactionLocked={board.interactionLocked}
                  lastMove={board.lastMove}
                  lastWalls={board.lastWalls}
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
                  resolveBoardIntent={board.resolveBoardIntent}
                  executeBoardIntent={board.executeBoardIntent}
                  projectBoardIntent={board.projectBoardIntent}
                  stagedActions={board.stagedActions}
                  premovedActions={board.premovedActions}
                  pendingActionsCount={board.pendingActionsCount}
                  activeLocalPlayerId={board.activeLocalPlayerId}
                  hasActionMessage={board.hasActionMessage}
                  actionError={board.actionError}
                  actionStatusText={board.actionStatusText}
                  clearStagedActions={board.clearStagedActions}
                  commitStagedActions={board.commitStagedActions}
                  annotations={board.annotations}
                  previewAnnotation={board.previewAnnotation}
                  arrowDragStateRef={board.arrowDragStateRef}
                  onWallSlotRightClick={board.onWallSlotRightClick}
                  onCellRightClickDragStart={board.onCellRightClickDragStart}
                  onCellRightClickDragMove={board.onCellRightClickDragMove}
                  onCellRightClickDragEnd={board.onCellRightClickDragEnd}
                  onArrowDragFinalize={board.onArrowDragFinalize}
                  evalBarProps={evalBarProps}
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
                    minWidthRem={minTimerPanelWidth}
                    goalDistance={
                      timers.goalDistances[timers.bottomPlayer.playerId] ?? null
                    }
                    score={timers.getPlayerMatchScore(timers.bottomPlayer)}
                    gameStatus={board.gameStatus}
                    isUnlimited={timers.isUnlimited}
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
                evalToggleState={evalBar.toggleState}
                evalDisplayMode={evalBar.displayMode}
                evalToggleDisabled={evalBar.isDisabled}
                evalToggleDisabledReason={evalBar.disabledReason}
                onEvalToggle={evalBar.toggleEval}
                onBestMoveToggle={evalBar.toggleBestMove}
                evalErrorMessage={evalBar.errorMessage}
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
