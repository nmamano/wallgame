import { createFileRoute } from "@tanstack/react-router";
import { MarkdownPage } from "@/components/markdown-page";
import { contactMarkdown } from "@/lib/external-links";
import { isEmbedded } from "@/lib/embedded-mode";

export const Route = createFileRoute("/terms")({
  component: Terms,
});

/** In a portal frame the page loses its links to other sites. */
const termsContent = (embedded: boolean) => `
_Last updated: October 27, 2026_

These terms apply when you use Wall Game at wallgame.io. When you use the site, you agree to them.

## The service

Wall Game is free. We give it to you as it is, with no guarantee. The site can have errors or be offline, and we can change or stop any part of it at any time. We try to keep your games, ratings and progress, but we cannot promise that they are never lost.

## Your account

- Choose a display name that is not offensive and does not pretend to be another person.
- You are responsible for what happens with your account.

## Fair play and conduct

- Be respectful in chat.
- In rated games against people, do not use a bot or another program to choose your moves.
- Do not attack, overload or try to break the site.
- If you connect a bot, its name and its look must also follow these rules.

We can remove a name, a chat message, a bot or an account that breaks these rules.

## Your games

Online games on Wall Game are public. Anyone can watch them live and replay them later, with the players' names. Wall Game can show games from the site in its own videos and posts.

## Privacy

Our [Privacy Policy](/privacy) tells you what data the site keeps.

## Liability

As far as the law allows, we are not responsible for any loss that comes from using Wall Game.

## Changes

When we change these terms, we update this page and the date at the top. If you use the site after a change, you agree to the new terms.

## Contact

${contactMarkdown(embedded)}
`;

function Terms() {
  return (
    <MarkdownPage
      title="Terms of Use"
      subtitle="The rules for using Wall Game"
      markdown={termsContent(isEmbedded())}
    />
  );
}
