"use client";

import type React from "react";
import { Cat, Rat } from "lucide-react";

// Types
export type PlayerColor = "red" | "blue" | "green" | "purple" | string;

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
  type?: PawnType; // Optional, defaults to "cat"
}

export interface Wall {
  row1: number;
  col1: number;
  row2: number;
  col2: number;
  state: WallState;
  playerColor?: PlayerColor;
}

export interface Arrow {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
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
  pawns?: Map<string, Pawn[]>; // Key: "row-col", Value: array of pawns
  walls?: Wall[];
  arrows?: Arrow[];
  lastMove?: LastMove;
}

const colorMap: Record<string, string> = {
  red: "#dc2626",
  blue: "#2563eb",
  green: "#16a34a",
  purple: "#9333ea",
};

// Color class mapping for Cat icons
const colorClassMap: Record<string, string> = {
  red: "text-red-600",
  blue: "text-blue-600",
  green: "text-green-600",
  purple: "text-purple-600",
};

export function Board({
  rows = 10,
  cols = 10,
  pawns = new Map(),
  walls = [],
  arrows = [],
  lastMove,
}: BoardProps) {
  // Create grid array
  const grid = Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: cols }, (_, colIndex) => ({
      row: rowIndex,
      col: colIndex,
    }))
  );

  // Calculate cell size for positioning walls (dynamic based on grid size)
  const gapSize = 0.25; // rem
  const cellSize = `calc((100% - ${cols - 1} * ${gapSize}rem) / ${cols})`;

  // Get pawns for a cell
  const getPawnsForCell = (row: number, col: number): Pawn[] => {
    const key = `${row}-${col}`;
    return pawns.get(key) || [];
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

  // Get arrows for a cell (arrows starting from this cell)
  const getArrowsFromCell = (row: number, col: number): Arrow[] => {
    return arrows.filter(
      (arrow) => arrow.fromRow === row && arrow.fromCol === col
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

  // Get wall color based on state and player color
  const getWallColor = (wall: Wall): string => {
    if (wall.state === "placed" && wall.playerColor) {
      return colorMap[wall.playerColor] || "#dc2626";
    }
    if (wall.state === "staged") return "#fbbf24"; // Yellow/amber for staged
    if (wall.state === "premoved") return "#60a5fa"; // Light blue for premoved
    if (wall.state === "calculated") return "#94a3b8"; // Gray for calculated
    return "transparent";
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

    const fromX = (arrow.fromCol + 0.5) * cellWidthPercent;
    const toX = (arrow.toCol + 0.5) * cellWidthPercent;
    const fromY = (arrow.fromRow + 0.5) * cellHeightPercent;
    const toY = (arrow.toRow + 0.5) * cellHeightPercent;

    const arrowColor = getArrowColor(arrow);
    const strokeWidth = arrow.type === "calculated" ? 1.5 : 2.5;
    const opacity = arrow.type === "calculated" ? 0.5 : 0.8;
    const dashArray = arrow.type === "calculated" ? "4,2" : "none";

    return (
      <svg
        key={`arrow-${arrow.fromRow}-${arrow.fromCol}-${arrow.toRow}-${arrow.toCol}-${index}`}
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
    <div className="p-8">
      <div className="rounded-lg p-4 bg-amber-100 w-full max-w-4xl mx-auto">
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
            className="grid gap-1 w-full relative"
            style={{
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
            }}
          >
            {/* Render arrows */}
            {arrows.map((arrow, index) => renderArrow(arrow, index))}
            {/* Render last move arrow */}
            {renderLastMoveArrow()}

            {/* Render walls */}
            {walls.map((wall, index) => {
              const [row1, col1, row2, col2] = normalizeWall(wall);
              const isHorizontal = row1 === row2;
              const wallColor = getWallColor(wall);

              let style: React.CSSProperties = {
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

                // 🔴 NEW: true center of the gap between col minCol and minCol + 1
                const wallCenterX = `calc((${minCol + 1} * (${cellSize} + ${gapSize}rem)) - ${gapSize}rem / 2)`;

                style = {
                  ...style,
                  height: cellSize, // spans one cell vertically
                  width: "0.5rem",
                  top: `calc(${row1} * (${cellSize} + ${gapSize}rem))`,
                  left: wallCenterX,
                  transform: "translateX(-50%)",
                  opacity: wall.state === "calculated" ? 0.5 : 1,
                };
              } else {
                // Horizontal wall (between cells in same column, separating rows)
                const minRow = Math.min(row1, row2);

                // 🔴 NEW: true center of the gap between row minRow and minRow + 1
                const wallCenterY = `calc((${minRow + 1} * (${cellSize} + ${gapSize}rem)) - ${gapSize}rem / 2)`;

                style = {
                  ...style,
                  width: cellSize, // spans one cell horizontally
                  height: "0.5rem",
                  left: `calc(${col1} * (${cellSize} + ${gapSize}rem))`,
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
                  className={`shadow-md rounded-full ${borderStyle}`}
                />
              );
            })}

            {/* Render cells */}
            {grid.map((row, rowIndex) =>
              row.map(({ col: colIndex }) => {
                const cellPawns = getPawnsForCell(rowIndex, colIndex);
                const isLight = (rowIndex + colIndex) % 2 === 0;

                return (
                  <div
                    key={`${rowIndex}-${colIndex}`}
                    className={`aspect-square border border-amber-400 flex items-center justify-center relative ${
                      isLight ? "bg-amber-200" : "bg-amber-100"
                    }`}
                  >
                    {/* Pawns */}
                    {cellPawns.length > 0 && (
                      <div className="w-full h-full flex items-center justify-center p-1">
                        {cellPawns.length === 1 ? (
                          (() => {
                            const pawn = cellPawns[0];
                            const Icon = pawn.type === "rat" ? Rat : Cat;
                            return (
                              <Icon
                                size={36}
                                strokeWidth={2.5}
                                className={`${
                                  colorClassMap[pawn.color] || "text-red-600"
                                } w-full h-full transform hover:scale-110 transition-transform`}
                              />
                            );
                          })()
                        ) : (
                          <div className="flex flex-wrap items-center justify-center gap-0.5">
                            {cellPawns.map((pawn) => {
                              const Icon = pawn.type === "rat" ? Rat : Cat;
                              return (
                                <Icon
                                  key={pawn.id}
                                  size={24}
                                  strokeWidth={2.5}
                                  className={`${
                                    colorClassMap[pawn.color] || "text-red-600"
                                  } transform hover:scale-110 transition-transform`}
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
