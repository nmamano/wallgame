"use client";

import type { CSSProperties, ReactNode, DragEvent, MouseEvent } from "react";
import { useMemo } from "react";
import { Cat, Rat } from "lucide-react";
import { StyledPillar, type EdgeColorKey } from "../lib/styled-pillar";
import {
  type PlayerColor,
  colorClassMap,
  colorFilterMap,
  colorHexMap,
} from "@/lib/player-colors";
import {
  Cell,
  Wall,
  type Pawn,
  type PlayerWall,
  type PlayerId,
} from "@/lib/game";

export type ArrowType = "staged" | "premoved" | "calculated";

export type BoardPawn = Pawn & {
  previewState?: "staged" | "ghost";
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
  pawns?: BoardPawn[];
  walls?: PlayerWall[];
  arrows?: Arrow[];
  lastMove?: LastMove;
  lastMoves?: LastMove[];
  maxWidth?: string;
  playerColors?: Record<PlayerId, PlayerColor>;
  onCellClick?: (row: number, col: number) => void;
  onWallClick?: (
    row: number,
    col: number,
    orientation: "horizontal" | "vertical"
  ) => void;
  onPawnRightClick?: (row: number, col: number, pawnId: string) => void;
  onWallRightClick?: (wallIndex: number) => void;
  onPawnClick?: (pawnId: string) => void;
  onPawnDragStart?: (pawnId: string) => void;
  onPawnDragEnd?: () => void;
  onCellDrop?: (row: number, col: number) => void;
  catPawnPath?: string;
  mousePawnPath?: string;
  className?: string;
}

type WallMaps = {
  vertical: Map<string, PlayerWall>;
  horizontal: Map<string, PlayerWall>;
};

type PillarColors = Record<EdgeColorKey, string | null>;

const wallKey = (row: number, col: number) => `${row}-${col}`;

type AxisPercents = {
  baseCell: number;
  cellWithGap: number;
  gapPercent: number;
};

const computeAxisPercents = (
  count: number,
  maxCellSize: number,
  gapSize: number
): AxisPercents => {
  if (count <= 0) {
    return { baseCell: 0, cellWithGap: 0, gapPercent: 0 };
  }

  const totalGap = Math.max(0, count - 1) * gapSize;
  const totalSpan = count * maxCellSize + totalGap;

  if (totalSpan === 0) {
    return { baseCell: 100 / count, cellWithGap: 0, gapPercent: 0 };
  }

  return {
    baseCell: 100 / count,
    cellWithGap: (maxCellSize / totalSpan) * 100,
    gapPercent: count > 1 ? (gapSize / totalSpan) * 100 : 0,
  };
};

const getCellCenterPercent = (
  index: number,
  axis: AxisPercents,
  includeGaps: boolean
) => {
  if (axis.baseCell === 0) return 0;

  const cellPercent = includeGaps ? axis.cellWithGap : axis.baseCell;
  const base = (index + 0.5) * cellPercent;

  if (!includeGaps || axis.gapPercent === 0) {
    return base;
  }

  return base + index * axis.gapPercent;
};

const buildWallMaps = (walls: PlayerWall[]): WallMaps => {
  const vertical = new Map<string, PlayerWall>();
  const horizontal = new Map<string, PlayerWall>();

  walls.forEach((pWall) => {
    const wall = pWall.wall;
    if (wall.row1 === wall.row2) {
      const row = wall.row1;
      const minCol = Math.min(wall.col1, wall.col2);
      vertical.set(wallKey(row, minCol), pWall);
      return;
    }

    if (wall.col1 === wall.col2) {
      const col = wall.col1;
      const minRow = Math.min(wall.row1, wall.row2);
      horizontal.set(wallKey(minRow, col), pWall);
    }
  });

  return { vertical, horizontal };
};

const getWallColor = (
  pWall: PlayerWall,
  playerColors?: Record<PlayerId, PlayerColor>
): string => {
  if (pWall.state === "placed" && pWall.playerId && playerColors) {
    const color = playerColors[pWall.playerId];
    return colorHexMap[color] || "#dc2626";
  }
  if (pWall.state === "staged") return "#fbbf24";
  if (pWall.state === "premoved") return "#60a5fa";
  if (pWall.state === "calculated") return "#94a3b8";
  return "transparent";
};

