/**
 * Bot Store (Proactive Bot Protocol V3)
 *
 * Manages bot client connections and their registered bots.
 * Bot clients connect proactively and register bots; users discover and play against them.
 *
 * Key concepts:
 * - A bot client (identified by clientId) can serve multiple bots
 * - Each bot has a unique botId within its client
 * - V3: Game sessions are managed by bgs-store.ts (Bot Game Sessions)
 * - V3: No request queue - BGS uses direct request/response per session
 */

import type { ServerWebSocket } from "bun";
import type { PlayerId, Variant } from "../../shared/domain/game-types";
import type {
  BotConfig,
  BotAppearance,
  VariantConfig,
  ListedBot,
  RecommendedBotEntry,
} from "../../shared/contracts/custom-bot-protocol";
import { db } from "../db";
import { builtInBotsTable } from "../db/schema/built-in-bots";

// ============================================================================
// Types
// ============================================================================

/**
 * V3: Bot client connection.
 * Request queues are removed - BGS sessions handle request/response directly.
 */
export interface BotClientConnection {
  clientId: string;
  ws: ServerWebSocket<unknown>;
  bots: Map<string, RegisteredBot>;
  attachedAt: number;
  invalidMessageCount: number;
  /** V3: Set of active BGS IDs this client is handling */
  activeBgsSessions: Set<string>;
}

export interface RegisteredBot {
  botId: string;
  clientId: string;
  name: string;
  isOfficial: boolean;
  username: string | null; // null = public bot
  appearance: BotAppearance;
  variants: Partial<Record<Variant, VariantConfig>>;
  /** Active games this bot is playing */
  activeGames: Map<string, ActiveBotGame>;
}

export interface ActiveBotGame {
  gameId: string;
  playerId: PlayerId;
  opponentName: string;
  startedAt: number;
}

// ============================================================================
// Storage
// ============================================================================

/** Map from clientId -> client connection */
const clients = new Map<string, BotClientConnection>();

/** Index: compositeId (clientId:botId) -> RegisteredBot */
const botIndex = new Map<string, RegisteredBot>();

/** Maximum number of connected clients */
const MAX_CLIENTS = 10;

const makeCompositeId = (clientId: string, botId: string): string =>
  `${clientId}:${botId}`;

// ============================================================================
// Client Management
// ============================================================================

/**
 * Persist bots to the built_in_bots table for game history tracking.
 * This is fire-and-forget - we don't wait for it to complete.
 * The botId stored is the composite ID (clientId:botId) to uniquely identify bots across clients.
 */
const persistBotsToDatabase = async (
  clientId: string,
  bots: BotConfig[],
  officialToken: string | undefined,
): Promise<void> => {
  if (bots.length === 0) return;

  try {
    for (const bot of bots) {
      const compositeId = makeCompositeId(clientId, bot.botId);
      const isOfficial = bot.officialToken === officialToken && !!officialToken;
      await db
        .insert(builtInBotsTable)
        .values({
          botId: compositeId,
          displayName: bot.name,
          isOfficial,
          metadata: { username: bot.username, appearance: bot.appearance },
        })
        .onConflictDoUpdate({
          target: builtInBotsTable.botId,
          set: {
            displayName: bot.name,
            isOfficial,
            metadata: { username: bot.username, appearance: bot.appearance },
          },
        });
    }
    console.info("[bot-store] bots persisted to database", {
      compositeIds: bots.map((b) => makeCompositeId(clientId, b.botId)),
    });
  } catch (error) {
    console.error("[bot-store] failed to persist bots to database", {
      error,
      compositeIds: bots.map((b) => makeCompositeId(clientId, b.botId)),
    });
  }
};

/**
 * Register a new client and its bots.
 * Returns the existing client if clientId is already connected (for force-disconnect).
 */
