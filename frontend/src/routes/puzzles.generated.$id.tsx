import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Compatibility only: every puzzle lives at /puzzles/$id now.
 *
 * Generated puzzles briefly had their own address, back when they were
 * numbered separately from the handcrafted ones and "generated 7" and
 * "handcrafted 7" were two different puzzles. The listing still shows the two
 * sections apart, but the numbering runs once across both now, so the segment
 * no longer distinguishes anything — and links minted under it are already out
 * in the world, so this keeps them working instead of turning them into 404s.
 *
 * The segment is passed straight through: /puzzles/$id accepts both a puzzle
 * number and a row id, which is exactly what this route accepted.
 */
export const Route = createFileRoute("/puzzles/generated/$id")({
  beforeLoad: ({ params }) => {
    // TanStack Router's redirect() is designed to be thrown.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/puzzles/$id", params, replace: true });
  },
});
