import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle, Play } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";

export const Route = createFileRoute("/puzzles")({
  component: Puzzles,
});

interface PuzzleApiResponse {
  id: number;
  title: string;
  author: string;
  rating: number;
}

interface PuzzlesApiResponse {
  puzzles: PuzzleApiResponse[];
}

interface Puzzle {
  id: number;
  name: string;
  difficulty: number;
  completed: boolean;
}

async function getAllPuzzles(): Promise<PuzzlesApiResponse> {
  const res = await api.puzzles.$get();
  if (!res.ok) {
    throw new Error("Server error: Failed to fetch puzzles");
  }
  return res.json() as Promise<PuzzlesApiResponse>;
}

function Puzzles() {
  const navigate = useNavigate();
  const { isPending, error, data } = useQuery({
    queryKey: ["get-all-puzzles"],
    queryFn: getAllPuzzles,
  });

  const handlePlayPuzzle = (puzzleId: number) => {
    void navigate({ to: `/puzzles/${puzzleId}` });
  };

  if (error)
    return (
      <div className="container mx-auto py-8 px-4">
        Server error: {error.message}
      </div>
    );

  // Map API data to match the UI structure
  const puzzles: Puzzle[] =
    data?.puzzles?.map((puzzle) => ({
      id: puzzle.id,
      name: puzzle.title ?? `Puzzle ${puzzle.id}`,
      difficulty: Math.min(
        5,
        Math.max(1, Math.floor((puzzle.rating ?? 1000) / 200)),
      ), // Convert rating to 1-5 difficulty
      completed: false, // TODO: Get from user data
    })) ?? [];

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-4 text-balance">
          Puzzles
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Sharpen your tactical skills with challenging puzzle positions. Find
          the winning move or secure a draw in difficult situations.
        </p>
      </div>

      <Alert className="mb-6 bg-card/50 border-border/50">
        <Info className="h-4 w-4" />
        <AlertDescription className="text-sm text-muted-foreground">
          Log in to save your completion status across devices.
        </AlertDescription>
      </Alert>

      {isPending ? (
        <div className="text-center py-12 text-muted-foreground">
          Loading puzzles...
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {puzzles.map((puzzle) => (
            <Card
              key={puzzle.id}
              className="p-6 hover:shadow-lg transition-shadow border-border/50 bg-card/50 backdrop-blur"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-start gap-3">
                  <div className="text-foreground mt-1">
                    {puzzle.completed ? (
                      <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-500" />
                    ) : (
                      <Circle className="w-5 h-5" />
                    )}
                  </div>

                  <div>
                    <h3 className="text-lg font-semibold text-foreground mb-2">
                      {puzzle.name}
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      <Badge
                        variant={
                          puzzle.difficulty <= 2 ? "secondary" : "default"
                        }
                        className="text-xs"
                      >
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
              </div>

              <Button
                onClick={() => handlePlayPuzzle(puzzle.id)}
                className="w-full gap-2"
                size="sm"
              >
                <Play className="w-4 h-4" />
                {puzzle.completed ? "Replay" : "Solve"}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
