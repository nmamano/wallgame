import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/puzzles/$id")({
  component: Puzzle,
});

function Puzzle() {
  const { id } = Route.useParams();

  return (
    <div className="container mx-auto py-12 px-4 max-w-4xl">
      <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-8 text-balance">
        Puzzle {id}
      </h1>

      <Card className="p-8 border-border/50 bg-card/50 backdrop-blur">
        <p className="text-lg text-muted-foreground">
          Puzzle board and controls will be displayed here. This feature is
          coming soon!
        </p>
      </Card>
    </div>
  );
}
