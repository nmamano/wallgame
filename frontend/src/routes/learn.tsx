import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";

const rulesContent = `
The Wall Game is a two-player, turn-based, strategy board game played on a rectangular grid. Each player controls a cat and a mouse, and the goal is to catch the opponent's mouse before they catch yours.
A capture occurs whenever a cat and the opponent's mouse occupy the same cell, regardless of which piece moved.

Each player is identified by a color. Player 1's cat and mouse start on the left and Player 2's cat and mouse start on the right, like this:

<img src="/starting-position.png" alt="Starting position" width="500" class="mx-auto my-4 rounded-lg shadow-md" />

Player 1 moves first. Each move consists of up to two actions, which can be:

- Move your cat to an adjacent square (diagonals not allowed)
- Move your mouse to an adjacent square (diagonals not allowed)
- Place a wall between two adjacent cells _anywhere_ on the board, with the only limitation that the walls must always leave a path from each cat to the opponent's mouse.

It is allowed to make both actions of the same kind.

Notes:

- There is no limit to how many walls you can place.
- Walls block both players regardless of who placed them, and there is no way to remove them.
- Pieces (cats and mice) can be stacked in the same square without limitations. This does not prevent movement. For example, Player 1's cat and mice can be in the same square, and so can Player 1's cat and Player 2's cat.
- One-move rule (starter handicap rule): If Player 1 catches the mouse first, but Player 2's cat is within 1 or 2 steps of Player 1's mouse, the game ends in a draw.

The one-move rule is to counteract the advantage that Player 1 has by moving first.
`;

const notationContent = `
### Denoting squares

Wall Game uses a standard notation system similar to chess. Squares are identified by a (lowercase) letter indicating the column (left to right) followed by a number indicating the row (bottom to top).

<img src="/board-coordinates.png" alt="Board coordinates" width="500" class="mx-auto my-4 rounded-lg shadow-md" />

Boards never have more than 26 columns.

### Denoting walls

- Vertical walls (between two cells in the same row) are denoted by **>** followed by the cell to the left: **>e4**
- Horizontal walls (between two cells in the same column) are denoted by **^** followed by the cell below: **^e4**

It is not allowed to use **<** to refer to a wall to the left of a cell or **v** to refer to the wall below a cell.

### Denoting actions

- A cat-walk action: **C** followed by the destination square (**Ce4**).
- A mouse-walk action: **M** followed by the destination square (**Me4**).
- A wall-placing action: the wall symbol (**>e4** or **^e4**).

### Denoting moves

A move consists of up to two actions. If there are two actions, they are connected with a period: **Ce4.Mc5**

When a move contains two actions, they must be listed in the following order to guarantee deterministic notation:

1. Cat-walk actions (**Ce4**)
2. Mouse-walk actions (**Me4**)
3. Vertical wall-placing actions (**>e4**)
4. Horizontal wall-placing actions (**^e4**)

For example, it must be **Ce4.Me4** (not **Me4.Ce4**) and **>e4.^e4** (not **^e4.>e4**).

If both actions are of the same type:

- Two wall actions of the same kind: they must be sorted by column first, and then by row (**>a2** comes before **>b1**).
- Two cat-walk or two mouse-walk actions: only the final destination is written (**Me4**, not a sequence like **Me3.Me4**).

If a player chooses to do no actions on their turn, their move is written as **---**.

### Denoting games

A complete game record has two parts, separated by a blank line:

1. Header lines describing the starting position, result, and metadata.
2. The move list.

### Header lines

We use PGN-style tag pairs (one per line). The following tag pairs are mandatory:

- **[Board "12x10"]**: Indicates the board size, as columns x rows.
- **[Result "1-0"]**: Indicates who won. It can be **"1-0"** (Player 1 win), **"0-1"** (Player 2 win), **"1/2-1/2"** (Draw), or **"*"** (Game still in progress or winner not recorded).

Variants may have additional mandatory tag pairs.

Optional tag pairs can be used to provide metadata:

- **[Variant "Standard"]**: Indicates the variant being played.
- **[TimeControl "180+2"]**: Indicates the time control, as "starting time + increment", both in seconds.
- **[Player1 "Name"]**
- **[Player2 "Name"]**
- **[Player1Elo "1820"]**
- **[Player2Elo "1700"]**
- **[Date "2025-01-23"]**
- **[Termination "Resignation"]**: Indicates how the game ended. It can be **"MouseCapture"**, **"Timeout"**, **"Resignation"**, **"DrawAgreement"**, **"OneMoveRuleDraw"**, **"Unknown"**. 

### Move list

The moves are listed in a numbered list. Each line begins with the move number, followed by the moves of Player 1 and Player 2 separated by a space:

**1. Cb6.>a6 Mb2**\\
**2. Md1 >d1.^d1**\\
**3. ...**`;

const variantsContent = `
### Standard

The default variant with cat and mouse pawns in the corners.

### Classic

A traditional variant where the mice are called "goals" and are fixed in the bottom corners. The goal is to reach the opposing corner before the opponent.

### Freestyle (coming soon)

A variant where the cat and mice start at random places, and there are some starting walls.
`;

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
    <div className="min-h-screen bg-background">
      <main className="container mx-auto py-12 px-4">
        <div className="max-w-3xl mx-auto">
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
                  Rules (Standard variant)
                </h2>
                {openSections.rules ? (
                  <ChevronDown className="w-6 h-6 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-6 h-6 text-muted-foreground" />
                )}
              </button>

              <div
                className={cn(
                  "grid transition-all duration-300 ease-in-out",
                  openSections.rules
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden">
                  <div className="px-6 pb-6 space-y-4 text-foreground leading-relaxed prose dark:prose-invert max-w-none prose-headings:font-serif prose-headings:font-bold prose-a:text-primary hover:prose-a:text-primary/80">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeRaw]}
                    >
                      {rulesContent}
                    </ReactMarkdown>

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
                  "grid transition-all duration-300 ease-in-out",
                  openSections.notation
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden">
                  <div className="px-6 pb-6 space-y-4 text-foreground leading-relaxed prose dark:prose-invert max-w-none prose-headings:font-serif prose-headings:font-bold">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeRaw]}
                    >
                      {notationContent}
                    </ReactMarkdown>
                  </div>
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
                  Lessons (coming soon)
                </h2>
                {openSections.lessons ? (
                  <ChevronDown className="w-6 h-6 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-6 h-6 text-muted-foreground" />
                )}
              </button>

              <div
                className={cn(
                  "grid transition-all duration-300 ease-in-out",
                  openSections.lessons
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden">
                  <div className="px-6 pb-6">
                    <p className="text-foreground leading-relaxed mb-4">
                      Improve your game with these strategic and tactical
                      lessons:
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
                  "grid transition-all duration-300 ease-in-out",
                  openSections.variants
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden">
                  <div className="px-6 pb-6 space-y-6 prose dark:prose-invert max-w-none prose-headings:font-serif prose-headings:font-bold">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeRaw]}
                    >
                      {variantsContent}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
