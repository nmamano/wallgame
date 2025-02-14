import { useState } from "react";
import reactLogo from "./assets/react.svg";
import viteLogo from "/vite.svg";
import "./App.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <>
      <div className="flex justify-center gap-8 p-4">
        <a
          href="https://vite.dev"
          target="_blank"
          className="hover:opacity-80 transition-opacity"
        >
          <img src={viteLogo} className="h-24 w-24" alt="Vite logo" />
        </a>
        <a
          href="https://react.dev"
          target="_blank"
          className="hover:opacity-80 transition-opacity"
        >
          <img
            src={reactLogo}
            className="h-24 w-24 motion-safe:animate-spin-slow"
            alt="React logo"
          />
        </a>
      </div>
      <h1 className="text-4xl font-bold mb-8">Vite + React</h1>
      <div className="max-w-md mx-auto p-6 bg-white/5 rounded-lg shadow-lg">
        <button
          onClick={() => setCount((count) => count + 1)}
          className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors mb-4"
        >
          count is {count}
        </button>
        <p className="text-gray-300">
          Edit{" "}
          <code className="bg-black/20 px-1 py-0.5 rounded">src/App.tsx</code>{" "}
          and save to test HMR
        </p>
      </div>
      <p className="mt-8 text-gray-400 text-sm">
        Click on the Vite and React logos to learn more
      </p>
    </>
  );
}

export default App;
