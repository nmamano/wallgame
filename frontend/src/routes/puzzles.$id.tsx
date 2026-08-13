import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useCallback,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Board } from "@/components/board";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePuzzleGame } from "@/hooks/use-puzzle-game";
import { usePuzzleProgress } from "@/hooks/use-puzzle-progress";
import { PUZZLES } from "../../../shared/domain/puzzles";
import {
  playPuzzle,
  savedPuzzlesQueryOptions,
  userQueryOptions,
} from "@/lib/api";
import { saveGameHandshake } from "@/lib/game-session";
import { useSettings } from "@/hooks/use-settings";
import {
  usePuzzlePlayback,
  isForcedToAuthoredLine,
  type PuzzlePlayback,
} from "@/hooks/use-puzzle-playback";
import { resolveSavedPuzzle, savedPuzzleSlug } from "@/lib/puzzle-links";
import {
  puzzleLaunchReducer,
  initialPuzzleLaunchState,
} from "@/lib/puzzle-launch-state";
import type { WallPosition, PlayerId } from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";
import { AudioControls } from "@/components/audio-controls";
import { SharePuzzleButton } from "@/components/share-puzzle-button";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  ArrowLeft,
  Check,
  Undo2,
  RotateCcw,
  ChevronRight,
  Lightbulb,
  StepForward,
} from "lucide-react";

/**
 * One puzzle's address, and the single place that decides how it is played.
 *
 * Every puzzle now lives in the same table and answers to the same URL. What
 * still differs is whether an opponent exists for that exact position, so this
 * route resolves the puzzle and then branches ONCE:
 *
 *   - a bot can play it  -> mint a game and hand off to /game/$id
 *   - it has an authored line -> walk it here, on this page
 *   - neither -> say so
 *
 * The second case is not a legacy leftover. Some authored boards are smaller
 * than any bot advertises, so in practice they are always played this way; for
 * the rest it is the fallback when no bot is around. Nil asked for exactly
 * that, and this is the honest boundary for it: the choice is made BEFORE a
 * game starts. A bot that disappears mid-game cannot become the authored line,
 * because the position may already have left it.
 */
export const Route = createFileRoute("/puzzles/$id")({
  /**
   * `?play=authored` says "walk the authored line, do not look for a bot".
   * It exists so the intent survives a navigation: when a launch is refused
   * on the listing, the card offers the authored line, and without this the
   * destination would simply try the same bot again and fail again.
   */
  validateSearch: (search: Record<string, unknown>): { play?: "authored" } =>
    search.play === "authored" ? { play: "authored" } : {},
  loader: async ({ context: { queryClient } }) => {
    // Prefetch, not ensure: a failed request should land on this component's
    // own message rather than the router's error page.
    await queryClient.prefetchQuery(savedPuzzlesQueryOptions);
  },
  component: PuzzlePage,
});

