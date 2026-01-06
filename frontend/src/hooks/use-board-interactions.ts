import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type MutableRefObject,
} from "react";
import type {
  Action,
  PlayerId,
  WallOrientation,
  Cell,
} from "../../../shared/domain/game-types";
import type { GameState } from "../../../shared/domain/game-state";
import type { BoardPawn, Arrow } from "@/components/board";
import {
  canEnqueue,
  enqueueToggle,
  resolveDoubleStep,
  promote,
  MAX_LOCAL_ACTIONS,
} from "@/game/local-actions";
import { sounds, play } from "@/lib/sounds";
import {
  useAnnotations,
  type Annotation,
  type AnnotationDragState,
} from "@/hooks/use-annotations";

export interface BoardInteractionsOptions {
  /**
   * Current game state for validating moves.
   */
  gameState: GameState | null;

  /**
   * Pawns currently on the board, including their positions.
   * These should reflect staged positions if previewState is applied.
   */
  boardPawns: BoardPawn[];

  /**
   * The player ID that can be controlled. Actions will only be allowed
   * for pawns belonging to this player.
   */
  controllablePlayerId: PlayerId | null;

  /**
   * Whether it's currently this player's turn (can stage actions for immediate commit).
   */
  canStage: boolean;

  /**
   * Whether premoves are allowed (can queue actions for when it becomes your turn).
   * Typically true when it's not your turn but the game is still playing.
   */
  canPremove?: boolean;

  /**
   * If true, the mouse pawn cannot be moved (used in some solo campaign levels).
   */
  mouseMoveLocked?: boolean;

  /**
   * Error message to show when mouse movement is attempted but locked.
   */
  mouseMoveLockedMessage?: string;

  /**
   * Enable sound effects for staging/unstaging actions.
   */
  sfxEnabled?: boolean;

  /**
   * Called when a complete move (2 actions or double-step) is ready to submit.
   * The parent should apply this move to the game state.
   */
  onMoveReady: (actions: Action[]) => void;

  /**
   * Called when an error occurs (e.g., illegal move).
   */
  onError?: (message: string | null) => void;
}

export interface BoardInteractionsResult {
  // Selection state
  selectedPawnId: string | null;
  draggingPawnId: string | null;

  // Staged actions (for current turn)
  stagedActions: Action[];

  // Premoved actions (for next turn)
  premovedActions: Action[];

  // Arrows for Board component (showing staged/premoved pawn moves)
  arrows: Arrow[];

  // Handlers for Board component
  handlePawnClick: (pawnId: string) => void;
  handleCellClick: (row: number, col: number) => void;
  handleWallClick: (
    row: number,
    col: number,
    orientation: WallOrientation,
  ) => void;
  handlePawnDragStart: (pawnId: string) => void;
  handlePawnDragEnd: () => void;
  handleCellDrop: (
    pawnId: string,
    targetRow: number,
    targetCol: number,
  ) => void;

  // Annotation handlers for Board component
  onWallSlotRightClick: (
    row: number,
    col: number,
    orientation: WallOrientation,
  ) => void;
  onCellRightClickDragStart: (row: number, col: number) => void;
  onCellRightClickDragMove: (row: number, col: number) => void;
  onCellRightClickDragEnd: (row: number, col: number) => void;
  onArrowDragFinalize: () => void;
  arrowDragStateRef: MutableRefObject<AnnotationDragState>;

  // Annotation state
  annotations: Annotation[];
  previewAnnotation: Annotation | null;
  clearAnnotations: () => void;

  // Manual controls
  clearStagedActions: () => void;
  clearPremovedActions: () => void;
  clearAllActions: () => void;
  clearSelection: () => void;
  undoLastAction: () => void;

  // For parent hook integration
  setStagedActions: React.Dispatch<React.SetStateAction<Action[]>>;
  setPremovedActions: React.Dispatch<React.SetStateAction<Action[]>>;
  setSelectedPawnId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraggingPawnId: React.Dispatch<React.SetStateAction<string | null>>;

  // Derived state
  canCommit: boolean;
  canUndo: boolean;
}

type QueueMode = "staged" | "premove" | null;

/**
 * Builds arrows to visualize pawn moves in a queue.
 */
