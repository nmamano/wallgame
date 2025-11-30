import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  createGameSession,
  getSessionSnapshot,
  joinGameSession,
  markHostReady,
  resolveSessionForToken,
  listMatchmakingGames,
} from "../games/store";
import {
  createGameSchema,
  joinGameSchema,
  readySchema,
  getGameSessionQuerySchema,
} from "../../shared/contracts/games";

// Lobby websocket connections for real-time matchmaking updates
const lobbyConnections = new Set<WebSocket>();

export const addLobbyConnection = (ws: WebSocket) => {
  lobbyConnections.add(ws);
};

export const removeLobbyConnection = (ws: WebSocket) => {
  lobbyConnections.delete(ws);
};

export const broadcastLobbyUpdate = () => {
  const games = listMatchmakingGames();
  const message = JSON.stringify({ type: "games", games });
  lobbyConnections.forEach((ws) => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    } catch (error) {
      console.error("Failed to broadcast to lobby connection:", error);
    }
  });
};

export const gamesRoute = new Hono()
  // Get list of available matchmaking games
  .get("/matchmaking", (c) => {
    try {
      const games = listMatchmakingGames();
      return c.json({ games });
    } catch (error) {
      console.error("Failed to list matchmaking games:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .post("/", zValidator("json", createGameSchema), async (c) => {
    try {
      const parsed = c.req.valid("json");
      console.log(
        "[games] POST /api/games body:",
        JSON.stringify(parsed, null, 2),
      );
      const { session, hostToken, hostSocketToken } = createGameSession({
        config: parsed.config,
        matchType: parsed.matchType,
        hostDisplayName: parsed.hostDisplayName,
        hostAppearance: parsed.hostAppearance,
        hostIsPlayer1: parsed.hostIsPlayer1,
      });
      // The FRONTEND_URL environment variable is used for creating shareable
      // links. It is only needed in dev mode because the proxied URL is not
      // the same URL as the backend is running on.
      const origin = process.env.FRONTEND_URL ?? new URL(c.req.url).origin;
      const shareUrl = `${origin}/game/${session.id}`;

      // Broadcast to lobby if this is a matchmaking game
      if (parsed.matchType === "matchmaking") {
        broadcastLobbyUpdate();
      }

      return c.json(
        {
          gameId: session.id,
          hostToken,
          socketToken: hostSocketToken,
          shareUrl,
          snapshot: getSessionSnapshot(session.id),
        },
        201,
      );
    } catch (error) {
      console.error("Failed to create game:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .get("/:id", zValidator("query", getGameSessionQuerySchema), (c) => {
    try {
      const { id } = c.req.param();
      const { token } = c.req.valid("query");
      const resolved = resolveSessionForToken({ id, token });
      if (!resolved) {
        return c.json({ error: "Game not found" }, 404);
      }
      const snapshot = getSessionSnapshot(id);
      const origin = process.env.FRONTEND_URL ?? new URL(c.req.url).origin;
      const shareUrl =
        resolved.player.role === "host" ? `${origin}/game/${id}` : undefined;

      return c.json({
        snapshot,
        role: resolved.player.role,
        playerId: resolved.player.playerId,
        socketToken: resolved.player.socketToken,
        token,
        shareUrl,
      });
    } catch (error) {
      console.error("Failed to fetch game session:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .post("/:id/join", zValidator("json", joinGameSchema), async (c) => {
    try {
      const { id } = c.req.param();
      const parsed = c.req.valid("json");
      const { session, guestToken, guestSocketToken } = joinGameSession({
        id,
        displayName: parsed.displayName,
        appearance: parsed.appearance,
      });
      const origin = process.env.FRONTEND_URL ?? new URL(c.req.url).origin;

      // Broadcast to lobby if this was a matchmaking game (it's now full)
      if (session.matchType === "matchmaking") {
        broadcastLobbyUpdate();
      }

      const shareUrl = `${origin}/game/${session.id}`;

      return c.json({
        gameId: session.id,
        token: guestToken,
        socketToken: guestSocketToken,
        snapshot: getSessionSnapshot(session.id),
        shareUrl,
      });
    } catch (error) {
      console.error("Failed to join game:", error);
      return c.json({ error: (error as Error).message ?? "Join failed" }, 400);
    }
  })
  .post("/:id/ready", zValidator("json", readySchema), async (c) => {
    try {
      const { id } = c.req.param();
      const parsed = c.req.valid("json");
      const resolved = resolveSessionForToken({ id, token: parsed.token });
      if (!resolved || resolved.player.role !== "host") {
        return c.json({ error: "Invalid host token" }, 403);
      }
      markHostReady(id);
      return c.json({ success: true, snapshot: getSessionSnapshot(id) });
    } catch (error) {
      console.error("Failed to mark host ready:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  });
