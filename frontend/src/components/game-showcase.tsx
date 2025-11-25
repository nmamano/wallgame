import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pause, Play } from "lucide-react";
import { Board, type Arrow } from "@/components/board";
import type { WallPosition, Pawn } from "../../../shared/game-types";

type WallPositionWithState = WallPosition & {
  state?: "placed" | "staged" | "premoved" | "calculated" | "missing";
};
import {
  cellFromStandardNotation,
  playerWallFromStandardNotation,
} from "../../../shared/standard-notation";

export function GameShowcase() {
  const [isPlaying, setIsPlaying] = useState(true);

  // Mock game position: 2 players (red and blue), each with a cat and a rat
  const pawns: Pawn[] = [
    // Red player pieces (Player 1)
    {
      playerId: 1,
      type: "cat",
      cell: cellFromStandardNotation("d8", 10),
    },
    {
      playerId: 1,
      type: "mouse",
      cell: cellFromStandardNotation("f6", 10),
    },

    // Blue player pieces (Player 2)
    {
      playerId: 2,
      type: "cat",
      cell: cellFromStandardNotation("g3", 10),
    },
    {
      playerId: 2,
      type: "mouse",
      cell: cellFromStandardNotation("h5", 10),
    },
  ];

  // Placed walls from both players (including adjacent walls)
  const walls: WallPositionWithState[] = [
    // Red player walls (Player 1)
    playerWallFromStandardNotation(">c9", 10, 1),
    playerWallFromStandardNotation(">c10", 10, 1),
    playerWallFromStandardNotation(">d9", 10, 1),
    playerWallFromStandardNotation("^d7", 10, 1),
    playerWallFromStandardNotation("^e6", 10, 1),
    playerWallFromStandardNotation(">f8", 10, 1),
    playerWallFromStandardNotation(">f7", 10, 1),
    playerWallFromStandardNotation("^e5", 10, 1),

    playerWallFromStandardNotation(">b10", 10, 1),
    playerWallFromStandardNotation("^b9", 10, 2),

    playerWallFromStandardNotation(">b7", 10, 1),
    playerWallFromStandardNotation("^b7", 10, 2),

    playerWallFromStandardNotation(">b5", 10, 2),
    playerWallFromStandardNotation("^b5", 10, 1),

    playerWallFromStandardNotation(">b3", 10, 2),
    playerWallFromStandardNotation("^c3", 10, 1),

    playerWallFromStandardNotation(">b1", 10, 2),
    playerWallFromStandardNotation(">c3", 10, 2),
    playerWallFromStandardNotation("^c2", 10, 1),

    // Blue player walls (Player 2)
    playerWallFromStandardNotation("^f3", 10, 2),
    playerWallFromStandardNotation("^g3", 10, 2),
    playerWallFromStandardNotation("^g4", 10, 2),
    playerWallFromStandardNotation(">g3", 10, 2),
    playerWallFromStandardNotation(">h3", 10, 2),
    playerWallFromStandardNotation("^h3", 10, 2),
  ].map((wall) => ({ ...wall, state: "placed" as const }));

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
            playerColors={{ 1: "red", 2: "blue" }}
          />
        </div>
      </div>
    </Card>
  );
}
