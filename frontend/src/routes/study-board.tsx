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
  type Pawn,
  type Wall,
  type PlayerColor,
  type PawnType,
  type WallState,
} from "@/components/board";

export const Route = createFileRoute("/study-board")({
  component: StudyBoard,
});

function StudyBoard() {
  // Board dimensions
  const [rows, setRows] = useState(10);
  const [cols, setCols] = useState(10);

  // Board state
  const [pawns, setPawns] = useState<Map<string, Pawn[]>>(new Map());
  const [walls, setWalls] = useState<Wall[]>([]);

  // Selected properties for adding new elements
  const [selectedPawnColor, setSelectedPawnColor] =
    useState<PlayerColor>("red");
  const [selectedPawnType, setSelectedPawnType] = useState<PawnType>("cat");
  const [selectedWallColor, setSelectedWallColor] =
    useState<PlayerColor>("red");
  const [selectedWallState, setSelectedWallState] =
    useState<WallState>("placed");

  // Handle cell clicks to add/remove pawns
  const handleCellClick = useCallback(
    (row: number, col: number) => {
      const key = `${row}-${col}`;
      setPawns((prev) => {
        const newPawns = new Map(prev);
        const existingPawns = newPawns.get(key) || [];

        // If there are pawns in this cell, remove the top one
        if (existingPawns.length > 0) {
          const updatedPawns = existingPawns.slice(0, -1);
          if (updatedPawns.length === 0) {
            newPawns.delete(key);
          } else {
            newPawns.set(key, updatedPawns);
          }
        } else {
          // Add a new pawn
          const newPawn: Pawn = {
            id: `${row}-${col}-${Date.now()}`,
            color: selectedPawnColor,
            type: selectedPawnType,
          };
          newPawns.set(key, [newPawn]);
        }

        return newPawns;
      });
    },
    [selectedPawnColor, selectedPawnType]
  );

  // Handle wall clicks to add/remove walls
  const handleWallClick = useCallback(
    (row: number, col: number, orientation: "horizontal" | "vertical") => {
      setWalls((prev) => {
        // Check if wall already exists at this position
        const existingWallIndex = prev.findIndex((wall) => {
          if (orientation === "horizontal") {
            return (
              wall.row1 === wall.row2 &&
              wall.row1 === row &&
              Math.min(wall.col1, wall.col2) === Math.min(col, col + 1)
            );
          } else {
            return (
              wall.col1 === wall.col2 &&
              wall.col1 === col &&
              Math.min(wall.row1, wall.row2) === Math.min(row, row + 1)
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
              row1: row,
              col1: col,
              row2: row,
              col2: col + 1,
              state: selectedWallState,
              playerColor: selectedWallColor,
            };
          } else {
            newWall = {
              row1: row,
              col1: col,
              row2: row + 1,
              col2: col,
              state: selectedWallState,
              playerColor: selectedWallColor,
            };
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
        const newPawns = new Map(prev);
        const key = `${row}-${col}`;
        const existingPawns = newPawns.get(key) || [];

        const updatedPawns = existingPawns.map((pawn) =>
          pawn.id === pawnId ? { ...pawn, color: selectedPawnColor } : pawn
        );

        newPawns.set(key, updatedPawns);
        return newPawns;
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
            ? { ...wall, playerColor: selectedWallColor }
            : wall
        )
      );
    },
    [selectedWallColor]
  );

  const clearBoard = useCallback(() => {
    setPawns(new Map());
    setWalls([]);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <div className="w-full mx-auto py-8 px-4">
        <h1 className="text-4xl font-bold mb-8 text-foreground text-balance">
          Study Board
        </h1>

        <div className="space-y-6">
          {/* Controls */}
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4">Board Configuration</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Board Dimensions */}
              <div className="space-y-2">
                <Label htmlFor="rows">Rows</Label>
                <Select
                  value={rows.toString()}
                  onValueChange={(value) => setRows(parseInt(value))}
                >
                  <SelectTrigger>
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

              <div className="space-y-2">
                <Label htmlFor="cols">Columns</Label>
                <Select
                  value={cols.toString()}
                  onValueChange={(value) => setCols(parseInt(value))}
                >
                  <SelectTrigger>
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

              {/* Pawn Properties */}
              <div className="space-y-2">
                <Label htmlFor="pawn-color">Pawn Color</Label>
                <Select
                  value={selectedPawnColor}
                  onValueChange={(value) =>
                    setSelectedPawnColor(value as PlayerColor)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="red">Red</SelectItem>
                    <SelectItem value="blue">Blue</SelectItem>
                    <SelectItem value="green">Green</SelectItem>
                    <SelectItem value="purple">Purple</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pawn-type">Pawn Type</Label>
                <Select
                  value={selectedPawnType}
                  onValueChange={(value) =>
                    setSelectedPawnType(value as PawnType)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cat">Cat</SelectItem>
                    <SelectItem value="rat">Rat</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Wall Properties */}
              <div className="space-y-2">
                <Label htmlFor="wall-color">Wall Color</Label>
                <Select
                  value={selectedWallColor}
                  onValueChange={(value) =>
                    setSelectedWallColor(value as PlayerColor)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="red">Red</SelectItem>
                    <SelectItem value="blue">Blue</SelectItem>
                    <SelectItem value="green">Green</SelectItem>
                    <SelectItem value="purple">Purple</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="wall-state">Wall State</Label>
                <Select
                  value={selectedWallState}
                  onValueChange={(value) =>
                    setSelectedWallState(value as WallState)
                  }
                >
                  <SelectTrigger>
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

              {/* Clear Board */}
              <div className="flex items-end">
                <Button
                  onClick={clearBoard}
                  variant="destructive"
                  className="w-full"
                >
                  Clear Board
                </Button>
              </div>
            </div>

            <div className="mt-4 text-sm text-muted-foreground">
              <p>• Click on cells to add/remove pawns</p>
              <p>• Click between cells to add/remove walls</p>
              <p>• Right-click on pawns to change their color</p>
              <p>• Right-click on walls to change their color</p>
            </div>
          </Card>

          {/* Board */}
          <Card className="p-6">
            <div className="flex justify-center">
              <Board
                rows={rows}
                cols={cols}
                pawns={pawns}
                walls={walls}
                maxWidth="max-w-3xl"
                onCellClick={handleCellClick}
                onWallClick={handleWallClick}
                onPawnRightClick={handlePawnRightClick}
                onWallRightClick={handleWallRightClick}
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
