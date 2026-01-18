import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useCallback } from "react";
import { Board } from "@/components/board";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePuzzleGame } from "@/hooks/use-puzzle-game";
import { usePuzzleProgress } from "@/hooks/use-puzzle-progress";
import { PUZZLES, getNextPuzzleId } from "../../../shared/domain/puzzles";
import type { WallPosition, PlayerId } from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";
import { ArrowLeft, Check, Undo2, RotateCcw, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/puzzles/$id")({
  component: PuzzlePage,
});

function PuzzlePage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const puzzle = PUZZLES[id];
  const { markCompleted } = usePuzzleProgress();

  // Redirect if puzzle doesn't exist
  useEffect(() => {
    if (!puzzle) {
      void navigate({ to: "/puzzles" });
    }
  }, [puzzle, navigate]);

  if (!puzzle) {
    return (
      <div className="container mx-auto py-12 px-4 max-w-4xl text-center">
        <p className="text-muted-foreground">
          Puzzle not found. Redirecting...
        </p>
      </div>
    );
  }

  return (
    <PuzzlePageContent
      key={id}
      puzzle={puzzle}
      puzzleId={id}
      onSolved={() => markCompleted(id)}
    />
  );
}

interface PuzzlePageContentProps {
  puzzle: (typeof PUZZLES)[string];
  puzzleId: string;
  onSolved: () => void;
}

function PuzzlePageContent({
  puzzle,
  puzzleId,
  onSolved,
}: PuzzlePageContentProps) {
  const navigate = useNavigate();
  const {
    gameState,
    isLoading,
    puzzleStatus,
    isPlayerTurn,
    isOpponentThinking,
    stagedActions,
    premovedActions,
    selectedPawnId,
    draggingPawnId,
    boardPawns,
    resetPuzzle,
    retryMove,
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
  } = usePuzzleGame(puzzle);

  // Track if we've reported completion to prevent duplicate calls
  const hasReportedCompletion = useRef(false);

  // Report completion when puzzle is solved
  useEffect(() => {
    if (puzzleStatus === "solved" && !hasReportedCompletion.current) {
      hasReportedCompletion.current = true;
      onSolved();
    }
  }, [puzzleStatus, onSolved]);

  // Reset completion flag when puzzle changes
  useEffect(() => {
    hasReportedCompletion.current = false;
  }, [puzzleId]);

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

  // Player colors: human is red, opponent is blue
  const playerColorsForBoard: Record<PlayerId, PlayerColor> = useMemo(() => {
    return {
      1: puzzle.humanPlaysAs === 1 ? "red" : "blue",
      2: puzzle.humanPlaysAs === 2 ? "red" : "blue",
    };
  }, [puzzle.humanPlaysAs]);

  const nextPuzzleId = getNextPuzzleId(puzzleId);

  const handleNextPuzzle = useCallback(() => {
    if (nextPuzzleId) {
      void navigate({ to: `/puzzles/${nextPuzzleId}` });
    } else {
      void navigate({ to: "/puzzles" });
    }
  }, [nextPuzzleId, navigate]);

  if (isLoading) {
    return (
      <div className="container mx-auto py-12 px-4 max-w-lg text-center">
        <p className="text-muted-foreground">Loading puzzle...</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 px-4 max-w-lg">
      {/* Back to puzzles link */}
      <div className="mb-4">
        <Link
          to="/puzzles"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Puzzles
        </Link>
      </div>

      {/* Info Panel - all states rendered in same grid cell, only one visible */}
      {/* This ensures the container always sizes to the largest content */}
      <Card className="p-4 bg-card/80 backdrop-blur border-border/50 mb-4">
        <div className="grid">
          {/* Playing State */}
          <div
            className={`col-start-1 row-start-1 ${puzzleStatus !== "playing" ? "invisible" : ""}`}
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-foreground">
                  {puzzle.title}
                </h2>
                <p className="text-sm text-muted-foreground">
                  by {puzzle.author}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">Rating: {puzzle.difficulty}</Badge>
                <Button variant="ghost" size="icon" onClick={resetPuzzle}>
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Move your{" "}
              <span className="text-red-500 font-medium">red cat</span> to your
              home before your opponent does!
            </p>
          </div>

          {/* Wrong Move State */}
          <div
            className={`col-start-1 row-start-1 ${puzzleStatus !== "wrong_move" ? "invisible" : ""}`}
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-foreground">
                  Not quite!
                </h2>
                <p className="text-sm text-muted-foreground">
                  That&apos;s not the optimal move.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={resetPuzzle}>
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Reset
                </Button>
                <Button size="sm" onClick={retryMove}>
                  <Undo2 className="h-4 w-4 mr-1" />
                  Retry
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Try again to find the winning sequence!
            </p>
          </div>

          {/* Solved State */}
          <div
            className={`col-start-1 row-start-1 ${puzzleStatus !== "solved" ? "invisible" : ""}`}
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-foreground">
                  Puzzle Solved!
                </h2>
                <p className="text-sm text-muted-foreground">
                  You found the winning sequence.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={resetPuzzle}>
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Replay
                </Button>
                <Button size="sm" onClick={handleNextPuzzle}>
                  {nextPuzzleId ? (
                    <>
                      Next
                      <ChevronRight className="h-4 w-4 ml-1" />
                    </>
                  ) : (
                    "Done"
                  )}
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Excellent work! Ready for the next challenge?
            </p>
          </div>
        </div>
      </Card>

      {/* Board */}
      <Card className="p-2 bg-card/80 backdrop-blur border-border/50 mb-4">
        <Board
          rows={puzzle.boardHeight}
          cols={puzzle.boardWidth}
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
          controllablePlayerId={puzzle.humanPlaysAs}
          forceReadOnly={puzzleStatus !== "playing"}
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
          disabled={!canUndo || puzzleStatus !== "playing"}
          className="gap-1"
        >
          <Undo2 className="h-4 w-4" />
          Undo
        </Button>
        <Button
          onClick={handleCommit}
          disabled={!canCommit || puzzleStatus !== "playing"}
          className="gap-1"
        >
          <Check className="h-4 w-4" />
          Confirm Move
        </Button>
      </div>

      {/* Status messages */}
      {isOpponentThinking && puzzleStatus === "playing" && (
        <p className="text-center text-sm text-muted-foreground mt-4">
          Opponent is thinking...
        </p>
      )}
      {isPlayerTurn &&
        puzzleStatus === "playing" &&
        stagedActions.length === 0 && (
          <p className="text-center text-sm text-muted-foreground mt-4">
            Your turn. Click on the board to make a move.
          </p>
        )}
      {stagedActions.length > 0 &&
        stagedActions.length < 2 &&
        puzzleStatus === "playing" && (
          <p className="text-center text-sm text-muted-foreground mt-4">
            {stagedActions.length}/2 actions staged. Add another or confirm.
          </p>
        )}
    </div>
  );
}
