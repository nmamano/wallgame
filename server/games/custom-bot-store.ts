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
import {
  isCustomSetupVariant,
  type PlayerId,
  type Variant,
} from "../../shared/domain/game-types";
import {
  botCapabilityVariant,
  botSupportsGameConfiguration,
  normalizeBotVariantCapabilities,
} from "../../shared/domain/bot-capability";
import type {
  BotConfig,
  BotAppearance,
  BotPlacement,
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
  /**
   * Set while the client's websocket is down but within the disconnect grace
   * period. Cleared on reattach (replaceClient). While set, the client's bots
   * are hidden from listings, cannot start new games, and report their seats
   * as disconnected — but their active games survive.
   */
  disconnectedAt?: number;
  /**
   * Ownership token for the pending grace-expiry teardown. A teardown may
   * only finalize the client if its generation still matches; a reattach
   * clears it.
   */
  graceGeneration?: number;
}

export interface RegisteredBot {
  botId: string;
  clientId: string;
  name: string;
  isOfficial: boolean;
  /**
   * May answer for the site: the evaluation bar's best move, and playing a
   * puzzle. Granted only to a bot that is ALSO official, so the trust decision
   * still rests entirely on the token.
   */
  isAnalysisBot: boolean;
  placement: BotPlacement;
  /** Ascending list position, gentlest first. Undefined sorts last. */
  listOrder: number | undefined;
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
      // `&&`, not the declaration alone: the config field is a request and the
      // token is the authority. A community client can put `analysis: true` in
      // its own file and it buys nothing.
      isAnalysisBot: isOfficial && botConfig.analysis === true,
      placement: botConfig.placement ?? "opponent",
      listOrder: botConfig.listOrder,
      username: botConfig.username,
      appearance: botConfig.appearance ?? {},
      variants: normalizeBotVariantCapabilities(botConfig.variants),
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
): {
  client: BotClientConnection;
  /**
   * Composite ids of bots that the old registration served but the new
   * attach no longer declares. The caller must end their BGS sessions and
   * reject their pending resolvers.
   */
  orphanedBotCompositeIds: string[];
  /**
   * Active games of those orphaned bots. The caller must resign these —
   * they must not survive without a serving bot.
   */
  orphanedGames: { compositeId: string; game: ActiveBotGame }[];
} => {
  // Snapshot the old registration's per-bot active games and unregister it.
  const existing = clients.get(clientId);
  const previousBots = new Map<string, RegisteredBot>();
  const previousBgsSessions = new Set<string>();
  if (existing) {
    for (const [botId, bot] of existing.bots) {
      previousBots.set(botId, bot);
      botIndex.delete(makeCompositeId(clientId, botId));
    }
    for (const bgsId of existing.activeBgsSessions) {
      previousBgsSessions.add(bgsId);
    }
    clients.delete(clientId);
  }

  // Then register new client
  const result = registerClient(clientId, bots, ws, officialToken);
  if (!result.success) {
    // Should never happen since we just deleted the old one
    throw new Error("Failed to register client after replacement");
  }

  // Carry active games forward for bots present in BOTH registrations, and
  // collect orphans for bots the new attach dropped. The BGS-session set is
  // carried whole; the caller prunes orphaned bots' sessions when it ends
  // their BGS.
  const orphanedBotCompositeIds: string[] = [];
  const orphanedGames: { compositeId: string; game: ActiveBotGame }[] = [];
  for (const [botId, oldBot] of previousBots) {
    const newBot = result.client.bots.get(botId);
    if (newBot) {
      for (const [gameId, game] of oldBot.activeGames) {
        newBot.activeGames.set(gameId, game);
      }
    } else {
      const compositeId = makeCompositeId(clientId, botId);
      orphanedBotCompositeIds.push(compositeId);
      for (const game of oldBot.activeGames.values()) {
        orphanedGames.push({ compositeId, game });
      }
    }
  }
  for (const bgsId of previousBgsSessions) {
    result.client.activeBgsSessions.add(bgsId);
  }

  return { client: result.client, orphanedBotCompositeIds, orphanedGames };
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
 * Mark a client as disconnected (websocket down, grace period running).
 * The generation token establishes ownership of the eventual teardown.
 * Returns false if the client is not registered.
 */
export const markClientDisconnected = (
  clientId: string,
  graceGeneration: number,
): boolean => {
  const client = clients.get(clientId);
  if (!client) return false;
  client.disconnectedAt = Date.now();
  client.graceGeneration = graceGeneration;
  return true;
};

/**
 * True while the client exists but its websocket is down (grace period).
 */
export const isClientIdInGrace = (clientId: string): boolean => {
  const client = clients.get(clientId);
  return !!client && client.disconnectedAt !== undefined;
};

/**
 * Grace check by bot composite id ("clientId:botId") — the centralized
 * predicate for the play route, listing filters, seat projection, and the
 * quiet-bail failure paths.
 */
export const isBotClientInGrace = (botCompositeId: string): boolean => {
  const clientId = botCompositeId.split(":")[0];
  return isClientIdInGrace(clientId);
};

/**
 * True when the bot's client is registered AND its websocket is up.
 * Used for seat "connected" projection: a client in grace exists but is
 * not connected.
 */
export const isBotClientConnected = (botCompositeId: string): boolean => {
  const clientId = botCompositeId.split(":")[0];
  const client = clients.get(clientId);
  return !!client && client.disconnectedAt === undefined;
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

/** The public shape of a registered bot. One builder, so the two listings
 *  below cannot come to disagree about what a bot looks like. */
const toListedBot = (compositeId: string, bot: RegisteredBot): ListedBot => ({
  id: compositeId,
  clientId: bot.clientId,
  botId: bot.botId,
  name: bot.name,
  isOfficial: bot.isOfficial,
  isAnalysisBot: bot.isAnalysisBot,
  placement: bot.placement,
  appearance: bot.appearance,
  variants: bot.variants,
});

/**
 * An absent `listOrder` sorts last rather than first, because defaulting to
 * zero would put every bot that never thought about it ahead of the ones we
 * deliberately placed.
 *
 * Note what this does NOT do: `listOrder` is ungated, so a community bot can
 * send any number it likes. It cannot reach our ladder with it - the
 * official-first comparison below runs first and no value survives it - so the
 * number only ever orders a client's bots among the other community ones.
 */
const LAST_IN_LIST = Number.MAX_SAFE_INTEGER;

/**
 * A row of a listing together with the key it sorts by. The key rides
 * alongside rather than on `ListedBot` itself: it is how the server decided to
 * order the array, not a property of the bot that any client needs.
 */
interface SortableRow<T> {
  row: T;
  isOfficial: boolean;
  listOrder: number;
  name: string;
}

/**
 * The order players see, and the first row is the one that matters: it is what
 * a first-time visitor plays. Ours before other people's, then the ladder in
 * the order we chose, then alphabetical so the result is stable.
 */
const compareRows = <T>(a: SortableRow<T>, b: SortableRow<T>): number => {
  if (a.isOfficial !== b.isOfficial) return a.isOfficial ? -1 : 1;
  if (a.listOrder !== b.listOrder) return a.listOrder - b.listOrder;
  return a.name.localeCompare(b.name);
};

const sortableRow = <T>(row: T, bot: RegisteredBot): SortableRow<T> => ({
  row,
  isOfficial: bot.isOfficial,
  listOrder: bot.listOrder ?? LAST_IN_LIST,
  name: bot.name,
});

/**
 * Get all bots that support the given game configuration.
 * V3: Filters by variant and optionally board size.
 * Time control filtering removed - bot games have no time control in V3.
 */
export const getMatchingBots = (
  variant: Variant,
  randomStart: boolean,
  boardWidth?: number,
  boardHeight?: number,
  username?: string,
  placement: BotPlacement = "opponent",
): ListedBot[] => {
  const results: SortableRow<ListedBot>[] = [];

  for (const [compositeId, bot] of botIndex) {
    if (bot.placement !== placement) continue;
    if (isCustomSetupVariant(variant) && !bot.isOfficial) continue;
    // Check visibility
    if (bot.username !== null) {
      if (!username || bot.username.toLowerCase() !== username.toLowerCase()) {
        continue; // Private bot, user doesn't match
      }
    }

    // Does this bot declare this variant, at this size? Same rule the launch
    // path re-asks later, and the same one the client uses to decide what a
    // puzzle card offers — see shared/domain/bot-capability.ts.
    if (
      !botSupportsGameConfiguration(bot.variants, {
        variant,
        randomStart,
        boardWidth,
        boardHeight,
      })
    ) {
      continue;
    }

    // V3: Check client is still connected (a client in disconnect grace
    // keeps its games but is hidden from listings)
    const client = clients.get(bot.clientId);
    if (!client || client.disconnectedAt !== undefined) {
      continue;
    }

    results.push(sortableRow(toListedBot(compositeId, bot), bot));
  }

  results.sort(compareRows);

  return results.map(({ row }) => row);
};

/**
 * Get recommended bot entries for the given variant.
 * V3: Time control filtering removed - bot games have no time control.
 * Returns bots with their recommended settings.
 */
export const getRecommendedBots = (
  variant: Variant,
  randomStart: boolean,
  username?: string,
  placement: BotPlacement = "opponent",
): RecommendedBotEntry[] => {
  const results: SortableRow<RecommendedBotEntry>[] = [];

  for (const [compositeId, bot] of botIndex) {
    if (bot.placement !== placement) continue;
    if (isCustomSetupVariant(variant) && !bot.isOfficial) continue;
    // Check visibility
    if (bot.username !== null) {
      if (!username || bot.username.toLowerCase() !== username.toLowerCase()) {
        continue;
      }
    }

    // Check if bot supports this variant
    const variantConfig =
      bot.variants[botCapabilityVariant(variant, randomStart)];
    if (!variantConfig) continue;

    // V3: Check client is still connected (grace clients are hidden)
    const client = clients.get(bot.clientId);
    if (!client || client.disconnectedAt !== undefined) {
      continue;
    }

    const botEntry = toListedBot(compositeId, bot);

    if (variantConfig.recommended.length > 0) {
      // Add an entry for each recommended setting
      for (const rec of variantConfig.recommended) {
        results.push(
          sortableRow(
            {
              bot: botEntry,
              boardWidth: rec.boardWidth,
              boardHeight: rec.boardHeight,
            },
            bot,
          ),
        );
      }
    } else if (
      variantConfig.boardWidth.min === variantConfig.boardWidth.max &&
      variantConfig.boardHeight.min === variantConfig.boardHeight.max
    ) {
      // The bot declared a single valid size for this variant - use it
      results.push(
        sortableRow(
          {
            bot: botEntry,
            boardWidth: variantConfig.boardWidth.min,
            boardHeight: variantConfig.boardHeight.min,
          },
          bot,
        ),
      );
    }
  }

  // One bot contributes several rows, so board size breaks the tie WITHIN a
  // bot - smaller first - after the shared comparator has placed the bot.
  results.sort((a, b) => {
    const byBot = compareRows(a, b);
    if (byBot !== 0) return byBot;
    const sizeA = a.row.boardWidth * a.row.boardHeight;
    const sizeB = b.row.boardWidth * b.row.boardHeight;
    return sizeA - sizeB;
  });

  return results.map(({ row }) => row);
};

/**
 * Find the bot that evaluates positions for the given game. Returns the first
 * matching analysis bot, or null if none is available.
 *
 * Analysis routes are unique by placement plus rules variant. Superhuman and
 * PuzzleBot may therefore both declare Classic and Standard without making
 * registration order decide which engine answers.
 *
 * It reads `isAnalysisBot` rather than `isOfficial` because those parted ways
 * when Easy Bot became official: a bot can be ours, badged as ours and listed
 * first while being the last thing that should be telling anyone the best
 * move.
 */
export const findEvalBot = (
  variant: Variant,
  boardWidth: number,
  boardHeight: number,
  placement: BotPlacement = "opponent",
): { compositeId: string; bot: RegisteredBot } | null => {
  for (const [compositeId, bot] of botIndex) {
    // Only an analysis bot can provide evaluations
    if (!bot.isAnalysisBot) continue;
    if (bot.placement !== placement) continue;

    // Check if bot supports this variant
    const variantConfig = bot.variants[botCapabilityVariant(variant, false)];
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

    // Check that the client is still connected (grace clients are hidden)
    const client = clients.get(bot.clientId);
    if (!client || client.disconnectedAt !== undefined) continue;

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
