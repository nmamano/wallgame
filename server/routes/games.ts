import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  cancelGameSession,
  createGameSession,
  getSession,
  getSessionSnapshot,
  getSerializedState,
  joinGameSession,
  markHostReady,
  resolveGameAccess,
  resolveSessionForToken,
  listMatchmakingGames,
  listLiveGames,
  setBotCompositeId,
  type PlayerConfigType,
} from "../games/store";
import {
  createGameSchema,
  joinGameSchema,
  readySchema,
  getGameSessionQuerySchema,
  pastGamesQuerySchema,
  botsQuerySchema,
  createBotGameSchema,
} from "../../shared/contracts/games";
import type { PlayerAppearance } from "../../shared/domain/game-types";
import type { BotAppearance } from "../../shared/contracts/custom-bot-protocol";
import { getOptionalUserMiddleware } from "../kinde";
import { getRatingForAuthUser } from "../db/rating-helpers";
import { sendMatchStatus } from "./game-socket";
import {
  getRandomShowcaseGame,
  getReplayGame,
  queryPastGames,
} from "../db/game-queries";
import {
  getMatchingBots,
  getRecommendedBots,
  getBotByCompositeId,
  addActiveGame,
} from "../games/custom-bot-store";
import { queueBotMoveRequest } from "./custom-bot-socket";

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
  // Get list of in-progress games for spectating
  .get("/live", (c) => {
    try {
      const games = listLiveGames(100);
      return c.json({ games });
    } catch (error) {
      console.error("Failed to list live games:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .get("/showcase", async (c) => {
    try {
      const replay = await getRandomShowcaseGame();
      if (!replay) {
        return c.json({ error: "No showcase games available" }, 404);
      }
      return c.json({
        matchStatus: replay.matchStatus,
        state: replay.state,
      });
    } catch (error) {
      console.error("Failed to fetch showcase game:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .get("/past", zValidator("query", pastGamesQuerySchema), async (c) => {
    try {
      const query = c.req.valid("query");
      const player1 = query.player1?.trim().toLowerCase();
      const player2 = query.player2?.trim().toLowerCase();
      const response = await queryPastGames({
        page: query.page,
        pageSize: query.pageSize,
        variant: query.variant,
        rated: query.rated,
        timeControl: query.timeControl,
        boardSize: query.boardSize,
        minElo: query.minElo,
        maxElo: query.maxElo,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        player1,
        player2,
      });
      return c.json(response);
    } catch (error) {
      console.error("Failed to query past games:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .post(
    "/",
    getOptionalUserMiddleware,
    zValidator("json", createGameSchema),
    async (c) => {
      try {
        const parsed = c.req.valid("json");
        const user = c.get("user"); // May be undefined for guests
        console.log(
          "[games] POST /api/games body:",
          JSON.stringify(parsed, null, 2),
        );

        // Look up ELO if user is authenticated
        let hostElo: number | undefined;
        if (user?.id) {
          const timeControlPreset = parsed.config.timeControl.preset ?? "rapid";
          hostElo = await getRatingForAuthUser(
            user.id,
            parsed.config.variant,
            timeControlPreset,
          );
        }

        // Map the joinerConfig type from schema to store type
        const joinerConfig = parsed.joinerConfig
          ? {
              type: parsed.joinerConfig.type as PlayerConfigType,
              displayName: parsed.joinerConfig.displayName,
            }
          : undefined;

        const { session, hostToken, hostSocketToken } = createGameSession({
          config: parsed.config,
          matchType: parsed.matchType,
          hostDisplayName: parsed.hostDisplayName,
          hostAppearance: parsed.hostAppearance,
          hostIsPlayer1: parsed.hostIsPlayer1,
          hostAuthUserId: user?.id,
          hostElo,
          joinerConfig,
        });

        console.info("[games] created session", {
          gameId: session.id,
          storedMatchType: session.matchType,
          requestedMatchType: parsed.matchType,
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
    },
  )
  .post("/:id/abort", zValidator("json", readySchema), (c) => {
    try {
      const { id } = c.req.param();
      const parsed = c.req.valid("json");
      const session = cancelGameSession({ id, token: parsed.token });
      if (session.matchType === "matchmaking") {
        broadcastLobbyUpdate();
      }
      sendMatchStatus(id);
      return c.json({
        success: true,
        snapshot: getSessionSnapshot(id),
      });
    } catch (error) {
      console.error("Failed to abort game:", error);
      return c.json({ error: (error as Error).message ?? "Abort failed" }, 400);
    }
  })
  .get(
    "/:id",
    getOptionalUserMiddleware,
    zValidator("query", getGameSessionQuerySchema),
    async (c) => {
      try {
        const { id } = c.req.param();
        const { token } = c.req.valid("query");
        const user = c.get("user");
        const origin = process.env.FRONTEND_URL ?? new URL(c.req.url).origin;
        const shareUrl = `${origin}/game/${id}`;
        const access = resolveGameAccess({
          id,
          token,
          authUserId: user?.id,
        });

        if (access.kind === "not-found") {
          const replay = await getReplayGame(id);
          if (!replay) {
            return c.json({ kind: "not-found" });
          }
          return c.json({
            kind: "replay",
            gameId: id,
            matchType: replay.matchStatus.matchType,
            matchStatus: replay.matchStatus,
            state: replay.state,
            shareUrl,
            views: replay.views,
          });
        }

        const matchStatus = getSessionSnapshot(id);
        const matchType = matchStatus.matchType;
        console.info("[resolve-access] response", {
          gameId: id,
          accessKind: access.kind,
          lifecycle: matchStatus.status,
          matchType,
        });

        if (access.kind === "player") {
          return c.json({
            kind: "player",
            gameId: id,
            matchType,
            seat: {
              role: access.player.role,
              playerId: access.player.playerId,
              token: access.player.token,
              socketToken: access.player.socketToken,
            },
            matchStatus,
            state: getSerializedState(id),
            shareUrl,
          });
        }

        if (access.kind === "spectator") {
          return c.json({
            kind: "spectator",
            gameId: id,
            matchType,
            matchStatus,
            state: getSerializedState(id),
            shareUrl,
          });
        }

        if (access.kind === "waiting") {
          return c.json({
            kind: "waiting",
            gameId: id,
            reason: access.reason ?? ("seat-not-filled" as const),
            matchStatus,
            shareUrl,
          });
        }

        if (access.kind === "replay") {
          const replay = await getReplayGame(id);
          if (replay) {
            return c.json({
              kind: "replay",
              gameId: id,
              matchType: replay.matchStatus.matchType,
              matchStatus: replay.matchStatus,
              state: replay.state,
              shareUrl,
              views: replay.views,
            });
          }

          return c.json({
            kind: "replay",
            gameId: id,
            matchType,
            matchStatus,
            state: getSerializedState(id),
            shareUrl,
          });
        }

        return c.json({ kind: "not-found" });
      } catch (error) {
        console.error("Failed to resolve game access:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    },
  )
  .post(
    "/:id/join",
    getOptionalUserMiddleware,
    zValidator("json", joinGameSchema),
    async (c) => {
      try {
        const { id } = c.req.param();
        const parsed = c.req.valid("json");
        const user = c.get("user"); // May be undefined for guests

        // Get session to know what variant/time control to look up
        const existingSession = getSession(id);

        // Look up ELO if user is authenticated
        let joinerElo: number | undefined;
        if (user?.id) {
          const timeControlPreset =
            existingSession.config.timeControl.preset ?? "rapid";
          joinerElo = await getRatingForAuthUser(
            user.id,
            existingSession.config.variant,
            timeControlPreset,
          );
        }

        const joinResult = joinGameSession({
          id,
          displayName: parsed.displayName,
          appearance: parsed.appearance,
          authUserId: user?.id,
          elo: joinerElo,
        });
        const session = joinResult.session;
        const origin = process.env.FRONTEND_URL ?? new URL(c.req.url).origin;

        // Broadcast to lobby if this was a matchmaking game (it's now full)
        if (session.matchType === "matchmaking") {
          broadcastLobbyUpdate();
        }

        // Broadcast match-status to all connected WebSocket clients
        // so they receive the updated joiner appearance
        sendMatchStatus(id);

        const shareUrl = `${origin}/game/${session.id}`;

        const snapshot = getSessionSnapshot(session.id);

        if (joinResult.kind === "player") {
          return c.json({
            role: "player" as const,
            seat: joinResult.player.role,
            playerId: joinResult.player.playerId,
            token: joinResult.player.token,
            socketToken: joinResult.player.socketToken,
            snapshot,
            shareUrl,
          });
        }

        return c.json({
          role: "spectator" as const,
          snapshot,
          shareUrl,
        });
      } catch (error) {
        console.error("Failed to join game:", error);
        return c.json(
          { error: (error as Error).message ?? "Join failed" },
          400,
        );
      }
    },
  )
  .post("/:id/ready", zValidator("json", readySchema), (c) => {
    try {
      const { id } = c.req.param();
      const parsed = c.req.valid("json");
      const resolved = resolveSessionForToken({ id, token: parsed.token });
      if (resolved?.player.role !== "host") {
        return c.json({ error: "Invalid host token" }, 403);
      }
      markHostReady(id);
      return c.json({ success: true, snapshot: getSessionSnapshot(id) });
    } catch (error) {
      console.error("Failed to mark host ready:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

// ============================================================================
// Bot Listing API (Proactive Bot Protocol v2)
// ============================================================================

export const botsRoute = new Hono()
  // Get list of available bots matching game settings
  .get("/", zValidator("query", botsQuerySchema), (c) => {
    try {
      const query = c.req.valid("query");
      const bots = getMatchingBots(
        query.variant,
        query.timeControl,
        query.boardWidth,
        query.boardHeight,
      );
      return c.json({ bots });
    } catch (error) {
      console.error("Failed to list bots:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  // Get recommended bots for current settings
  .get("/recommended", zValidator("query", botsQuerySchema), (c) => {
    try {
      const query = c.req.valid("query");
      // getRecommendedBots takes variant and timeControl (username is optional for private bots)
      const bots = getRecommendedBots(query.variant, query.timeControl);
      return c.json({ bots });
    } catch (error) {
      console.error("Failed to list recommended bots:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  // Create a game against a specific bot
  .post(
    "/play",
    getOptionalUserMiddleware,
    zValidator("json", createBotGameSchema),
    async (c) => {
      try {
        const parsed = c.req.valid("json");
        const user = c.get("user");

        // Verify bot exists and is connected
        const bot = getBotByCompositeId(parsed.botId);
        if (!bot) {
          return c.json({ error: "Bot not found or not connected" }, 404);
        }

        // Look up host ELO if authenticated
        let hostElo: number | undefined;
        if (user?.id) {
          const timeControlPreset = parsed.config.timeControl.preset ?? "rapid";
          hostElo = await getRatingForAuthUser(
            user.id,
            parsed.config.variant,
            timeControlPreset,
          );
        }

        const joinerAppearance = mapBotAppearance(bot.appearance);

        // Create game session with bot as joiner
        const { session, hostToken, hostSocketToken } = createGameSession({
          config: {
            ...parsed.config,
            rated: false, // Bot games are unrated
          },
          matchType: "friend",
          hostDisplayName: parsed.hostDisplayName,
          hostAppearance: parsed.hostAppearance,
          hostIsPlayer1: parsed.hostIsPlayer1 ?? Math.random() < 0.5,
          hostAuthUserId: user?.id,
          hostElo,
          joinerConfig: {
            type: "bot",
            displayName: bot.name,
          },
        });

        session.players.joiner.appearance = joinerAppearance;

        // Set bot composite ID on joiner seat
        setBotCompositeId(session.id, "joiner", parsed.botId);

        // Mark joiner as ready (bot is always ready)
        session.players.joiner.ready = true;
        session.status = "ready";

        // Track active bot game for response validation and disconnect handling
        addActiveGame(
          parsed.botId,
          session.id,
          session.players.joiner.playerId,
          session.players.host.displayName,
        );

        console.info("[games] created bot game", {
          gameId: session.id,
          botId: parsed.botId,
          botName: bot.name,
        });

        // If bot is Player 1 (goes first), queue move request
        if (session.players.joiner.playerId === 1) {
          queueBotMoveRequest(
            parsed.botId,
            session.id,
            session.players.joiner.playerId,
            session.players.host.displayName,
          );
        }

        const origin = process.env.FRONTEND_URL ?? new URL(c.req.url).origin;
        const shareUrl = `${origin}/game/${session.id}`;

        return c.json(
          {
            gameId: session.id,
            token: hostToken,
            socketToken: hostSocketToken,
            role: "host" as const,
            playerId: session.players.host.playerId,
            shareUrl,
          },
          201,
        );
      } catch (error) {
        console.error("Failed to create bot game:", error);
        return c.json({ error: "Internal server error" }, 500);
      }
    },
  );

const mapBotAppearance = (
  appearance: BotAppearance | undefined,
): PlayerAppearance => {
  if (!appearance) {
    return {};
  }

  const result: PlayerAppearance = {};
  const color = appearance.color?.trim();
  const catSkin = appearance.catStyle?.trim();
  const mouseSkin = appearance.mouseStyle?.trim();
  const homeSkin = appearance.homeStyle?.trim();

  if (color) result.pawnColor = color;
  if (catSkin) result.catSkin = catSkin;
  if (mouseSkin) result.mouseSkin = mouseSkin;
  if (homeSkin) result.homeSkin = homeSkin;

  return result;
};