function buildArrowsForQueue(
  gameState: GameState | null,
  queue: Action[],
  ownerId: PlayerId | null,
  arrowType: Arrow["type"],
): Arrow[] {
  if (!gameState || queue.length === 0 || !ownerId) return [];
  const pawns = gameState.pawns[ownerId];
  if (!pawns) return [];

  const workingPositions = {
    cat: [pawns.cat[0], pawns.cat[1]] as Cell,
    mouse: [pawns.mouse[0], pawns.mouse[1]] as Cell,
  };

  const moveActions = queue.filter(
    (action) => action.type === "cat" || action.type === "mouse",
  );

  // Special case: two moves of the same pawn type -> single long arrow
  if (
    queue.length === 2 &&
    moveActions.length === 2 &&
    moveActions.every((action) => action.type === moveActions[0].type)
  ) {
    const pawnType = moveActions[0].type as "cat" | "mouse";
    const fromCell = workingPositions[pawnType];
    const toCell = moveActions[1].target;
    const from: Cell = [fromCell[0], fromCell[1]];
    const to: Cell = [toCell[0], toCell[1]];
    return [{ from, to, type: arrowType }];
  }

  // Normal case: one arrow per pawn move
  const arrows: Arrow[] = [];
  queue.forEach((action) => {
    if (action.type !== "cat" && action.type !== "mouse") {
      return;
    }
    const fromCell = workingPositions[action.type];
    const toCell = action.target;
    const from: Cell = [fromCell[0], fromCell[1]];
    const to: Cell = [toCell[0], toCell[1]];
    arrows.push({ from, to, type: arrowType });
    workingPositions[action.type] = [toCell[0], toCell[1]];
  });
  return arrows;
}

