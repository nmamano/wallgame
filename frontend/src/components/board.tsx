"use client";

import type { CSSProperties, ReactNode, DragEvent, MouseEvent } from "react";
import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { Cat, Rat } from "lucide-react";
import { StyledPillar, type EdgeColorKey } from "./styled-pillar";
import {
  type PlayerColor,
  colorClassMap,
  colorFilterMap,
  colorHexMap,
} from "@/lib/player-colors";
import { Grid } from "../../../shared/domain/grid";
import type {
  PlayerId,
  WallOrientation,
  Cell,
  WallPosition,
} from "../../../shared/domain/game-types";
import type { Pawn } from "../../../shared/domain/game-types";
import { pawnId } from "../../../shared/domain/game-utils";

type WallState = "placed" | "staged" | "premoved" | "calculated" | "missing";

type WallPositionWithState = WallPosition & { state?: WallState };

export type ArrowType = "staged" | "premoved" | "calculated";

export type BoardPawn = Pawn & {
  id: string;
  previewState?: "staged" | "ghost"; // TODO: rename "ghost" to "premoved"
};

export interface Arrow {
  from: Cell;
  to: Cell;
  type: ArrowType;
}

export interface LastMove {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  playerColor?: PlayerColor;
}

export interface BoardProps {
  rows?: number;
  cols?: number;
  pawns?: Pawn[];
  walls?: WallPositionWithState[];
  arrows?: Arrow[];
  lastMove?: LastMove;
  lastMoves?: LastMove[];
  maxWidth?: string;
  playerColors?: Record<PlayerId, PlayerColor>;
  onCellClick?: (row: number, col: number) => void;
  onWallClick?: (
    row: number,
    col: number,
    orientation: WallOrientation,
  ) => void;
  onPawnRightClick?: (pawnId: string) => void;
  onWallRightClick?: (wallIndex: number) => void;
  onPawnClick?: (pawnId: string) => void;
  onPawnDragStart?: (pawnId: string) => void;
  onPawnDragEnd?: () => void;
  onCellDrop?: (pawnId: string, targetRow: number, targetCol: number) => void;
  className?: string;
  draggingPawnId?: string | null;
  selectedPawnId?: string | null;
  stagedActionsCount?: number;
  controllablePlayerId?: PlayerId;
}

interface WallMaps {
  vertical: Map<string, WallPositionWithState>;
  horizontal: Map<string, WallPositionWithState>;
}

type PillarColors = Record<EdgeColorKey, string | null>;

const wallKey = (row: number, col: number) => `${row}-${col}`;

const buildWallMaps = (walls: WallPositionWithState[]): WallMaps => {
  const vertical = new Map<string, WallPositionWithState>();
  const horizontal = new Map<string, WallPositionWithState>();

  walls.forEach((wall) => {
    if (wall.orientation === "vertical") {
      vertical.set(wallKey(wall.cell[0], wall.cell[1]), wall);
    } else {
      horizontal.set(wallKey(wall.cell[0], wall.cell[1]), wall);
    }
  });

  return { vertical, horizontal };
};

const getWallColor = (
  wall: WallPositionWithState,
  playerColors?: Record<PlayerId, PlayerColor>,
): string => {
  if (wall.state === "placed" && wall.playerId && playerColors) {
    const color = playerColors[wall.playerId];
    return colorHexMap[color] || "#dc2626";
  }
  if (wall.state === "staged") return "#fbbf24";
  if (wall.state === "premoved") return "#60a5fa";
  if (wall.state === "calculated") return "#94a3b8";
  return "transparent";
};

const getPillarColors = (
  rowIndex: number,
  colIndex: number,
  wallMaps: WallMaps,
  resolveColor: (wall: WallPositionWithState) => string,
): PillarColors => {
  const northWall = wallMaps.vertical.get(wallKey(rowIndex - 1, colIndex - 1));
  const southWall = wallMaps.vertical.get(wallKey(rowIndex, colIndex - 1));
  // Horizontal wall at cell [r, c] blocks (r-1, c) ↔ (r, c)
  // West edge: blocks (rowIndex-1, colIndex-1) ↔ (rowIndex, colIndex-1), so wall is at [rowIndex, colIndex-1]
  const westWall = wallMaps.horizontal.get(wallKey(rowIndex, colIndex - 1));
  // East edge: blocks (rowIndex-1, colIndex) ↔ (rowIndex, colIndex), so wall is at [rowIndex, colIndex]
  const eastWall = wallMaps.horizontal.get(wallKey(rowIndex, colIndex));

  return {
    north: northWall ? resolveColor(northWall) : null,
    east: eastWall ? resolveColor(eastWall) : null,
    south: southWall ? resolveColor(southWall) : null,
    west: westWall ? resolveColor(westWall) : null,
  };
};

