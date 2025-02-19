import { createFileRoute } from "@tanstack/react-router";

import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

export const Route = createFileRoute("/")({
  component: Index,
});

async function getNumPuzzles() {
  const res = await api.puzzles["count"].$get();
  if (!res.ok) {
    throw new Error("Server error: Failed to fetch number of puzzles");
  }
  const data = await res.json();
  return data;
}

function Index() {
  const { isPending, error, data } = useQuery({
    queryKey: ["puzzles-count"],
    queryFn: getNumPuzzles,
  });

  if (error) return "Server error: " + error.message;

  return (
    <>
      <div>
        <h1>Wall Game</h1>
        <p>Hello! Wall Game is under construction.</p>
        <p>
          Visit the <a href="/blog">blog</a>.
        </p>
        <p>
          Visit the legacy version at{" "}
          <a href="https://www.wallwars.net/">wallwars.net</a>.
        </p>
      </div>
      <div className="card">
        <p>
          API test: Number of puzzles: {isPending ? "Loading..." : data?.count}
        </p>
      </div>
    </>
  );
}
