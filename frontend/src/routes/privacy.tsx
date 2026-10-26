import { createFileRoute } from "@tanstack/react-router";
import { MarkdownPage } from "@/components/markdown-page";
import { DISCORD_INVITE_URL } from "@/lib/external-links";
import { isEmbedded } from "@/lib/embedded-mode";

export const Route = createFileRoute("/privacy")({
  component: Privacy,
});

/**
 * Each claim here was checked against the code that it describes. When that
 * code changes (what the database keeps, the cookies, the analytics settings
 * in index.html), change this page too. In a portal frame the page keeps
 * its words and loses the link that leaves the site (lib/embedded-mode.ts).
 */
const privacyContent = (embedded: boolean) => `
_Last updated: October 26, 2026_

Wall Game is a free board game website at wallgame.io, made by Nil Mamano. This page tells you what data the site keeps, why it keeps it, and who else gets it.

## If you play without an account

You can play without an account. Then:

- Your browser keeps a random id for Wall Game. We save this id with each game that you play, so that we can count how many players come back. It does not tell us who you are.
- In games, you get a guest name such as "Guest Otter".
- Your settings (theme, sound, board look) stay in your browser.

## If you make an account

An account gives you a rating and keeps your progress. Kinde, our sign-in service, does the login. Kinde keeps the email address or the login account that you use. Our database does not keep your email address. It keeps:

- an account id from Kinde,
- the display name that you choose,
- the date when you made the account,
- your settings (board theme, pawn styles, default game options),
- your ratings, your puzzle and campaign progress, and your puzzle votes.

The random browser id is also saved with the games that you play when you are signed in. This lets us see when a guest later makes an account.

## Games and chat

When an online game ends, we save it: the moves, the game settings, the result, the date and the names of the players. Anyone can watch online games live and replay them later. The ranking page shows display names and ratings.

Players' chat goes only to the players, and spectators' chat goes only to the spectators who watch at that time. We do not save chat messages. Our server log records that a message was sent, with the sender's name and the length of the message, but not the text.

## Bots

When you play against a bot, the bot's program gets the game settings and the moves. It does not get your name. Some bots are run by other players.

If you connect your own bot, we save its name, its look and its games.

## Cookies and browser storage

- When you sign in, the site sets cookies that keep you signed in. Login does not work without them.
- Your browser keeps your settings, the random id, and small notes, for example whether we showed you the offer to make an account.
- Google Analytics sets its own cookies (see below).
- Cloudflare can set a security cookie.

We use no advertising cookies.

## Google Analytics

On wallgame.io we use Google Analytics to count visits: which pages people open, where they come from, and whether they see and click the offer to make an account. Google says that Google Analytics 4 does not store IP addresses. We turned off Google signals and ad personalization. Google Analytics does not run when Wall Game is shown inside another game website.

## Hosting and logs

The site runs on a server that we rent. Cloudflare carries the traffic to our server, so Cloudflare sees your IP address. Our server writes technical logs (for example, which page was asked for, and errors) so that we can find and fix problems. Our web server's access logs include IP addresses. Old log files are deleted automatically. To stop abuse, the server keeps IP addresses in memory for a short time. It does not save them in the database. We keep backups of the database.

## Wall Game videos on social media

Wall Game makes short videos of games played on the site and posts them to Wall Game's own accounts on YouTube, TikTok, Instagram, Facebook, Threads, X and Bluesky. A video or its text can show the in-game name of a player. The tool that posts these videos only uploads Wall Game's own videos to Wall Game's own accounts. It does not read or keep data about other users of these platforms.

## Your choices

- You can play without an account.
- You can block or delete cookies and browser storage in your browser settings. If you block cookies, you cannot sign in.
- To delete your account, or to ask what data we have about you, contact us. When we delete an account, we remove its account data. Your past games stay in the game archive.

## Changes

When we change this policy, we update this page and the date at the top.

<h2 id="contact">Contact</h2>

Write to us on the ${embedded ? "Wall Game Discord" : `[Wall Game Discord](${DISCORD_INVITE_URL})`}.
`;

function Privacy() {
  return (
    <MarkdownPage
      title="Privacy Policy"
      subtitle="What data Wall Game keeps, and why"
      markdown={privacyContent(isEmbedded())}
    />
  );
}
