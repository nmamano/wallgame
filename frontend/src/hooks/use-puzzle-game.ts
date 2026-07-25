import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { PlayerId, Move, Action } from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";
import { GameState } from "../../../shared/domain/game-state";
import type { Puzzle } from "../../../shared/domain/puzzles";
import { buildPuzzleConfig } from "../../../shared/domain/puzzles";
import { useBoardInteractions } from "@/hooks/use-board-interactions";
import type { Annotation } from "@/hooks/use-annotations";
import type { BoardPawn, BoardProps, LastWall } from "@/components/board";
import { computeLastMoves, computeLastWalls } from "@/lib/gameViewModel";
import { pawnId } from "../../../shared/domain/game-utils";

export type PuzzleStatus = "loading" | "playing" | "wrong_move" | "solved";

export interface UsePuzzleGameResult {
  // Game state
  gameState: GameState | null;
  isLoading: boolean;

  // Puzzle state
  puzzleStatus: PuzzleStatus;
  currentMoveIndex: number;

  // Turn info
  isPlayerTurn: boolean;
  isOpponentThinking: boolean;

  // Board interactions (from useBoardInteractions)
  stagedActions: ReturnType<typeof useBoardInteractions>["stagedActions"];
  premovedActions: ReturnType<typeof useBoardInteractions>["premovedActions"];
  selectedPawnId: ReturnType<typeof useBoardInteractions>["selectedPawnId"];
  draggingPawnId: ReturnType<typeof useBoardInteractions>["draggingPawnId"];
  handleCellClick: ReturnType<typeof useBoardInteractions>["handleCellClick"];
  handleWallClick: ReturnType<typeof useBoardInteractions>["handleWallClick"];
  handlePawnClick: ReturnType<typeof useBoardInteractions>["handlePawnClick"];
  handlePawnDragStart: ReturnType<
    typeof useBoardInteractions
  >["handlePawnDragStart"];
  handlePawnDragEnd: ReturnType<
    typeof useBoardInteractions
  >["handlePawnDragEnd"];
  handleCellDrop: ReturnType<typeof useBoardInteractions>["handleCellDrop"];
  canCommit: ReturnType<typeof useBoardInteractions>["canCommit"];
  canUndo: ReturnType<typeof useBoardInteractions>["canUndo"];

  // Arrows for Board
  arrows: ReturnType<typeof useBoardInteractions>["arrows"];

  // Annotation handlers and state
  onWallSlotRightClick: ReturnType<
    typeof useBoardInteractions
  >["onWallSlotRightClick"];
  onCellRightClickDragStart: ReturnType<
    typeof useBoardInteractions
  >["onCellRightClickDragStart"];
  onCellRightClickDragMove: ReturnType<
    typeof useBoardInteractions
  >["onCellRightClickDragMove"];
  onCellRightClickDragEnd: ReturnType<
    typeof useBoardInteractions
  >["onCellRightClickDragEnd"];
  onArrowDragFinalize: ReturnType<
    typeof useBoardInteractions
  >["onArrowDragFinalize"];
  arrowDragStateRef: ReturnType<
    typeof useBoardInteractions
  >["arrowDragStateRef"];
  annotations: ReturnType<typeof useBoardInteractions>["annotations"];
  previewAnnotation: ReturnType<
    typeof useBoardInteractions
  >["previewAnnotation"];

  // Actions
  resetPuzzle: () => void;
  retryMove: () => void;
  /** Reveal the expected move for the current turn as board annotations. */
  showSolution: () => void;
  solutionShown: boolean;
  /** Annotations drawing the expected move; empty unless solutionShown. */
  solutionAnnotations: Annotation[];
  /** Play the expected move, to walk the engine's line turn by turn. */
  playSolutionMove: () => void;
  canPlaySolutionMove: boolean;
  /** Number of turns in the stored line. */
  lineLength: number;
  handleCommit: () => void;
  handleUndo: () => void;

  // Board pawns (with staged/premoved positions applied)
  boardPawns: BoardPawn[];

  // Last moves for showing opponent's last move
  lastMoves: BoardProps["lastMoves"] | null;

  // Last walls for highlighting recently placed walls
  lastWalls: LastWall[] | null;

  // Error state
  actionError: string | null;
}

