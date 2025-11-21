"use client";

import type { CSSProperties, ReactNode } from "react";
import { useMemo } from "react";
import { Cat, Rat } from "lucide-react";
import { StyledPillar, type EdgeColorKey } from "../lib/styled-pillar";
import { type PlayerColor, colorClassMap, colorFilterMap } from "@/lib/player-colors";
import { Cell, Wall } from "@/lib/game";

// Re-export for backwards compatibility
export type { PlayerColor };

export type WallState =
  | "placed"
  | "staged"
  | "premoved"
  | "calculated"
  | "missing";

export type ArrowType = "staged" | "premoved" | "calculated";

export type PawnType = "cat" | "rat";

export interface Pawn {
  id: string;
  color: PlayerColor;
  type: PawnType; // "cat" or "rat"
  cell: Cell;
  pawnStyle?: string; // Optional, stores the specific cat/mouse SVG filename
}

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
  walls?: Wall[];
  arrows?: Arrow[];
  lastMove?: LastMove;
  maxWidth?: string;
  onCellClick?: (row: number, col: number) => void;
  onWallClick?: (
    row: number,
    col: number,
    orientation: "horizontal" | "vertical"
  ) => void;
  onPawnRightClick?: (row: number, col: number, pawnId: string) => void;
  onWallRightClick?: (wallIndex: number) => void;
  catPawnPath?: string;
  mousePawnPath?: string;
  className?: string;
}

const colorMap: Record<string, string> = {
  red: "#dc2626",
  blue: "#2563eb",
  green: "#16a34a",
  purple: "#9333ea",
  orange: "#ea580c",
  pink: "#ec4899",
  cyan: "#06b6d4",
  brown: "#b45309",
  gray: "#6b7280",
};

type WallMaps = {
  vertical: Map<string, Wall>;
  horizontal: Map<string, Wall>;
};

type PillarColors = Record<EdgeColorKey, string | null>;

const wallKey = (row: number, col: number) => `${row}-${col}`;

const buildWallMaps = (walls: Wall[]): WallMaps => {
  const vertical = new Map<string, Wall>();
  const horizontal = new Map<string, Wall>();

  walls.forEach((wall) => {
    if (wall.row1 === wall.row2) {
      const row = wall.row1;
      const minCol = Math.min(wall.col1, wall.col2);
      vertical.set(wallKey(row, minCol), wall);
      return;
    }

    if (wall.col1 === wall.col2) {
      const col = wall.col1;
      const minRow = Math.min(wall.row1, wall.row2);
      horizontal.set(wallKey(minRow, col), wall);
    }
  });

  return { vertical, horizontal };
};

