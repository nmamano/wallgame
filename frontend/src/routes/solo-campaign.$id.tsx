import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useCallback } from "react";
import { Board } from "@/components/board";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SoloCampaignInfoPanel } from "@/components/solo-campaign-info-panel";
import { SoloCampaignEndPopup } from "@/components/solo-campaign-end-popup";
import { useSoloCampaignGame } from "@/hooks/use-solo-campaign-game";
import {
  SOLO_CAMPAIGN_LEVELS,
  getNextLevelId,
} from "../../../shared/domain/solo-campaign-levels";
import type { WallPosition, PlayerId } from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";
import { useCampaignProgress } from "@/hooks/use-campaign-progress";
import { useMediaQuery } from "@/hooks/use-media-query";
import { ArrowLeft, Check, Undo2 } from "lucide-react";

export const Route = createFileRoute("/solo-campaign/$id")({
  component: SoloCampaignLevel,
});

function SoloCampaignLevel() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const level = SOLO_CAMPAIGN_LEVELS[id];

  const { markCompleted, retryCompletion } = useCampaignProgress();

  // Memoize onComplete to prevent infinite loops
  const onComplete = useCallback(() => {
    markCompleted(id);
  }, [markCompleted, id]);

  // Redirect if level doesn't exist
  useEffect(() => {
    if (!level) {
      void navigate({ to: "/solo-campaign" });
    }
  }, [level, navigate]);

  if (!level) {
    return (
      <div className="container mx-auto py-12 px-4 max-w-4xl text-center">
        <p className="text-muted-foreground">Level not found. Redirecting...</p>
      </div>
    );
  }

  return (
    <SoloCampaignLevelContent
      key={id}
      level={level}
      levelId={id}
      onComplete={onComplete}
      onRetrySavingProgress={retryCompletion}
    />
  );
}

interface SoloCampaignLevelContentProps {
  level: (typeof SOLO_CAMPAIGN_LEVELS)[string];
  levelId: string;
  onComplete: () => void;
  /** Non-null only when saving this win failed; calling it tries again. */
  onRetrySavingProgress: (() => void) | null;
}

