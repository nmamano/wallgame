import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/learn")({
  component: Learn,
});

function Learn() {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    rules: true,
    notation: false,
    lessons: false,
    variants: false,
  });

  const toggleSection = (section: string) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const lessons = [
    { title: "Opening Principles", url: "#" },
    { title: "Wall Placement Strategy", url: "#" },
    { title: "Endgame Techniques", url: "#" },
    { title: "Common Tactical Patterns", url: "#" },
    { title: "Time Management", url: "#" },
  ];

  return (
    <div className="container mx-auto py-12 px-4 max-w-3xl">
      <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-8 text-balance">
        Learn
      </h1>

      <div className="space-y-4">
        {/* Rules Section */}
        <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur">
          <button
            onClick={() => toggleSection("rules")}
            className="w-full p-6 flex items-center justify-between hover:bg-muted/50 transition-colors"
          >
            <h2 className="text-2xl font-serif font-bold text-foreground">
              Rules (Standard)
            </h2>
            {openSections.rules ? (
              <ChevronDown className="w-6 h-6 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-6 h-6 text-muted-foreground" />
            )}
          </button>

          <div
            className={cn(
              "transition-all duration-300 overflow-hidden",
              openSections.rules
                ? "max-h-[2000px] opacity-100"
                : "max-h-0 opacity-0"
            )}
          >
            <div className="px-6 pb-6 space-y-4 text-foreground leading-relaxed">
              <p>
                Wall Game is a two-player strategy board game played on a
                rectangular grid. Each player controls a pawn that starts on
                opposite sides of the board. The goal is to reach the opposite
                side of the board before your opponent.
              </p>

              <h3 className="text-xl font-semibold mt-6 mb-3">Basic Rules:</h3>
              <ul className="list-disc list-inside space-y-2 ml-4">
                <li>
                  Players alternate turns, moving their pawn one square
                  orthogonally (up, down, left, or right).
                </li>
                <li>
                  On each turn, a player must perform two actions: moving their
                  pawn and placing a wall.
                </li>
                <li>
                  Walls are placed between squares to block movement. Both you
                  and your opponent cannot cross walls.
                </li>
                <li>
                  Each player has a limited number of walls (typically 10 in
                  standard games).
                </li>
                <li>
                  You cannot place a wall that completely blocks your opponent
                  from reaching their goal.
                </li>
                <li>
                  The first player to reach any square on the opposite side wins
                  the game.
                </li>
              </ul>

              <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-950/30 rounded border border-blue-200 dark:border-blue-800">
                <p className="text-blue-900 dark:text-blue-200">
                  <strong>Ready to play?</strong> You can now{" "}
                  <Link
                    to="/solo-campaign"
                    className="underline hover:text-blue-600 dark:hover:text-blue-400"
                  >
                    start the solo campaign
                  </Link>{" "}
                  to learn through practice!
                </p>
              </div>
            </div>
          </div>
        </Card>

        {/* Notation Section */}
        <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur">
          <button
            onClick={() => toggleSection("notation")}
            className="w-full p-6 flex items-center justify-between hover:bg-muted/50 transition-colors"
          >
            <h2 className="text-2xl font-serif font-bold text-foreground">
              Notation (Standard)
            </h2>
            {openSections.notation ? (
              <ChevronDown className="w-6 h-6 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-6 h-6 text-muted-foreground" />
            )}
          </button>

          <div
            className={cn(
              "transition-all duration-300 overflow-hidden",
              openSections.notation
                ? "max-h-[2000px] opacity-100"
                : "max-h-0 opacity-0"
            )}
          >
            <div className="px-6 pb-6 space-y-4 text-foreground leading-relaxed">
              <p>
                Wall Game uses a standard notation system similar to chess.
                Squares are identified by a letter (column) followed by a number
                (row). For example, "e4" refers to the square in column E, row
                4.
              </p>

              <h3 className="text-xl font-semibold mt-6 mb-3">
                Move Notation:
              </h3>
              <ul className="list-disc list-inside space-y-2 ml-4">
                <li>
                  <strong>Pawn moves:</strong> Simply write the destination
                  square. Example: "e4" means move your pawn to square e4.
                </li>
                <li>
                  <strong>Wall placement:</strong> Use "W" followed by the
                  position and orientation. Example: "Wh4h" means place a
                  horizontal wall at position h4.
                </li>
                <li>
                  <strong>Complete turn:</strong> A turn consists of two
                  actions. Example: "e4 Wh4h" means move to e4, then place a
                  horizontal wall at h4.
                </li>
              </ul>

              <p className="mt-4">
                You'll see this notation in the move history during games. It
                helps you review and analyze your games after they're finished.
              </p>
            </div>
          </div>
        </Card>

        {/* Lessons Section */}
        <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur">
          <button
            onClick={() => toggleSection("lessons")}
            className="w-full p-6 flex items-center justify-between hover:bg-muted/50 transition-colors"
          >
            <h2 className="text-2xl font-serif font-bold text-foreground">
              Lessons (Standard)
            </h2>
            {openSections.lessons ? (
              <ChevronDown className="w-6 h-6 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-6 h-6 text-muted-foreground" />
            )}
          </button>

          <div
            className={cn(
              "transition-all duration-300 overflow-hidden",
              openSections.lessons
                ? "max-h-[2000px] opacity-100"
                : "max-h-0 opacity-0"
            )}
          >
            <div className="px-6 pb-6">
              <p className="text-foreground leading-relaxed mb-4">
                Improve your game with these strategic and tactical lessons:
              </p>
              <div className="space-y-2">
                {lessons.map((lesson, idx) => (
                  <a
                    key={idx}
                    href={lesson.url}
                    className="flex items-center justify-between p-3 rounded hover:bg-muted/50 transition-colors group"
                  >
                    <span className="text-foreground font-medium">
                      {lesson.title}
                    </span>
                    <ExternalLink className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
                  </a>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {/* Variants Section */}
        <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur">
          <button
            onClick={() => toggleSection("variants")}
            className="w-full p-6 flex items-center justify-between hover:bg-muted/50 transition-colors"
          >
            <h2 className="text-2xl font-serif font-bold text-foreground">
              Variants
            </h2>
            {openSections.variants ? (
              <ChevronDown className="w-6 h-6 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-6 h-6 text-muted-foreground" />
            )}
          </button>

          <div
            className={cn(
              "transition-all duration-300 overflow-hidden",
              openSections.variants
                ? "max-h-[2000px] opacity-100"
                : "max-h-0 opacity-0"
            )}
          >
            <div className="px-6 pb-6 space-y-6">
              <div>
                <h3 className="text-xl font-semibold text-foreground mb-2">
                  Standard
                </h3>
                <p className="text-foreground leading-relaxed">
                  The default variant with cat and mouse pawns. Features two
                  actions per turn: move and wall placement. Board dimensions
                  are customizable from 2x2 to 12x12.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-foreground mb-2">
                  Classic
                </h3>
                <p className="text-foreground leading-relaxed">
                  A traditional variant inspired by Quoridor. Uses cat and goal
                  pawns instead of cat and mouse. The wall placement mechanics
                  are slightly different, emphasizing strategic blocking over
                  aggressive pursuit.
                </p>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
