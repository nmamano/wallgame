import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { userQueryOptions, completeLevel } from "@/lib/api";
import { ArrowLeft, Check, Undo2 } from "lucide-react";

export const Route = createFileRoute("/solo-campaign/$id")({
  component: SoloCampaignLevel,
});

function SoloCampaignLevel() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const level = SOLO_CAMPAIGN_LEVELS[id];

  // Check if user is logged in
  const { data: userData } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;

  // Complete level mutation
  const completeLevelMutation = useMutation({
    mutationFn: (levelId: string) => completeLevel(levelId),
    onError: (error) => {
      console.error("Failed to save progress:", error);
    },
  });

  // Memoize onComplete to prevent infinite loops
  const onComplete = useCallback(() => {
    completeLevelMutation.mutate(id);
  }, [completeLevelMutation, id]);

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
      level={level}
      levelId={id}
      isLoggedIn={isLoggedIn}
      onComplete={onComplete}
    />
  );
}

interface SoloCampaignLevelContentProps {
  level: (typeof SOLO_CAMPAIGN_LEVELS)[string];
  levelId: string;
  isLoggedIn: boolean;
  onComplete: () => void;
}

function SoloCampaignLevelContent({
  level,
  levelId,
  isLoggedIn,
  onComplete,
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

  // Report completion to server when player wins
  useEffect(() => {
    if (playerWon && isLoggedIn && !hasReportedCompletion.current) {
      hasReportedCompletion.current = true;
      onComplete();
    }
  }, [playerWon, isLoggedIn, onComplete]);

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
          />
        )}
      </div>

      {/* Board */}
      <Card className="p-2 bg-card/80 backdrop-blur border-border/50 mb-4">
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
        />
      </Card>

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