export function useBoardInteractions(
  options: BoardInteractionsOptions,
): BoardInteractionsResult {
  const {
    gameState,
    boardPawns,
    controllablePlayerId,
    canStage,
    canPremove = false,
    mouseMoveLocked = false,
    mouseMoveLockedMessage = "Mouse movement is disabled for this level.",
    sfxEnabled = false,
    onMoveReady,
    onError,
  } = options;

  // Selection state
  const [selectedPawnId, setSelectedPawnId] = useState<string | null>(null);
  const [draggingPawnId, setDraggingPawnId] = useState<string | null>(null);

  // Staged actions (for current turn)
  const [stagedActions, setStagedActions] = useState<Action[]>([]);
  // Premoved actions (for next turn)
  const [premovedActions, setPremovedActions] = useState<Action[]>([]);

  // Annotations (right-click to draw arrows/circles)
  const {
    annotations,
    previewAnnotation,
    toggleWallAnnotation,
    startArrowDrag,
    updateArrowDrag,
    endArrowDrag,
    finalizeArrowDrag,
    clearAnnotations,
    dragStateRef,
  } = useAnnotations();

  // Track previous canStage for premove promotion
  const prevCanStageRef = useRef(canStage);

  // Refs to avoid stale closures
  const stagedActionsRef = useRef(stagedActions);
  const premovedActionsRef = useRef(premovedActions);
  useEffect(() => {
    stagedActionsRef.current = stagedActions;
  }, [stagedActions]);
  useEffect(() => {
    premovedActionsRef.current = premovedActions;
  }, [premovedActions]);

  // Determine current queue mode
  const queueMode: QueueMode = canStage
    ? "staged"
    : canPremove
      ? "premove"
      : null;

  // Can interact at all?
  const canInteract = queueMode !== null;

  const setError = useCallback(
    (message: string | null) => {
      onError?.(message);
    },
    [onError],
  );

  const clearSelection = useCallback(() => {
    setSelectedPawnId(null);
    setDraggingPawnId(null);
  }, []);

  const clearStagedActions = useCallback(() => {
    setStagedActions([]);
    clearSelection();
    setError(null);
  }, [clearSelection, setError]);

  const clearPremovedActions = useCallback(() => {
    setPremovedActions([]);
    setError(null);
  }, [setError]);

  const clearAllActions = useCallback(() => {
    setStagedActions([]);
    setPremovedActions([]);
    clearSelection();
    setError(null);
  }, [clearSelection, setError]);

  const undoLastAction = useCallback(() => {
    if (queueMode === "staged") {
      setStagedActions((prev) => prev.slice(0, -1));
    } else if (queueMode === "premove") {
      setPremovedActions((prev) => prev.slice(0, -1));
    }
  }, [queueMode]);

  /**
   * Commits staged actions by calling onMoveReady and clearing state.
   */
  const commitStagedActions = useCallback(
    (actions: Action[]) => {
      onMoveReady(actions);
      setStagedActions([]);
      clearSelection();
      setError(null);
    },
    [onMoveReady, clearSelection, setError],
  );

  /**
   * Promote premoves to staged actions when it becomes our turn.
   */
  useEffect(() => {
    // Only run when canStage transitions from false to true
    if (!canStage || prevCanStageRef.current === canStage) {
      prevCanStageRef.current = canStage;
      return;
    }
    prevCanStageRef.current = canStage;

    const pending = premovedActionsRef.current;
    if (pending.length === 0) return;

    const promotion = promote({
      state: gameState,
      playerId: controllablePlayerId,
      current: stagedActionsRef.current,
      pending,
    });

    if (promotion.accepted.length) {
      setStagedActions(promotion.stagedNext);
      setPremovedActions([]);
      setError(null);

      // Auto-commit if we have enough actions
      if (promotion.stagedNext.length === MAX_LOCAL_ACTIONS) {
        commitStagedActions(promotion.stagedNext);
      }
    } else if (promotion.premoveCleared) {
      setPremovedActions([]);
      if (promotion.dropped.length) {
        setError("Queued premove was cleared because it was illegal.");
      }
    }
  }, [
    canStage,
    gameState,
    controllablePlayerId,
    commitStagedActions,
    setError,
  ]);

  /**
   * Attempts to enqueue an action. Returns the outcome.
   */
  const enqueueAction = useCallback(
    (
      action: Action,
      mode: QueueMode,
      errorMessage?: string,
    ): "added" | "removed" | "rejected" => {
      if (!gameState || !controllablePlayerId || !mode) {
        setError("Game is still loading");
        return "rejected";
      }

      const queue =
        mode === "staged"
          ? stagedActionsRef.current
          : premovedActionsRef.current;
      const setQueue =
        mode === "staged" ? setStagedActions : setPremovedActions;

      const nextQueue = enqueueToggle(queue, action);
      const removed = nextQueue.length < queue.length;

      if (removed) {
        setQueue(nextQueue);
        setError(null);
        if (sfxEnabled) {
          play(action.type === "wall" ? sounds.wallUndo : sounds.pawnUndo);
        }
        return "removed";
      }

      if (
        !canEnqueue({
          state: gameState,
          playerId: controllablePlayerId,
          queue,
          action,
        })
      ) {
        setError(
          errorMessage ??
            (mode === "premove" ? "Premove is illegal." : "Illegal move."),
        );
        return "rejected";
      }

      setQueue(nextQueue);
      setError(null);
      if (sfxEnabled) {
        play(action.type === "wall" ? sounds.wall : sounds.pawn);
      }

      // Auto-commit when we have MAX_LOCAL_ACTIONS (only for staged)
      if (mode === "staged" && nextQueue.length === MAX_LOCAL_ACTIONS) {
        commitStagedActions(nextQueue);
      }

      return "added";
    },
    [
      gameState,
      controllablePlayerId,
      sfxEnabled,
      setError,
      commitStagedActions,
    ],
  );

  /**
   * Stages a pawn move from the current position to the target cell.
   * Handles double-step detection and validation.
   */
  const stagePawnAction = useCallback(
    (pawnId: string, targetRow: number, targetCol: number) => {
      if (!queueMode) return;
      if (!controllablePlayerId) return;

      const pawn = boardPawns.find((p) => p.id === pawnId);
      if (!pawn || pawn.playerId !== controllablePlayerId) return;
      if (pawn.type !== "cat" && pawn.type !== "mouse") return;

      const pawnType = pawn.type;

      // Same cell = no-op
      if (pawn.cell[0] === targetRow && pawn.cell[1] === targetCol) return;

      // Check mouse lock
      if (mouseMoveLocked && pawnType === "mouse") {
        setError(mouseMoveLockedMessage);
        clearSelection();
        return;
      }

      const queue =
        queueMode === "staged"
          ? stagedActionsRef.current
          : premovedActionsRef.current;
      const setQueue =
        queueMode === "staged" ? setStagedActions : setPremovedActions;

      // Check if there's already a staged action for this pawn type
      const existingStagedPawnAction = queue.find(
        (action) => action.type === pawnType,
      );

      if (existingStagedPawnAction && gameState) {
        // Get the pawn's ORIGINAL position from gameState
        const originalCell =
          pawnType === "cat"
            ? gameState.pawns[controllablePlayerId].cat
            : gameState.pawns[controllablePlayerId].mouse;

        // Case 1: Dragging back to original position = undo the staged action
        if (originalCell[0] === targetRow && originalCell[1] === targetCol) {
          setQueue((prev) => prev.filter((a) => a.type !== pawnType));
          clearSelection();
          setError(null);
          if (sfxEnabled) {
            play(sounds.pawnUndo);
          }
          return;
        }

        // Case 2: Moving from staged position - only allow distance 1
        // Use the staged action's target position, not pawn.cell, since
        // boardPawns might have original positions when passed from parent
        const stagedPosition = existingStagedPawnAction.target;
        const distanceFromStaged =
          Math.abs(stagedPosition[0] - targetRow) +
          Math.abs(stagedPosition[1] - targetCol);

        if (distanceFromStaged > 1) {
          setError(
            "You can only move 1 cell when you already have a staged action.",
          );
          return;
        }

        const baseAction: Action = {
          type: pawnType,
          target: [targetRow, targetCol],
        };
        const outcome = enqueueAction(
          baseAction,
          queueMode,
          queueMode === "premove" ? "Premove is illegal." : "Illegal move.",
        );
        if (outcome !== "rejected") {
          clearSelection();
        }
        return;
      }

      // No existing staged action for this pawn - check for double step
      const baseAction: Action = {
        type: pawnType,
        target: [targetRow, targetCol],
      };

      const doubleStepSequence = resolveDoubleStep({
        state: gameState,
        playerId: controllablePlayerId,
        action: baseAction,
      });

      if (doubleStepSequence) {
        if (queue.length > 0) {
          setError(
            "You can't make a double move after staging another action.",
          );
          return;
        }
        if (sfxEnabled) {
          play(sounds.pawn);
        }
        if (queueMode === "staged") {
          commitStagedActions(doubleStepSequence);
        } else {
          setPremovedActions(doubleStepSequence);
          setError(null);
        }
        clearSelection();
        return;
      }

      // Regular single action
      const outcome = enqueueAction(
        baseAction,
        queueMode,
        queueMode === "premove" ? "Premove is illegal." : "Illegal move.",
      );
      if (outcome !== "rejected") {
        clearSelection();
      }
    },
    [
      boardPawns,
      clearSelection,
      commitStagedActions,
      controllablePlayerId,
      enqueueAction,
      gameState,
      mouseMoveLocked,
      mouseMoveLockedMessage,
      queueMode,
      setError,
      sfxEnabled,
    ],
  );

  // ============================================================================
  // Board Event Handlers
  // ============================================================================

  const handlePawnClick = useCallback(
    (pawnId: string) => {
      if (!queueMode) return;
      if (!controllablePlayerId) return;

      const pawn = boardPawns.find((p) => p.id === pawnId);
      if (!pawn || pawn.playerId !== controllablePlayerId) return;

      // Check mouse lock
      if (mouseMoveLocked && pawn.type === "mouse") {
        setError(mouseMoveLockedMessage);
        clearSelection();
        return;
      }

      const queue =
        queueMode === "staged"
          ? stagedActionsRef.current
          : premovedActionsRef.current;
      const setQueue =
        queueMode === "staged" ? setStagedActions : setPremovedActions;

      // If this pawn has a staged/premoved action, clicking it unstages it
      const hasActions = queue.some((action) => action.type === pawn.type);
      if (hasActions) {
        setQueue((prev) => prev.filter((action) => action.type !== pawn.type));
        setSelectedPawnId(null);
        setError(null);
        if (sfxEnabled) {
          play(sounds.pawnUndo);
        }
        return;
      }

      // Toggle selection
      if (selectedPawnId === pawnId) {
        setSelectedPawnId(null);
      } else {
        setSelectedPawnId(pawn.id);
      }
      setError(null);
    },
    [
      boardPawns,
      clearSelection,
      controllablePlayerId,
      mouseMoveLocked,
      mouseMoveLockedMessage,
      queueMode,
      selectedPawnId,
      setError,
      sfxEnabled,
    ],
  );

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!queueMode) return;
      if (!controllablePlayerId) return;

      // If no pawn selected, see if clicking on our own pawn
      if (!selectedPawnId) {
        const pawn = boardPawns.find(
          (p) =>
            p.playerId === controllablePlayerId &&
            p.cell[0] === row &&
            p.cell[1] === col,
        );
        if (pawn) {
          if (mouseMoveLocked && pawn.type === "mouse") {
            setError(mouseMoveLockedMessage);
            return;
          }
          setSelectedPawnId(pawn.id);
        }
        return;
      }

      // A pawn is selected - stage the move
      stagePawnAction(selectedPawnId, row, col);
    },
    [
      boardPawns,
      controllablePlayerId,
      mouseMoveLocked,
      mouseMoveLockedMessage,
      queueMode,
      selectedPawnId,
      setError,
      stagePawnAction,
    ],
  );

  const handleWallClick = useCallback(
    (row: number, col: number, orientation: WallOrientation) => {
      if (!queueMode) return;

      const newAction: Action = {
        type: "wall",
        target: [row, col] as Cell,
        wallOrientation: orientation,
      };
      enqueueAction(
        newAction,
        queueMode,
        queueMode === "premove"
          ? "Premove wall placement is illegal."
          : "Illegal wall placement.",
      );
    },
    [enqueueAction, queueMode],
  );

  const handlePawnDragStart = useCallback(
    (pawnId: string) => {
      if (!queueMode) return;
      if (!controllablePlayerId) return;

      const pawn = boardPawns.find((p) => p.id === pawnId);
      if (pawn?.playerId !== controllablePlayerId) return;

      if (mouseMoveLocked && pawn?.type === "mouse") {
        setError(mouseMoveLockedMessage);
        clearSelection();
        return;
      }

      setDraggingPawnId(pawnId);
      setSelectedPawnId(pawnId);
    },
    [
      boardPawns,
      clearSelection,
      controllablePlayerId,
      mouseMoveLocked,
      mouseMoveLockedMessage,
      queueMode,
      setError,
    ],
  );

  const handlePawnDragEnd = useCallback(() => {
    if (!queueMode) return;
    setDraggingPawnId(null);
  }, [queueMode]);

  const handleCellDrop = useCallback(
    (pawnId: string, targetRow: number, targetCol: number) => {
      if (!queueMode) return;
      if (!draggingPawnId) return;
      stagePawnAction(pawnId, targetRow, targetCol);
      setDraggingPawnId(null);
    },
    [draggingPawnId, queueMode, stagePawnAction],
  );

  // ============================================================================
  // Computed Arrows
  // ============================================================================

  const stagedArrowOwnerId = gameState?.turn ?? controllablePlayerId ?? null;
  const stagedMoveArrows = useMemo(
    () =>
      buildArrowsForQueue(
        gameState,
        stagedActions,
        stagedArrowOwnerId,
        "staged",
      ),
    [gameState, stagedActions, stagedArrowOwnerId],
  );

  const premoveArrowOwnerId = controllablePlayerId;
  const premoveArrows = useMemo(
    () =>
      buildArrowsForQueue(
        gameState,
        premovedActions,
        premoveArrowOwnerId,
        "premoved",
      ),
    [gameState, premovedActions, premoveArrowOwnerId],
  );

  const arrows = useMemo(
    () => [...stagedMoveArrows, ...premoveArrows],
    [stagedMoveArrows, premoveArrows],
  );

  // Derived state
  const activeQueue = queueMode === "staged" ? stagedActions : premovedActions;
  const canCommit = activeQueue.length > 0 && canInteract;
  const canUndo = activeQueue.length > 0 && canInteract;

  return {
    // Selection state
    selectedPawnId,
    draggingPawnId,

    // Action queues
    stagedActions,
    premovedActions,

    // Arrows for Board
    arrows,

    // Handlers
    handlePawnClick,
    handleCellClick,
    handleWallClick,
    handlePawnDragStart,
    handlePawnDragEnd,
    handleCellDrop,

    // Annotation handlers
    onWallSlotRightClick: toggleWallAnnotation,
    onCellRightClickDragStart: startArrowDrag,
    onCellRightClickDragMove: updateArrowDrag,
    onCellRightClickDragEnd: endArrowDrag,
    onArrowDragFinalize: finalizeArrowDrag,
    arrowDragStateRef: dragStateRef,

    // Annotation state
    annotations,
    previewAnnotation,
    clearAnnotations,

    // Manual controls
    clearStagedActions,
    clearPremovedActions,
    clearAllActions,
    clearSelection,
    undoLastAction,

    // For parent hook integration
    setStagedActions,
    setPremovedActions,
    setSelectedPawnId,
    setDraggingPawnId,

    // Derived state
    canCommit,
    canUndo,
  };
}