/**
 * Check if two moves are equivalent.
 *
 * Handles the case where puzzle notation uses single destination (e.g., "b2")
 * but player's move is a double-step path (2 cat actions to reach that cell).
 */
function movesMatch(move1: Move, move2: Move): boolean {
  // Normalize both moves to compare them properly
  const norm1 = normalizeMove(move1);
  const norm2 = normalizeMove(move2);

  if (norm1.walls.length !== norm2.walls.length) return false;
  if (
    norm1.catDest?.[0] !== norm2.catDest?.[0] ||
    norm1.catDest?.[1] !== norm2.catDest?.[1]
  )
    return false;
  if (
    norm1.mouseDest?.[0] !== norm2.mouseDest?.[0] ||
    norm1.mouseDest?.[1] !== norm2.mouseDest?.[1]
  )
    return false;

  // Check walls match (order doesn't matter)
  if (norm1.walls.length === 0) return true;
  if (norm1.walls.length === 1) {
    return wallsMatch(norm1.walls[0], norm2.walls[0]);
  }
  // Two walls - either order
  return (
    (wallsMatch(norm1.walls[0], norm2.walls[0]) &&
      wallsMatch(norm1.walls[1], norm2.walls[1])) ||
    (wallsMatch(norm1.walls[0], norm2.walls[1]) &&
      wallsMatch(norm1.walls[1], norm2.walls[0]))
  );
}

interface NormalizedMove {
  catDest: [number, number] | null;
  mouseDest: [number, number] | null;
  walls: Action[];
}

/**
 * Normalize a move to its semantic meaning:
 * - For cat/mouse: just the final destination (handles double-step paths)
 * - For walls: the wall actions
 */
function normalizeMove(move: Move): NormalizedMove {
  let catDest: [number, number] | null = null;
  let mouseDest: [number, number] | null = null;
  const walls: Action[] = [];

  for (const action of move.actions) {
    if (action.type === "cat") {
      // Always take the last cat action as the destination (handles double-step)
      catDest = [action.target[0], action.target[1]];
    } else if (action.type === "mouse") {
      mouseDest = [action.target[0], action.target[1]];
    } else if (action.type === "wall") {
      walls.push(action);
    }
  }

  return { catDest, mouseDest, walls };
}

function wallsMatch(w1: Action, w2: Action): boolean {
  return (
    w1.target[0] === w2.target[0] &&
    w1.target[1] === w2.target[1] &&
    w1.wallOrientation === w2.wallOrientation
  );
}

