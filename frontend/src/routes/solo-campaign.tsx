import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle, Play } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";

export const Route = createFileRoute("/solo-campaign")({
  component: SoloCampaign,
});

function SoloCampaign() {
  const navigate = useNavigate();
  const [isLoggedIn] = useState(false);

  const puzzles = [
    { id: 1, name: "First Steps", difficulty: 1, completed: true },
    { id: 2, name: "Basic Walls", difficulty: 1, completed: true },
    { id: 3, name: "Blocking Paths", difficulty: 2, completed: false },
    { id: 4, name: "Strategic Position", difficulty: 2, completed: false },
    { id: 5, name: "Advanced Tactics", difficulty: 3, completed: false },
    { id: 6, name: "Endgame Mastery", difficulty: 4, completed: false },
  ];

  const handlePlayPuzzle = (puzzleId: number) => {
    navigate({ to: `/solo-campaign/${puzzleId}` });
  };

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-4 text-balance">
          Solo Campaign
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Learn the fundamentals of Wall Game through a structured series of
          challenges. Start here if you're new to the game!
        </p>
      </div>

      {!isLoggedIn && (
        <Alert className="mb-6 bg-card/50 border-border/50">
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm text-muted-foreground">
            Log in to save your completion status across devices.
          </AlertDescription>
        </Alert>
      )}

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
                  <h3 className="text-xl font-semibold text-foreground mb-2">
                    {puzzle.id}. {puzzle.name}
                  </h3>
                  <div className="flex gap-2">
                    <Badge
                      variant={puzzle.difficulty <= 2 ? "secondary" : "default"}
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

              <Button
                onClick={() => handlePlayPuzzle(puzzle.id)}
                className="gap-2"
              >
                <Play className="w-4 h-4" />
                {puzzle.completed ? "Replay" : "Play"}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