const getPillarColors = (
  rowIndex: number,
  colIndex: number,
  wallMaps: WallMaps,
  resolveColor: (wall: PlayerWall) => string
): PillarColors => {
  const northWall = wallMaps.vertical.get(wallKey(rowIndex - 1, colIndex - 1));
  const southWall = wallMaps.vertical.get(wallKey(rowIndex, colIndex - 1));
  const westWall = wallMaps.horizontal.get(wallKey(rowIndex - 1, colIndex - 1));
  const eastWall = wallMaps.horizontal.get(wallKey(rowIndex - 1, colIndex));

  return {
    north: northWall ? resolveColor(northWall) : null,
    east: eastWall ? resolveColor(eastWall) : null,
    south: southWall ? resolveColor(southWall) : null,
    west: westWall ? resolveColor(westWall) : null,
  };
};

const computeGapPosition = (
  index: number,
  cellSize: string,
  gapValue: string
): string => `calc(${index} * (${cellSize} + ${gapValue}) - ${gapValue})`;

const buildPillarBoundingBox = (rowIndex: number, colIndex: number) => {
  const size = 100;
  return {
    x: colIndex * size,
    y: rowIndex * size,
    width: size,
    height: size,
  };
};

type CreatePillarElementsParams = {
  rows: number;
  cols: number;
  cellSize: string;
  gapValue: string;
  wallMaps: WallMaps;
  resolveColor: (wall: PlayerWall) => string;
};

