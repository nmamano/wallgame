import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pause, Play } from "lucide-react";
import { Board, type Pawn, type Wall, type Arrow } from "@/components/board";

export function GameShowcase() {
  const [isPlaying, setIsPlaying] = useState(true);

  // Mock game position: 2 players (red and blue), each with a cat and a rat
  const pawns = new Map<string, Pawn[]>([
    // Red player pieces
    ["2-3", [{ id: "red-cat", color: "red", type: "cat" }]], // Red cat
    ["4-5", [{ id: "red-rat", color: "red", type: "rat" }]], // Red rat

    // Blue player pieces
    ["7-6", [{ id: "blue-cat", color: "blue", type: "cat" }]], // Blue cat
    ["5-7", [{ id: "blue-rat", color: "blue", type: "rat" }]], // Blue rat
  ]);

  // Placed walls from both players (including adjacent walls)
  const walls: Wall[] = [
    // Red player walls
    { row1: 1, col1: 2, row2: 1, col2: 3, state: "placed", playerColor: "red" }, // Vertical wall
    { row1: 1, col1: 3, row2: 1, col2: 4, state: "placed", playerColor: "red" }, // Adjacent vertical wall
    { row1: 2, col1: 3, row2: 3, col2: 3, state: "placed", playerColor: "red" }, // Horizontal wall
    { row1: 3, col1: 4, row2: 4, col2: 4, state: "placed", playerColor: "red" }, // Horizontal wall
    { row1: 2, col1: 5, row2: 2, col2: 6, state: "placed", playerColor: "red" }, // Vertical wall
    { row1: 3, col1: 5, row2: 3, col2: 6, state: "placed", playerColor: "red" }, // Adjacent vertical wall
    { row1: 4, col1: 4, row2: 5, col2: 4, state: "placed", playerColor: "red" }, // Horizontal wall

    // Blue player walls
    {
      row1: 6,
      col1: 5,
      row2: 7,
      col2: 5,
      state: "placed",
      playerColor: "blue",
    }, // Horizontal wall
    {
      row1: 6,
      col1: 6,
      row2: 7,
      col2: 6,
      state: "placed",
      playerColor: "blue",
    }, // Adjacent horizontal wall
    {
      row1: 5,
      col1: 6,
      row2: 6,
      col2: 6,
      state: "placed",
      playerColor: "blue",
    }, // Horizontal wall
    {
      row1: 7,
      col1: 6,
      row2: 7,
      col2: 7,
      state: "placed",
      playerColor: "blue",
    }, // Vertical wall
    {
      row1: 7,
      col1: 7,
      row2: 7,
      col2: 8,
      state: "placed",
      playerColor: "blue",
    }, // Adjacent vertical wall
    {
      row1: 6,
      col1: 7,
      row2: 7,
      col2: 7,
      state: "placed",
      playerColor: "blue",
    }, // Horizontal wall
  ];

  // No arrows
  const arrows: Arrow[] = [];

  // Last move: red rat moved
  const lastMove = {
    fromRow: 1,
    fromCol: 2,
    toRow: 2,
    toCol: 3,
    playerColor: "red" as const,
  };

  return (
    <Card className="relative overflow-hidden bg-card border-2 border-border transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-2 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-medium text-muted-foreground">
            Game showcase:{" "}
            <span className="text-foreground">Magnus (1843)</span> vs{" "}
            <span className="text-foreground">Hikaru (1821)</span>{" "}
            <span className="text-muted-foreground">(Oct 2024)</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setIsPlaying(!isPlaying);
            }}
          >
            {isPlaying ? (
              <>
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Play
              </>
            )}
          </Button>
        </div>

        {/* Game Board */}
        <div className="w-full">
          <Board
            rows={10}
            cols={10}
            pawns={pawns}
            walls={walls}
            arrows={arrows}
            lastMove={lastMove}
          />
        </div>
      </div>
    </Card>
  );
}