function SoloCampaignLevelContent({
  level,
  levelId,
  onComplete,
  onRetrySavingProgress,
}: SoloCampaignLevelContentProps) {
  const {
    gameState,
    isLoading,
    turnsRemaining,
    isPlayerTurn,
    isAiThinking,
    gameEnded,
    playerWon,
    stagedActions,
    premovedActions,
    selectedPawnId,
    draggingPawnId,
    boardPawns,
    resetLevel,
    handleCellClick,
    handleWallClick,
    handlePawnClick,
    handlePawnDragStart,
    handlePawnDragEnd,
    handleCellDrop,
    handleCommit,
    handleUndo,
    canCommit,
    canUndo,
    // Arrows
    arrows,
    // Last moves/walls
    lastMoves,
    lastWalls,
    // Annotations
    onWallSlotRightClick,
    onCellRightClickDragStart,
    onCellRightClickDragMove,
    onCellRightClickDragEnd,
    onArrowDragFinalize,
    arrowDragStateRef,
    annotations,
    previewAnnotation,
  } = useSoloCampaignGame(level);

  // Track if we've reported completion to prevent duplicate calls
  const hasReportedCompletion = useRef(false);

  // Report completion to the server when the player wins — for anonymous
  // players too, whose completions are kept as usage data even though they
  // are shown no progress markers.
  useEffect(() => {
    if (playerWon && !hasReportedCompletion.current) {
      hasReportedCompletion.current = true;
      onComplete();
    }
  }, [playerWon, onComplete]);

  // boardPawns is now provided by useSoloCampaignGame with staged positions applied

  const boardWalls: (WallPosition & {
    state?: "placed" | "staged" | "premoved";
  })[] = useMemo(() => {
    if (!gameState) return [];

    const walls = gameState.grid.getWalls();

    // Add staged wall actions
    const stagedWalls = stagedActions
      .filter((a) => a.type === "wall")
      .map((a) => ({
        cell: a.target,
        orientation: a.wallOrientation!,
        state: "staged" as const,
      }));

    // Add premoved wall actions
    const premovedWalls = premovedActions
      .filter((a) => a.type === "wall")
      .map((a) => ({
        cell: a.target,
        orientation: a.wallOrientation!,
        state: "premoved" as const,
      }));

    return [
      ...walls.map((w: WallPosition) => ({ ...w, state: "placed" as const })),
      ...stagedWalls,
      ...premovedWalls,
    ];
  }, [gameState, stagedActions, premovedActions]);

  // Player colors: user is always red, AI is always blue
  const playerColorsForBoard: Record<PlayerId, PlayerColor> = useMemo(() => {
    return {
      1: level.userPlaysAs === 1 ? "red" : "blue",
      2: level.userPlaysAs === 2 ? "red" : "blue",
    };
  }, [level.userPlaysAs]);

  const nextLevelId = getNextLevelId(levelId);
  const isLargeScreen = useMediaQuery("(min-width: 1024px)");

  if (isLoading) {
    return (
      <div className="container mx-auto py-12 px-4 max-w-lg text-center">
        <p className="text-muted-foreground">Loading level...</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 px-4 max-w-lg">
      {/* Back to campaign link */}
      <div className="mb-4">
        <Link
          to="/solo-campaign"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Campaign
        </Link>
      </div>

      {/* Info Panel with popup overlay */}
      <div className="relative mb-4">
        <SoloCampaignInfoPanel
          level={level}
          turnsRemaining={turnsRemaining}
          onReset={resetLevel}
          isAiThinking={isAiThinking}
        />

        {gameEnded && playerWon !== null && (
          <SoloCampaignEndPopup
            won={playerWon}
            nextLevelId={nextLevelId}
            onTryAgain={resetLevel}
            onRetrySavingProgress={onRetrySavingProgress}
          />
        )}
      </div>

      {/* Board */}
      {(() => {
        const boardContent = (
          <Board
            rows={level.boardHeight}
            cols={level.boardWidth}
            pawns={boardPawns}
            walls={boardWalls}
            playerColors={playerColorsForBoard}
            onCellClick={handleCellClick}
            onWallClick={handleWallClick}
            onPawnClick={handlePawnClick}
            onPawnDragStart={handlePawnDragStart}
            onPawnDragEnd={handlePawnDragEnd}
            onCellDrop={handleCellDrop}
            selectedPawnId={selectedPawnId}
            draggingPawnId={draggingPawnId}
            controllablePlayerId={level.userPlaysAs}
            disableMousePawnInteraction={!level.mouseCanMove}
            forceReadOnly={gameEnded}
            stagedActionsCount={stagedActions.length}
            // Arrows for staged/premoved moves
            arrows={arrows}
            // Last moves/walls (to show opponent's last move/wall)
            lastMoves={lastMoves ?? undefined}
            lastWalls={lastWalls ?? undefined}
            // Annotations
            annotations={annotations}
            previewAnnotation={previewAnnotation}
            onWallSlotRightClick={onWallSlotRightClick}
            onCellRightClickDragStart={onCellRightClickDragStart}
            onCellRightClickDragMove={onCellRightClickDragMove}
            onCellRightClickDragEnd={onCellRightClickDragEnd}
            arrowDragStateRef={arrowDragStateRef}
            onArrowDragFinalize={onArrowDragFinalize}
            gapSizeRem={isLargeScreen ? undefined : 0.75}
            flush={!isLargeScreen}
            className={isLargeScreen ? undefined : "p-0"}
            maxWidth={isLargeScreen ? undefined : "max-w-full"}
          />
        );
        return isLargeScreen ? (
          <Card className="p-2 bg-card/80 backdrop-blur border-border/50 mb-4">
            {boardContent}
          </Card>
        ) : (
          <div className="-mx-4 mb-4">{boardContent}</div>
        );
      })()}

      {/* Action buttons */}
      <div className="flex gap-2 justify-center">
        <Button
          variant="outline"
          onClick={handleUndo}
          disabled={!canUndo}
          className="gap-1"
        >
          <Undo2 className="h-4 w-4" />
          Undo
        </Button>
        <Button onClick={handleCommit} disabled={!canCommit} className="gap-1">
          <Check className="h-4 w-4" />
          Confirm Move
        </Button>
      </div>

      {/* Status messages */}
      {isAiThinking && (
        <p className="text-center text-sm text-muted-foreground mt-4">
          Opponent is thinking...
        </p>
      )}
      {isPlayerTurn && !gameEnded && stagedActions.length === 0 && (
        <p className="text-center text-sm text-muted-foreground mt-4">
          Your turn. Click on the board to make a move.
        </p>
      )}
      {stagedActions.length > 0 && stagedActions.length < 2 && (
        <p className="text-center text-sm text-muted-foreground mt-4">
          {stagedActions.length}/2 actions staged. Add another or confirm.
        </p>
      )}
    </div>
  );
}
