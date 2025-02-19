import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <>
      <div>
        <p>Hello! Wall Game is under construction.</p>
        <p>
          Visit the legacy version at{" "}
          <a href="https://www.wallwars.net/">wallwars.net</a>.
        </p>
      </div>
    </>
  );
}
