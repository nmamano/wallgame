import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/play-vs-ai")({
  component: PlayVsAI,
});

function PlayVsAI() {
  const navigate = useNavigate();

  const handleCreateGame = () => {
    const gameId = Math.random().toString(36).substring(7);
    navigate({ to: `/game/${gameId}` });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4 max-w-6xl">
        <h1 className="text-4xl font-bold mb-8 text-foreground text-balance">
          Play vs AI
        </h1>

        <Card className="p-6 border-border/50 bg-card/50 backdrop-blur">
          <h2 className="text-xl font-semibold mb-4 text-foreground">
            Players
          </h2>
          <div className="space-y-4 mb-6">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Player 1</p>
              <div className="p-3 bg-muted rounded border border-border">
                <p className="font-semibold text-foreground">You</p>
                <p className="text-xs text-muted-foreground">
                  You'll make the moves.
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Player 2</p>
              <div className="p-3 bg-accent/20 rounded border border-accent/30">
                <p className="font-semibold text-foreground">AI Opponent</p>
                <p className="text-xs text-muted-foreground">
                  Choose difficulty: Easy, Medium, or Hard
                </p>
              </div>
            </div>
          </div>

          <Button onClick={handleCreateGame} size="lg" className="w-full">
            Start Game
          </Button>
        </Card>
      </div>
    </div>
  );
}
