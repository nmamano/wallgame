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
  PawnType,
  PlayerId,
  WallOrientation,
  Cell,
} from "../../../shared/domain/game-types";
import type { GameState } from "../../../shared/domain/game-state";
import { pawnId } from "../../../shared/domain/game-utils";
import {
  isMovablePawnType,
  pawnCell,
  requirePawnCell,
} from "../../../shared/domain/pawns";
import type {
  BoardPawn,
  Arrow,
  BoardIntentProjection,
} from "@/components/board";
import {
  resolveLocalIntent,
  type ResolvedLocalIntent,
  promote,
  MAX_LOCAL_ACTIONS,
} from "@/game/local-actions";
import { sounds, play } from "@/lib/sounds";
import {
  useAnnotations,
  type Annotation,
  type AnnotationDragState,
} from "@/hooks/use-annotations";

/**
 * Whether this pawn refuses to move right now. A classic home never moves at
 * all; a mouse moves unless the variant locks it. Checking `isMovablePawnType`
 * rather than just "mouse" matters because a home used to travel in the mouse
 * slot, so mouse-only guards used to cover it by accident.
 */
const isPawnMoveBlocked = (type: PawnType, mouseMoveLocked: boolean) =>
  !isMovablePawnType(type) || (mouseMoveLocked && type === "mouse");

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

  /** Number of actions left in the current authored turn. */
  maxStagedActions?: 1 | 2;

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
  resolveBoardIntent: (action: Action, pawnId?: string) => ResolvedLocalIntent;
  executeBoardIntent: (intent: ResolvedLocalIntent, action: Action) => void;
  projectBoardIntent: (
    intent: ResolvedLocalIntent,
    action: Action,
  ) => BoardIntentProjection | null;

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
  const cat = pawnCell(gameState.pawns, ownerId, "cat");
  const mouse = pawnCell(gameState.pawns, ownerId, "mouse");

  // Arrows only ever describe cat and mouse moves. A variant that lacks one
  // simply never produces an action for it.
  const workingPositions: Partial<Record<"cat" | "mouse", Cell>> = {
    ...(cat ? { cat: [cat[0], cat[1]] as Cell } : {}),
    ...(mouse ? { mouse: [mouse[0], mouse[1]] as Cell } : {}),
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
    if (!fromCell) return [];
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
    if (!fromCell) return;
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
    maxStagedActions = MAX_LOCAL_ACTIONS,
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
      maxActions: maxStagedActions,
    });

    if (promotion.accepted.length) {
      setStagedActions(promotion.stagedNext);
      setPremovedActions([]);
      setError(null);

      // Auto-commit if we have enough actions
      if (promotion.stagedNext.length === maxStagedActions) {
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
    maxStagedActions,
    commitStagedActions,
    setError,
  ]);

  const resolveBoardIntent = useCallback(
    (action: Action, sourcePawnId?: string): ResolvedLocalIntent => {
      if (!queueMode || !gameState || !controllablePlayerId) {
        return { kind: "no-op" };
      }
      const queue =
        queueMode === "staged"
          ? stagedActionsRef.current
          : premovedActionsRef.current;
      const pawn =
        action.type === "wall"
          ? undefined
          : boardPawns.find(
              (candidate) =>
                candidate.id === sourcePawnId ||
                (candidate.playerId === controllablePlayerId &&
                  candidate.type === action.type),
            );
      const originalCell =
        action.type === "wall"
          ? undefined
          : requirePawnCell(gameState.pawns, controllablePlayerId, action.type);
      return resolveLocalIntent({
        state: gameState,
        playerId: controllablePlayerId,
        queue,
        action,
        maxActions:
          queueMode === "staged" ? maxStagedActions : MAX_LOCAL_ACTIONS,
        mode: queueMode,
        ...(pawn ? { currentCell: pawn.cell } : {}),
        ...(originalCell ? { originalCell } : {}),
        pawnBlocked:
          action.type !== "wall" &&
          isPawnMoveBlocked(action.type, mouseMoveLocked),
        blockedReason: mouseMoveLockedMessage,
      });
    },
    [
      boardPawns,
      controllablePlayerId,
      gameState,
      maxStagedActions,
      mouseMoveLocked,
      mouseMoveLockedMessage,
      queueMode,
    ],
  );

  const executeBoardIntent = useCallback(
    (intent: ResolvedLocalIntent, action: Action) => {
      if (!queueMode) return;
      if (intent.kind === "reject") {
        setError(intent.reason);
        return;
      }
      if (intent.kind === "no-op") return;
      if (intent.kind === "commit-double-step") {
        if (sfxEnabled) play(sounds.pawn);
        commitStagedActions(intent.actions);
        return;
      }
      const setQueue =
        queueMode === "staged" ? setStagedActions : setPremovedActions;
      setQueue(intent.nextQueue);
      setError(null);
      if (sfxEnabled) {
        const sound =
          intent.kind === "remove"
            ? action.type === "wall"
              ? sounds.wallUndo
              : sounds.pawnUndo
            : action.type === "wall"
              ? sounds.wall
              : sounds.pawn;
        play(sound);
      }
      clearSelection();
      if (intent.kind === "add" && intent.autoCommit) {
        commitStagedActions(intent.nextQueue);
      }
    },
    [clearSelection, commitStagedActions, queueMode, setError, sfxEnabled],
  );

  const projectBoardIntent = useCallback(
    (
      intent: ResolvedLocalIntent,
      sourceAction: Action,
    ): BoardIntentProjection | null => {
      if (!queueMode || !gameState || !controllablePlayerId) return null;
      if (intent.kind === "reject" || intent.kind === "no-op") return null;
      const actions =
        intent.kind === "commit-double-step"
          ? intent.actions
          : intent.nextQueue;
      const previewState =
        queueMode === "staged" ? ("staged" as const) : ("premoved" as const);
      const pawnCells: BoardIntentProjection["pawnCells"] = {};
      for (const action of actions) {
        if (action.type === "wall") continue;
        const pawn = gameState
          .getPawns()
          .find(
            (candidate) =>
              candidate.playerId === controllablePlayerId &&
              candidate.type === action.type,
          );
        if (pawn) {
          pawnCells[pawnId(pawn)] = {
            cell: [action.target[0], action.target[1]],
            previewState,
          };
        }
      }
      if (intent.kind === "remove" && sourceAction.type !== "wall") {
        const pawn = gameState
          .getPawns()
          .find(
            (candidate) =>
              candidate.playerId === controllablePlayerId &&
              candidate.type === sourceAction.type,
          );
        if (pawn) {
          pawnCells[pawnId(pawn)] = {
            cell: [pawn.cell[0], pawn.cell[1]],
            previewState: undefined,
          };
        }
      }
      return {
        actions,
        mode: queueMode,
        arrows: buildArrowsForQueue(
          gameState,
          actions,
          controllablePlayerId,
          previewState,
        ),
        walls: actions
          .filter((action) => action.type === "wall")
          .map((action) => ({
            cell: [action.target[0], action.target[1]],
            orientation: action.wallOrientation!,
            playerId: controllablePlayerId,
            state: previewState,
          })),
        pawnCells,
      };
    },
    [controllablePlayerId, gameState, queueMode],
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
      if (!isMovablePawnType(pawn.type)) return;
      const action: Action = {
        type: pawn.type,
        target: [targetRow, targetCol],
      };
      executeBoardIntent(resolveBoardIntent(action, pawnId), action);
    },
    [
      boardPawns,
      controllablePlayerId,
      queueMode,
      executeBoardIntent,
      resolveBoardIntent,
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

      // Refuses to move: a home never does, a mouse when the variant locks it.
      if (isPawnMoveBlocked(pawn.type, mouseMoveLocked)) {
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
          if (isPawnMoveBlocked(pawn.type, mouseMoveLocked)) {
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
      executeBoardIntent(resolveBoardIntent(newAction), newAction);
    },
    [executeBoardIntent, queueMode, resolveBoardIntent],
  );

  const handlePawnDragStart = useCallback(
    (pawnId: string) => {
      if (!queueMode) return;
      if (!controllablePlayerId) return;

      const pawn = boardPawns.find((p) => p.id === pawnId);
      if (pawn?.playerId !== controllablePlayerId) return;

      if (pawn && isPawnMoveBlocked(pawn.type, mouseMoveLocked)) {
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
    resolveBoardIntent,
    executeBoardIntent,
    projectBoardIntent,

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
