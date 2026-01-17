import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle, Play, Clock } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";
import { PUZZLES, getPuzzleIds } from "../../../shared/domain/puzzles";
import { usePuzzleProgress } from "@/hooks/use-puzzle-progress";

export const Route = createFileRoute("/puzzles/")({
  component: Puzzles,
});

/**
 * Convert difficulty rating (1350-1850) to a 1-5 scale for display.
 */
function ratingToDifficulty(rating: number): number {
  // Map ~1300-1900 range to 1-5
  // 1300-1400 = 1, 1400-1500 = 2, 1500-1600 = 3, 1600-1750 = 4, 1750+ = 5
  if (rating < 1400) return 1;
  if (rating < 1500) return 2;
  if (rating < 1600) return 3;
  if (rating < 1750) return 4;
  return 5;
}

function Puzzles() {
  const navigate = useNavigate();
  const { isCompleted } = usePuzzleProgress();

  const handlePlayPuzzle = (puzzleId: string) => {
    void navigate({ to: `/puzzles/${puzzleId}` });
  };

  const puzzleIds = getPuzzleIds();
  const puzzles = puzzleIds.map((id) => {
    const puzzle = PUZZLES[id];
    return {
      id: puzzle.id,
      title: puzzle.title,
      author: puzzle.author,
      rating: puzzle.difficulty,
      difficulty: ratingToDifficulty(puzzle.difficulty),
      completed: isCompleted(puzzle.id),
    };
  });

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-4 text-balance">
          Puzzles
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Sharpen your tactical skills with challenging puzzle positions. Find
          the winning sequence of moves to reach your goal!
        </p>
      </div>

      <Alert className="mb-6 bg-card/50 border-border/50">
        <Info className="h-4 w-4" />
        <AlertDescription className="text-sm text-muted-foreground">
          Your progress is saved locally in this browser.
        </AlertDescription>
      </Alert>

      <div className="space-y-4">
        {puzzles.map((puzzle) => (
          <Card
            key={puzzle.id}
            className="p-6 hover:shadow-lg transition-shadow border-border/50 bg-card/50 backdrop-blur"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4 flex-1">
                <div className="text-foreground">
                  {puzzle.completed ? (
                    <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-500" />
                  ) : (
                    <Circle className="w-6 h-6" />
                  )}
                </div>

                <div className="flex-1">
                  <h3 className="text-xl font-serif font-semibold text-foreground mb-1">
                    {puzzle.title}
                  </h3>
                  <p className="text-sm text-muted-foreground mb-2">
                    by {puzzle.author}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant={puzzle.difficulty <= 2 ? "secondary" : "default"}
                      className="text-xs"
                    >
                      Rating: {puzzle.rating}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      Difficulty: {puzzle.difficulty}/5
                    </Badge>
                    {puzzle.completed && (
                      <Badge className="text-xs bg-green-600 dark:bg-green-700">
                        Completed
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              <Button
                onClick={() => handlePlayPuzzle(puzzle.id)}
                className="gap-2"
              >
                <Play className="w-4 h-4" />
                {puzzle.completed ? "Replay" : "Solve"}
              </Button>
            </div>
          </Card>
        ))}

        {/* Coming soon placeholder */}
        <Card className="p-6 border-dashed border-2 border-border/50 bg-card/30">
          <div className="flex items-center gap-4">
            <div className="text-muted-foreground">
              <Clock className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-xl font-serif font-semibold text-muted-foreground">
                More coming soon...
              </h3>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Additional puzzles are in development
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
