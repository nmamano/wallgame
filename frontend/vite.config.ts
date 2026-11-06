import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { TanStackRouterVite } from "@tanstack/router-vite-plugin";
import { pawnManifestPlugin } from "./vite-plugin-pawn-manifest";

export default defineConfig({
  plugins: [
    // Before react(): the code splitter must see the route files before JSX
    // is compiled.
    TanStackRouterVite({ autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    pawnManifestPlugin(path.resolve(__dirname, "./public")),
  ],
  build: {
    rollupOptions: {
      output: {
        // React and the TanStack libraries change only with a dependency
        // update, so their own file stays cached across deploys. An explicit
        // list: a package used by only some pages (the Markdown stack) must
        // stay in those pages' chunks.
        manualChunks: (id) =>
          /\/node_modules\/(react|react-dom|scheduler|@tanstack\/[^/]+)\//.test(
            id,
          )
            ? "vendor"
            : undefined,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // See comment in tsconfig.json
      "@server": path.resolve(__dirname, "../server"),
    },
  },
  // When developing locally, the frontend runs on port 5173 and the backend
  // runs on port 3000.
  // This makes it so, when developing locally, we can access the API routes
  // and WebSocket connections through the frontend port, i.e.,
  // http://localhost:5173/api/ and ws://localhost:5173/ws/.
  // This matches the behavior of the production setup, where the frontend is
  // served from the same origin as the API routes and WebSocket endpoints
  // (it's actually kind of the opposite: Locally, everything goes through the
  // frontend (due to this proxy). In production, everything goes through the
  // backend (due to how we bundle it). But what matters is that, in both,
  // there is a single origin).
  server: {
    host: true,
    allowedHosts: ["auntie"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
      "/ws": {
        target: "http://127.0.0.1:3000",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
