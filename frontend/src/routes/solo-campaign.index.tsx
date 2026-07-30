import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy URL kept as a redirect: the campaign level list moved onto the
 * unified /puzzles page as its first section (S-FOLD, Nil's request), but this
 * URL was the campaign's home for a long time and bookmarks should keep
 * working.
 *
 * Levels themselves still play at /solo-campaign/$id — only the LIST moved.
 *
 * `replace: true` so this does not add a history entry: a visitor who lands
 * here and presses Back should go wherever they came from, not bounce through
 * the redirect again.
 */
export const Route = createFileRoute("/solo-campaign/")({
  beforeLoad: () => {
    // TanStack Router's redirect() is designed to be thrown.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/puzzles", replace: true });
  },
});
