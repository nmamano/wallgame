import { createFileRoute } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

export const Route = createFileRoute("/puzzles")({
  component: Puzzles,
});

async function getAllPuzzles() {
  const res = await api.puzzles.$get();
  if (!res.ok) {
    throw new Error("Server error: Failed to fetch puzzles");
  }
  const data = await res.json();
  return data;
}

function Puzzles() {
  const { isPending, error, data } = useQuery({
    queryKey: ["get-all-puzzles"],
    queryFn: getAllPuzzles,
  });

  if (error) return "Server error: " + error.message;

  return (
    <>
      <div>Show all puzzles</div>
      <div>
        {isPending
          ? "Loading..."
          : data?.puzzles.map((puzzle) => (
              <div key={puzzle.id}>
                <div>ID: {puzzle.id}</div>
                <div>Title: {puzzle.title}</div>
                <div>Author: {puzzle.author}</div>
                <div>Rating: {puzzle.rating}</div>
                <hr />
              </div>
            ))}
      </div>
    </>
  );
}
