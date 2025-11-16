import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/study-board")({
  component: StudyBoard,
});

function StudyBoard() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4">
        <h1 className="text-4xl font-bold mb-8 text-foreground text-balance">
          Study Board
        </h1>

        <Card className="p-8 border-border/50 bg-card/50 backdrop-blur">
          <p className="text-lg text-muted-foreground">
            Analyze positions and experiment with strategies freely. This
            feature is coming soon!
          </p>
        </Card>
      </div>
    </div>
  );
}