function PuzzlePage() {
  const { id } = Route.useParams();
  const { play: playIntent } = Route.useSearch();
  const navigate = useNavigate();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const settings = useSettings(!!userData?.user, userPending);
  const puzzlesQuery = useQuery(savedPuzzlesQueryOptions);
  const { markScriptedCompleted, retryScriptedCompletion } =
    usePuzzleProgress();
  /**
   * Whether a launch may be started, and why not. Starting a game is a
   * one-shot permission that only a player hands back — see the reducer.
   */
  const [launch, dispatchLaunch] = useReducer(
    puzzleLaunchReducer,
    initialPuzzleLaunchState,
  );

  // Memoised: the `?? []` fallback would otherwise be a fresh array on every
  // render, and both the playback hook and the "next puzzle" lookup key off it.
  const puzzles = useMemo(
    () => puzzlesQuery.data?.puzzles ?? [],
    [puzzlesQuery.data],
  );
  const puzzle = puzzlesQuery.data
    ? resolveSavedPuzzle(puzzles, id)
    : undefined;
  const { playbackFor, refetchFor } = usePuzzlePlayback(puzzles);

  /**
   * WHICH puzzle was forced onto its authored line after a refused launch —
   * an id, not a flag.
   *
   * A boolean would leak: "Next puzzle" changes only the route param, so the
   * component can be reused, and the next puzzle would inherit the decision
   * and skip bot discovery even with a bot sitting there. Keying it to the id
   * makes the state expire exactly when the puzzle does.
   */
  const [forcedAuthoredId, setForcedAuthoredId] = useState<string | null>(null);
  const forcedAuthored =
    !!puzzle && isForcedToAuthoredLine(puzzle, playIntent, forcedAuthoredId);

  // Memoised because the launch effect depends on it: a fresh object each
  // render would re-run the effect, and the effect starts a game.
  const playback: PuzzlePlayback | undefined = useMemo(() => {
    if (!puzzle) return undefined;
    if (forcedAuthored && puzzle.legacyScriptedId !== null) {
      return { kind: "scripted", scriptedId: puzzle.legacyScriptedId };
    }
    return playbackFor(puzzle);
  }, [puzzle, forcedAuthored, playbackFor]);

  const puzzleId = puzzle?.id;

  // "Next" follows the LIST, which the server returns in sort_index order —
  // the authored puzzles are ten rows among the rest now, not a sequence of
  // their own, so walking the domain set would skip everything else.
  const nextPuzzleSlug = useMemo(() => {
    if (!puzzle) return null;
    const index = puzzles.findIndex((row) => row.id === puzzle.id);
    const next = index === -1 ? undefined : puzzles[index + 1];
    return next ? savedPuzzleSlug(next) : null;
  }, [puzzles, puzzle]);

  // "Next" can reuse this component, so the permission has to be handed back
  // when the puzzle changes — otherwise a page that already launched once
  // would leave the next puzzle permanently unable to start.
  useEffect(() => {
    dispatchLaunch({ type: "puzzle-changed" });
  }, [puzzleId]);

  useEffect(() => {
    // Deliberately the ONLY condition. The effect re-runs whenever anything
    // query-derived changes, so "we already tried and it failed" has to live
    // in state rather than in whether an error card happens to be rendered.
    if (!launch.armed) return;
    if (!puzzle || playback?.kind !== "bot") return;
    dispatchLaunch({ type: "launch-started" });

    void (async () => {
      try {
        const response = await playPuzzle({
          botId: playback.bot.id,
          puzzleId: puzzle.id,
          hostDisplayName: settings.displayName,
          hostAppearance: {
            pawnColor: settings.pawnColor,
            catSkin: settings.catPawn,
            mouseSkin: settings.mousePawn,
            homeSkin: settings.homePawn,
          },
        });
        saveGameHandshake({
          gameId: response.gameId,
          token: response.token,
          socketToken: response.socketToken,
          role: response.role,
          playerId: response.playerId,
          shareUrl: response.shareUrl,
          puzzleId: puzzle.id,
          puzzleName: puzzle.displayName,
        });
        void navigate({ to: `/game/${response.gameId}`, replace: true });
      } catch (cause) {
        // Stays DISARMED. The bot may simply have gone away between the
        // listing and the click, which the server answers as a refused launch
        // rather than a broken game — but retrying is the player's call, and
        // re-arming here would let the effect call the same bot again on the
        // next render, unasked and invisibly.
        dispatchLaunch({
          type: "launch-failed",
          message:
            cause instanceof Error
              ? cause.message
              : "Unable to start this puzzle.",
        });
      }
    })();
  }, [launch.armed, puzzle, playback, settings, navigate]);

  const shell = (children: ReactNode) => (
    <div className="container mx-auto py-12 px-4 max-w-lg">
      <div className="mb-4">
        <Link
          to="/puzzles"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Puzzles
        </Link>
      </div>
      {children}
    </div>
  );

  // A list we could not read is NOT a retired puzzle, and saying so would
  // blame a good link for a bad connection.
  if (puzzlesQuery.isError) {
    return shell(
      <Card className="border-destructive p-6 text-destructive">
        <p>We could not load this puzzle. Check your connection and retry.</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => void puzzlesQuery.refetch()}
        >
          Try again
        </Button>
      </Card>,
    );
  }

  // Puzzles are retired over time, so an old link outliving its puzzle is
  // expected rather than an error.
  if (!puzzlesQuery.isPending && !puzzle) {
    return shell(
      <Card className="p-6">
        <h1 className="font-serif text-xl font-semibold text-foreground">
          This puzzle is no longer available
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The link may be out of date. There are plenty of others to try.
        </p>
        <Button
          className="mt-4"
          onClick={() => void navigate({ to: "/puzzles" })}
        >
          Browse puzzles
        </Button>
      </Card>,
    );
  }

  if (launch.error) {
    return shell(
      <Card className="border-destructive p-6 text-destructive">
        <p>{launch.error}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {/* The bot we picked is by now known to be stale — it either went
              away or stopped serving this position — so a retry has to ask
              who is online again rather than choosing the same one. */}
          <Button
            variant="outline"
            onClick={() => {
              // Order matters, and both happen in one batch: the refetch marks
              // this puzzle's shape pending SYNCHRONOUSLY, so by the time the
              // page is re-armed, playback is `pending` rather than the bot
              // that just refused. Without that the cached bot survives the
              // refetch and gets tried twice.
              void refetchFor(puzzle!);
              dispatchLaunch({ type: "retry-requested" });
            }}
          >
            Try again
          </Button>
          {/* No game was created, so falling back here is honest. */}
          {puzzle?.legacyScriptedId !== null && (
            <Button
              onClick={() => {
                // Never re-arms: there is nothing left to launch.
                dispatchLaunch({ type: "authored-chosen" });
                setForcedAuthoredId(puzzle!.id);
              }}
            >
              Play the authored line
            </Button>
          )}
        </div>
      </Card>,
    );
  }

  if (puzzle && playback?.kind === "scripted") {
    const authored = PUZZLES[playback.scriptedId];
    // `legacyScriptedId` is a pointer into code with no foreign key behind it,
    // so a row can outlive the line it names — a puzzle retired from
    // shared/domain/puzzles.ts, or a typo that passed "non-empty string"
    // validation. Say so instead of crashing on an undefined puzzle.
    if (!authored) {
      return shell(
        <Card className="border-destructive p-6 text-destructive">
          <p>This puzzle is temporarily unavailable.</p>
        </Card>,
      );
    }
    return (
      <PuzzlePageContent
        key={puzzle.id}
        puzzle={authored}
        puzzleId={puzzle.id}
        puzzleName={puzzle.displayName}
        difficulty={puzzle.difficulty}
        shareSlug={savedPuzzleSlug(puzzle)}
        nextPuzzleSlug={nextPuzzleSlug}
        // The ROW id, not the authored line's "1".."10": completion is
        // recorded against the puzzle, which is now one thing.
        onSolved={() => markScriptedCompleted(puzzle.id)}
        onRetrySavingProgress={retryScriptedCompletion}
      />
    );
  }

  if (puzzle && playback?.kind === "unavailable") {
    return shell(
      <Card className="border-destructive p-6 text-destructive">
        <p>
          The opponent for this puzzle is offline right now. Try again in a
          little while.
        </p>
      </Card>,
    );
  }

  // Everything left is a wait: the list, the opponent search, or the launch
  // itself. Deliberately one branch — while playback is `pending` we must NOT
  // fall through to the authored line, or a player would start walking a
  // scripted puzzle and be pulled into a bot game a moment later.
  return shell(
    <Card className="flex items-center gap-3 p-6">
      <Loader2 className="h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
      <p className="text-muted-foreground">
        {puzzle && playback?.kind === "bot"
          ? `Starting ${puzzle.displayName}…`
          : "Loading puzzle…"}
      </p>
    </Card>,
  );
}