const getWallColor = (wall: Wall): string => {
  if (wall.state === "placed" && wall.playerColor) {
    return colorMap[wall.playerColor] || "#dc2626";
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
  resolveColor: (wall: Wall) => string
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
  resolveColor: (wall: Wall) => string;
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
  maxWidth = "max-w-4xl",
  onCellClick,
  onWallClick,
  onPawnRightClick,
  onWallRightClick,
  catPawnPath,
  mousePawnPath,
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
  const cellSize = `calc((100% - ${cols - 1} * ${gapSize}rem) / ${cols})`;
  const gapValue = `${gapSize}rem`;

  const wallMaps = useMemo(() => buildWallMaps(walls), [walls]);
  const pillars = useMemo(
    () =>
      createPillarElements({
        rows,
        cols,
        cellSize,
        gapValue,
        wallMaps,
        resolveColor: getWallColor,
      }),
    [rows, cols, cellSize, gapValue, wallMaps]
  );

  // Get pawns for a cell
  const getPawnsForCell = (row: number, col: number): Pawn[] => {
    return pawns.filter(p => p.cell.row === row && p.cell.col === col);
  };

  // Render last move arrow (subtle)
  const renderLastMoveArrow = () => {
    if (!lastMove) return null;

    const cellWidthPercent = 100 / cols;
    const cellHeightPercent = 100 / rows;

    const fromX = (lastMove.fromCol + 0.5) * cellWidthPercent;
    const toX = (lastMove.toCol + 0.5) * cellWidthPercent;
    const fromY = (lastMove.fromRow + 0.5) * cellHeightPercent;
    const toY = (lastMove.toRow + 0.5) * cellHeightPercent;

    // Calculate direction vector
    const dx = toX - fromX;
    const dy = toY - fromY;
    const length = Math.sqrt(dx * dx + dy * dy);

    // Shorten the line to prevent shaft showing through arrowhead
    // Arrowhead is about 0.8% of the viewBox (smaller now), so shorten by that amount
    const shortenAmount = 3;
    const shortenRatio = (length - shortenAmount) / length;
    const adjustedToX = fromX + dx * shortenRatio;
    const adjustedToY = fromY + dy * shortenRatio;

    // Get arrow color from player color, or use default gray
    const arrowColor = lastMove.playerColor
      ? colorMap[lastMove.playerColor] || "#94a3b8"
      : "#94a3b8";
    const strokeWidth = 1.1;
    const opacity = 0.3; // More subtle than calculated arrows

    return (
      <svg
        key="last-move-arrow"
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 3, opacity }} // <- only here
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <defs>
          <marker id="arrowhead-last-move" refX="2" refY="1.5" orient="auto">
            <polygon
              points="0 0, 3 1.5, 0 3"
              fill={arrowColor} // <- opaque color, e.g. "#f97316"
            />
          </marker>
        </defs>
        <line
          x1={fromX}
          y1={fromY}
          x2={adjustedToX}
          y2={adjustedToY}
          stroke={arrowColor} // <- same opaque color
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          markerEnd="url(#arrowhead-last-move)"
        />
      </svg>
    );
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
    const cellWidthPercent = 100 / cols;
    const cellHeightPercent = 100 / rows;

    const fromX = (arrow.from.col + 0.5) * cellWidthPercent;
    const toX = (arrow.to.col + 0.5) * cellWidthPercent;
    const fromY = (arrow.from.row + 0.5) * cellHeightPercent;
    const toY = (arrow.to.row + 0.5) * cellHeightPercent;

    const arrowColor = getArrowColor(arrow);
    const strokeWidth = arrow.type === "calculated" ? 1.5 : 2.5;
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
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="3"
            orient="auto"
          >
            <polygon
              points="0 0, 10 3, 0 6"
              fill={arrowColor}
              opacity={opacity}
            />
          </marker>
        </defs>
        <line
          x1={fromX}
          y1={fromY}
          x2={toX}
          y2={toY}
          stroke={arrowColor}
          strokeWidth={strokeWidth}
          opacity={opacity}
          strokeDasharray={dashArray}
          markerEnd={`url(#arrowhead-${arrow.type}-${index})`}
        />
      </svg>
    );
  };

  return (
    <div className={`w-full ${className}`}>
      <div className={`rounded-lg p-4 bg-amber-100 w-full ${maxWidth} mx-auto`}>
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
                style={{ height: cellSize }}
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
                style={{ height: cellSize }}
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
                  onClick={() =>
                    onWallClick?.(rowIndex, colIndex, "vertical")
                  }
                />
              ))
            )}

            {/* Render arrows */}
            {arrows.map((arrow, index) => renderArrow(arrow, index))}
            {/* Render last move arrow */}
            {renderLastMoveArrow()}

            {/* Render walls */}
            {walls.map((wall, index) => {
              const [row1, col1, row2, col2] = normalizeWall(wall);
              const isHorizontal = row1 === row2;
              const wallColor = getWallColor(wall);

              let style: CSSProperties = {
                position: "absolute",
                backgroundColor: wallColor,
                zIndex:
                  wall.state === "placed"
                    ? 10
                    : wall.state === "staged" || wall.state === "premoved"
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
                  opacity: wall.state === "calculated" ? 0.5 : 1,
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
                  opacity: wall.state === "calculated" ? 0.5 : 1,
                };
              }

              const borderStyle =
                wall.state === "staged" || wall.state === "premoved"
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
                  >
                    {/* Pawns */}
                    {cellPawns.length > 0 && (
                      <div className="w-full h-full flex items-center justify-center p-1">
                        {cellPawns.length === 1 ? (
                          (() => {
                            const pawn = cellPawns[0];
                            
                            // Custom Cat Pawn Logic - use pawn's own style only
                            const customCatPath = pawn.type !== "rat" && pawn.pawnStyle 
                              ? `/pawns/cat/${pawn.pawnStyle}`
                              : null;
                            
                            if (customCatPath) {
                                return (
                                  <div 
                                    className="w-full h-full transform hover:scale-110 transition-transform cursor-pointer relative p-0.5"
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onPawnRightClick?.(
                                        rowIndex,
                                        colIndex,
                                        pawn.id
                                      );
                                    }}
                                  >
                                    <img 
                                      src={customCatPath} 
                                      alt="pawn" 
                                      className="w-full h-full object-contain drop-shadow-md"
                                      style={colorFilterMap[pawn.color] ? { filter: colorFilterMap[pawn.color] } : undefined}
                                    />
                                  </div>
                                );
                            }
                            
                            // Custom Mouse Pawn Logic - use pawn's own style only
                            const customMousePath = pawn.type === "rat" && pawn.pawnStyle
                              ? `/pawns/mouse/${pawn.pawnStyle}`
                              : null;
                            
                            if (customMousePath) {
                                return (
                                  <div 
                                    className="w-full h-full transform hover:scale-110 transition-transform cursor-pointer relative p-0.5"
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onPawnRightClick?.(
                                        rowIndex,
                                        colIndex,
                                        pawn.id
                                      );
                                    }}
                                  >
                                    <img 
                                      src={customMousePath} 
                                      alt="pawn" 
                                      className="w-full h-full object-contain drop-shadow-md"
                                      style={colorFilterMap[pawn.color] ? { filter: colorFilterMap[pawn.color] } : undefined}
                                    />
                                  </div>
                                );
                            }

                            const Icon = pawn.type === "rat" ? Rat : Cat;
                            return (
                              <Icon
                                size={36}
                                strokeWidth={2.5}
                                className={`${
                                  colorClassMap[pawn.color] || "text-red-600"
                                } w-full h-full transform hover:scale-110 transition-transform cursor-pointer`}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  onPawnRightClick?.(
                                    rowIndex,
                                    colIndex,
                                    pawn.id
                                  );
                                }}
                              />
                            );
                          })()
                        ) : (
                          <div className="flex flex-wrap items-center justify-center gap-0.5">
                            {cellPawns.map((pawn) => {
                              // Check if we should render a custom image for cat
                              const customCatPath = pawn.type !== "rat" && pawn.pawnStyle
                                ? `/pawns/cat/${pawn.pawnStyle}`
                                : null;
                              
                              if (customCatPath) {
                                return (
                                  <div
                                    key={pawn.id}
                                    className="w-6 h-6 transform hover:scale-110 transition-transform cursor-pointer relative"
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onPawnRightClick?.(
                                        rowIndex,
                                        colIndex,
                                        pawn.id
                                      );
                                    }}
                                  >
                                    <img 
                                      src={customCatPath} 
                                      alt="pawn" 
                                      className="w-full h-full object-contain"
                                      style={colorFilterMap[pawn.color] ? { filter: colorFilterMap[pawn.color] } : undefined}
                                    />
                                  </div>
                                );
                              }

                              // Check if we should render a custom image for mouse
                              const customMousePath = pawn.type === "rat" && pawn.pawnStyle
                                ? `/pawns/mouse/${pawn.pawnStyle}`
                                : null;
                              
                              if (customMousePath) {
                                return (
                                  <div
                                    key={pawn.id}
                                    className="w-6 h-6 transform hover:scale-110 transition-transform cursor-pointer relative"
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onPawnRightClick?.(
                                        rowIndex,
                                        colIndex,
                                        pawn.id
                                      );
                                    }}
                                  >
                                    <img 
                                      src={customMousePath} 
                                      alt="pawn" 
                                      className="w-full h-full object-contain"
                                      style={colorFilterMap[pawn.color] ? { filter: colorFilterMap[pawn.color] } : undefined}
                                    />
                                  </div>
                                );
                              }

                              const Icon = pawn.type === "rat" ? Rat : Cat;
                              return (
                                <Icon
                                  key={pawn.id}
                                  size={24}
                                  strokeWidth={2.5}
                                  className={`${
                                    colorClassMap[pawn.color] || "text-red-600"
                                  } transform hover:scale-110 transition-transform cursor-pointer`}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onPawnRightClick?.(
                                      rowIndex,
                                      colIndex,
                                      pawn.id
                                    );
                                  }}
                                />
                              );
                            })}
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