const buildPillarBoundingBox = (rowIndex: number, colIndex: number) => {
  const size = 100;
  return {
    x: colIndex * size,
    y: rowIndex * size,
    width: size,
    height: size,
  };
};

export function Board({
  rows = 10,
  cols = 10,
  pawns = [],
  walls = [],
  arrows = [],
  lastMove,
  lastMoves,
  maxWidth = "max-w-4xl",
  playerColors = { 1: "red", 2: "blue" },
  onCellClick,
  onWallClick,
  onPawnRightClick,
  onWallRightClick,
  onPawnClick,
  onPawnDragStart,
  onPawnDragEnd,
  onCellDrop,
  className = "p-4",
  draggingPawnId = null,
  selectedPawnId = null,
  stagedActionsCount = 0,
  controllablePlayerId,
}: BoardProps) {
  // Generate IDs for pawns internally
  const pawnsWithIds: BoardPawn[] = pawns.map((pawn) => ({
    ...pawn,
    id: pawnId(pawn),
  }));

  // Create grid array
  const grid = Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: cols }, (_, colIndex) => ({
      row: rowIndex,
      col: colIndex,
    })),
  );

  // Calculate cell size for positioning walls (dynamic based on grid size)
  const gapSize = 0.9; // rem
  const maxCellSize = 3; // rem
  const paddingX = 2; // rem (p-4 = 1rem on each side)

  const cellSize = `calc((100% - ${cols - 1} * ${gapSize}rem) / ${cols})`;
  const cellHeight = `calc((100% - ${rows - 1} * ${gapSize}rem) / ${rows})`;
  const gapValue = `${gapSize}rem`;
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [gridMetrics, setGridMetrics] = useState({
    width: 0,
    height: 0,
    gapX: 0,
    gapY: 0,
  });

  useEffect(() => {
    const node = gridRef.current;
    if (!node) {
      return;
    }

    const updateMetrics = () => {
      const rect = node.getBoundingClientRect();
      const computedStyle = window.getComputedStyle(node);
      const gapX =
        parseFloat(computedStyle.columnGap || computedStyle.gap || "0") || 0;
      const gapY =
        parseFloat(computedStyle.rowGap || computedStyle.gap || "0") || 0;

      setGridMetrics({
        width: rect.width,
        height: rect.height,
        gapX,
        gapY,
      });
    };

    updateMetrics();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateMetrics);
      return () => {
        window.removeEventListener("resize", updateMetrics);
      };
    }

    const resizeObserver = new ResizeObserver(() => updateMetrics());
    resizeObserver.observe(node);
    return () => resizeObserver.disconnect();
  }, [rows, cols]);

  const cellWidthPx = useMemo(() => {
    if (cols <= 0) return 0;
    const widthSansGaps =
      gridMetrics.width - Math.max(0, cols - 1) * gridMetrics.gapX;
    if (widthSansGaps <= 0) return 0;
    return widthSansGaps / cols;
  }, [cols, gridMetrics.width, gridMetrics.gapX]);

  const cellHeightPx = useMemo(() => {
    if (rows <= 0) return 0;
    const heightSansGaps =
      gridMetrics.height - Math.max(0, rows - 1) * gridMetrics.gapY;
    if (heightSansGaps <= 0) return 0;
    return heightSansGaps / rows;
  }, [rows, gridMetrics.height, gridMetrics.gapY]);

  const wallMaps = useMemo(() => buildWallMaps(walls), [walls]);
  const resolveWallColor = useCallback(
    (wall: WallPositionWithState) => getWallColor(wall, playerColors),
    [playerColors],
  );

  // Get pawns for a cell
  const getPawnsForCell = (row: number, col: number): BoardPawn[] => {
    return pawnsWithIds.filter((p) => p.cell[0] === row && p.cell[1] === col);
  };

  const dragEnabled = Boolean(onCellDrop);

  // Build gameGrid from walls for distance calculations
  // Include both placed and staged walls so distance calculations account for staged walls
  const gameGrid = useMemo(() => {
    const g = new Grid(cols, rows, "standard");
    walls.forEach((pWall) => {
      if (pWall.state === "placed" || pWall.state === "staged") {
        g.addWall(pWall);
      }
    });
    return g;
  }, [walls, cols, rows]);

  // Calculate valid drop cells when dragging or when a pawn is selected
  const validDropCells = useMemo(() => {
    // Use draggingPawnId if dragging, otherwise use selectedPawnId
    const activePawnId = draggingPawnId ?? selectedPawnId;
    if (!activePawnId || !dragEnabled) return new Set<string>();

    const pawn = pawnsWithIds.find((p) => p.id === activePawnId);
    if (!pawn) return new Set<string>();

    const validCells = new Set<string>();

    // Check all cells to see if they're at the target distance
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const distance = gameGrid.distance(
          [pawn.cell[0], pawn.cell[1]],
          [row, col],
        );
        if (stagedActionsCount === 0) {
          // With 0 staged actions: highlight cells at distance 1 OR 2
          if (distance === 1 || distance === 2) {
            validCells.add(`${row}-${col}`);
          }
        } else {
          // With 1 staged action: highlight cells at distance 1
          if (distance === 1) {
            validCells.add(`${row}-${col}`);
          }
        }
      }
    }

    return validCells;
  }, [
    draggingPawnId,
    selectedPawnId,
    dragEnabled,
    pawnsWithIds,
    stagedActionsCount,
    gameGrid,
    rows,
    cols,
  ]);

  const getArrowScale = (
    fromRow: number,
    fromCol: number,
    toRow: number,
    toCol: number,
  ) => {
    const rowDelta = Math.abs(toRow - fromRow);
    const colDelta = Math.abs(toCol - fromCol);

    if (
      (rowDelta === 1 && colDelta === 0) ||
      (rowDelta === 0 && colDelta === 1)
    ) {
      return 0.4;
    }

    if (
      (rowDelta === 2 && colDelta === 0) ||
      (rowDelta === 0 && colDelta === 2)
    ) {
      return 0.6;
    }

    if (rowDelta === colDelta && rowDelta > 0) {
      return 0.45;
    }

    return 0.85;
  };

  const shortenLineBetweenCenters = (
    start: { x: number; y: number },
    end: { x: number; y: number },
    scale: number,
  ) => {
    const boundedScale = Math.max(0, Math.min(scale, 1));
    if (boundedScale === 1) {
      return { start, end };
    }

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const offsetRatio = (1 - boundedScale) / 2;
    const offsetX = dx * offsetRatio;
    const offsetY = dy * offsetRatio;

    return {
      start: { x: start.x + offsetX / 3, y: start.y + offsetY / 3 },
      end: { x: end.x - offsetX, y: end.y - offsetY },
    };
  };

  // Render last move arrows (subtle)
  const renderLastMoveArrows = () => {
    const moves = lastMove ? [lastMove] : (lastMoves ?? []);
    if (
      moves.length === 0 ||
      gridMetrics.width === 0 ||
      gridMetrics.height === 0
    ) {
      return null;
    }

    return moves.map((move: LastMove, index: number) => {
      const { strokeWidth, markerSize, markerRef } = arrowVisuals;
      const fromCenter = getCellCenterPosition(move.fromRow, move.fromCol);
      const toCenter = getCellCenterPosition(move.toRow, move.toCol);
      const { start, end } = shortenLineBetweenCenters(
        { x: fromCenter.x, y: fromCenter.y },
        { x: toCenter.x, y: toCenter.y },
        getArrowScale(move.fromRow, move.fromCol, move.toRow, move.toCol),
      );

      const arrowColor = move.playerColor
        ? colorHexMap[move.playerColor] || "#94a3b8"
        : "#94a3b8";
      const markerId = `arrowhead-last-move-${index}`;

      return (
        <svg
          key={`last-move-arrow-${index}`}
          className="absolute inset-0 pointer-events-none"
          style={{ zIndex: 3, opacity: 0.3 }}
          viewBox={`0 0 ${Math.max(gridMetrics.width, 1)} ${Math.max(
            gridMetrics.height,
            1,
          )}`}
          preserveAspectRatio="none"
        >
          <defs>
            <marker
              id={markerId}
              markerWidth={markerSize}
              markerHeight={markerSize}
              refX={markerRef}
              refY={markerRef}
              orient="auto"
            >
              <polygon
                points={`0 0, ${markerSize} ${markerRef}, 0 ${markerSize}`}
                fill={arrowColor}
                opacity={0.8}
              />
            </marker>
          </defs>
          <line
            x1={start.x}
            y1={start.y}
            x2={end.x}
            y2={end.y}
            stroke={arrowColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            markerEnd={`url(#${markerId})`}
          />
        </svg>
      );
    });
  };

  // Convert WallPosition to rectangle coordinates for rendering
  // Returns [row1, col1, row2, col2] representing the two cells separated by the wall
  const wallToRectCoords = (
    wall: WallPosition,
  ): [number, number, number, number] => {
    if (wall.orientation === "vertical") {
      // Vertical wall: separates (row, col) and (row, col+1)
      return [wall.cell[0], wall.cell[1], wall.cell[0], wall.cell[1] + 1];
    } else {
      // Horizontal wall: separates (row-1, col) and (row, col)
      return [wall.cell[0] - 1, wall.cell[1], wall.cell[0], wall.cell[1]];
    }
  };

  // Get arrow color based on type
  const getArrowColor = (arrow: Arrow): string => {
    if (arrow.type === "staged") return "#fbbf24"; // Yellow/amber
    if (arrow.type === "premoved") return "#60a5fa"; // Light blue
    return "#94a3b8"; // Gray for calculated
  };

  // Render arrow SVG
  const renderArrow = (arrow: Arrow, index: number) => {
    if (gridMetrics.width === 0 || gridMetrics.height === 0) {
      return null;
    }

    const fromCenter = getCellCenterPosition(arrow.from[0], arrow.from[1]);
    const toCenter = getCellCenterPosition(arrow.to[0], arrow.to[1]);
    const { start, end } = shortenLineBetweenCenters(
      { x: fromCenter.x, y: fromCenter.y },
      { x: toCenter.x, y: toCenter.y },
      getArrowScale(arrow.from[0], arrow.from[1], arrow.to[0], arrow.to[1]),
    );

    const arrowColor = getArrowColor(arrow);
    const { strokeWidth, markerSize, markerRef } = arrowVisuals;
    const opacity = arrow.type === "calculated" ? 0.5 : 0.8;
    const dashArray = arrow.type === "calculated" ? "4,2" : "none";
    const markerId = `arrowhead-${arrow.type}-${index}`;

    return (
      <svg
        key={`arrow-${arrow.from[0]}-${arrow.from[1]}-${arrow.to[0]}-${arrow.to[1]}-${index}`}
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: arrow.type === "calculated" ? 1 : 5 }}
        viewBox={`0 0 ${Math.max(gridMetrics.width, 1)} ${Math.max(
          gridMetrics.height,
          1,
        )}`}
        preserveAspectRatio="none"
      >
        <defs>
          <marker
            id={markerId}
            markerWidth={markerSize}
            markerHeight={markerSize}
            refX={markerRef}
            refY={markerRef}
            orient="auto"
          >
            <polygon
              points={`0 0, ${markerSize} ${markerRef}, 0 ${markerSize}`}
              fill={arrowColor}
              opacity={opacity}
            />
          </marker>
        </defs>
        <line
          x1={start.x}
          y1={start.y}
          x2={end.x}
          y2={end.y}
          stroke={arrowColor}
          strokeWidth={strokeWidth}
          opacity={opacity}
          strokeDasharray={dashArray}
          strokeLinecap="round"
          strokeLinejoin="round"
          markerEnd={`url(#${markerId})`}
        />
      </svg>
    );
  };

  const getCellRect = useCallback(
    (rowIndex: number, colIndex: number) => {
      if (cellWidthPx === 0 || cellHeightPx === 0) {
        return null;
      }
      const left = colIndex * (cellWidthPx + gridMetrics.gapX);
      const top = rowIndex * (cellHeightPx + gridMetrics.gapY);
      return {
        left,
        top,
        right: left + cellWidthPx,
        bottom: top + cellHeightPx,
        width: cellWidthPx,
        height: cellHeightPx,
      };
    },
    [cellWidthPx, cellHeightPx, gridMetrics.gapX, gridMetrics.gapY],
  );

  const getCellCenterPosition = useCallback(
    (rowIndex: number, colIndex: number) => {
      const rect = getCellRect(rowIndex, colIndex);
      if (!rect) {
        return { x: 0, y: 0, leftPercent: 0, topPercent: 0 };
      }
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const leftPercent =
        gridMetrics.width > 0 ? (centerX / gridMetrics.width) * 100 : 0;
      const topPercent =
        gridMetrics.height > 0 ? (centerY / gridMetrics.height) * 100 : 0;

      return { x: centerX, y: centerY, leftPercent, topPercent };
    },
    [getCellRect, gridMetrics.width, gridMetrics.height],
  );

  const renderMoveHighlights = useCallback(() => {
    if (
      validDropCells.size === 0 ||
      gridMetrics.width === 0 ||
      gridMetrics.height === 0
    ) {
      return null;
    }

    return Array.from(validDropCells).map((key) => {
      const [rowIndex, colIndex] = key.split("-").map(Number);
      if (Number.isNaN(rowIndex) || Number.isNaN(colIndex)) {
        return null;
      }
      const { topPercent, leftPercent } = getCellCenterPosition(
        rowIndex,
        colIndex,
      );
      return (
        <span
          key={`move-target-${key}`}
          className="absolute bg-amber-500/80 dark:bg-primary/80 rounded-full pointer-events-none shadow-sm"
          style={{
            width: "0.45rem",
            height: "0.45rem",
            top: `${topPercent}%`,
            left: `${leftPercent}%`,
            transform: "translate(-50%, -50%)",
            zIndex: 6,
          }}
        />
      );
    });
  }, [
    validDropCells,
    gridMetrics.width,
    gridMetrics.height,
    getCellCenterPosition,
  ]);

  const arrowVisuals = useMemo(() => {
    const minCellDimension = Math.min(cellWidthPx || 100, cellHeightPx || 100);
    // Make arrow proportional to cell size (approx 15% of cell width)
    // But cap it so it doesn't get too thin on very small screens or too thick on large ones
    const strokeWidth = Math.max(2, Math.min(minCellDimension * 0.15, 10));

    const markerSize = 3; // Multiplier of strokeWidth
    return {
      strokeWidth,
      markerSize,
      markerRef: markerSize / 2,
    };
  }, [cellWidthPx, cellHeightPx]);

  const pillars = useMemo(() => {
    if (
      rows < 2 ||
      cols < 2 ||
      cellWidthPx === 0 ||
      cellHeightPx === 0 ||
      gridMetrics.width === 0 ||
      gridMetrics.height === 0
    ) {
      return [];
    }

    const elements: ReactNode[] = [];
    const gapWidth = Math.max(gridMetrics.gapX, 2);
    const gapHeight = Math.max(gridMetrics.gapY, 2);

    for (let rowIndex = 1; rowIndex < rows; rowIndex += 1) {
      for (let colIndex = 1; colIndex < cols; colIndex += 1) {
        const colors = getPillarColors(
          rowIndex,
          colIndex,
          wallMaps,
          resolveWallColor,
        );
        const boundingBox = buildPillarBoundingBox(rowIndex, colIndex);
        const pillar = new StyledPillar({ boundingBox, colors });
        const anchorRect = getCellRect(rowIndex - 1, colIndex - 1);
        if (!anchorRect) {
          continue;
        }

        const style: CSSProperties = {
          position: "absolute",
          width: `${gapWidth}px`,
          height: `${gapHeight}px`,
          top: `${anchorRect.bottom}px`,
          left: `${anchorRect.right}px`,
          pointerEvents: "none",
          zIndex: 12,
        };

        elements.push(
          <div key={`pillar-${rowIndex}-${colIndex}`} style={style}>
            <svg
              width="100%"
              height="100%"
              viewBox={`${boundingBox.x} ${boundingBox.y} ${boundingBox.width} ${boundingBox.height}`}
              preserveAspectRatio="none"
            >
              {pillar.render()}
            </svg>
          </div>,
        );
      }
    }

    return elements;
  }, [
    rows,
    cols,
    cellWidthPx,
    cellHeightPx,
    gridMetrics.width,
    gridMetrics.height,
    gridMetrics.gapX,
    gridMetrics.gapY,
    wallMaps,
    resolveWallColor,
    getCellRect,
  ]);

  const maxBoardWidth = `${cols * maxCellSize + (cols - 1) * gapSize + paddingX}rem`;

  const handleCellDrop = (
    event: DragEvent<HTMLDivElement>,
    row: number,
    col: number,
  ) => {
    if (!onCellDrop) return;
    event.preventDefault();
    event.stopPropagation();
    const pawnId = event.dataTransfer.getData("text/plain");
    if (pawnId) {
      onCellDrop(pawnId, row, col);
    }
  };

  const renderPawnWrapper = (pawn: BoardPawn, size: "lg" | "sm") => {
    const pawnColor = playerColors[pawn.playerId];
    const isControllable =
      controllablePlayerId == null || pawn.playerId === controllablePlayerId;

    // Use percentage padding for large pawns to maintain proportions on small screens
    const dimensionClass = size === "lg" ? "w-full h-full" : "w-6 h-6";
    // If pawns are too close to the edge boundaries, increase this padding.
    const paddingStyle = size === "lg" ? { padding: "0%" } : undefined;

    const hoverClass = isControllable ? "hover:scale-110" : "";
    const isDraggingThisPawn = draggingPawnId === pawn.id;
    const cursorClass = isControllable
      ? isDraggingThisPawn
        ? "cursor-grabbing"
        : "cursor-grab"
      : "cursor-not-allowed";
    const canDrag = dragEnabled && isControllable;

    const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!isControllable) return;
      onPawnRightClick?.(pawn.id);
    };

    const handleClick = (event: MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (!isControllable) return;
      onPawnClick?.(pawn.id);
    };

    const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
      if (!canDrag) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", pawn.id);
      onPawnDragStart?.(pawn.id);
    };

    const handleDragEnd = () => {
      if (!canDrag) return;
      onPawnDragEnd?.();
    };

    const customCatPath =
      pawn.type !== "mouse" && pawn.pawnStyle
        ? `/pawns/cat/${pawn.pawnStyle}`
        : null;
    const customMousePath =
      pawn.type === "mouse" && pawn.pawnStyle
        ? `/pawns/mouse/${pawn.pawnStyle}`
        : null;

    const content = (() => {
      if (customCatPath || customMousePath) {
        const src = (customCatPath ?? customMousePath)!;
        return (
          <img
            src={src}
            alt="pawn"
            draggable={false}
            className="w-full h-full object-contain drop-shadow-md"
            style={
              colorFilterMap[pawnColor]
                ? { filter: colorFilterMap[pawnColor] }
                : undefined
            }
          />
        );
      }
      const Icon = pawn.type === "mouse" ? Rat : Cat;
      // Remove fixed pixel size for lg, let it fill container
      const sizePx = size === "lg" ? undefined : 24;
      return (
        <Icon
          size={sizePx}
          strokeWidth={2.5}
          className={`${
            colorClassMap[pawnColor] || "text-red-600"
          } w-full h-full`}
        />
      );
    })();

    const previewState = pawn.previewState;
    const previewClasses =
      previewState === "staged"
        ? "opacity-80 ring-2 ring-amber-400 ring-offset-2"
        : previewState === "ghost"
          ? "opacity-70"
          : "";

    return (
      <div
        key={pawn.id}
        className={`${dimensionClass} transform ${hoverClass} transition-transform ${cursorClass} relative ${previewClasses}`}
        style={paddingStyle}
        onContextMenu={handleContextMenu}
        onClick={handleClick}
        draggable={canDrag}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        aria-disabled={!isControllable}
      >
        {content}
      </div>
    );
  };

  return (
    <div
      className={`flex items-center justify-center ${className} ${maxWidth}`}
    >
      <div
        className="rounded-lg p-2.5 lg:p-4 bg-amber-100 dark:bg-card w-full h-auto"
        style={{
          maxWidth: maxBoardWidth,
        }}
      >
        <div className="relative">
          {/* Top row labels (column letters) */}
          <div
            className="absolute -top-4 left-0 right-0 flex hidden lg:flex"
            style={{ gap: `${gapSize}rem` }}
          >
            {Array.from({ length: cols }, (_, colIndex) => (
              <div
                key={`top-${colIndex}`}
                className="flex items-center justify-center"
                style={{ width: cellSize }}
              >
                <span className="text-[10px] text-gray-600 dark:text-muted-foreground font-medium">
                  {String.fromCharCode(97 + colIndex)}
                </span>
              </div>
            ))}
          </div>

          {/* Bottom row labels (column letters) */}
          <div
            className="absolute -bottom-4 left-0 right-0 flex hidden lg:flex"
            style={{ gap: `${gapSize}rem` }}
          >
            {Array.from({ length: cols }, (_, colIndex) => (
              <div
                key={`bottom-${colIndex}`}
                className="flex items-center justify-center"
                style={{ width: cellSize }}
              >
                <span className="text-[10px] text-gray-600 dark:text-muted-foreground font-medium">
                  {String.fromCharCode(97 + colIndex)}
                </span>
              </div>
            ))}
          </div>

          {/* Left column labels (row numbers) */}
          <div
            className="absolute -left-4 top-0 bottom-0 flex flex-col items-center hidden lg:flex"
            style={{ gap: `${gapSize}rem`, width: "1rem" }}
          >
            {Array.from({ length: rows }, (_, rowIndex) => (
              <div
                key={`left-${rowIndex}`}
                className="flex items-center justify-center w-full"
                style={{ height: cellHeight }}
              >
                <span className="text-[10px] text-gray-600 dark:text-muted-foreground font-medium">
                  {rows - rowIndex}
                </span>
              </div>
            ))}
          </div>

          {/* Right column labels (row numbers) */}
          <div
            className="absolute -right-4 top-0 bottom-0 flex flex-col items-center hidden lg:flex"
            style={{ gap: `${gapSize}rem`, width: "1rem" }}
          >
            {Array.from({ length: rows }, (_, rowIndex) => (
              <div
                key={`right-${rowIndex}`}
                className="flex items-center justify-center w-full"
                style={{ height: cellHeight }}
              >
                <span className="text-[10px] text-gray-600 dark:text-muted-foreground font-medium">
                  {rows - rowIndex}
                </span>
              </div>
            ))}
          </div>

          <div
            ref={gridRef}
            className="grid w-full relative"
            style={{
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gap: gapValue,
            }}
          >
            {/* Wall click areas - horizontal (between rows) */}
            {cellWidthPx > 0 &&
              gridMetrics.gapY > 0 &&
              Array.from({ length: rows - 1 }, (_, rowIndex) =>
                Array.from({ length: cols }, (_, colIndex) => {
                  const rect = getCellRect(rowIndex, colIndex);
                  if (!rect) return null;
                  const gapHeight = Math.max(gridMetrics.gapY, 2);
                  return (
                    <div
                      key={`horizontal-wall-click-${rowIndex}-${colIndex}`}
                      className="absolute cursor-pointer hover:bg-blue-200/20 dark:hover:bg-primary/20"
                      style={{
                        width: `${rect.width}px`,
                        height: `${gapHeight}px`,
                        top: `${rect.bottom}px`,
                        left: `${rect.left}px`,
                        zIndex: 15,
                      }}
                      onClick={() =>
                        onWallClick?.(
                          rowIndex + 1,
                          colIndex,
                          "horizontal" as WallOrientation,
                        )
                      }
                    />
                  );
                }),
              )}

            {/* Wall click areas - vertical (between columns) */}
            {cellHeightPx > 0 &&
              gridMetrics.gapX > 0 &&
              Array.from({ length: rows }, (_, rowIndex) =>
                Array.from({ length: cols - 1 }, (_, colIndex) => {
                  const rect = getCellRect(rowIndex, colIndex);
                  if (!rect) return null;
                  const gapWidth = Math.max(gridMetrics.gapX, 2);
                  return (
                    <div
                      key={`vertical-wall-click-${rowIndex}-${colIndex}`}
                      className="absolute cursor-pointer hover:bg-blue-200/20 dark:hover:bg-primary/20"
                      style={{
                        width: `${gapWidth}px`,
                        height: `${rect.height}px`,
                        top: `${rect.top}px`,
                        left: `${rect.right}px`,
                        zIndex: 15,
                      }}
                      onClick={() =>
                        onWallClick?.(
                          rowIndex,
                          colIndex,
                          "vertical" as WallOrientation,
                        )
                      }
                    />
                  );
                }),
              )}

            {/* Render arrows */}
            {arrows.map((arrow, index) => renderArrow(arrow, index))}
            {/* Render last move arrow */}
            {renderLastMoveArrows()}
            {/* Render move targets */}
            {renderMoveHighlights()}

            {/* Render walls */}
            {walls.map((pWall, index) => {
              if (cellWidthPx === 0 || cellHeightPx === 0) {
                return null;
              }
              const [row1, col1, row2] = wallToRectCoords(pWall);
              const isVertical = pWall.orientation === "vertical";
              const wallColor = resolveWallColor(pWall);

              let style: CSSProperties = {
                position: "absolute",
                backgroundColor: wallColor,
                zIndex:
                  pWall.state === "placed"
                    ? 10
                    : pWall.state === "staged" || pWall.state === "premoved"
                      ? 8
                      : 2,
              };

              if (isVertical) {
                // Vertical wall: separates cells horizontally (between columns)
                const rect = getCellRect(row1, col1);
                if (!rect) {
                  return null;
                }
                const wallCenterX =
                  rect.left + rect.width + gridMetrics.gapX / 2;
                const thickness = Math.max(gridMetrics.gapX, 2);

                style = {
                  ...style,
                  height: `${rect.height + 2}px`, // Extend slightly to prevent gaps
                  width: `${thickness}px`,
                  top: `${rect.top - 1}px`,
                  left: `${wallCenterX}px`,
                  transform: "translateX(-50%)",
                  opacity: pWall.state === "calculated" ? 0.5 : 1,
                };
              } else {
                // Horizontal wall: separates cells vertically (between rows)
                const minRow = Math.min(row1, row2);
                const wallCenterY =
                  (minRow + 1) * (cellHeightPx + gridMetrics.gapY) -
                  gridMetrics.gapY / 2;
                const thickness = Math.max(gridMetrics.gapY, 2);
                const left = col1 * (cellWidthPx + gridMetrics.gapX) - 1;

                style = {
                  ...style,
                  width: `${cellWidthPx + 2}px`, // Extend slightly to prevent gaps
                  height: `${thickness}px`,
                  left: `${left}px`,
                  top: `${wallCenterY}px`,
                  transform: "translateY(-50%)",
                  opacity: pWall.state === "calculated" ? 0.5 : 1,
                };
              }

              const borderStyle =
                pWall.state === "staged" || pWall.state === "premoved"
                  ? "border-2 border-dashed border-gray-600"
                  : "";

              return (
                <div
                  key={`wall-${index}`}
                  style={style}
                  className={`shadow-md ${borderStyle}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onWallRightClick?.(index);
                  }}
                />
              );
            })}
            {/* Render pillars */}
            {pillars}

            {/* Render cells */}
            {grid.map((row, rowIndex) =>
              row.map(({ col: colIndex }) => {
                const cellPawns = getPawnsForCell(rowIndex, colIndex);
                const isLight = (rowIndex + colIndex) % 2 === 0;
                return (
                  <div
                    key={`${rowIndex}-${colIndex}`}
                    className={`aspect-square border border-amber-400 dark:border-border flex items-center justify-center relative cursor-pointer transition-colors ${
                      isLight
                        ? "bg-amber-200 dark:bg-muted/80 hover:bg-amber-300 dark:hover:bg-accent/30"
                        : "bg-amber-100 dark:bg-background hover:bg-amber-200 dark:hover:bg-accent/30"
                    }`}
                    onClick={() => onCellClick?.(rowIndex, colIndex)}
                    onDragOver={(event) => {
                      if (!dragEnabled) return;
                      event.preventDefault();
                    }}
                    onDrop={(event) =>
                      handleCellDrop(event, rowIndex, colIndex)
                    }
                  >
                    {/* Pawns */}
                    {cellPawns.length > 0 && (
                      <div className="w-full h-full flex items-center justify-center p-1">
                        {cellPawns.length === 1 ? (
                          renderPawnWrapper(cellPawns[0], "lg")
                        ) : (
                          <div className="flex flex-wrap items-center justify-center gap-0.5">
                            {cellPawns.map((pawn) =>
                              renderPawnWrapper(pawn, "sm"),
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              }),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
