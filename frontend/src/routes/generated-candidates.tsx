import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy URL kept as a redirect: the generated puzzles moved onto the
 * unified /puzzles page (S-G2), but this direct URL was used during
 * playtesting and bookmarks should keep working.
 */
export const Route = createFileRoute("/generated-candidates")({
  beforeLoad: () => {
    // TanStack Router's redirect() is designed to be thrown.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/puzzles", replace: true });
  },
});