export const registerClient = (
  clientId: string,
  bots: BotConfig[],
  ws: ServerWebSocket<unknown>,
  officialToken: string | undefined,
):
  | { success: true; client: BotClientConnection }
  | { success: false; existingClient: BotClientConnection } => {
  // Check if client already exists
  const existing = clients.get(clientId);
  if (existing) {
    return { success: false, existingClient: existing };
  }

  const connection: BotClientConnection = {
    clientId,
    ws,
    bots: new Map(),
    attachedAt: Date.now(),
    invalidMessageCount: 0,
    activeBgsSessions: new Set(),
  };

  // Register each bot
  for (const botConfig of bots) {
    const isOfficial =
      botConfig.officialToken === officialToken && !!officialToken;
    const registeredBot: RegisteredBot = {
      botId: botConfig.botId,
      clientId,
      name: botConfig.name,
      isOfficial,
      username: botConfig.username,
      appearance: botConfig.appearance ?? {},
      variants: botConfig.variants,
      activeGames: new Map(),
    };

    connection.bots.set(botConfig.botId, registeredBot);
    botIndex.set(makeCompositeId(clientId, botConfig.botId), registeredBot);
  }

  clients.set(clientId, connection);
  console.info("[bot-store] client registered", {
    clientId,
    botCount: bots.length,
    botNames: bots.map((b) => b.name),
  });

  // Persist bots to database (fire-and-forget)
  void persistBotsToDatabase(clientId, bots, officialToken);

  return { success: true, client: connection };
};

/**
 * Force-replace an existing client connection.
 * Used when a new connection arrives with the same clientId.
 */
export const replaceClient = (
  clientId: string,
  bots: BotConfig[],
  ws: ServerWebSocket<unknown>,
  officialToken: string | undefined,
): BotClientConnection => {
  // First unregister old bots
  const existing = clients.get(clientId);
  if (existing) {
    for (const [botId] of existing.bots) {
      botIndex.delete(makeCompositeId(clientId, botId));
    }
    clients.delete(clientId);
  }

  // Then register new client
  const result = registerClient(clientId, bots, ws, officialToken);
  if (result.success) {
    return result.client;
  }
  // Should never happen since we just deleted the old one
  throw new Error("Failed to register client after replacement");
};

/**
 * Unregister a client and all its bots.
 */
export const unregisterClient = (clientId: string): RegisteredBot[] | null => {
  const client = clients.get(clientId);
  if (!client) return null;

  const bots: RegisteredBot[] = [];
  for (const [botId, bot] of client.bots) {
    bots.push(bot);
    botIndex.delete(makeCompositeId(clientId, botId));
  }

  clients.delete(clientId);
  console.info("[bot-store] client unregistered", {
    clientId,
    botCount: bots.length,
  });

  return bots;
};

/**
 * Get client by clientId.
 */
export const getClient = (
  clientId: string,
): BotClientConnection | undefined => {
  return clients.get(clientId);
};

/**
 * Get the number of connected clients.
 */
export const getClientCount = (): number => {
  return clients.size;
};

/**
 * Check if we've reached the maximum client limit.
 */
export const isAtClientLimit = (): boolean => {
  return clients.size >= MAX_CLIENTS;
};

// ============================================================================
// Bot Lookup
// ============================================================================

/**
 * Get a bot by composite ID (clientId:botId).
 */
export const getBotByCompositeId = (
  compositeId: string,
): RegisteredBot | undefined => {
  return botIndex.get(compositeId);
};

/**
 * Get a bot by clientId and botId.
 */
export const getBot = (
  clientId: string,
  botId: string,
): RegisteredBot | undefined => {
  return botIndex.get(makeCompositeId(clientId, botId));
};

/**
 * Get the client that owns a bot.
 */
export const getClientForBot = (
  compositeId: string,
): BotClientConnection | undefined => {
  const bot = botIndex.get(compositeId);
  if (!bot) return undefined;
  return clients.get(bot.clientId);
};

// ============================================================================
// Bot Discovery
// ============================================================================

/**
 * Get all bots that support the given game configuration.
 * V3: Filters by variant and optionally board size.
 * Time control filtering removed - bot games have no time control in V3.
 */
