import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/find-others")({
  component: FindOthers,
});

function FindOthers() {
  const navigate = useNavigate();

  const handleFindMatch = () => {
    const gameId = Math.random().toString(36).substring(7);
    navigate({ to: `/game/${gameId}` });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4 max-w-6xl">
        <h1 className="text-4xl font-bold mb-8 text-foreground text-balance">
          Find Others
        </h1>

        <Card className="p-6 border-border/50 bg-card/50 backdrop-blur">
          <h2 className="text-xl font-semibold mb-4 text-foreground">
            Matchmaking
          </h2>
          <p className="text-muted-foreground leading-relaxed mb-6">
            You'll be paired with a random player with compatible settings and
            similar rating. The system will match you with someone currently
            looking for a game.
          </p>

          <div className="space-y-3 p-4 bg-muted rounded border border-border mb-6">
            <h3 className="font-semibold text-foreground text-sm">
              How it works:
            </h3>
            <ul className="text-sm text-muted-foreground space-y-2 list-disc list-inside">
              <li>Choose your preferred game settings</li>
              <li>Click "Find Match" to enter the queue</li>
              <li>Wait for a suitable opponent (usually under 30 seconds)</li>
              <li>Game starts automatically when matched</li>
            </ul>
          </div>

          <Button onClick={handleFindMatch} size="lg" className="w-full">
            Find Match
          </Button>
        </Card>
      </div>
    </div>
  );
}