interface PuzzlePageContentProps {
  /** The authored line to walk. */
  puzzle: (typeof PUZZLES)[string];
  /** The saved-puzzle row this is, which is what completion is recorded against. */
  puzzleId: string;
  /** The name and tier come from the ROW now, not from the authored line. */
  puzzleName: string;
  difficulty: number | null;
  /** What a share link should carry — the puzzle's number when it has one. */
  shareSlug: string;
  /**
   * Where "Next puzzle" goes, or null at the end of the list. Computed from
   * the LIST rather than from the authored set: the authored puzzles are no
   * longer a sequence of their own, they are ten rows among the rest.
   */
  nextPuzzleSlug: string | null;
  onSolved: () => void;
  /** Non-null only when saving this solve failed; calling it tries again. */
  onRetrySavingProgress: (() => void) | null;
}

function PuzzlePageContent({
  puzzle,
  puzzleId,
  puzzleName,
  difficulty,
  shareSlug,
  nextPuzzleSlug,
  onSolved,
  onRetrySavingProgress,
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
    showSolution,
    solutionShown,
    playSolutionMove,
    canPlaySolutionMove,
    lineLength,
    solutionAnnotations,
    handleCellClick,
    handleWallClick,
    handlePawnClick,
    handlePawnDragStart,
    handlePawnDragEnd,
    handleCellDrop,
    resolveBoardIntent,
    executeBoardIntent,
    projectBoardIntent,
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

  const isLargeScreen = useMediaQuery("(min-width: 1024px)");

  const handleNextPuzzle = useCallback(() => {
    if (nextPuzzleSlug) {
      // Empty search on purpose: `?play=authored` belongs to the puzzle it was
      // chosen for, and carrying it forward would silently force the next one
      // onto its authored line even with a bot available.
      void navigate({
        to: "/puzzles/$id",
        params: { id: nextPuzzleSlug },
        search: {},
      });
    } else {
      void navigate({ to: "/puzzles" });
    }
  }, [nextPuzzleSlug, navigate]);

  if (isLoading) {
    return (
      <div className="container mx-auto py-12 px-4 max-w-lg text-center">
        <p className="text-muted-foreground">Loading puzzle...</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 px-4 max-w-lg">
      {/* Back link and share sit on one row: the control cluster in the card
          below already wraps to two lines on a phone, and this row was empty
          to the right of the link. */}
      <div className="mb-4 flex items-center justify-between gap-2">
        <Link
          to="/puzzles"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Puzzles
        </Link>
        <SharePuzzleButton
          kind="saved"
          id={shareSlug}
          puzzleName={puzzleName}
          size="default"
        />
      </div>

      {/* Info Panel - all states rendered in same grid cell, only one visible */}
      {/* This ensures the container always sizes to the largest content */}
      <Card className="p-4 bg-card/80 backdrop-blur border-border/50 mb-4">
        <div className="grid">
          {/* Playing State */}
          <div
            className={`col-start-1 row-start-1 ${puzzleStatus !== "playing" ? "invisible" : ""}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xl font-semibold text-foreground">
                  {puzzleName}
                </h2>
                {/* Difficulty is metadata about the puzzle, not a control, so it
                    belongs with the byline rather than in the button row. It
                    shows the same 1-5 tier as the listing - a player who picked
                    "Difficulty: 1/5" should not then be shown a 1350 rating.
                    A row without one simply has no badge. */}
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-muted-foreground">
                    by {puzzle.author}
                  </p>
                  {difficulty !== null && (
                    <Badge variant="outline">Difficulty: {difficulty}/5</Badge>
                  )}
                </div>
              </div>
              {/* Ordered by purpose: the two solving aids first, in the order a
                  stuck player reaches for them, then puzzle-scoped Reset, then
                  the global audio toggle last since it is not about this puzzle. */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={showSolution}
                  disabled={solutionShown}
                  title="Draw the expected move on the board"
                >
                  <Lightbulb className="h-4 w-4 mr-1" />
                  {solutionShown ? "Shown" : "Show move"}
                </Button>
                {/* Only worth offering when the puzzle actually stores a continuation:
                    with a single stored turn there is no line to walk. */}
                {lineLength > 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={playSolutionMove}
                    disabled={!canPlaySolutionMove}
                    title="Play the expected move and see the opponent's reply"
                  >
                    <StepForward className="h-4 w-4 mr-1" />
                    Play the line
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={resetPuzzle}
                  title="Reset puzzle"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
                <AudioControls />
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xl font-semibold text-foreground">
                  Not quite!
                </h2>
                <p className="text-sm text-muted-foreground">
                  That&apos;s not the optimal move.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xl font-semibold text-foreground">
                  Puzzle Solved!
                </h2>
                <p className="text-sm text-muted-foreground">
                  You found the winning sequence.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={resetPuzzle}>
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Replay
                </Button>
                <Button size="sm" onClick={handleNextPuzzle}>
                  {nextPuzzleSlug ? (
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
            {onRetrySavingProgress && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-destructive">
                <span>We could not save this solve.</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetrySavingProgress}
                >
                  Try again
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Board */}
      {(() => {
        const boardContent = (
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
            resolveBoardIntent={resolveBoardIntent}
            executeBoardIntent={executeBoardIntent}
            projectBoardIntent={projectBoardIntent}
            selectedPawnId={selectedPawnId}
            draggingPawnId={draggingPawnId}
            controllablePlayerId={puzzle.humanPlaysAs}
            disableMousePawnInteraction
            forceReadOnly={puzzleStatus !== "playing"}
            stagedActionsCount={stagedActions.length}
            // Arrows for staged/premoved moves
            arrows={arrows}
            // Last moves/walls (to show opponent's last move/wall)
            lastMoves={lastMoves ?? undefined}
            lastWalls={lastWalls ?? undefined}
            // Annotations
            annotations={[...annotations, ...solutionAnnotations]}
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
