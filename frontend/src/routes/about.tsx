import { createFileRoute } from "@tanstack/react-router";
import { MarkdownPage } from "@/components/markdown-page";
import { DISCORD_INVITE_URL } from "@/lib/external-links";
import { isEmbedded } from "@/lib/embedded-mode";

export const Route = createFileRoute("/about")({
  component: About,
});

/**
 * Inside a portal frame the page keeps every word it can and loses every link
 * that leaves the site - including the account bullet, since a framed session
 * cannot log in at all. See `lib/embedded-mode.ts`.
 */
const aboutContent = (embedded: boolean) => `
Wall Game is a strategic board game about building walls and outsmarting your opponents.

## How to Navigate

Use the navigation bar at the top to go to different sections:

- **[Learn](/learn):** Game rules and strategic concepts
- **[Play](/):** Start games, by yourself or with friends
- **[Ranking](/ranking):** See who is the best player
- **[Past Games](/past-games):** Study past games from other players
- **[Live Games](/live-games):** Spectate live games from other players
- **[Settings](/settings):** Adjust your experience${
  embedded ? "" : "\n- **[Login](/profile):** Manage your account"
}
${
  embedded
    ? ""
    : `
There is also a [blog](https://nilmamano.com/blog/category/wallgame) about the game's development, with the post '[The Wall Game Project](https://nilmamano.com/blog/wall-game-intro?category=wallgame)' as an introduction.

## Community

Join the [Wall Game Discord](${DISCORD_INVITE_URL}) to find opponents, talk strategy, report bugs, and follow what is being built next.
`
}
## Credits

Wall Game was created by ${embedded ? "Nil Mamano" : "[Nil Mamano](https://nilmamano.com)"}.

The game is inspired by classic strategy games like ${
  embedded ? "Quoridor" : "[Quoridor](https://en.wikipedia.org/wiki/Quoridor)"
} and ${
  embedded
    ? "Blockade"
    : "[Blockade](https://en.wikipedia.org/wiki/Blockade_(board_game))"
}.

## Privacy and Terms

- [Privacy Policy](/privacy)
- [Terms of Use](/terms)
`;

function About() {
  return (
    <MarkdownPage
      title="About"
      subtitle="What is Wall Game?"
      markdown={aboutContent(isEmbedded())}
    />
  );
}
