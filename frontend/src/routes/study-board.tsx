import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Board,
} from "@/components/board";
import { Cell, Wall, type Pawn, type PawnType, type WallState } from "@/lib/game";
import { PawnSelector } from "@/components/pawn-selector";
import { CAT_PAWNS } from "@/lib/cat-pawns";
import { MOUSE_PAWNS } from "@/lib/mouse-pawns";
import { PLAYER_COLORS, colorDisplayNames, colorHexMap, type PlayerColor } from "@/lib/player-colors";

export const Route = createFileRoute("/study-board")({
  component: StudyBoard,
});

function StudyBoard() {
  // Board dimensions
  const [rows, setRows] = useState(10);
  const [cols, setCols] = useState(10);

  // Board state
  const [pawns, setPawns] = useState<Pawn[]>([]);
  const [walls, setWalls] = useState<Wall[]>([]);

  // Selected properties for adding new elements
  const [selectedPawnColor, setSelectedPawnColor] =
    useState<PlayerColor>("red");
  const [selectedPawnType, setSelectedPawnType] = useState<PawnType>("cat");
  const [selectedWallColor, setSelectedWallColor] =
    useState<PlayerColor>("red");
  const [selectedWallState, setSelectedWallState] =
    useState<WallState>("placed");
  
  // Cat pawn selection
  const [catPawn, setCatPawn] = useState<string>("default");
  // Mouse pawn selection
  const [mousePawn, setMousePawn] = useState<string>("default");

  // Handle cell clicks to add/remove pawns
  const handleCellClick = useCallback(
    (row: number, col: number) => {
      setPawns((prev) => {
        // Find pawns at this cell
        const pawnsAtCell = prev.filter(p => p.cell.row === row && p.cell.col === col);

        // If there are pawns in this cell, remove the last one added (LIFOish for UI feel)
        if (pawnsAtCell.length > 0) {
          const pawnToRemove = pawnsAtCell[pawnsAtCell.length - 1];
          return prev.filter(p => p.id !== pawnToRemove.id);
        } else {
          // Add a new pawn
          const newPawn: Pawn = {
            id: `${row}-${col}-${Date.now()}`,
            color: selectedPawnColor,
            type: selectedPawnType,
            cell: new Cell(row, col),
            pawnStyle: selectedPawnType === "cat" 
              ? (catPawn !== "default" ? catPawn : undefined)
              : (mousePawn !== "default" ? mousePawn : undefined),
          };
          return [...prev, newPawn];
        }
      });
    },
    [selectedPawnColor, selectedPawnType, catPawn, mousePawn]
  );

  // Handle wall clicks to add/remove walls
  const handleWallClick = useCallback(
    (row: number, col: number, orientation: "horizontal" | "vertical") => {
      setWalls((prev) => {
        // Check if wall already exists at this position
        const existingWallIndex = prev.findIndex((wall) => {
          if (orientation === "horizontal") {
            // Horizontal wall separates rows: (row-1, col) and (row, col)
            return (
              wall.col1 === wall.col2 &&
              wall.col1 === col &&
              Math.min(wall.row1, wall.row2) === Math.min(row - 1, row)
            );
          } else {
            // Vertical wall separates columns: (row, col) and (row, col+1)
            return (
              wall.row1 === wall.row2 &&
              wall.row1 === row &&
              Math.min(wall.col1, wall.col2) === Math.min(col, col + 1)
            );
          }
        });

        if (existingWallIndex !== -1) {
          // Remove existing wall
          return prev.filter((_, index) => index !== existingWallIndex);
        } else {
          // Add new wall
          let newWall: Wall;
          if (orientation === "horizontal") {
            newWall = {
              row1: row - 1,
              col1: col,
              row2: row,
              col2: col,
              state: selectedWallState,
              playerColor: selectedWallColor,
            } as Wall;
          } else {
            newWall = {
              row1: row,
              col1: col,
              row2: row,
              col2: col + 1,
              state: selectedWallState,
              playerColor: selectedWallColor,
            } as Wall;
          }
          return [...prev, newWall];
        }
      });
    },
    [selectedWallColor, selectedWallState]
  );

  // Handle right-click on pawn to change color
  const handlePawnRightClick = useCallback(
    (row: number, col: number, pawnId: string) => {
      setPawns((prev) => {
        return prev.map((pawn) =>
          pawn.id === pawnId ? { ...pawn, color: selectedPawnColor } : pawn
        );
      });
    },
    [selectedPawnColor]
  );

  // Handle right-click on wall to change color
  const handleWallRightClick = useCallback(
    (wallIndex: number) => {
      setWalls((prev) =>
        prev.map((wall, index) =>
          index === wallIndex
            ? { ...wall, playerColor: selectedWallColor } as Wall
            : wall
        )
      );
    },
    [selectedWallColor]
  );

  const clearBoard = useCallback(() => {
    setPawns([]);
    setWalls([]);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4">
        <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-8 text-balance">
          Study Board
        </h1>

        <div className="flex flex-col lg:flex-row gap-6 items-start">
          {/* Controls */}
          <Card className="p-4 lg:w-72 shrink-0 space-y-4">
            <h2 className="text-lg font-semibold">Configuration</h2>

            <div className="space-y-4">
              {/* Board Dimensions */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Dimensions
                </Label>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="rows" className="text-xs">
                      Rows
                    </Label>
                    <Select
                      value={rows.toString()}
                      onValueChange={(value) => {
                        const newRows = parseInt(value);
                        setRows(newRows);
                        setPawns((prev) =>
                          prev.filter((p) => p.cell.row < newRows)
                        );
                        setWalls((prev) =>
                          prev.filter(
                            (w) => w.row1 < newRows && w.row2 < newRows
                          )
                        );
                      }}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((num) => (
                          <SelectItem key={num} value={num.toString()}>
                            {num}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="cols" className="text-xs">
                      Cols
                    </Label>
                    <Select
                      value={cols.toString()}
                      onValueChange={(value) => {
                        const newCols = parseInt(value);
                        setCols(newCols);
                        setPawns((prev) =>
                          prev.filter((p) => p.cell.col < newCols)
                        );
                        setWalls((prev) =>
                          prev.filter(
                            (w) => w.col1 < newCols && w.col2 < newCols
                          )
                        );
                      }}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((num) => (
                          <SelectItem key={num} value={num.toString()}>
                            {num}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Pawn Properties */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Pawn
                </Label>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="pawn-color" className="text-xs">
                      Color
                    </Label>
                    <Select
                      value={selectedPawnColor}
                      onValueChange={(value) =>
                        setSelectedPawnColor(value as PlayerColor)
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLAYER_COLORS.map((color) => (
                          <SelectItem key={color} value={color}>
                            <div className="flex items-center gap-2">
                              <div
                                className="w-4 h-4 rounded-full border border-gray-300"
                                style={{ backgroundColor: colorHexMap[color] }}
                              />
                              <span>{colorDisplayNames[color]}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="pawn-type" className="text-xs">
                      Type
                    </Label>
                    <Select
                      value={selectedPawnType}
                      onValueChange={(value) =>
                        setSelectedPawnType(value as PawnType)
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cat">Cat</SelectItem>
                        <SelectItem value="mouse">Mouse</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Cat Pawn Selection */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Cat Pawn Style
                </Label>
                <PawnSelector
                  value={catPawn}
                  onChange={setCatPawn}
                  pawns={CAT_PAWNS}
                  basePath="/pawns/cat/"
                  label="Cat Pawn"
                  defaultLabel="Default Cat"
                  color={selectedPawnColor}
                />
              </div>

              {/* Mouse Pawn Selection */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Mouse Pawn Style
                </Label>
                <PawnSelector
                  value={mousePawn}
                  onChange={setMousePawn}
                  pawns={MOUSE_PAWNS}
                  basePath="/pawns/mouse/"
                  label="Mouse Pawn"
                  defaultLabel="Default Mouse"
                  color={selectedPawnColor}
                />
              </div>

              {/* Wall Properties */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Wall
                </Label>
                <div className="grid grid-cols-1 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="wall-color" className="text-xs">
                      Color
                    </Label>
                    <Select
                      value={selectedWallColor}
                      onValueChange={(value) =>
                        setSelectedWallColor(value as PlayerColor)
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLAYER_COLORS.map((color) => (
                          <SelectItem key={color} value={color}>
                            <div className="flex items-center gap-2">
                              <div
                                className="w-4 h-4 rounded-full border border-gray-300"
                                style={{ backgroundColor: colorHexMap[color] }}
                              />
                              <span>{colorDisplayNames[color]}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="wall-state" className="text-xs">
                      State
                    </Label>
                    <Select
                      value={selectedWallState}
                      onValueChange={(value) =>
                        setSelectedWallState(value as WallState)
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="placed">Placed</SelectItem>
                        <SelectItem value="staged">Staged</SelectItem>
                        <SelectItem value="premoved">Premoved</SelectItem>
                        <SelectItem value="calculated">Calculated</SelectItem>
                        <SelectItem value="missing">Missing</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Clear Board */}
              <Button
                onClick={clearBoard}
                variant="destructive"
                className="w-full h-8 text-xs"
              >
                Clear Board
              </Button>
            </div>

            <div className="pt-4 border-t text-xs text-muted-foreground space-y-1">
              <p>• Click cells to add/remove pawns</p>
              <p>• Click between cells for walls</p>
              <p>• Right-click to change color</p>
            </div>
          </Card>

          {/* Board */}
            <Board
              rows={rows}
              cols={cols}
              pawns={pawns}
              walls={walls}
              maxWidth="max-w-2xl"
              className="p-2"
              onCellClick={handleCellClick}
              onWallClick={handleWallClick}
              onPawnRightClick={handlePawnRightClick}
              onWallRightClick={handleWallRightClick}
              catPawnPath={catPawn !== "default" ? `/pawns/cat/${catPawn}` : undefined}
              mousePawnPath={mousePawn !== "default" ? `/pawns/mouse/${mousePawn}` : undefined}
            />
        </div>
      </div>
    </div>
  );
}