export function usePuzzleGame(puzzle: Puzzle): UsePuzzleGameResult {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [puzzleStatus, setPuzzleStatus] = useState<PuzzleStatus>("loading");
  const [currentMoveIndex, setCurrentMoveIndex] = useState(0);
  const [isOpponentThinking, setIsOpponentThinking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [solutionShown, setSolutionShown] = useState(false);

  // State for retry: store the game state before the wrong move
  const preWrongMoveStateRef = useRef<GameState | null>(null);
  const preMoveIndexRef = useRef<number>(0);

  const gameStateRef = useRef<GameState | null>(null);

  // Ref to track if we're already processing an opponent move (to avoid effect re-triggering)
  const isProcessingOpponentMoveRef = useRef(false);

  // Determine which player is human and which is opponent (puzzle)
  const humanPlayerId = puzzle.humanPlaysAs;
  const opponentPlayerId: PlayerId = humanPlayerId === 1 ? 2 : 1;

  // Check if it's player's turn
  const isPlayerTurn =
    puzzleStatus === "playing" &&
    gameState?.status === "playing" &&
    gameState.turn === humanPlayerId;

  // Apply a move to the game state
  const applyMove = useCallback((playerId: PlayerId, move: Move) => {
    const current = gameStateRef.current;
    if (!current) return;

    const nextState = current.applyGameAction({
      kind: "move",
      move,
      playerId,
      timestamp: Date.now(),
    });

    gameStateRef.current = nextState;
    setGameState(nextState);
  }, []);

  // Compute board pawns with staged positions
  // TODO: Extract visualType logic into shared utility - same pattern exists in
  // use-game-page-controller.ts and game-showcase.tsx
  const boardPawns = useMemo((): BoardPawn[] => {
    if (!gameState) return [];

    const pawns = gameState.getPawns();
    return pawns.map((pawn) => ({
      ...pawn,
      id: pawnId(pawn),
      // Classic variant: "mouse" is actually "home"
      visualType: pawn.type === "mouse" ? "home" : pawn.type,
    }));
  }, [gameState]);

  // Store clearAllActions in a ref to avoid dependency issues
  const clearAllActionsRef = useRef<() => void>(() => undefined);

  // Use the board interactions hook
  const boardInteractions = useBoardInteractions({
    gameState,
    boardPawns,
    controllablePlayerId: humanPlayerId,
    // Can stage when it's player's turn and puzzle is active
    canStage: isPlayerTurn && !isOpponentThinking,
    // Premoves not really useful for puzzles, but allow them
    canPremove: false,
    mouseMoveLocked: true, // Classic variant: no mouse movement
    mouseMoveLockedMessage: "In classic puzzles, only cats can move.",
    sfxEnabled: false,
    onMoveReady: (actions) => {
      if (!isPlayerTurn) return;
      const move: Move = { actions };

      // Save state before applying move (for retry)
      preWrongMoveStateRef.current = gameStateRef.current;
      preMoveIndexRef.current = currentMoveIndex;

      // Check if the move matches any valid alternative
      const validAlternatives = puzzle.moves[currentMoveIndex] || [];
      const isCorrect = validAlternatives.some((alt) => movesMatch(move, alt));

      try {
        applyMove(humanPlayerId, move);
        setCurrentMoveIndex((i) => i + 1);

        if (!isCorrect) {
          setPuzzleStatus("wrong_move");
        }
      } catch (error) {
        console.error("Invalid move:", error);
        setActionError(error instanceof Error ? error.message : "Invalid move");
      }
    },
    onError: setActionError,
  });

  // Update the ref after boardInteractions is created
  useEffect(() => {
    clearAllActionsRef.current = boardInteractions.clearAllActions;
  }, [boardInteractions.clearAllActions]);

  // Compute board pawns with staged/premoved preview positions
  const boardPawnsWithPreview = useMemo((): BoardPawn[] => {
    if (!gameState) return [];

    // Get staged pawn moves
    const stagedPawnMoves = boardInteractions.stagedActions.filter(
      (a) => a.type === "cat" || a.type === "mouse",
    );

    // Build pawns with preview positions in a single pass
    return gameState.getPawns().map((pawn) => {
      const basePawn = {
        ...pawn,
        id: pawnId(pawn),
        // Classic variant: "mouse" is actually "home"
        visualType: pawn.type === "mouse" ? ("home" as const) : pawn.type,
      };

      if (pawn.playerId !== humanPlayerId) return basePawn;

      // Check for staged move
      const stagedMove = stagedPawnMoves.find((a) => a.type === pawn.type);
      if (stagedMove) {
        return {
          ...basePawn,
          cell: stagedMove.target,
          previewState: "staged" as const,
        };
      }

      return basePawn;
    });
  }, [gameState, boardInteractions.stagedActions, humanPlayerId]);

  // Initialize game from puzzle's baked-in starting state
  const initializeGame = useCallback(() => {
    setIsLoading(true);
    setPuzzleStatus("loading");
    setActionError(null);
    preWrongMoveStateRef.current = null;

    const config = buildPuzzleConfig(puzzle);
    const newGameState = new GameState(config, Date.now());

    // Set the starting turn — the human always moves first in puzzles
    newGameState.turn = puzzle.humanPlaysAs;

    gameStateRef.current = newGameState;
    setGameState(newGameState);
    setCurrentMoveIndex(0);
    setIsLoading(false);
    setPuzzleStatus("playing");
    setIsOpponentThinking(false);
    clearAllActionsRef.current();
  }, [puzzle]);

  // Initialize on mount and when puzzle changes
  useEffect(() => {
    initializeGame();
  }, [initializeGame]);

  // Auto-play opponent's response after correct player move
  useEffect(() => {
    if (puzzleStatus !== "playing") return;
    if (gameState?.status !== "playing") return;
    if (gameState.turn !== opponentPlayerId) return;
    // Use ref to prevent re-triggering (state would cause effect to re-run and clear timeout)
    if (isProcessingOpponentMoveRef.current) return;

    // Check if we've reached the end of the puzzle moves
    if (currentMoveIndex >= puzzle.moves.length) {
      return;
    }

    // Mark as processing and update UI state
    isProcessingOpponentMoveRef.current = true;
    setIsOpponentThinking(true);

    const timeoutId = setTimeout(() => {
      try {
        const alternatives = puzzle.moves[currentMoveIndex];
        if (alternatives && alternatives.length > 0) {
          const move = alternatives[0]; // Opponent uses first alternative
          applyMove(opponentPlayerId, move);
          setCurrentMoveIndex((i) => i + 1);
        }
      } catch (error) {
        console.error("Error applying opponent move:", error);
        setActionError(
          error instanceof Error ? error.message : "Error in puzzle",
        );
      } finally {
        isProcessingOpponentMoveRef.current = false;
        setIsOpponentThinking(false);
      }
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [
    puzzleStatus,
    gameState,
    currentMoveIndex,
    opponentPlayerId,
    applyMove,
    puzzle.moves,
  ]);

  // Check for puzzle solved when game ends
  useEffect(() => {
    if (puzzleStatus !== "playing") return;
    if (gameState?.status !== "finished") return;

    if (gameState.result?.winner === humanPlayerId) {
      setPuzzleStatus("solved");
    }
  }, [gameState, puzzleStatus, humanPlayerId]);

  // Manual commit (for when user wants to commit with fewer than 2 actions)
  const handleCommit = useCallback(() => {
    if (!isPlayerTurn || boardInteractions.stagedActions.length === 0) return;

    const move: Move = { actions: boardInteractions.stagedActions };

    // Save state before applying move (for retry)
    preWrongMoveStateRef.current = gameStateRef.current;
    preMoveIndexRef.current = currentMoveIndex;

    // Check if the move matches any valid alternative
    const validAlternatives = puzzle.moves[currentMoveIndex] || [];
    const isCorrect = validAlternatives.some((alt) => movesMatch(move, alt));

    try {
      applyMove(humanPlayerId, move);
      boardInteractions.clearStagedActions();
      setCurrentMoveIndex((i) => i + 1);

      if (!isCorrect) {
        setPuzzleStatus("wrong_move");
      }
    } catch (error) {
      console.error("Invalid move:", error);
      setActionError(error instanceof Error ? error.message : "Invalid move");
      boardInteractions.clearStagedActions();
    }
  }, [
    isPlayerTurn,
    boardInteractions,
    humanPlayerId,
    applyMove,
    currentMoveIndex,
    puzzle.moves,
  ]);

  // Retry after wrong move - go back to state before the wrong move
  const retryMove = useCallback(() => {
    if (puzzleStatus !== "wrong_move") return;
    if (!preWrongMoveStateRef.current) return;

    gameStateRef.current = preWrongMoveStateRef.current;
    setGameState(preWrongMoveStateRef.current);
    setCurrentMoveIndex(preMoveIndexRef.current);
    setPuzzleStatus("playing");
    setActionError(null);
    clearAllActionsRef.current();
  }, [puzzleStatus]);

  // Reset puzzle from the beginning
  const resetPuzzle = useCallback(() => {
    initializeGame();
  }, [initializeGame]);

  // Compute player colors (human is red, opponent is blue)
  const playerColorsForBoard: Record<PlayerId, PlayerColor> = useMemo(
    () => ({
      1: humanPlayerId === 1 ? "red" : "blue",
      2: humanPlayerId === 2 ? "red" : "blue",
    }),
    [humanPlayerId],
  );

  // Compute last moves to show opponent's last move
  const lastMoves = useMemo(
    () => computeLastMoves(gameState, playerColorsForBoard),
    [gameState, playerColorsForBoard],
  );

  // Compute last walls to highlight recently placed walls
  const lastWalls = useMemo(
    () => computeLastWalls(gameState, playerColorsForBoard),
    [gameState, playerColorsForBoard],
  );

  /**
   * The expected move for this turn, rendered with the same annotation vocabulary the
   * user's own right-click marks use: walls become wall-lines, pawn moves become an
   * arrow from where the pawn stands now to its destination. Only the first listed
   * alternative is shown - the others are equally correct, but drawing all of them at
   * once reads as noise rather than as an answer.
   */
  const solutionAnnotations = useMemo((): Annotation[] => {
    if (!solutionShown || !gameState) return [];
    const alternative = puzzle.moves[currentMoveIndex]?.[0];
    if (!alternative) return [];

    return alternative.actions.map((action): Annotation => {
      if (action.type === "wall") {
        return {
          type: "wall-line",
          row: action.target[0],
          col: action.target[1],
          orientation: action.wallOrientation ?? "vertical",
        };
      }
      const pawns = gameState.pawns[humanPlayerId];
      const from = action.type === "cat" ? pawns.cat : pawns.mouse;
      return { type: "arrow", from, to: action.target };
    });
  }, [solutionShown, gameState, puzzle.moves, currentMoveIndex, humanPlayerId]);

  const showSolution = useCallback(() => setSolutionShown(true), []);

  /**
   * Play the expected move for the human's side, so the engine's whole line can be walked
   * turn by turn. Seeing a key move on its own is not enough to judge it - the reason a
   * quiet move is good usually lives several turns later, in the continuation it forces.
   *
   * This deliberately reuses the normal move path rather than building a separate replay
   * of the position: applying the move leaves the puzzle in exactly the state it would be
   * in had the solver found it, and the existing auto-reply effect plays the opponent's
   * answer. Stepping backwards is `resetPuzzle` and forward again, which keeps a single
   * source of truth for the board instead of a second, parallel one.
   */
  const playSolutionMove = useCallback(() => {
    if (!isPlayerTurn || isOpponentThinking) return;
    const expected = puzzle.moves[currentMoveIndex]?.[0];
    if (!expected) return;

    try {
      applyMove(humanPlayerId, expected);
      clearAllActionsRef.current();
      setCurrentMoveIndex((i) => i + 1);
    } catch (error) {
      console.error("Could not play the expected move:", error);
      setActionError(
        error instanceof Error ? error.message : "Could not play that move",
      );
    }
  }, [
    isPlayerTurn,
    isOpponentThinking,
    puzzle.moves,
    currentMoveIndex,
    applyMove,
    humanPlayerId,
  ]);

  /** Whether there is still a stored turn for the human to step through. */
  const canPlaySolutionMove =
    isPlayerTurn &&
    !isOpponentThinking &&
    Boolean(puzzle.moves[currentMoveIndex]?.[0]);

  /** Turns of the stored line, so the UI can show how far along the review is. */
  const lineLength = puzzle.moves.length;

  // Re-hide once the turn advances or the puzzle restarts, so a reveal never leaks
  // into the next turn (where the annotation would point at a stale move).
  useEffect(() => {
    setSolutionShown(false);
  }, [currentMoveIndex]);

  return {
    gameState,
    isLoading,
    puzzleStatus,
    currentMoveIndex,
    isPlayerTurn,
    isOpponentThinking,
    stagedActions: boardInteractions.stagedActions,
    premovedActions: boardInteractions.premovedActions,
    selectedPawnId: boardInteractions.selectedPawnId,
    draggingPawnId: boardInteractions.draggingPawnId,
    resetPuzzle,
    retryMove,
    handleCellClick: boardInteractions.handleCellClick,
    handleWallClick: boardInteractions.handleWallClick,
    handlePawnClick: boardInteractions.handlePawnClick,
    handlePawnDragStart: boardInteractions.handlePawnDragStart,
    handlePawnDragEnd: boardInteractions.handlePawnDragEnd,
    handleCellDrop: boardInteractions.handleCellDrop,
    // Arrows
    arrows: boardInteractions.arrows,
    // Annotation handlers
    onWallSlotRightClick: boardInteractions.onWallSlotRightClick,
    onCellRightClickDragStart: boardInteractions.onCellRightClickDragStart,
    onCellRightClickDragMove: boardInteractions.onCellRightClickDragMove,
    onCellRightClickDragEnd: boardInteractions.onCellRightClickDragEnd,
    onArrowDragFinalize: boardInteractions.onArrowDragFinalize,
    arrowDragStateRef: boardInteractions.arrowDragStateRef,
    annotations: boardInteractions.annotations,
    previewAnnotation: boardInteractions.previewAnnotation,
    solutionAnnotations,
    solutionShown,
    showSolution,
    playSolutionMove,
    canPlaySolutionMove,
    lineLength,
    handleCommit,
    handleUndo: boardInteractions.undoLastAction,
    canCommit: boardInteractions.canCommit,
    canUndo: boardInteractions.canUndo,
    boardPawns: boardPawnsWithPreview,
    lastMoves,
    lastWalls,
    actionError,
  };
}
