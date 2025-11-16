import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { ExternalLink } from "lucide-react";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <div className="container mx-auto py-12 px-4 max-w-3xl">
      <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-8 text-balance">
        About
      </h1>

      <Card className="p-8 border-border/50 bg-card/50 backdrop-blur">
        <div className="prose prose-amber dark:prose-invert max-w-none">
          <p className="text-lg leading-relaxed text-foreground mb-6">
            Wall Game is a strategic board game about building walls and
            outsmarting your opponents. Navigate the board while strategically
            placing walls to block your opponent's path to victory.
          </p>

          <h2 className="text-2xl font-serif font-bold text-foreground mb-4">
            Inspired By
          </h2>

          <p className="leading-relaxed text-foreground mb-4">
            Wall Game draws inspiration from classic strategy games:
          </p>

          <ul className="space-y-3 mb-6">
            <li className="flex items-start gap-2">
              <span className="text-muted-foreground">•</span>
              <div>
                <a
                  href="https://en.wikipedia.org/wiki/Quoridor"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
                >
                  Quoridor
                  <ExternalLink className="w-3 h-3" />
                </a>
                <span className="text-foreground">
                  {" "}
                  - The classic maze-building game
                </span>
              </div>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-muted-foreground">•</span>
              <div>
                <a
                  href="https://en.wikipedia.org/wiki/Blockade_(board_game)"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
                >
                  Blockade
                  <ExternalLink className="w-3 h-3" />
                </a>
                <span className="text-foreground">
                  {" "}
                  - The original barrier-placement game
                </span>
              </div>
            </li>
          </ul>

          <h2 className="text-2xl font-serif font-bold text-foreground mb-4 mt-8">
            How to Navigate
          </h2>

          <p className="leading-relaxed text-foreground mb-4">
            Use the navigation bar at the top to explore different sections:
          </p>

          <ul className="space-y-2 mb-6 text-foreground">
            <li className="flex items-start gap-2">
              <span className="text-muted-foreground">•</span>
              <span>
                <strong>Play:</strong> Start games, practice solo, or invite
                friends
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-muted-foreground">•</span>
              <span>
                <strong>Learn:</strong> Master the rules and study strategic
                concepts
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-muted-foreground">•</span>
              <span>
                <strong>Ranking:</strong> See where you stand among other
                players
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-muted-foreground">•</span>
              <span>
                <strong>Past/Live Games:</strong> Watch and learn from other
                players
              </span>
            </li>
          </ul>

          <h2 className="text-2xl font-serif font-bold text-foreground mb-4 mt-8">
            Created By
          </h2>

          <p className="leading-relaxed text-foreground">
            Wall Game was created by{" "}
            <a
              href="https://nilmamano.com"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Nil Mamano
            </a>
            . For more information and updates, visit the{" "}
            <a
              href="https://nilmamano.com/blog/category/wallgame"
              className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
            >
              blog
              <ExternalLink className="w-3 h-3" />
            </a>
            .
          </p>
        </div>
      </Card>
    </div>
  );
}
