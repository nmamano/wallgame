import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pause, Play } from "lucide-react";

export function GameShowcase() {
  const [isPlaying, setIsPlaying] = useState(true);

  // Mock game board - 8x8 grid
  const boardSize = 8;
  const cells = Array.from({ length: boardSize * boardSize });

  return (
    <Card className="relative overflow-hidden bg-card/50 border-2">
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
            onClick={() => setIsPlaying(!isPlaying)}
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
        <div className="aspect-square max-w-md mx-auto">
          <div
            className="grid gap-0.5 bg-border p-1 rounded-lg"
            style={{
              gridTemplateColumns: `repeat(${boardSize}, 1fr)`,
            }}
          >
            {cells.map((_, i) => {
              const row = Math.floor(i / boardSize);
              const col = i % boardSize;
              const isLight = (row + col) % 2 === 0;
              return (
                <div
                  key={i}
                  className={`aspect-square relative flex items-center justify-center text-xs ${
                    isLight ? "bg-secondary/20" : "bg-primary/10"
                  }`}
                >
                  {/* Row labels */}
                  {col === 0 && (
                    <span className="absolute top-0.5 left-0.5 text-[8px] text-muted-foreground">
                      {boardSize - row}
                    </span>
                  )}
                  {/* Column labels */}
                  {row === boardSize - 1 && (
                    <span className="absolute bottom-0.5 right-0.5 text-[8px] text-muted-foreground">
                      {String.fromCharCode(97 + col)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}
