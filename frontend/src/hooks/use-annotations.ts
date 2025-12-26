import { useState, useCallback, useRef } from "react";
import type { Cell, WallOrientation } from "../../../shared/domain/game-types";

export interface CellAnnotation {
  type: "circle";
  row: number;
  col: number;
}

export interface WallAnnotation {
  type: "wall-line";
  row: number;
  col: number;
  orientation: WallOrientation;
}

export interface ArrowAnnotation {
  type: "arrow";
  from: Cell;
  to: Cell;
}

export type Annotation = CellAnnotation | WallAnnotation | ArrowAnnotation;

// Distinct green color for annotations - clearly different from:
// - Premoves: #60a5fa (light blue)
// - Staged: #fbbf24 (amber/yellow)
// - Placed walls: brown or player color
// - Calculated: #94a3b8 (gray)
export const ANNOTATION_COLOR = "#22c55e"; // green-500
export const ANNOTATION_PREVIEW_OPACITY = 0.7; // Slightly lighter preview during drag

const cellKey = (row: number, col: number) => `circle:${row}:${col}`;
const wallKey = (row: number, col: number, orientation: WallOrientation) =>
  `wall:${row}:${col}:${orientation}`;
const arrowKey = (from: Cell, to: Cell) =>
  `arrow:${from[0]}:${from[1]}:${to[0]}:${to[1]}`;

export interface AnnotationDragState {
  isDragging: boolean;
  startCell: Cell | null;
  lastVisitedCell: Cell | null;
}

export function useAnnotations() {
  const [annotations, setAnnotations] = useState<Map<string, Annotation>>(
    () => new Map(),
  );

  // Preview annotation shown during drag (circle or arrow)
  const [previewAnnotation, setPreviewAnnotation] = useState<Annotation | null>(
    null,
  );

  // Track right-click drag state for arrow annotations
  const dragState = useRef<AnnotationDragState>({
    isDragging: false,
    startCell: null,
    lastVisitedCell: null,
  });

  const toggleCellAnnotation = useCallback((row: number, col: number) => {
    setAnnotations((prev) => {
      const key = cellKey(row, col);
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, { type: "circle", row, col });
      }
      return next;
    });
  }, []);

  const toggleWallAnnotation = useCallback(
    (row: number, col: number, orientation: WallOrientation) => {
      setAnnotations((prev) => {
        const key = wallKey(row, col, orientation);
        const next = new Map(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.set(key, { type: "wall-line", row, col, orientation });
        }
        return next;
      });
    },
    [],
  );

  const toggleArrowAnnotation = useCallback((from: Cell, to: Cell) => {
    // Don't allow arrows to same cell
    if (from[0] === to[0] && from[1] === to[1]) return;

    setAnnotations((prev) => {
      const key = arrowKey(from, to);
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, { type: "arrow", from, to });
      }
      return next;
    });
  }, []);

  const clearAnnotations = useCallback(() => {
    setAnnotations(new Map());
    setPreviewAnnotation(null);
    dragState.current = {
      isDragging: false,
      startCell: null,
      lastVisitedCell: null,
    };
  }, []);

  // Start arrow drag - show circle preview immediately
  const startArrowDrag = useCallback((row: number, col: number) => {
    dragState.current = {
      isDragging: true,
      startCell: [row, col],
      lastVisitedCell: [row, col],
    };
    // Show circle preview at the start cell
    setPreviewAnnotation({ type: "circle", row, col });
  }, []);

  // Update arrow drag - called when cursor moves to a different cell
  const updateArrowDrag = useCallback((row: number, col: number) => {
    const { isDragging, startCell } = dragState.current;
    if (!isDragging || !startCell) return;

    // Track the last visited cell
    dragState.current.lastVisitedCell = [row, col];

    // If same cell as start, show circle; otherwise show arrow
    if (startCell[0] === row && startCell[1] === col) {
      setPreviewAnnotation({ type: "circle", row, col });
    } else {
      setPreviewAnnotation({
        type: "arrow",
        from: startCell,
        to: [row, col],
      });
    }
  }, []);

  // End arrow drag - finalize and clear preview
  const endArrowDrag = useCallback(
    (row: number, col: number) => {
      const { isDragging, startCell } = dragState.current;
      if (isDragging && startCell) {
        // If same cell, toggle circle; otherwise toggle arrow
        if (startCell[0] === row && startCell[1] === col) {
          toggleCellAnnotation(row, col);
        } else {
          toggleArrowAnnotation(startCell, [row, col]);
        }
      }
      dragState.current = {
        isDragging: false,
        startCell: null,
        lastVisitedCell: null,
      };
      setPreviewAnnotation(null);
    },
    [toggleCellAnnotation, toggleArrowAnnotation],
  );

  const cancelArrowDrag = useCallback(() => {
    dragState.current = {
      isDragging: false,
      startCell: null,
      lastVisitedCell: null,
    };
    setPreviewAnnotation(null);
  }, []);

  // Finalize arrow drag using lastVisitedCell (for when mouse released outside a cell)
  const finalizeArrowDrag = useCallback(() => {
    const { isDragging, startCell, lastVisitedCell } = dragState.current;
    if (isDragging && startCell && lastVisitedCell) {
      // If same cell, toggle circle; otherwise toggle arrow
      if (
        startCell[0] === lastVisitedCell[0] &&
        startCell[1] === lastVisitedCell[1]
      ) {
        toggleCellAnnotation(lastVisitedCell[0], lastVisitedCell[1]);
      } else {
        toggleArrowAnnotation(startCell, lastVisitedCell);
      }
    }
    dragState.current = {
      isDragging: false,
      startCell: null,
      lastVisitedCell: null,
    };
    setPreviewAnnotation(null);
  }, [toggleCellAnnotation, toggleArrowAnnotation]);

  const getAnnotationsList = useCallback((): Annotation[] => {
    return Array.from(annotations.values());
  }, [annotations]);

  return {
    annotations: getAnnotationsList(),
    hasAnnotations: annotations.size > 0,
    previewAnnotation,
    toggleCellAnnotation,
    toggleWallAnnotation,
    toggleArrowAnnotation,
    clearAnnotations,
    startArrowDrag,
    updateArrowDrag,
    endArrowDrag,
    finalizeArrowDrag,
    cancelArrowDrag,
    dragStateRef: dragState,
  };
}
