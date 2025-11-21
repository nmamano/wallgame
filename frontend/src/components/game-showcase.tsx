import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pause, Play } from "lucide-react";
import { Board, type Pawn, type Arrow } from "@/components/board";
import { Wall, createCell, createWall } from "@/lib/game";

export function GameShowcase() {
  const [isPlaying, setIsPlaying] = useState(true);

  // Mock game position: 2 players (red and blue), each with a cat and a rat
  const pawns: Pawn[] = [
    // Red player pieces
    { id: "red-cat", color: "red", type: "cat", cell: createCell("d8", 10) },
    { id: "red-rat", color: "red", type: "rat", cell: createCell("f6", 10) },

    // Blue player pieces
    { id: "blue-cat", color: "blue", type: "cat", cell: createCell("g3", 10) },
    { id: "blue-rat", color: "blue", type: "rat", cell: createCell("h5", 10) },
  ];

  // Placed walls from both players (including adjacent walls)
  const walls: Wall[] = [
    // Red player walls
    createWall(">c9", 10, "red"),
    createWall(">c10", 10, "red"),
    createWall(">d9", 10, "red"),
    createWall("^d7", 10, "red"),
    createWall("^e6", 10, "red"),
    createWall(">f8", 10, "red"),
    createWall(">f7", 10, "red"),
    createWall("^e5", 10, "red"),

    createWall(">b10", 10, "red"),
    createWall("^b9", 10, "blue"),

    createWall(">b7", 10, "red"),
    createWall("^b7", 10, "blue"),

    createWall(">b5", 10, "blue"),
    createWall("^b5", 10, "red"),

    createWall(">b3", 10, "blue"),
    createWall("^c3", 10, "red"),

    createWall(">b1", 10, "blue"),
    createWall(">c3", 10, "blue"),
    createWall("^c2", 10, "red"),

    // Blue player walls
    createWall("^f3", 10, "blue"),
    createWall("^g3", 10, "blue"),
    createWall("^g4", 10, "blue"),
    createWall(">g3", 10, "blue"),
    createWall(">h3", 10, "blue"),
    createWall("^h3", 10, "blue"),
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
