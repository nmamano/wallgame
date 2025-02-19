import { useEffect, useState } from "react";
import "./App.css";

import { hc } from "hono/client";
import { type ApiRoutes } from "../../server/index";

const client = hc<ApiRoutes>("/");

function App() {
  const [numPuzzles, setNumPuzzles] = useState(0);

  useEffect(() => {
    async function fetchNumPuzzles() {
      const res = await client.api.puzzles["count"].$get();
      const data = await res.json();
      setNumPuzzles(data.count);
    }
    fetchNumPuzzles();
  }, []);

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
        <p>API test: Number of puzzles: {numPuzzles}</p>
      </div>
    </>
  );
}

export default App;
