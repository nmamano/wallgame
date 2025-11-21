import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";

export const Route = createFileRoute("/about")({
  component: About,
});

const aboutContent = `
Wall Game is a strategic board game about building walls and outsmarting your opponents.

## How to Navigate

Use the navigation bar at the top to go to different sections:

- **[Learn](/learn):** Game rules and strategic concepts
- **[Play](/):** Start games, by yourself or with friends
- **[Ranking](/ranking):** See who is the best player
- **[Past Games](/past-games):** Study past games from other players
- **[Live Games](/live-games):** Spectate live games from other players
- **[Settings](/settings):** Adjust your experience
- **[Login](/profile):** Manage your account

There is also a [blog](https://nilmamano.com/blog/category/wallgame) about the game's development, with the post '[The Wall Game Project](https://nilmamano.com/blog/wall-game-intro?category=wallgame)' as an introduction.

## Credits

Wall Game was created by [Nil Mamano](https://nilmamano.com).

The game is inspired by classic strategy games like [Quoridor](https://en.wikipedia.org/wiki/Quoridor) and [Blockade](https://en.wikipedia.org/wiki/Blockade_(board_game)).
`;

function About() {
  return (
    <div className="container mx-auto py-12 px-4 max-w-3xl">
      <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-8 text-balance">
        About
      </h1>

      <Card className="p-8 border-border/50 bg-card/50 backdrop-blur">
        <div className="space-y-4 text-foreground leading-relaxed prose dark:prose-invert max-w-none prose-headings:font-serif prose-headings:font-bold prose-a:text-primary hover:prose-a:text-primary/80">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={{
              a: ({ node, ...props }) => {
                if (props.href?.startsWith("http")) {
                  return (
                    <a {...props} target="_blank" rel="noopener noreferrer" />
                  );
                }
                return <a {...props} />;
              },
            }}
          >
            {aboutContent}
          </ReactMarkdown>
        </div>
      </Card>
    </div>
  );
}