export const getMatchingBots = (
  variant: Variant,
  boardWidth?: number,
  boardHeight?: number,
  username?: string,
): ListedBot[] => {
  const results: ListedBot[] = [];

  for (const [compositeId, bot] of botIndex) {
    // Check visibility
    if (bot.username !== null) {
      if (!username || bot.username.toLowerCase() !== username.toLowerCase()) {
        continue; // Private bot, user doesn't match
      }
    }

    // Check if bot supports this variant
    const variantConfig = bot.variants[variant];
    if (!variantConfig) continue;

    // Check board dimensions if specified
    if (boardWidth !== undefined) {
      if (
        boardWidth < variantConfig.boardWidth.min ||
        boardWidth > variantConfig.boardWidth.max
      ) {
        continue;
      }
    }
    if (boardHeight !== undefined) {
      if (
        boardHeight < variantConfig.boardHeight.min ||
        boardHeight > variantConfig.boardHeight.max
      ) {
        continue;
      }
    }

    // V3: Check client is still connected
    const client = clients.get(bot.clientId);
    if (!client) {
      continue;
    }

    results.push({
      id: compositeId,
      clientId: bot.clientId,
      botId: bot.botId,
      name: bot.name,
      isOfficial: bot.isOfficial,
      appearance: bot.appearance,
      variants: bot.variants,
    });
  }

  // Sort: official first, then by name
  results.sort((a, b) => {
    if (a.isOfficial !== b.isOfficial) {
      return a.isOfficial ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return results;
};

/**
 * Get recommended bot entries for the given variant.
 * V3: Time control filtering removed - bot games have no time control.
 * Returns bots with their recommended settings.
 */
export const getRecommendedBots = (
  variant: Variant,
  username?: string,
): RecommendedBotEntry[] => {
  const results: RecommendedBotEntry[] = [];

  for (const [compositeId, bot] of botIndex) {
    // Check visibility
    if (bot.username !== null) {
      if (!username || bot.username.toLowerCase() !== username.toLowerCase()) {
        continue;
      }
    }

    // Check if bot supports this variant
    const variantConfig = bot.variants[variant];
    if (!variantConfig) continue;

    // V3: Check client is still connected
    const client = clients.get(bot.clientId);
    if (!client) {
      continue;
    }

    // Add an entry for each recommended setting
    for (const rec of variantConfig.recommended) {
      results.push({
        bot: {
          id: compositeId,
          clientId: bot.clientId,
          botId: bot.botId,
          name: bot.name,
          isOfficial: bot.isOfficial,
          appearance: bot.appearance,
          variants: bot.variants,
        },
        boardWidth: rec.boardWidth,
        boardHeight: rec.boardHeight,
      });
    }
  }

  // Sort: official first, then by name, then by board size
  results.sort((a, b) => {
    if (a.bot.isOfficial !== b.bot.isOfficial) {
      return a.bot.isOfficial ? -1 : 1;
    }
    const nameCompare = a.bot.name.localeCompare(b.bot.name);
    if (nameCompare !== 0) return nameCompare;
    // Sort by board size (smaller first)
    const sizeA = a.boardWidth * a.boardHeight;
    const sizeB = b.boardWidth * b.boardHeight;
    return sizeA - sizeB;
  });

  return results;
};

/**
 * Find an official bot that can evaluate positions for the given game.
 * Returns the first matching official bot, or null if none available.
 * Used by the evaluation bar feature.
 */
export const findEvalBot = (
  variant: Variant,
  boardWidth: number,
  boardHeight: number,
): { compositeId: string; bot: RegisteredBot } | null => {
  for (const [compositeId, bot] of botIndex) {
    // Only official bots can provide evaluations
    if (!bot.isOfficial) continue;

    // Check if bot supports this variant
    const variantConfig = bot.variants[variant];
    if (!variantConfig) continue;

    // Check board dimensions
    if (
      boardWidth < variantConfig.boardWidth.min ||
      boardWidth > variantConfig.boardWidth.max
    ) {
      continue;
    }
    if (
      boardHeight < variantConfig.boardHeight.min ||
      boardHeight > variantConfig.boardHeight.max
    ) {
      continue;
    }

    // Check that the client is still connected
    const client = clients.get(bot.clientId);
    if (!client) continue;

    return { compositeId, bot };
  }

  return null;
};

// ============================================================================
// Active Game Management
// ============================================================================

/**
 * Register an active game for a bot.
 */
export const addActiveGame = (
  compositeId: string,
  gameId: string,
  playerId: PlayerId,
  opponentName: string,
): void => {
  const bot = botIndex.get(compositeId);
  if (!bot) return;

  bot.activeGames.set(gameId, {
    gameId,
    playerId,
    opponentName,
    startedAt: Date.now(),
  });

  console.info("[bot-store] active game added", {
    compositeId,
    gameId,
    playerId,
  });
};

/**
 * Remove an active game from a bot.
 */
export const removeActiveGame = (compositeId: string, gameId: string): void => {
  const bot = botIndex.get(compositeId);
  if (!bot) return;

  bot.activeGames.delete(gameId);
  console.info("[bot-store] active game removed", { compositeId, gameId });
};

/**
 * Get the active game for a bot in a specific game.
 */
export const getActiveGame = (
  compositeId: string,
  gameId: string,
): ActiveBotGame | undefined => {
  const bot = botIndex.get(compositeId);
  if (!bot) return undefined;
  return bot.activeGames.get(gameId);
};

/**
 * Get all active games for a client's bots.
 */
export const getActiveGamesForClient = (
  clientId: string,
): { compositeId: string; game: ActiveBotGame }[] => {
  const client = clients.get(clientId);
  if (!client) return [];

  const games: { compositeId: string; game: ActiveBotGame }[] = [];
  for (const [botId, bot] of client.bots) {
    const compositeId = makeCompositeId(clientId, botId);
    for (const game of bot.activeGames.values()) {
      games.push({ compositeId, game });
    }
  }
  return games;
};

// ============================================================================
// V3 BGS Session Tracking
// ============================================================================

/**
 * Add a BGS to a client's active sessions.
 */
export const addClientBgsSession = (
  clientId: string,
  bgsId: string,
): boolean => {
  const client = clients.get(clientId);
  if (!client) return false;
  client.activeBgsSessions.add(bgsId);
  return true;
};

/**
 * Remove a BGS from a client's active sessions.
 */
export const removeClientBgsSession = (
  clientId: string,
  bgsId: string,
): boolean => {
  const client = clients.get(clientId);
  if (!client) return false;
  return client.activeBgsSessions.delete(bgsId);
};

/**
 * Check if a client has an active BGS.
 */
export const hasClientBgsSession = (
  clientId: string,
  bgsId: string,
): boolean => {
  const client = clients.get(clientId);
  if (!client) return false;
  return client.activeBgsSessions.has(bgsId);
};

/**
 * Get all active BGS IDs for a client.
 */
export const getClientBgsSessions = (clientId: string): string[] => {
  const client = clients.get(clientId);
  if (!client) return [];
  return Array.from(client.activeBgsSessions);
};

// ============================================================================
// Abuse Tracking
// ============================================================================

/**
 * Increment invalid message count for a game.
 * Returns the new count.
 */
export const incrementInvalidMessageCount = (clientId: string): number => {
  const client = clients.get(clientId);
  if (!client) return 0;

  client.invalidMessageCount += 1;
  return client.invalidMessageCount;
};

/**
 * Reset invalid message count.
 */
export const resetInvalidMessageCount = (clientId: string): void => {
  const client = clients.get(clientId);
  if (client) {
    client.invalidMessageCount = 0;
  }
};

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Clean up stale connections.
 * Should be called periodically.
 */
export const cleanupStaleEntries = (
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): void => {
  const now = Date.now();
  let clientsCleaned = 0;

  for (const [clientId, client] of clients.entries()) {
    if (now - client.attachedAt > maxAgeMs) {
      unregisterClient(clientId);
      clientsCleaned++;
    }
  }

  if (clientsCleaned > 0) {
    console.info("[bot-store] cleanup completed", { clientsCleaned });
  }
};

// ============================================================================
// Debug / Testing
// ============================================================================

/**
 * Clear all data (for testing).
 */
export const clearAll = (): void => {
  clients.clear();
  botIndex.clear();
};

/**
 * Get all clients (for debugging).
 */
export const getAllClients = (): BotClientConnection[] => {
  return Array.from(clients.values());
};

/**
 * Get all bots (for debugging).
 */
export const getAllBots = (): RegisteredBot[] => {
  return Array.from(botIndex.values());
};
