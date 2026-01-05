import { useState, useCallback, useRef, useEffect } from "react";
import type {
  PlayerId,
  Move,
  Action,
  Cell,
  WallOrientation,
} from "../../../shared/domain/game-types";
import { GameState } from "../../../shared/domain/game-state";
import type { SoloCampaignLevel } from "../../../shared/domain/solo-campaign-levels";
import { buildLevelConfig } from "../../../shared/domain/solo-campaign-levels";
import { buildSurvivalInitialState } from "../../../shared/domain/survival-setup";
import { SoloCampaignAIController } from "@/lib/solo-campaign-controller";
import { LocalHumanController } from "@/lib/player-controllers";

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

  // Staged actions
  stagedActions: Action[];

  // Actions
  resetLevel: () => void;

  // Board interaction handlers
  handleCellClick: (row: number, col: number) => void;
  handleWallClick: (
    row: number,
    col: number,
    orientation: WallOrientation,
  ) => void;
  handlePawnClick: (playerId: PlayerId) => void;
  handleCommit: () => void;
  handleUndo: () => void;
  canCommit: boolean;
  canUndo: boolean;
}

export function useSoloCampaignGame(
  level: SoloCampaignLevel,
): UseSoloCampaignGameResult {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [stagedActions, setStagedActions] = useState<Action[]>([]);
  const [isAiThinking, setIsAiThinking] = useState(false);

  const gameStateRef = useRef<GameState | null>(null);
  const aiControllerRef = useRef<SoloCampaignAIController | null>(null);
  const humanControllerRef = useRef<LocalHumanController | null>(null);

  // Determine which player is human and which is AI
  const humanPlayerId = level.userPlaysAs;
  const aiPlayerId: PlayerId = humanPlayerId === 1 ? 2 : 1;

  // Initialize game
  const initializeGame = useCallback(() => {
    const config = buildLevelConfig(level);
    const initialState = buildSurvivalInitialState(config);
    const newGameState = new GameState(config, Date.now(), initialState);

    gameStateRef.current = newGameState;
    setGameState(newGameState);
    setStagedActions([]);
    setIsLoading(false);
    setIsAiThinking(false);

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

  // Check if it's player's turn
  const isPlayerTurn =
    gameState?.status === "playing" && gameState.turn === humanPlayerId;

  // Handle cell click (for pawn movement)
  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!isPlayerTurn || isAiThinking) return;

      const target: Cell = [row, col];

      // Determine what pawn type the human controls
      // In survival: P1 controls cat, P2 controls mouse
      const pawnType = humanPlayerId === 1 ? "cat" : "mouse";

      // Check if mouse can move (Level 2 restriction)
      if (pawnType === "mouse" && !level.mouseCanMove) {
        return;
      }

      // Add pawn move action
      const action: Action = { type: pawnType, target };
      setStagedActions((prev) => {
        // Check if we already have 2 actions
        if (prev.length >= 2) return prev;
        return [...prev, action];
      });
    },
    [isPlayerTurn, isAiThinking, humanPlayerId, level.mouseCanMove],
  );

  // Handle wall click
  const handleWallClick = useCallback(
    (row: number, col: number, orientation: WallOrientation) => {
      if (!isPlayerTurn || isAiThinking) return;

      const target: Cell = [row, col];
      const action: Action = {
        type: "wall",
        target,
        wallOrientation: orientation,
      };

      setStagedActions((prev) => {
        // Check if we already have 2 actions
        if (prev.length >= 2) return prev;
        return [...prev, action];
      });
    },
    [isPlayerTurn, isAiThinking],
  );

  // Handle pawn click (for selection - currently just triggers cell click)
  const handlePawnClick = useCallback(
    (playerId: PlayerId) => {
      // In solo campaign, clicking your own pawn doesn't do anything special
      // Movement is handled by clicking destination cells
      if (playerId !== humanPlayerId) return;
    },
    [humanPlayerId],
  );

  // Commit staged actions
  const handleCommit = useCallback(() => {
    if (!isPlayerTurn || stagedActions.length === 0) return;

    const move: Move = { actions: stagedActions };

    const current = gameStateRef.current;
    if (!current) return;

    try {
      // Try to apply - applyGameAction will throw if invalid
      applyMove(humanPlayerId, move);
      setStagedActions([]);
    } catch (error) {
      console.error("Invalid move:", error);
      // Clear staged actions on error
      setStagedActions([]);
    }
  }, [isPlayerTurn, stagedActions, humanPlayerId, applyMove]);

  // Undo last staged action
  const handleUndo = useCallback(() => {
    setStagedActions((prev) => prev.slice(0, -1));
  }, []);

  // Reset level
  const resetLevel = useCallback(() => {
    aiControllerRef.current?.cancel();
    initializeGame();
  }, [initializeGame]);

  const canCommit = stagedActions.length > 0 && isPlayerTurn && !isAiThinking;
  const canUndo = stagedActions.length > 0 && isPlayerTurn && !isAiThinking;

  return {
    gameState,
    isLoading,
    turnsRemaining,
    isPlayerTurn,
    isAiThinking,
    gameEnded,
    playerWon,
    stagedActions,
    resetLevel,
    handleCellClick,
    handleWallClick,
    handlePawnClick,
    handleCommit,
    handleUndo,
    canCommit,
    canUndo,
  };
}
