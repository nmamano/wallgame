import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { PlayerId, Move } from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";
import { GameState } from "../../../shared/domain/game-state";
import type { SoloCampaignLevel } from "../../../shared/domain/solo-campaign-levels";
import { buildLevelConfig } from "../../../shared/domain/solo-campaign-levels";
import { buildSurvivalInitialState } from "../../../shared/domain/survival-setup";
import { SoloCampaignAIController } from "@/lib/solo-campaign-controller";
import { LocalHumanController } from "@/lib/player-controllers";
import { useBoardInteractions } from "@/hooks/use-board-interactions";
import type { BoardPawn, BoardProps } from "@/components/board";
import { computeLastMoves } from "@/lib/gameViewModel";
import { pawnId } from "../../../shared/domain/game-utils";

export interface UseSoloCampaignGameResult {
  // Game state
  gameState: GameState | null;
  isLoading: boolean;

  // Turn info
  turnsRemaining: number;
  isPlayerTurn: boolean;
  isAiThinking: boolean;

  // Game end state
  gameEnded: boolean;
  playerWon: boolean | null;

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
  resetLevel: () => void;
  handleCommit: () => void;
  handleUndo: () => void;

  // Board pawns (with staged/premoved positions applied)
  boardPawns: BoardPawn[];

  // Last moves for showing opponent's last move
  lastMoves: BoardProps["lastMoves"] | null;

  // Error state
  actionError: string | null;
}

