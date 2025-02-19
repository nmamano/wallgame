import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/puzzles")({
  component: Puzzles,
});

function Puzzles() {
  return <div>Show all puzzles</div>;
}