const createPillarElements = ({
  rows,
  cols,
  cellSize,
  gapValue,
  wallMaps,
  resolveColor,
}: CreatePillarElementsParams): ReactNode[] => {
  if (rows < 2 || cols < 2) {
    return [];
  }

  const elements: ReactNode[] = [];

  for (let rowIndex = 1; rowIndex < rows; rowIndex += 1) {
    for (let colIndex = 1; colIndex < cols; colIndex += 1) {
      const colors = getPillarColors(
        rowIndex,
        colIndex,
        wallMaps,
        resolveColor
      );
      const boundingBox = buildPillarBoundingBox(rowIndex, colIndex);
      const pillar = new StyledPillar({ boundingBox, colors });
      const style: CSSProperties = {
        position: "absolute",
        width: gapValue,
        height: gapValue,
        top: computeGapPosition(rowIndex, cellSize, gapValue),
        left: computeGapPosition(colIndex, cellSize, gapValue),
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
        </div>
      );
    }
  }

  return elements;
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
}: BoardProps) {
  // Create grid array
  const grid = Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: cols }, (_, colIndex) => ({
      row: rowIndex,
      col: colIndex,
    }))
  );

  // Calculate cell size for positioning walls (dynamic based on grid size)
  const gapSize = 0.9; // rem
  const maxCellSize = 3; // rem
  const paddingX = 2; // rem (p-4 = 1rem on each side)
  const paddingY = 2; // rem (p-4 = 1rem on each side)
  const cellSize = `calc((100% - ${cols - 1} * ${gapSize}rem) / ${cols})`;
  const cellHeight = `calc((100% - ${rows - 1} * ${gapSize}rem) / ${rows})`;
  const gapValue = `${gapSize}rem`;
  const widthPercents = computeAxisPercents(cols, maxCellSize, gapSize);
  const heightPercents = computeAxisPercents(rows, maxCellSize, gapSize);
  const isStraightMove = (
    fromRow: number,
    fromCol: number,
    toRow: number,
    toCol: number
  ) => fromRow === toRow || fromCol === toCol;

  const wallMaps = useMemo(() => buildWallMaps(walls), [walls]);
  const resolveWallColor = (wall: PlayerWall) =>
    getWallColor(wall, playerColors);

  const pillars = useMemo(
    () =>
      createPillarElements({
        rows,
        cols,
        cellSize,
        gapValue,
        wallMaps,
        resolveColor: resolveWallColor,
      }),
    [rows, cols, cellSize, gapValue, wallMaps, playerColors]
  );

  // Get pawns for a cell
  const getPawnsForCell = (row: number, col: number): BoardPawn[] => {
    return pawns.filter((p) => p.cell.row === row && p.cell.col === col);
  };

  const dragEnabled = Boolean(onCellDrop);

  // Render last move arrows (subtle)
  const renderLastMoveArrows = () => {
    const moves = lastMove ? [lastMove] : lastMoves || [];
    if (moves.length === 0) return null;

    return moves.map((move: LastMove, index: number) => {
      const useGapAware = isStraightMove(
        move.fromRow,
        move.fromCol,
        move.toRow,
        move.toCol
      );

      const fromX = getCellCenterPercent(
        move.fromCol,
        widthPercents,
        useGapAware
      );
      const toX = getCellCenterPercent(move.toCol, widthPercents, useGapAware);
      const fromY = getCellCenterPercent(
        move.fromRow,
        heightPercents,
        useGapAware
      );
      const toY = getCellCenterPercent(move.toRow, heightPercents, useGapAware);

      // Calculate direction vector
      const dx = toX - fromX;
      const dy = toY - fromY;
      const length = Math.sqrt(dx * dx + dy * dy);

      // Shorten the line to prevent shaft showing through arrowhead
      // Arrowhead is about 0.8% of the viewBox (smaller now), so shorten by that amount
      const shortenAmount = 3;
      const shortenRatio =
        length > shortenAmount ? (length - shortenAmount) / length : 0;
      const adjustedToX = fromX + dx * shortenRatio;
      const adjustedToY = fromY + dy * shortenRatio;

      // Get arrow color from player color, or use default gray
      const arrowColor = move.playerColor
        ? colorHexMap[move.playerColor] || "#94a3b8"
        : "#94a3b8";
      const strokeWidth = 1.1;
      const opacity = 0.3; // More subtle than calculated arrows

      return (
        <svg
          key={`last-move-arrow-${index}`}
          className="absolute inset-0 pointer-events-none"
          style={{ zIndex: 3, opacity }}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <defs>
            <marker
              id={`arrowhead-last-move-${index}`}
              refX="2"
              refY="1.5"
              orient="auto"
            >
              <polygon points="0 0, 3 1.5, 0 3" fill={arrowColor} />
            </marker>
          </defs>
          <line
            x1={fromX}
            y1={fromY}
            x2={adjustedToX}
            y2={adjustedToY}
            stroke={arrowColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            markerEnd={`url(#arrowhead-last-move-${index})`}
          />
        </svg>
      );
    });
  };

  // Normalize wall coordinates (always store in consistent order)
  const normalizeWall = (wall: Wall): [number, number, number, number] => {
    if (
      wall.row1 < wall.row2 ||
      (wall.row1 === wall.row2 && wall.col1 < wall.col2)
    ) {
      return [wall.row1, wall.col1, wall.row2, wall.col2];
    }
    return [wall.row2, wall.col2, wall.row1, wall.col1];
  };

  // Get arrow color based on type
  const getArrowColor = (arrow: Arrow): string => {
    if (arrow.type === "staged") return "#fbbf24"; // Yellow/amber
    if (arrow.type === "premoved") return "#60a5fa"; // Light blue
    return "#94a3b8"; // Gray for calculated
  };

  // Render arrow SVG
  const renderArrow = (arrow: Arrow, index: number) => {
    // Calculate center positions of cells
    const useGapAware = isStraightMove(
      arrow.from.row,
      arrow.from.col,
      arrow.to.row,
      arrow.to.col
    );
    const fromX = getCellCenterPercent(
      arrow.from.col,
      widthPercents,
      useGapAware
    );
    const toX = getCellCenterPercent(arrow.to.col, widthPercents, useGapAware);
    const fromY = getCellCenterPercent(
      arrow.from.row,
      heightPercents,
      useGapAware
    );
    const toY = getCellCenterPercent(arrow.to.row, heightPercents, useGapAware);

    // Calculate direction vector for shortening
    const dx = toX - fromX;
    const dy = toY - fromY;
    const length = Math.sqrt(dx * dx + dy * dy);

    // Shorten the line to prevent shaft showing through arrowhead
    // Using same shortening as last move arrow
    const shortenAmount = 3;
    const shortenRatio =
      length > shortenAmount ? (length - shortenAmount) / length : 0;
    const adjustedToX = fromX + dx * shortenRatio;
    const adjustedToY = fromY + dy * shortenRatio;

    const arrowColor = getArrowColor(arrow);
    const strokeWidth = 1.1;
    const opacity = arrow.type === "calculated" ? 0.5 : 0.8;
    const dashArray = arrow.type === "calculated" ? "4,2" : "none";

    return (
      <svg
        key={`arrow-${arrow.from.row}-${arrow.from.col}-${arrow.to.row}-${arrow.to.col}-${index}`}
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: arrow.type === "calculated" ? 1 : 5 }}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <defs>
          <marker
            id={`arrowhead-${arrow.type}-${index}`}
            markerWidth="3"
            markerHeight="3"
            refX="2"
            refY="1.5"
            orient="auto"
          >
            <polygon
              points="0 0, 3 1.5, 0 3"
              fill={arrowColor}
              opacity={opacity}
            />
          </marker>
        </defs>
        <line
          x1={fromX}
          y1={fromY}
          x2={adjustedToX}
          y2={adjustedToY}
          stroke={arrowColor}
          strokeWidth={strokeWidth}
          opacity={opacity}
          strokeDasharray={dashArray}
          strokeLinecap="round"
          strokeLinejoin="round"
          markerEnd={`url(#arrowhead-${arrow.type}-${index})`}
        />
      </svg>
    );
  };

  const maxBoardWidth = `${cols * maxCellSize + (cols - 1) * gapSize + paddingX}rem`;
  const maxBoardHeight = `${rows * maxCellSize + (rows - 1) * gapSize + paddingY}rem`;

  // Calculate aspect ratio based on rows and cols
  const aspectRatio = cols / rows;

  const handleCellDrop = (
    event: DragEvent<HTMLDivElement>,
    row: number,
    col: number
  ) => {
    if (!onCellDrop) return;
    event.preventDefault();
    event.stopPropagation();
    onCellDrop(row, col);
  };

  const renderPawnWrapper = (
    pawn: BoardPawn,
    rowIndex: number,
    colIndex: number,
    size: "lg" | "sm"
  ) => {
    const pawnColor = playerColors[pawn.playerId];
    const dimensionClass = size === "lg" ? "w-full h-full p-0.5" : "w-6 h-6";

    const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onPawnRightClick?.(rowIndex, colIndex, pawn.id);
    };

    const handleClick = (event: MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      onPawnClick?.(pawn.id);
    };

    const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
      if (!dragEnabled) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", pawn.id);
      onPawnDragStart?.(pawn.id);
    };

    const handleDragEnd = () => {
      if (!dragEnabled) return;
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
      const sizePx = size === "lg" ? 36 : 24;
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
        className={`${dimensionClass} transform hover:scale-110 transition-transform cursor-pointer relative ${previewClasses}`}
        onContextMenu={handleContextMenu}
        onClick={handleClick}
        draggable={dragEnabled}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
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
        className="rounded-lg p-4 bg-amber-100 max-w-full max-h-full"
        style={{
          width: maxBoardWidth,
          height: maxBoardHeight,
          maxWidth: "100%",
          maxHeight: "100%",
          aspectRatio: aspectRatio.toString(),
        }}
      >
        <div className="relative">
          {/* Top row labels (column letters) */}
          <div
            className="absolute -top-4 left-0 right-0 flex"
            style={{ gap: `${gapSize}rem` }}
          >
            {Array.from({ length: cols }, (_, colIndex) => (
              <div
                key={`top-${colIndex}`}
                className="flex items-center justify-center"
                style={{ width: cellSize }}
              >
                <span className="text-[10px] text-gray-600 font-medium">
                  {String.fromCharCode(97 + colIndex)}
                </span>
              </div>
            ))}
          </div>

          {/* Bottom row labels (column letters) */}
          <div
            className="absolute -bottom-4 left-0 right-0 flex"
            style={{ gap: `${gapSize}rem` }}
          >
            {Array.from({ length: cols }, (_, colIndex) => (
              <div
                key={`bottom-${colIndex}`}
                className="flex items-center justify-center"
                style={{ width: cellSize }}
              >
                <span className="text-[10px] text-gray-600 font-medium">
                  {String.fromCharCode(97 + colIndex)}
                </span>
              </div>
            ))}
          </div>

          {/* Left column labels (row numbers) */}
          <div
            className="absolute -left-4 top-0 bottom-0 flex flex-col items-center"
            style={{ gap: `${gapSize}rem`, width: "1rem" }}
          >
            {Array.from({ length: rows }, (_, rowIndex) => (
              <div
                key={`left-${rowIndex}`}
                className="flex items-center justify-center w-full"
                style={{ height: cellHeight }}
              >
                <span className="text-[10px] text-gray-600 font-medium">
                  {rows - rowIndex}
                </span>
              </div>
            ))}
          </div>

          {/* Right column labels (row numbers) */}
          <div
            className="absolute -right-4 top-0 bottom-0 flex flex-col items-center"
            style={{ gap: `${gapSize}rem`, width: "1rem" }}
          >
            {Array.from({ length: rows }, (_, rowIndex) => (
              <div
                key={`right-${rowIndex}`}
                className="flex items-center justify-center w-full"
                style={{ height: cellHeight }}
              >
                <span className="text-[10px] text-gray-600 font-medium">
                  {rows - rowIndex}
                </span>
              </div>
            ))}
          </div>

          <div
            className="grid w-full relative"
            style={{
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gap: gapValue,
            }}
          >
            {/* Wall click areas - horizontal (between rows) */}
            {Array.from({ length: rows - 1 }, (_, rowIndex) =>
              Array.from({ length: cols }, (_, colIndex) => (
                <div
                  key={`horizontal-wall-click-${rowIndex}-${colIndex}`}
                  className="absolute cursor-pointer hover:bg-blue-200/20"
                  style={{
                    width: cellSize,
                    height: gapValue,
                    top: `calc(${rowIndex + 1} * (${cellSize} + ${gapValue}) - ${gapValue} / 2)`,
                    left: `calc(${colIndex} * (${cellSize} + ${gapValue}))`,
                    transform: "translateY(-50%)",
                    zIndex: 15,
                  }}
                  onClick={() =>
                    onWallClick?.(rowIndex + 1, colIndex, "horizontal")
                  }
                />
              ))
            )}

            {/* Wall click areas - vertical (between columns) */}
            {Array.from({ length: rows }, (_, rowIndex) =>
              Array.from({ length: cols - 1 }, (_, colIndex) => (
                <div
                  key={`vertical-wall-click-${rowIndex}-${colIndex}`}
                  className="absolute cursor-pointer hover:bg-blue-200/20"
                  style={{
                    width: gapValue,
                    height: cellSize,
                    top: `calc(${rowIndex} * (${cellSize} + ${gapValue}))`,
                    left: `calc(${colIndex + 1} * (${cellSize} + ${gapValue}) - ${gapValue} / 2)`,
                    transform: "translateX(-50%)",
                    zIndex: 15,
                  }}
                  onClick={() => onWallClick?.(rowIndex, colIndex, "vertical")}
                />
              ))
            )}

            {/* Render arrows */}
            {arrows.map((arrow, index) => renderArrow(arrow, index))}
            {/* Render last move arrow */}
            {renderLastMoveArrows()}

            {/* Render walls */}
            {walls.map((pWall, index) => {
              const wall = pWall.wall;
              const [row1, col1, row2, col2] = normalizeWall(wall);
              const isHorizontal = row1 === row2;
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

              if (isHorizontal) {
                // Vertical wall (between cells in same row, separating columns)
                const minCol = Math.min(col1, col2);

                // center of the gap between col minCol and minCol + 1
                const wallCenterX = `calc((${minCol + 1} * (${cellSize} + ${gapValue})) - ${gapValue} / 2)`;

                style = {
                  ...style,
                  height: `calc(${cellSize} + 2px)`, // Extend slightly to prevent gaps
                  width: gapValue,
                  top: `calc(${row1} * (${cellSize} + ${gapValue}) - 1px)`,
                  left: wallCenterX,
                  transform: "translateX(-50%)",
                  opacity: pWall.state === "calculated" ? 0.5 : 1,
                };
              } else {
                // Horizontal wall (between cells in same column, separating rows)
                const minRow = Math.min(row1, row2);

                // center of the gap between row minRow and minRow + 1
                const wallCenterY = `calc((${minRow + 1} * (${cellSize} + ${gapValue})) - ${gapValue} / 2)`;

                style = {
                  ...style,
                  width: `calc(${cellSize} + 2px)`, // Extend slightly to prevent gaps
                  height: gapValue,
                  left: `calc(${col1} * (${cellSize} + ${gapValue}) - 1px)`,
                  top: wallCenterY,
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
                    className={`aspect-square border border-amber-400 flex items-center justify-center relative cursor-pointer hover:bg-amber-300 ${
                      isLight ? "bg-amber-200" : "bg-amber-100"
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
                          renderPawnWrapper(
                            cellPawns[0],
                            rowIndex,
                            colIndex,
                            "lg"
                          )
                        ) : (
                          <div className="flex flex-wrap items-center justify-center gap-0.5">
                            {cellPawns.map((pawn) =>
                              renderPawnWrapper(pawn, rowIndex, colIndex, "sm")
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