export function useSoloCampaignGame(
  level: SoloCampaignLevel,
): UseSoloCampaignGameResult {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const gameStateRef = useRef<GameState | null>(null);
  const aiControllerRef = useRef<SoloCampaignAIController | null>(null);
  const humanControllerRef = useRef<LocalHumanController | null>(null);

  // Determine which player is human and which is AI
  const humanPlayerId = level.userPlaysAs;
  const aiPlayerId: PlayerId = humanPlayerId === 1 ? 2 : 1;

  // Check if it's player's turn
  const isPlayerTurn =
    gameState?.status === "playing" && gameState.turn === humanPlayerId;

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
  const boardPawns = useMemo((): BoardPawn[] => {
    if (!gameState) return [];

    const pawns = gameState.getPawns();
    return pawns.map((pawn) => ({
      ...pawn,
      id: pawnId(pawn),
    }));
  }, [gameState]);

  // Game is playing and not ended
  const isGamePlaying = gameState?.status === "playing";

  // Use the board interactions hook
  const boardInteractions = useBoardInteractions({
    gameState,
    boardPawns,
    controllablePlayerId: humanPlayerId,
    // Can stage when it's player's turn
    canStage: isPlayerTurn && !isAiThinking,
    // Can premove when AI is thinking (so player can queue moves while waiting)
    canPremove: isGamePlaying && !isPlayerTurn,
    mouseMoveLocked: !level.mouseCanMove,
    mouseMoveLockedMessage: "Mouse movement is disabled for this level.",
    sfxEnabled: false, // TODO: integrate with sound settings
    onMoveReady: (actions) => {
      if (!isPlayerTurn) return;
      const move: Move = { actions };
      try {
        applyMove(humanPlayerId, move);
      } catch (error) {
        console.error("Invalid move:", error);
        setActionError(error instanceof Error ? error.message : "Invalid move");
      }
    },
    onError: setActionError,
  });

  // Compute board pawns with staged/premoved preview positions
  const boardPawnsWithPreview = useMemo((): BoardPawn[] => {
    if (!gameState) return [];

    // Get staged and premoved pawn moves
    const stagedPawnMoves = boardInteractions.stagedActions.filter(
      (a) => a.type === "cat" || a.type === "mouse",
    );
    const premovedPawnMoves = boardInteractions.premovedActions.filter(
      (a) => a.type === "cat" || a.type === "mouse",
    );

    // Build pawns with preview positions in a single pass
    return gameState.getPawns().map((pawn) => {
      const basePawn = {
        ...pawn,
        id: pawnId(pawn),
      };

      if (pawn.playerId !== humanPlayerId) return basePawn;

      // Check for staged move (amber/yellow) - takes priority
      const stagedMove = stagedPawnMoves.find((a) => a.type === pawn.type);
      if (stagedMove) {
        return {
          ...basePawn,
          cell: stagedMove.target,
          previewState: "staged" as const,
        };
      }

      // Check for premoved move (blue) - use the LAST move for double-walks
      const premovedMovesForPawn = premovedPawnMoves.filter(
        (a) => a.type === pawn.type,
      );
      if (premovedMovesForPawn.length > 0) {
        const lastPremovedMove =
          premovedMovesForPawn[premovedMovesForPawn.length - 1];
        return {
          ...basePawn,
          cell: lastPremovedMove.target,
          previewState: "premoved" as const,
        };
      }

      return basePawn;
    });
  }, [
    gameState,
    boardInteractions.stagedActions,
    boardInteractions.premovedActions,
    humanPlayerId,
  ]);

  // Store clearAllActions in a ref to avoid dependency issues
  const clearAllActionsRef = useRef(boardInteractions.clearAllActions);
  clearAllActionsRef.current = boardInteractions.clearAllActions;

  // Initialize game
  const initializeGame = useCallback(() => {
    const config = buildLevelConfig(level);
    const initialState = buildSurvivalInitialState(config);
    const newGameState = new GameState(config, Date.now(), initialState);

    gameStateRef.current = newGameState;
    setGameState(newGameState);
    setIsLoading(false);
    setIsAiThinking(false);
    setActionError(null);
    clearAllActionsRef.current();

    // Create controllers
    aiControllerRef.current = new SoloCampaignAIController({
      playerId: aiPlayerId,
      aiType: level.aiType,
      moveDelayMs: 1000,
    });

    humanControllerRef.current = new LocalHumanController(humanPlayerId, "you");
  }, [level, humanPlayerId, aiPlayerId]);

  // Initialize on mount and when level changes
  useEffect(() => {
    initializeGame();

    return () => {
      // Cleanup
      aiControllerRef.current?.cancel();
    };
  }, [initializeGame]);

  // Handle AI turn
  const handleAiTurn = useCallback(async () => {
    const current = gameStateRef.current;
    const aiController = aiControllerRef.current;

    if (!current || !aiController || current.status !== "playing") return;
    if (current.turn !== aiPlayerId) return;

    setIsAiThinking(true);

    try {
      const move = await aiController.makeMove(current);
      if (move && gameStateRef.current?.status === "playing") {
        applyMove(aiPlayerId, move);
      }
    } catch (error) {
      console.error("AI move error:", error);
    } finally {
      setIsAiThinking(false);
    }
  }, [aiPlayerId, applyMove]);

  // Trigger AI turn when it's AI's turn
  useEffect(() => {
    if (gameState?.status !== "playing") return;
    if (gameState.turn !== aiPlayerId) return;
    if (isAiThinking) return;

    void handleAiTurn();
  }, [gameState, aiPlayerId, isAiThinking, handleAiTurn]);

  // Calculate turns remaining
  const turnsRemaining = gameState
    ? level.turnsToSurvive - Math.floor(gameState.moveCount / 2)
    : level.turnsToSurvive;

  // Check if game ended and who won
  const gameEnded = gameState?.status === "finished";
  const playerWon = gameEnded
    ? gameState?.result?.winner === humanPlayerId
    : null;

  // Manual commit (for when user wants to commit with fewer than 2 actions)
  const handleCommit = useCallback(() => {
    if (!isPlayerTurn || boardInteractions.stagedActions.length === 0) return;

    const move: Move = { actions: boardInteractions.stagedActions };
    try {
      applyMove(humanPlayerId, move);
      boardInteractions.clearStagedActions();
    } catch (error) {
      console.error("Invalid move:", error);
      setActionError(error instanceof Error ? error.message : "Invalid move");
      boardInteractions.clearStagedActions();
    }
  }, [isPlayerTurn, boardInteractions, humanPlayerId, applyMove]);

  // Reset level
  const resetLevel = useCallback(() => {
    aiControllerRef.current?.cancel();
    initializeGame();
  }, [initializeGame]);

  // Compute player colors (human is red, AI is blue)
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

  return {
    gameState,
    isLoading,
    turnsRemaining,
    isPlayerTurn,
    isAiThinking,
    gameEnded,
    playerWon,
    stagedActions: boardInteractions.stagedActions,
    premovedActions: boardInteractions.premovedActions,
    selectedPawnId: boardInteractions.selectedPawnId,
    draggingPawnId: boardInteractions.draggingPawnId,
    resetLevel,
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
    handleCommit,
    handleUndo: boardInteractions.undoLastAction,
    canCommit: boardInteractions.canCommit,
    canUndo: boardInteractions.canUndo,
    boardPawns: boardPawnsWithPreview,
    lastMoves,
    actionError,
  };
}
