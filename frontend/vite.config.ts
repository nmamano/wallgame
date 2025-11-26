import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { TanStackRouterVite } from "@tanstack/router-vite-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), TanStackRouterVite()],
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
