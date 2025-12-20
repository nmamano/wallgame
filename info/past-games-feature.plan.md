# Past Games – Implementation Plan

## 0. High-Level Goals

- Persist completed games (friend or matchmaking) to the database for permanent storage.
- Show completed games on a **Past Games** page with filterable, paginated results.
- Allow users to click a past game and enter **replay mode**:
  - They see the final position by default.
  - They can navigate through the game move-by-move using controls and keyboard shortcuts.
  - They see host on the bottom, joiner on the top.
  - They cannot interact with the game (no moves, no meta-actions).
  - Chat is not preserved (grayed out with message).
- **Same URL** works across the game lifecycle: `/game/:id` serves waiting → in-progress → completed states.
- Increment view count when someone watches a past game.

### Terminology: Views vs Spectator Count

Two different metrics exist for game viewership:

| Metric | Context | Meaning | Storage |
|--------|---------|---------|---------|
| **Spectator Count** | Live games | Current viewers watching NOW (like Twitch) | In-memory, real-time |
| **Views** | Past games | Total people who have watched replay (like YouTube) | Database, persisted |

These are completely separate concepts and should not be conflated.

### Move Navigation is Universal (Client-Side) – NEW FEATURE

Move navigation (stepping through game history) will be available in **all viewing contexts**:

| Context | Can Navigate History | Can Make Moves | Notes |
|---------|---------------------|----------------|-------|
| **Player (live game)** | ✅ Yes | Only at latest position | Must return to latest move to submit a move |
| **Live spectator** | ✅ Yes | ❌ No | Can review past positions while game continues |
| **Past game replay** | ✅ Yes | ❌ No | Starts at final position by default |

**Current state:** The live spectating feature is already implemented, but it currently just follows the live position without move navigation. This feature plan includes adding move navigation to all contexts as part of the same shared implementation.

**Key points:**
- Move navigation is **purely client-side** – it does not affect the server or other viewers
- When a player/spectator navigates to a past position, they see that historical state
- The server continues to track the "real" current position
- Players must be viewing the latest position to submit their move
- New moves from the opponent will still arrive; the UI should indicate "X new moves" if viewing history

This means the move navigation UI components (⏮ ◀ ▶ ⏭, keyboard shortcuts, clickable move list) are shared across all contexts, not just past game replay.

**Implementation scope:** As part of this feature, we will:
1. Build the shared move navigation hook and UI components
2. Integrate into the existing game page controller for players
3. Integrate into the existing spectator controller
4. Use in the new replay controller for past games

---

## 1. Routes and Responsibilities

- `/past-games` (existing page, needs wiring):
  - Shows completed games from the database.
  - Backed by `GET /api/games/past` (REST with query params for filters and pagination).
  - Filters are stored in URL query params for shareability.
- `/game/:id`:
  - Player mode (existing): accessed with join/host flow using existing handshake/link.
  - Live spectator mode (existing): accessed without joining while game is in-progress.
  - **Replay mode (new)**: accessed when game is completed and no longer in memory.
- `GET /api/games/:id/replay`:
  - REST endpoint to fetch a past game from the database for replay.
  - Increments the view count.

---

## 2. Database Schema Changes

### 2.1 Change Primary Key to UUID

The current schema uses auto-incrementing integers. Change to use the session UUID as the primary key so the same URL works across the game lifecycle.

**Migration: Modify `gamesTable`**

```typescript
// server/db/schema/games.ts
export const gamesTable = pgTable("games", {
  gameId: varchar("game_id", { length: 36 }).primaryKey(), // UUID from session
  variant: varchar("variant", { length: 255 }).notNull(),
  timeControl: varchar("time_control", { length: 255 }).notNull(),
  rated: boolean("rated").notNull(),
  boardWidth: integer("board_width").notNull(),
  boardHeight: integer("board_height").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
  views: integer("views").notNull().default(0),
  movesCount: integer("moves_count").notNull().default(0),
  averageElo: integer("average_elo").notNull().default(1500), // Precomputed for sorting/filtering
});
```

**Migration: Update `gamePlayersTable`**

```typescript
// server/db/schema/game-players.ts
export const gamePlayersTable = pgTable(
  "game_players",
  {
    gameId: varchar("game_id", { length: 36 })
      .notNull()
      .references(() => gamesTable.gameId, { onDelete: "cascade" }),
    playerOrder: integer("player_order").notNull(), // 1 or 2
    playerConfigType: varchar("player_config_type", { length: 255 }).notNull(),
    userId: integer("user_id").references(() => usersTable.userId),
    botId: varchar("bot_id", { length: 255 }).references(() => builtInBotsTable.botId),
    ratingAtStart: integer("rating_at_start"),
    outcomeRank: integer("outcome_rank").notNull(), // 1 = winner, 2 = loser, 1 for both = draw
    outcomeReason: varchar("outcome_reason", { length: 255 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.gameId, table.playerOrder] })],
);
```

**Migration: Update `gameDetailsTable`**

```typescript
// server/db/schema/game-details.ts
export const gameDetailsTable = pgTable("game_details", {
  gameId: varchar("game_id", { length: 36 })
    .primaryKey()
    .references(() => gamesTable.gameId, { onDelete: "cascade" }),
  configParameters: jsonb("config_parameters"),
  moves: jsonb("moves").notNull(), // Array of move notations
});
```

### 2.2 Guest Display Names

Guests cannot set display names. The UI will display "Guest 1" and "Guest 2" based on `playerOrder`. No additional columns needed.

---

## 3. Shared Types (shared/contracts/\*)

### 3.1 PastGameSummary

A list-friendly summary for the `/past-games` table:

```typescript
// shared/contracts/games.ts
export interface PastGamePlayerSummary {
  playerOrder: 1 | 2;
  displayName: string; // Username or "Guest 1"/"Guest 2"
  rating?: number; // Rating at start of game
  isWinner: boolean;
  isDraw: boolean;
}

export interface PastGameSummary {
  id: string; // UUID
  variant: Variant;
  rated: boolean;
  timeControl: TimeControlConfig;
  boardWidth: number;
  boardHeight: number;
  players: [PastGamePlayerSummary, PastGamePlayerSummary]; // Always 2 players
  movesCount: number;
  views: number;
  averageElo: number;
  endedAt: number; // Timestamp
  outcomeReason: string; // "timeout", "resignation", "capture", etc.
}
```

### 3.2 PastGamesFilters

Query parameters for filtering:

```typescript
// shared/contracts/games.ts
export interface PastGamesFilters {
  variant?: Variant | "all";
  rated?: "yes" | "no" | "all";
  timeControl?: TimeControlPreset | "all";
  boardSize?: "small" | "medium" | "large" | "all";
  eloMin?: number;
  eloMax?: number;
  player1?: string; // Username search
  player2?: string; // Username search
  timePeriod?: "today" | "7days" | "30days" | "365days" | "all";
  page?: number;
  pageSize?: number; // Default 25
}
```

### 3.3 PastGamesResponse

Response from the past games list endpoint:

```typescript
// shared/contracts/games.ts
export interface PastGamesResponse {
  games: PastGameSummary[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}
```

### 3.4 PastGameReplayResponse

Response from the replay endpoint:

```typescript
// shared/contracts/games.ts
export interface PastGameReplayPlayer {
  playerOrder: 1 | 2;
  displayName: string;
  rating?: number;
  isWinner: boolean;
  isDraw: boolean;
  outcomeReason: string;
}

export interface PastGameReplayResponse {
  id: string;
  variant: Variant;
  rated: boolean;
  timeControl: TimeControlConfig;
  boardWidth: number;
  boardHeight: number;
  players: [PastGameReplayPlayer, PastGameReplayPlayer];
  moves: string[]; // Array of move notations in order
  views: number;
  endedAt: number;
}
```

---

## 4. Backend Changes

### 4.1 Game Persistence (server/games/persistence.ts) – NEW FILE

Create a dedicated module for persisting completed games:

```typescript
import { db } from "../db";
import { gamesTable } from "../db/schema/games";
import { gameDetailsTable } from "../db/schema/game-details";
import { gamePlayersTable } from "../db/schema/game-players";
import type { GameSession } from "./store";

export async function persistCompletedGame(session: GameSession): Promise<void> {
  const gameState = session.gameState;

  // Don't persist games with fewer than 2 moves
  if (gameState.moveCount < 2) {
    console.info("[persistence] Skipping game with < 2 moves", {
      sessionId: session.id,
      moveCount: gameState.moveCount,
    });
    return;
  }

  const host = session.players.host;
  const joiner = session.players.joiner;
  const player1 = host.playerId === 1 ? host : joiner;
  const player2 = host.playerId === 2 ? host : joiner;

  const elos = [player1.elo ?? 1500, player2.elo ?? 1500];
  const averageElo = Math.round((elos[0] + elos[1]) / 2);

  const result = gameState.result;
  const isDraw = result && result.winner === undefined;

  await db.transaction(async (tx) => {
    // Insert main game record
    await tx.insert(gamesTable).values({
      gameId: session.id,
      variant: session.config.variant,
      timeControl: session.config.timeControl.preset ?? "rapid",
      rated: session.config.rated,
      boardWidth: session.config.boardWidth,
      boardHeight: session.config.boardHeight,
      startedAt: new Date(session.createdAt),
      endedAt: new Date(session.updatedAt),
      views: 0,
      movesCount: gameState.moveCount,
      averageElo,
    });

    // Insert game details (moves)
    const moveNotations = gameState.history.map((entry) => entry.notation);
    await tx.insert(gameDetailsTable).values({
      gameId: session.id,
      configParameters: {
        initialSeconds: session.config.timeControl.initialSeconds,
        incrementSeconds: session.config.timeControl.incrementSeconds,
      },
      moves: moveNotations,
    });

    // Insert player records
    const players = [
      { player: player1, order: 1 as const },
      { player: player2, order: 2 as const },
    ];

    for (const { player, order } of players) {
      const isWinner = result?.winner === order;
      await tx.insert(gamePlayersTable).values({
        gameId: session.id,
        playerOrder: order,
        playerConfigType: player.authUserId ? "matched user" : "guest",
        userId: player.authUserId
          ? await getUserIdFromAuthId(player.authUserId)
          : null,
        botId: null,
        ratingAtStart: player.elo ?? null,
        outcomeRank: isDraw ? 1 : isWinner ? 1 : 2,
        outcomeReason: result?.reason ?? "unknown",
      });
    }
  });

  console.info("[persistence] Game persisted", {
    sessionId: session.id,
    moveCount: gameState.moveCount,
    winner: result?.winner,
    reason: result?.reason,
  });
}
```

### 4.2 Trigger Persistence on Game End

In `server/routes/game-socket.ts`, call persistence when a game ends:

```typescript
// After handleMove when game finishes:
if (newState.status === "finished") {
  await processRatingUpdate(socket.sessionId);
  await persistCompletedGame(getSession(socket.sessionId));
  broadcastLiveGamesRemove(socket.sessionId);
}

// After handleResign:
await persistCompletedGame(getSession(socket.sessionId));

// After handleDrawAccept:
await persistCompletedGame(getSession(socket.sessionId));

// After timeout handling:
await persistCompletedGame(getSession(socket.sessionId));
```

### 4.3 Past Games Query (server/db/game-queries.ts) – NEW FILE

```typescript
import { db } from "./index";
import { gamesTable } from "./schema/games";
import { gamePlayersTable } from "./schema/game-players";
import { usersTable } from "./schema/users";
import { and, eq, gte, lte, like, desc, sql, or } from "drizzle-orm";
import type { PastGamesFilters, PastGameSummary, PastGamesResponse } from "../../shared/contracts/games";

export async function queryPastGames(filters: PastGamesFilters): Promise<PastGamesResponse> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const offset = (page - 1) * pageSize;

  // Build WHERE conditions
  const conditions: SQL[] = [];

  if (filters.variant && filters.variant !== "all") {
    conditions.push(eq(gamesTable.variant, filters.variant));
  }

  if (filters.rated && filters.rated !== "all") {
    conditions.push(eq(gamesTable.rated, filters.rated === "yes"));
  }

  if (filters.timeControl && filters.timeControl !== "all") {
    conditions.push(eq(gamesTable.timeControl, filters.timeControl));
  }

  if (filters.boardSize && filters.boardSize !== "all") {
    if (filters.boardSize === "small") {
      conditions.push(lte(gamesTable.boardWidth, 6));
    } else if (filters.boardSize === "medium") {
      conditions.push(and(gte(gamesTable.boardWidth, 7), lte(gamesTable.boardWidth, 8)));
    } else if (filters.boardSize === "large") {
      conditions.push(gte(gamesTable.boardWidth, 9));
    }
  }

  if (filters.eloMin !== undefined) {
    conditions.push(gte(gamesTable.averageElo, filters.eloMin));
  }

  if (filters.eloMax !== undefined) {
    conditions.push(lte(gamesTable.averageElo, filters.eloMax));
  }

  if (filters.timePeriod && filters.timePeriod !== "all") {
    const now = new Date();
    let cutoff: Date;
    switch (filters.timePeriod) {
      case "today":
        cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case "7days":
        cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "30days":
        cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case "365days":
        cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
    }
    conditions.push(gte(gamesTable.endedAt, cutoff));
  }

  // Player filters require joining game_players
  // (handled via subquery or separate query for simplicity)

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Get total count
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(gamesTable)
    .where(whereClause);
  const totalCount = Number(countResult[0]?.count ?? 0);

  // Get paginated games
  const games = await db
    .select()
    .from(gamesTable)
    .where(whereClause)
    .orderBy(desc(gamesTable.endedAt))
    .limit(pageSize)
    .offset(offset);

  // Fetch players for each game
  const gameIds = games.map((g) => g.gameId);
  const allPlayers = await db
    .select({
      gameId: gamePlayersTable.gameId,
      playerOrder: gamePlayersTable.playerOrder,
      userId: gamePlayersTable.userId,
      ratingAtStart: gamePlayersTable.ratingAtStart,
      outcomeRank: gamePlayersTable.outcomeRank,
      outcomeReason: gamePlayersTable.outcomeReason,
    })
    .from(gamePlayersTable)
    .where(sql`${gamePlayersTable.gameId} IN ${gameIds}`);

  // Fetch usernames for authenticated players
  const userIds = allPlayers.filter((p) => p.userId).map((p) => p.userId!);
  const users = userIds.length > 0
    ? await db
        .select({ userId: usersTable.userId, username: usersTable.username })
        .from(usersTable)
        .where(sql`${usersTable.userId} IN ${userIds}`)
    : [];
  const userMap = new Map(users.map((u) => [u.userId, u.username]));

  // Build response
  const summaries: PastGameSummary[] = games.map((game) => {
    const gamePlayers = allPlayers.filter((p) => p.gameId === game.gameId);
    const p1 = gamePlayers.find((p) => p.playerOrder === 1);
    const p2 = gamePlayers.find((p) => p.playerOrder === 2);

    const buildPlayerSummary = (
      p: typeof p1,
      order: 1 | 2,
    ): PastGamePlayerSummary => {
      const isDraw = p?.outcomeRank === 1 && gamePlayers.every((gp) => gp.outcomeRank === 1);
      return {
        playerOrder: order,
        displayName: p?.userId ? userMap.get(p.userId) ?? `Guest ${order}` : `Guest ${order}`,
        rating: p?.ratingAtStart ?? undefined,
        isWinner: !isDraw && p?.outcomeRank === 1,
        isDraw,
      };
    };

    return {
      id: game.gameId,
      variant: game.variant as Variant,
      rated: game.rated,
      timeControl: {
        initialSeconds: 0, // Will be fetched from details if needed
        incrementSeconds: 0,
        preset: game.timeControl as TimeControlPreset,
      },
      boardWidth: game.boardWidth,
      boardHeight: game.boardHeight,
      players: [buildPlayerSummary(p1, 1), buildPlayerSummary(p2, 2)],
      movesCount: game.movesCount,
      views: game.views,
      averageElo: game.averageElo,
      endedAt: game.endedAt.getTime(),
      outcomeReason: p1?.outcomeReason ?? "unknown",
    };
  });

  // Apply player name filters (post-filter for simplicity)
  let filteredSummaries = summaries;
  if (filters.player1) {
    const search = filters.player1.toLowerCase();
    filteredSummaries = filteredSummaries.filter((g) =>
      g.players.some((p) => p.displayName.toLowerCase().includes(search)),
    );
  }
  if (filters.player2) {
    const search = filters.player2.toLowerCase();
    filteredSummaries = filteredSummaries.filter((g) =>
      g.players.some((p) => p.displayName.toLowerCase().includes(search)),
    );
  }

  return {
    games: filteredSummaries,
    pagination: {
      page,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
    },
  };
}

export async function getGameReplay(gameId: string): Promise<PastGameReplayResponse | null> {
  // Increment view count
  await db
    .update(gamesTable)
    .set({ views: sql`${gamesTable.views} + 1` })
    .where(eq(gamesTable.gameId, gameId));

  // Fetch game
  const games = await db
    .select()
    .from(gamesTable)
    .where(eq(gamesTable.gameId, gameId))
    .limit(1);

  if (games.length === 0) return null;
  const game = games[0];

  // Fetch details
  const details = await db
    .select()
    .from(gameDetailsTable)
    .where(eq(gameDetailsTable.gameId, gameId))
    .limit(1);

  // Fetch players
  const players = await db
    .select()
    .from(gamePlayersTable)
    .where(eq(gamePlayersTable.gameId, gameId));

  // Fetch usernames
  const userIds = players.filter((p) => p.userId).map((p) => p.userId!);
  const users = userIds.length > 0
    ? await db
        .select({ userId: usersTable.userId, username: usersTable.username })
        .from(usersTable)
        .where(sql`${usersTable.userId} IN ${userIds}`)
    : [];
  const userMap = new Map(users.map((u) => [u.userId, u.username]));

  const p1 = players.find((p) => p.playerOrder === 1);
  const p2 = players.find((p) => p.playerOrder === 2);
  const isDraw = p1?.outcomeRank === 1 && p2?.outcomeRank === 1;

  const buildReplayPlayer = (
    p: typeof p1,
    order: 1 | 2,
  ): PastGameReplayPlayer => ({
    playerOrder: order,
    displayName: p?.userId ? userMap.get(p.userId) ?? `Guest ${order}` : `Guest ${order}`,
    rating: p?.ratingAtStart ?? undefined,
    isWinner: !isDraw && p?.outcomeRank === 1,
    isDraw,
    outcomeReason: p?.outcomeReason ?? "unknown",
  });

  const configParams = details[0]?.configParameters as {
    initialSeconds?: number;
    incrementSeconds?: number;
  } | null;

  return {
    id: game.gameId,
    variant: game.variant as Variant,
    rated: game.rated,
    timeControl: {
      initialSeconds: configParams?.initialSeconds ?? 600,
      incrementSeconds: configParams?.incrementSeconds ?? 0,
      preset: game.timeControl as TimeControlPreset,
    },
    boardWidth: game.boardWidth,
    boardHeight: game.boardHeight,
    players: [buildReplayPlayer(p1, 1), buildReplayPlayer(p2, 2)],
    moves: (details[0]?.moves as string[]) ?? [],
    views: game.views + 1, // Include the increment we just made
    endedAt: game.endedAt.getTime(),
  };
}
```

### 4.4 REST Endpoints (server/routes/games.ts)

Add endpoints for past games:

```typescript
// Get paginated list of past games
.get("/past", zValidator("query", pastGamesFiltersSchema), async (c) => {
  try {
    const filters = c.req.valid("query");
    const result = await queryPastGames(filters);
    return c.json(result);
  } catch (error) {
    console.error("Failed to query past games:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
})

// Get a single past game for replay
.get("/:id/replay", async (c) => {
  try {
    const { id } = c.req.param();

    // First check if game is still in memory (live)
    try {
      const session = getSession(id);
      if (session.status !== "completed") {
        return c.json({ error: "Game is still in progress", code: "GAME_IN_PROGRESS" }, 400);
      }
    } catch {
      // Game not in memory, check database
    }

    const replay = await getGameReplay(id);
    if (!replay) {
      return c.json({ error: "Game not found" }, 404);
    }

    return c.json(replay);
  } catch (error) {
    console.error("Failed to get game replay:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
})
```

---

## 5. Frontend Changes

### 5.1 Past Game Replay Hook – NEW FILE (frontend/src/hooks/use-past-game-replay.ts)

```typescript
import { useState, useEffect, useCallback, useMemo } from "react";
import type { PastGameReplayResponse } from "../../../shared/contracts/games";
import { parseNotationToMove } from "../../../shared/domain/standard-notation";
import { GameState, createInitialGameState } from "@/lib/game-state";

interface ReplayState {
  game: PastGameReplayResponse | null;
  isLoading: boolean;
  error: string | null;
  currentMoveIndex: number; // -1 = initial position, 0 = after move 1, etc.
  gameState: GameState | null;
}

export function usePastGameReplay(gameId: string) {
  const [state, setState] = useState<ReplayState>({
    game: null,
    isLoading: true,
    error: null,
    currentMoveIndex: -1,
    gameState: null,
  });

  // Fetch game data
  useEffect(() => {
    let cancelled = false;

    const fetchGame = async () => {
      try {
        const res = await fetch(`/api/games/${gameId}/replay`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to load game");
        }
        const game: PastGameReplayResponse = await res.json();

        if (!cancelled) {
          // Set to final position by default
          const finalIndex = game.moves.length - 1;
          setState({
            game,
            isLoading: false,
            error: null,
            currentMoveIndex: finalIndex,
            gameState: null, // Will be computed
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            isLoading: false,
            error: error instanceof Error ? error.message : "Failed to load game",
          }));
        }
      }
    };

    fetchGame();
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  // Compute game state for current move index
  const computedGameState = useMemo(() => {
    if (!state.game) return null;

    const config = {
      variant: state.game.variant,
      timeControl: state.game.timeControl,
      rated: state.game.rated,
      boardWidth: state.game.boardWidth,
      boardHeight: state.game.boardHeight,
    };

    let gameState = createInitialGameState(config);

    // Apply moves up to currentMoveIndex
    for (let i = 0; i <= state.currentMoveIndex && i < state.game.moves.length; i++) {
      const move = parseNotationToMove(state.game.moves[i], config.boardHeight);
      const playerId = (i % 2) + 1 as 1 | 2;
      gameState = gameState.applyGameAction({
        kind: "move",
        move,
        playerId,
        timestamp: Date.now(),
      });
    }

    return gameState;
  }, [state.game, state.currentMoveIndex]);

  // Navigation functions
  const goToMove = useCallback((index: number) => {
    setState((prev) => {
      if (!prev.game) return prev;
      const maxIndex = prev.game.moves.length - 1;
      const clampedIndex = Math.max(-1, Math.min(index, maxIndex));
      return { ...prev, currentMoveIndex: clampedIndex };
    });
  }, []);

  const goToStart = useCallback(() => goToMove(-1), [goToMove]);
  const goToEnd = useCallback(() => {
    setState((prev) => {
      if (!prev.game) return prev;
      return { ...prev, currentMoveIndex: prev.game.moves.length - 1 };
    });
  }, []);
  const goToPrevious = useCallback(() => {
    setState((prev) => ({ ...prev, currentMoveIndex: Math.max(-1, prev.currentMoveIndex - 1) }));
  }, []);
  const goToNext = useCallback(() => {
    setState((prev) => {
      if (!prev.game) return prev;
      return {
        ...prev,
        currentMoveIndex: Math.min(prev.game.moves.length - 1, prev.currentMoveIndex + 1),
      };
    });
  }, []);

  return {
    game: state.game,
    isLoading: state.isLoading,
    error: state.error,
    currentMoveIndex: state.currentMoveIndex,
    totalMoves: state.game?.moves.length ?? 0,
    gameState: computedGameState,
    navigation: {
      goToMove,
      goToStart,
      goToEnd,
      goToPrevious,
      goToNext,
    },
  };
}
```

### 5.2 Replay Controller – NEW FILE (frontend/src/hooks/use-replay-game-controller.ts)

Create a controller similar to `use-spectator-game-controller.ts` but for replays:

```typescript
import { useMemo, useEffect, useCallback } from "react";
import { usePastGameReplay } from "@/hooks/use-past-game-replay";
import { pawnId } from "../../../shared/domain/game-utils";
import { moveToStandardNotation } from "../../../shared/domain/standard-notation";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";

const DEFAULT_PLAYER_COLORS: Record<PlayerId, PlayerColor> = {
  1: "red",
  2: "blue",
};

export function useReplayGameController(gameId: string) {
  const replay = usePastGameReplay(gameId);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          replay.navigation.goToPrevious();
          break;
        case "ArrowRight":
          e.preventDefault();
          replay.navigation.goToNext();
          break;
        case "Home":
          e.preventDefault();
          replay.navigation.goToStart();
          break;
        case "End":
          e.preventDefault();
          replay.navigation.goToEnd();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [replay.navigation]);

  const config = replay.game
    ? {
        variant: replay.game.variant,
        timeControl: replay.game.timeControl,
        rated: replay.game.rated,
        boardWidth: replay.game.boardWidth,
        boardHeight: replay.game.boardHeight,
      }
    : null;

  const gameState = replay.gameState;

  // Build display pawns
  const boardPawns = useMemo(() => {
    if (!gameState) return [];
    return gameState.getPawns().map((pawn) => ({
      ...pawn,
      id: pawnId(pawn),
    }));
  }, [gameState]);

  // Build walls
  const boardWalls = useMemo(() => {
    if (!gameState) return [];
    return gameState.grid.getWalls().map((wall) => ({
      ...wall,
      state: "placed" as const,
    }));
  }, [gameState]);

  // Format history for display with current move highlighting
  const formattedHistory = useMemo(() => {
    if (!replay.game) return [];
    const rows = replay.game.boardHeight;
    const paired: { num: number; white?: string; black?: string; whiteIndex: number; blackIndex?: number }[] = [];

    for (let i = 0; i < replay.game.moves.length; i += 2) {
      paired.push({
        num: Math.floor(i / 2) + 1,
        white: replay.game.moves[i],
        black: replay.game.moves[i + 1],
        whiteIndex: i,
        blackIndex: i + 1 < replay.game.moves.length ? i + 1 : undefined,
      });
    }
    return paired;
  }, [replay.game]);

  const rows = config?.boardHeight ?? 9;
  const cols = config?.boardWidth ?? 9;

  // Player info
  const players = useMemo(() => {
    if (!replay.game) return { bottom: null, top: null };
    const p1 = replay.game.players.find((p) => p.playerOrder === 1) ?? null;
    const p2 = replay.game.players.find((p) => p.playerOrder === 2) ?? null;
    // Host (player 1) on bottom, joiner (player 2) on top
    return { bottom: p1, top: p2 };
  }, [replay.game]);

  const buildTimerPlayer = (player: typeof players.bottom, playerId: PlayerId) => {
    if (!player) return null;
    return {
      id: `p${playerId}`,
      playerId,
      name: player.displayName,
      rating: player.rating ?? 1500,
      color: DEFAULT_PLAYER_COLORS[playerId],
      type: "friend" as const,
      isOnline: false, // Past game, not online
    };
  };

  const getPlayerName = (id: PlayerId) =>
    replay.game?.players.find((p) => p.playerOrder === id)?.displayName ?? `Player ${id}`;

  // Determine winner info
  const winnerPlayer = useMemo(() => {
    if (!replay.game) return null;
    const winner = replay.game.players.find((p) => p.isWinner);
    if (!winner) return null;
    return {
      playerId: winner.playerOrder as PlayerId,
      name: winner.displayName,
    };
  }, [replay.game]);

  const isDraw = replay.game?.players[0]?.isDraw ?? false;

  const noop = () => {};

  return {
    isSpectator: false,
    isReplay: true,
    matching: {
      isOpen: false,
      players: [],
      shareUrl: undefined,
      statusMessage: undefined,
      canAbort: false,
      onAbort: noop,
    },
    board: {
      gameStatus: "finished" as const,
      gameState,
      isLoadingConfig: replay.isLoading,
      loadError: replay.error,
      winnerPlayer,
      winReason: replay.game?.players[0]?.outcomeReason ?? "",
      isDraw,
      scoreboardEntries: [],
      rematchState: {
        status: "idle" as const,
        responses: { 1: "pending" as const, 2: "pending" as const },
        requestId: 0,
      },
      rematchResponseSummary: [],
      rematchStatusText: "",
      primaryLocalPlayerId: null,
      userRematchResponse: null,
      handleAcceptRematch: noop,
      handleDeclineRematch: noop,
      openRematchWindow: noop,
      handleExitAfterMatch: () => window.history.back(),
      rows,
      cols,
      boardPawns,
      boardWalls,
      stagedArrows: [],
      playerColorsForBoard: DEFAULT_PLAYER_COLORS,
      interactionLocked: true,
      lastMove: undefined,
      draggingPawnId: null,
      selectedPawnId: null,
      stagedActionsCount: 0,
      actionablePlayerId: null,
      onCellClick: noop,
      onWallClick: noop,
      onPawnClick: noop,
      onPawnDragStart: noop,
      onPawnDragEnd: noop,
      onCellDrop: noop,
      stagedActions: [],
      activeLocalPlayerId: null,
      hasActionMessage: false,
      actionError: null,
      actionStatusText: null,
      clearStagedActions: noop,
      commitStagedActions: noop,
    },
    timers: {
      topPlayer: buildTimerPlayer(players.top, 2),
      bottomPlayer: buildTimerPlayer(players.bottom, 1),
      displayedTimeLeft: { 1: 0, 2: 0 }, // Not relevant for replay
      gameTurn: gameState?.turn ?? 1,
      thinkingPlayer: null,
      getPlayerMatchScore: () => null,
    },
    actions: {
      drawDecisionPrompt: null,
      takebackDecisionPrompt: null,
      incomingPassiveNotice: null,
      getPlayerName,
      respondToDrawPrompt: noop,
      respondToTakebackPrompt: noop,
      handleDismissIncomingNotice: noop,
      resignFlowPlayerId: null,
      pendingDrawForLocal: false,
      pendingDrawOffer: null,
      takebackPendingForLocal: false,
      pendingTakebackRequest: null,
      outgoingTimeInfo: null,
      canCancelDrawOffer: false,
      canCancelTakebackRequest: false,
      handleCancelResign: noop,
      handleConfirmResign: noop,
      handleCancelDrawOffer: noop,
      handleCancelTakebackRequest: noop,
      handleDismissOutgoingInfo: noop,
      actionButtonsDisabled: true,
      manualActionsDisabled: true,
      hasTakebackHistory: false,
      handleStartResign: noop,
      handleOfferDraw: noop,
      handleRequestTakeback: noop,
      handleGiveTime: noop,
    },
    replay: {
      currentMoveIndex: replay.currentMoveIndex,
      totalMoves: replay.totalMoves,
      formattedHistory,
      navigation: replay.navigation,
      onMoveClick: (index: number) => replay.navigation.goToMove(index),
    },
    chat: {
      activeTab: "history" as const,
      onTabChange: noop,
      formattedHistory: formattedHistory.map((h) => ({
        num: h.num,
        white: h.white,
        black: h.black,
      })),
      chatChannel: "game" as const,
      messages: [],
      chatInput: "",
      onChannelChange: noop,
      onInputChange: noop,
      onSendMessage: noop,
      chatDisabledMessage: "Chat is not preserved.",
    },
    info: {
      config,
      defaultVariant: "standard" as const,
      defaultTimeControlPreset: "blitz" as const,
      soundEnabled: false,
      onSoundToggle: noop,
      interactionLocked: true,
      isMultiplayerMatch: true,
      unsupportedPlayers: [],
      placeholderCopy: {},
    },
  };
}
```

### 5.3 Update Game Page Controller

Modify `use-game-page-controller.ts` to handle the replay case:

```typescript
export function useGamePageController(gameId: string) {
  const storedHandshake = useMemo(() => getGameHandshake(gameId), [gameId]);
  const isSpectator = !storedHandshake;

  // Try to determine if this is a past game (not in live memory)
  const [isPastGame, setIsPastGame] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isSpectator) {
      setIsPastGame(false);
      return;
    }

    // Check if game exists in live memory via spectate endpoint
    fetch(`/api/games/${gameId}/spectate`)
      .then((res) => {
        if (res.ok) {
          setIsPastGame(false); // Live game
        } else if (res.status === 404) {
          setIsPastGame(true); // Not in memory, try DB
        } else {
          setIsPastGame(true); // Assume past game on other errors
        }
      })
      .catch(() => {
        setIsPastGame(true);
      });
  }, [gameId, isSpectator]);

  // Use replay controller for past games
  const replayController = useReplayGameController(gameId);

  // Use spectator controller for live games
  const spectatorController = useSpectatorGameController(gameId);

  // Loading state while determining game type
  if (isSpectator && isPastGame === null) {
    return {
      isSpectator: true,
      isReplay: false,
      isLoading: true,
      // ... loading state shape
    };
  }

  if (isSpectator && isPastGame) {
    return replayController;
  }

  if (isSpectator) {
    return spectatorController;
  }

  // ... existing player logic
}
```

### 5.4 Replay Navigation Component – NEW FILE (frontend/src/components/replay-controls.tsx)

```typescript
import { Button } from "@/components/ui/button";
import { SkipBack, ChevronLeft, ChevronRight, SkipForward } from "lucide-react";

interface ReplayControlsProps {
  currentMoveIndex: number;
  totalMoves: number;
  onGoToStart: () => void;
  onGoToPrevious: () => void;
  onGoToNext: () => void;
  onGoToEnd: () => void;
}

export function ReplayControls({
  currentMoveIndex,
  totalMoves,
  onGoToStart,
  onGoToPrevious,
  onGoToNext,
  onGoToEnd,
}: ReplayControlsProps) {
  const isAtStart = currentMoveIndex === -1;
  const isAtEnd = currentMoveIndex === totalMoves - 1;

  return (
    <div className="flex items-center justify-center gap-2 py-3 border-t border-border/50">
      <Button
        variant="ghost"
        size="sm"
        onClick={onGoToStart}
        disabled={isAtStart}
        title="Go to start (Home)"
      >
        <SkipBack className="w-4 h-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onGoToPrevious}
        disabled={isAtStart}
        title="Previous move (←)"
      >
        <ChevronLeft className="w-4 h-4" />
      </Button>
      <span className="text-sm text-muted-foreground min-w-[80px] text-center">
        {currentMoveIndex + 1} / {totalMoves}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onGoToNext}
        disabled={isAtEnd}
        title="Next move (→)"
      >
        <ChevronRight className="w-4 h-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onGoToEnd}
        disabled={isAtEnd}
        title="Go to end (End)"
      >
        <SkipForward className="w-4 h-4" />
      </Button>
    </div>
  );
}
```

### 5.5 Past Games Page Updates (frontend/src/routes/past-games.tsx)

Wire up the page with real data and URL-based filters:

```typescript
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import type { PastGameSummary, PastGamesFilters, PastGamesResponse } from "../../../shared/contracts/games";

// Define search params schema
const pastGamesSearchSchema = z.object({
  variant: z.enum(["all", "standard", "classic"]).optional().default("all"),
  rated: z.enum(["all", "yes", "no"]).optional().default("all"),
  timeControl: z.enum(["all", "bullet", "blitz", "rapid", "classical"]).optional().default("all"),
  boardSize: z.enum(["all", "small", "medium", "large"]).optional().default("all"),
  eloMin: z.coerce.number().optional(),
  eloMax: z.coerce.number().optional(),
  player1: z.string().optional(),
  player2: z.string().optional(),
  timePeriod: z.enum(["all", "today", "7days", "30days", "365days"]).optional().default("all"),
  page: z.coerce.number().optional().default(1),
});

export const Route = createFileRoute("/past-games")({
  component: PastGames,
  validateSearch: pastGamesSearchSchema,
});

function PastGames() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/past-games" });

  const [data, setData] = useState<PastGamesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch games when filters change
  useEffect(() => {
    setIsLoading(true);
    const params = new URLSearchParams();

    if (search.variant !== "all") params.set("variant", search.variant);
    if (search.rated !== "all") params.set("rated", search.rated);
    if (search.timeControl !== "all") params.set("timeControl", search.timeControl);
    if (search.boardSize !== "all") params.set("boardSize", search.boardSize);
    if (search.eloMin) params.set("eloMin", String(search.eloMin));
    if (search.eloMax) params.set("eloMax", String(search.eloMax));
    if (search.player1) params.set("player1", search.player1);
    if (search.player2) params.set("player2", search.player2);
    if (search.timePeriod !== "all") params.set("timePeriod", search.timePeriod);
    params.set("page", String(search.page));

    fetch(`/api/games/past?${params.toString()}`)
      .then((res) => res.json())
      .then((data: PastGamesResponse) => {
        setData(data);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoading(false);
      });
  }, [search]);

  const updateFilter = (key: string, value: string | number | undefined) => {
    void navigate({
      to: "/past-games",
      search: (prev) => ({
        ...prev,
        [key]: value,
        page: key === "page" ? value : 1, // Reset page when other filters change
      }),
    });
  };

  const handleWatchGame = (gameId: string) => {
    void navigate({ to: `/game/${gameId}` });
  };

  const handlePlayerClick = (playerName: string, slot: 1 | 2) => {
    const key = slot === 1 ? "player1" : "player2";
    updateFilter(key, playerName);
  };

  const handleVsClick = (player1: string, player2: string) => {
    void navigate({
      to: "/past-games",
      search: (prev) => ({
        ...prev,
        player1,
        player2,
        page: 1,
      }),
    });
  };

  // ... render filters, table, and pagination
}
```

### 5.6 Game Page UI Updates for Replay Mode

Update the game page to show replay controls when in replay mode:

```typescript
// In game.$id.tsx
function GamePage() {
  const { id } = Route.useParams();
  const controller = useGamePageController(id);

  const { isSpectator, isReplay, matching, board, timers, actions, chat, info, replay } = controller;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Replay indicator banner */}
      {isReplay && (
        <div className="bg-slate-100 dark:bg-slate-900/50 text-slate-700 dark:text-slate-300 text-center py-2 text-sm font-medium">
          📼 Replay • {replay?.totalMoves ?? 0} moves • {data?.views ?? 0} views
        </div>
      )}

      {/* Spectator indicator banner */}
      {isSpectator && !isReplay && (
        <div className="bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-center py-2 text-sm font-medium">
          👁️ Spectating
        </div>
      )}

      {/* ... board and other components ... */}

      {/* Show replay controls in the move list panel for replay mode */}
      {isReplay && replay && (
        <ReplayControls
          currentMoveIndex={replay.currentMoveIndex}
          totalMoves={replay.totalMoves}
          onGoToStart={replay.navigation.goToStart}
          onGoToPrevious={replay.navigation.goToPrevious}
          onGoToNext={replay.navigation.goToNext}
          onGoToEnd={replay.navigation.goToEnd}
        />
      )}

      {/* Chat panel with disabled message for replay */}
      {isReplay && (
        <div className="text-center text-muted-foreground py-4 bg-muted/30">
          Chat is not preserved.
        </div>
      )}
    </div>
  );
}
```

---

## 6. Runtime Flows

### 6.1 Game Persistence Flow

1. Game ends via move (checkmate/timeout), resignation, or draw agreement.
2. Handler calls `persistCompletedGame(session)`.
3. Persistence function checks move count ≥ 2.
4. If valid, inserts records into `games`, `game_details`, `game_players` tables.
5. Session remains in memory until cleanup (for immediate spectators/rematches).
6. Eventually, session is cleaned up from memory.

### 6.2 Past Games List Flow

1. User navigates to `/past-games`.
2. Frontend parses URL search params for filters.
3. Frontend calls `GET /api/games/past?...` with filter params.
4. Backend queries database with filters and pagination.
5. Backend returns `PastGamesResponse` with games and pagination info.
6. Frontend renders table and pagination controls.
7. User clicks filter → URL updates → new fetch triggered.

### 6.3 Past Game Replay Flow

1. User clicks "Watch" on a past game row.
2. Router navigates to `/game/:id`.
3. `useGamePageController` checks for handshake (none = spectator mode).
4. Controller tries spectate endpoint → 404 (game not in memory).
5. Controller switches to replay mode, calls `GET /api/games/:id/replay`.
6. Backend fetches from DB, increments view count, returns `PastGameReplayResponse`.
7. Frontend initializes replay state at final position.
8. User can navigate with buttons (⏮ ◀ ▶ ⏭) or keyboard (← → Home End).
9. Clicking move in history list jumps to that position.

### 6.4 URL Continuity Flow

The same URL `/game/:id` works throughout the game lifecycle:

```
1. Host creates game     → /game/abc123 → Waiting room (has handshake)
2. Joiner joins          → /game/abc123 → Game starts (has handshake)
3. Third party visits    → /game/abc123 → Live spectating (no handshake, in memory)
4. Game ends             → /game/abc123 → Still accessible (in memory briefly)
5. Memory cleanup        → /game/abc123 → Replay from DB (no handshake, not in memory)
```

### 6.5 Rematch Flow (New Session ID)

**Important design decision**: Rematches create a **new session with a new game ID**. This ensures:
- Each game has a unique, permanent URL
- Both games are preserved in the database
- No overwriting of game history

**Flow when players accept a rematch:**

1. Game 1 ends (ID: `abc123`)
   - Game is persisted to DB with ID `abc123`
   - Session remains in memory briefly
2. Both players accept rematch
3. Server creates **new session** with ID `def456`
   - Config inherited from previous game
   - Player IDs swapped (loser goes first)
   - New tokens generated for both players
4. Server broadcasts to all connected clients:
   - **Targeted to each player seat (includes credentials):**
     ```typescript
     {
       type: "rematch-started",
       newGameId: "def456",
       seat: { token, socketToken }
     }
     ```
   - **Broadcast to everyone else (spectators, stale sockets, etc.):**
     ```typescript
     { type: "rematch-started", newGameId: "def456" }
     ```
   - Immediately after broadcasting, the server marks `abc123` as completed/read-only and rejects new gameplay actions for that id.
5. Players' clients:
   - Receive the new seat credentials in-band
   - Store the handshake payload for `def456`
   - Navigate to `/game/def456`
6. Spectators' clients:
   - Show "Players started a rematch" message
   - Display link to follow: "Watch rematch →"
   - Can choose to stay viewing completed game or follow
7. Old session (`abc123`) eventually cleaned from memory
   - URL `/game/abc123` continues to work via DB replay

Offline (vs-bot/solo) games obey the same rule: each `/game/:id` covers a single lifecycle. Creating a new local game generates a fresh NanoID client-side, and rematching locally creates another ID before routing to `/game/:newId`.

**Backend changes required:**

Replace `resetSession` with `createRematchSession`:

```typescript
export const createRematchSession = (
  previousSessionId: string,
): { newSession: GameSession; hostToken: string; joinerToken: string } => {
  const previous = ensureSession(previousSessionId);
  
  // Create new session with new ID
  const newId = nanoid(8);
  const hostToken = nanoid();
  const joinerToken = nanoid();
  const hostSocketToken = nanoid();
  const joinerSocketToken = nanoid();
  
  // Swap player IDs so loser goes first
  const newHostPlayerId = previous.players.joiner.playerId;
  const newJoinerPlayerId = previous.players.host.playerId;
  
  const newSession: GameSession = {
    id: newId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "waiting",
    config: previous.config,
    matchType: previous.matchType,
    gameState: createGameState(previous.config),
    players: {
      host: {
        ...previous.players.host,
        playerId: newHostPlayerId,
        token: hostToken,
        socketToken: hostSocketToken,
        ready: false,
        connected: false,
      },
      joiner: {
        ...previous.players.joiner,
        playerId: newJoinerPlayerId,
        token: joinerToken,
        socketToken: joinerSocketToken,
        ready: false,
        connected: false,
      },
    },
  };
  
  sessions.set(newId, newSession);
  
  return { newSession, hostToken, joinerToken };
};
```

**New WebSocket message type:**

```typescript
// shared/contracts/websocket-messages.ts
export type ServerMessage =
  | { type: "state"; state: SerializedGameState }
  | { type: "match-status"; snapshot: GameSnapshot }
  | { type: "rematch-started"; newGameId: string; seat?: { token: string; socketToken: string } }
  // ... other existing types
```

---

## 7. Test Plan (tests/integration/\*)

### 7.1 Game Persistence Tests

1. **Test: game with ≥2 moves is persisted**
   - Play a game to completion with 5 moves
   - Verify record exists in `games` table
   - Verify moves stored in `game_details`
   - Verify both players in `game_players`

2. **Test: game with <2 moves is not persisted**
   - Create game, player resigns after 1 move
   - Verify no record in `games` table

3. **Test: game aborted in waiting is not persisted**
   - Create game, abort before starting
   - Verify no record in database

4. **Test: guest game is persisted**
   - Two guests play a game
   - Verify game is saved
   - Verify `userId` is null for both players

5. **Test: authenticated player game is persisted**
   - Authenticated user plays guest
   - Verify `userId` set for authenticated player
   - Verify username retrievable

### 7.2 Past Games Query Tests

6. **Test: pagination works correctly**
   - Insert 50 games
   - Request page 1, size 25 → get 25 games
   - Request page 2, size 25 → get 25 games
   - Verify no duplicates

7. **Test: variant filter**
   - Insert games with different variants
   - Filter by "standard" → only standard games returned

8. **Test: time period filter**
   - Insert games at different dates
   - Filter by "7days" → only recent games returned

9. **Test: player name filter**
   - Insert games with known players
   - Filter by player name → games including that player returned

10. **Test: ELO range filter**
    - Insert games with different average ELOs
    - Filter by eloMin=1400, eloMax=1600 → only matching games

### 7.3 Replay Tests

11. **Test: replay endpoint returns correct data**
    - Complete a game, wait for persistence
    - Call `/api/games/:id/replay`
    - Verify moves array matches played moves
    - Verify player info correct

12. **Test: view count increments**
    - Note initial view count
    - Call replay endpoint
    - Verify view count increased by 1

13. **Test: replay endpoint 404 for non-existent game**
    - Call `/api/games/nonexistent/replay`
    - Expect 404

14. **Test: replay endpoint 400 for in-progress game**
    - Start game but don't finish
    - Call `/api/games/:id/replay`
    - Expect 400 with "GAME_IN_PROGRESS"

### 7.4 Frontend Tests

15. **Test: replay navigation**
    - Load past game
    - Verify starts at final position
    - Click "previous" → position updates
    - Click "start" → at initial position
    - Press End key → at final position

16. **Test: URL filters persist**
    - Set variant filter via UI
    - Verify URL contains `?variant=standard`
    - Refresh page → filter still applied

### 7.5 Rematch Tests

17. **Test: rematch creates new game ID**
    - Complete a game (ID: abc123)
    - Both players accept rematch
    - Verify new session created with different ID (def456)
    - Verify original game (abc123) still in DB
    - Verify new game playable at new URL

18. **Test: rematch preserves config**
    - Create game with specific config (variant, time control, board size)
    - Complete game and rematch
    - Verify new game has same config

19. **Test: rematch swaps player order**
    - Player 1 wins game
    - Rematch accepted
    - Verify Player 1 is now Player 2 (goes second)

20. **Test: spectators notified of rematch**
    - Spectator watching game that ends
    - Players accept rematch
    - Spectator receives `rematch-started` message with new game ID

---

## 8. Non-Goals and Constraints

- **Chat not preserved**: Chat messages are not stored in the database. Past games show a placeholder message.
- **No live updates for past games**: Unlike live spectating, past games don't connect via WebSocket.
- **No editing/annotating**: Users cannot add comments or annotations to past games.
- **Guest display names**: Guests always display as "Guest 1" / "Guest 2" based on player order.
- **No download/export**: PGN or other export formats are out of scope.
- **No deep linking to specific moves**: URLs don't include move position (could be added later with `?move=15`).

---

## 9. Implementation Order

Recommended order to minimize risk:

1. **Database: Schema migration** (UUID primary key)
2. **Backend: Rematch refactor** (createRematchSession with new ID)
3. **Backend: Add rematch-started WebSocket message**
4. **Backend: Persistence module** (persistCompletedGame)
5. **Backend: Wire persistence** to game end handlers
6. **Backend: Past games query** module
7. **Backend: REST endpoints** (/api/games/past, /api/games/:id/replay)
8. **Frontend: Handle rematch-started message** (navigate to new game)
9. **Frontend: Shared move navigation** (useMoveNavigation hook, controls component) – used by players, spectators, AND replay
10. **Frontend: Integrate move navigation** into existing game page controller for players
11. **Frontend: usePastGameReplay** hook
12. **Frontend: useReplayGameController** hook (uses shared move navigation)
13. **Frontend: Update useGamePageController** with replay branch
14. **Frontend: Past games page** with filters and pagination
15. **Frontend: Game page UI** updates for all modes (navigation controls, history indicators)
16. **Integration tests**
17. **Manual testing and polish**

**Note on move navigation:** The move navigation feature (step 9) should be implemented as a shared hook/component that works across all contexts. The same UI controls and keyboard shortcuts apply to players viewing history, live spectators reviewing past moves, and past game replay.

---

## 10. Relationship with Live Spectating and Player Mode

This feature complements the existing Live Spectating feature and shares components with player mode:

| Aspect | Player (Live) | Live Spectator | Past Game Replay |
|--------|---------------|----------------|------------------|
| Data source | In-memory session | In-memory session | Database |
| Real-time updates | Yes (WebSocket) | Yes (WebSocket) | No (static) |
| Move navigation | ✅ Yes (NEW) | ✅ Yes (NEW) | ✅ Yes (NEW) |
| Can submit moves | At latest position only | ❌ No | ❌ No |
| URL | `/game/:id` | `/game/:id` | `/game/:id` |
| Detection | Has handshake | No handshake + in memory | No handshake + not in memory |
| Viewership metric | N/A | Spectator count (live) | Views (cumulative) |

**Note on current state:** Live spectating is already implemented but currently just follows the live position. Move navigation will be added to players, live spectators, AND replay as part of this feature using shared components.

**Shared components (to be built):**
- Move navigation controls (⏮ ◀ ▶ ⏭) and keyboard shortcuts (← → Home End)
- Clickable move list for jumping to specific positions
- "Viewing move X of Y" indicator
- Board rendering at historical positions
- `useMoveNavigation` hook with shared logic

**Key differences by context:**
- **Players:** See "Return to live position" prompt when viewing history during their turn; can only submit moves at latest position
- **Live spectators:** See "X new moves" indicator when new moves arrive while viewing history
- **Past game replay:** No real-time updates; position is fully controlled by user; starts at final position

The same `/game/:id` URL seamlessly transitions from live spectating to replay mode when the game ends and is cleaned up from memory.

---

This plan provides complete game persistence, a filterable past games archive, and move-by-move replay functionality while maintaining URL continuity with the existing game system.

# Reviewer comments

You’ve clearly thought this through a lot; overall this is a very solid, internally consistent plan. I’ll focus on where I think you’re over-scoping, where there are hidden footguns, and what I’d trim / tweak for a realistic v1.

I’ll split feedback into: **(1) scope & phasing, (2) schema, (3) backend logic, (4) frontend & replay, (5) UX mismatches / polish, (6) suggested v1 cut-down.**

---

## 1. Scope & Phasing

Big picture: you’ve bundled three fairly large features together:

1. Past games (persistence, list, replay)
2. Global move navigation across *all* contexts
3. Rematch refactor (new IDs, WS messages, etc.)
4. PK refactor to UUID / session ID

All of them make sense **conceptually**; combined, they’re a lot of surface area and regression risk.

**My suggestion: make “Past games v1” as narrow as possible:**

* **In scope for v1:**

  * Persist finished games to DB.
  * `/api/games/past` with filters + pagination.
  * `/api/games/:id/replay` that rehydrates from DB.
  * Replay mode in `/game/:id` for spectators only (or a separate `/replay/:id` route, see below).
  * Very simple move navigation **only in replay mode** (buttons + keyboard, no global integration yet).

* **Out of scope for v1 (or separate tasks):**

  * Global move nav for *live* players and spectators.
  * Rematch refactor (`createRematchSession`, `rematch-started` WS message).
  * PK migration to UUID if your current DB already works (more below).

You *can* keep them in the doc as “Phase 2 / Related features,” but I’d decouple them from the “done = past games ship” definition.

---

## 2. Database Schema & Migration

### 2.1 Changing primary key to UUID / session ID

You’re proposing:

```ts
gameId: varchar("game_id", { length: 36 }).primaryKey() // UUID from session
```

But your runtime session IDs are currently nanoids like `2ei3nd43`, not actual UUIDs. That’s:

* Slightly confusing naming (varchar 36 but using nanoid 8).
* A heavy migration if you already have `games` with integer PK and FKs.

**Alternatives:**

1. **Add a `sessionId` column** (or `publicId`) that stores the nanoid and is unique, while keeping your existing int PK:

   * Pros: easier migration, no cascading FK updates, you can keep internal PK and still support `/game/:sessionId` forever.
   * `/game/:id` uses `sessionId`, DB joins on that.

2. **If you really want “one true ID”**:

   * Make column a varchar with appropriate length for nanoid.
   * Name it something like `publicId` or `sessionId` and be honest in comments (“nanoid, not UUID”).
   * Only do this PK swap if your DB is still small and you’re comfortable doing a real migration and updating all FKs + code paths.

Right now, the plan says “UUID” but the ecosystem is “nanoid” – I’d clean that up deliberately one way or the other.

### 2.2 Board size / multi-player variants

You defined:

```ts
boardSize?: "small" | "medium" | "large" | "all";
```

And map it to width thresholds in the query. That works now, but:

* You already know some variants might not map to that nicely.
* For multi-player / weird board shapes later, this may feel arbitrary.

I’d explicitly note in the doc: *“For now, small/medium/large are heuristics based on width only. If variants diverge, we’ll add variant-specific board size presets.”*

### 2.3 Indices

You’re going to query by:

* `endedAt` (ordering + time filters)
* `variant`, `rated`, `timeControl`
* `averageElo`
* `boardWidth` (for size buckets)

You’ll want at least:

* Index on `(endedAt DESC)` or `(endedAt)` for the main sort.
* Likely a composite index like `(variant, endedAt)` or `(rated, endedAt)` depending on common filters.

Your plan doesn’t mention indices; I’d add a tiny “Indexes” subsection so future-you doesn’t forget.

---

## 3. Backend Logic

### 3.1 Player filters & pagination

You do:

* DB query without player name conditions.
* Then filter in memory by `player1`/`player2`.

That means:

* `totalCount` and `totalPages` include *unfiltered* games.
* Some pages can come back completely empty after post-filtering.

For correctness + UX:

* Either:

  * Apply player name filters at the SQL level (requires joining `game_players` / `users` in the main query and counting over that), **or**
  * Be honest in the contract and compute pagination **after** filtering (i.e., bring more rows from DB, filter, then paginate in memory – less ideal but simpler if your dataset is small).

Right now, you have a hybrid that will look subtly broken for users.

### 3.2 Player filters semantics

Spec says:

> Filling only one gives you all games with that player. Filling both gives you all games including both players.

Your logic:

```ts
if (filters.player1) {
  filteredSummaries = filteredSummaries.filter(… contains player1 …)
}
if (filters.player2) {
  filteredSummaries = filteredSummaries.filter(… contains player2 …)
}
```

So if both are set, you end up with an intersection (good). This matches the spec. ✅

Just be aware of case-insensitivity and displayName vs username; you’re using displayName text search which can be fragile if names change. Long-term you might want stable user handles or user IDs exposed in some way, but that’s a future worry.

### 3.3 Time period vs date range

Your original UX spec:

> Time period: a **date range**

Implementation:

```ts
timePeriod?: "today" | "7days" | "30days" | "365days" | "all";
```

So you’ve silently changed “date range picker” → “canned shortcuts.”

That’s totally fine for v1, but I’d explicitly mark this as:

* “v1 supports relative periods; full date-range picker is future work.”

Otherwise you’ll keep tripping over the mismatch when you return to the doc.

### 3.4 View count logic

`getGameReplay`:

* `UPDATE games SET views = views + 1`
* then select game and return `views: game.views + 1`.

This is **mostly fine** but:

* Under concurrency, you might show a value off by 1 vs what’s truly in DB, but it’s non-critical.
* If some bot / prefetcher hits the endpoint, it increments views. That might be OK; if not, you probably want a separate “mark view” endpoint or some simple cookie/session guard.

For v1, I’d accept this as good enough and document “views ≈ unique viewers, not exact.”

### 3.5 Skipping games with < 2 moves

This matches your spec (“Games with fewer than 2 moves are filtered out”) and your persistence code. Just make sure:

* You don’t also filter them *again* when querying; it’s redundant but harmless.
* You don’t accidentally call `persistCompletedGame` twice for the same session (e.g., move end + timeout handler both firing) – use an idempotency flag on the session or a unique constraint violation handling in DB.

---

## 4. Frontend & Replay

### 4.1 usePastGameReplay performance

You’re recomputing `GameState` by:

```ts
let gameState = createInitialGameState(config);
for (let i = 0; i <= currentMoveIndex; ++i) {
  gameState = gameState.applyGameAction(…);
}
```

Every time `currentMoveIndex` changes, you replay from scratch up to that move. That’s:

* O(n) per change.
* Worst-case O(n²) if you rapidly scrub back and forth.

Probably OK for your expected game lengths, but:

* It can get annoying if you later add auto-play or long games.
* A simple optimization is to store `prefixStates[]` once when the game loads (or lazily build as needed) so `goToMove` is O(1).

You don’t need to do this **now**, but I’d at least note: “If this becomes heavy, we’ll cache states per move index.”

### 4.2 Timestamps in replay

In the reconstruction loop you use `Date.now()` as the `timestamp` when applying moves.

If your `GameState` logic ever uses timestamp for clocks / timeouts, this could:

* Produce weird “time used” values.
* Confuse any UI that shows elapsed time per move.

If clocks are irrelevant in replay, I’d pass a constant (e.g. `0`) or explicitly document that GameState ignores timestamps for replay mode.

### 4.3 useGamePageController & handshake semantics

You detect mode as:

* “Has handshake → player”
* “No handshake → spectator, then distinguish live vs past via `/spectate` endpoint.”

Edge case: a user who *played* the game and comes back a day later from history still has the handshake in localStorage:

* They navigate to `/game/:id`.
* Controller sees handshake and puts them into player mode.
* But the server session is long gone; you’ll fail to connect / load live game, whereas you really want replay.

You need a “game finished” signal to override handshake:

* e.g., if you get 404 / GAME_COMPLETED when trying to join/spectate, fall back to replay controller and clear handshake for that game.

Otherwise, “I’m the host of this old game” behaves differently than “I’m a random spectator”.

### 4.4 Separate `/replay/:id` vs `/game/:id`-only

You’ve designed for “same URL across lifecycle,” which is elegant. But it also:

* Complicates mode detection.
* Means bots or crawlers hitting `/game/:id` might wake up live logic.

An alternative is **dual routes**:

* `/game/:id` – live (waiting + in progress)
* `/replay/:id` – always DB replay

Then your “Watch” button goes to `/replay/:id`, and `/game/:id` remains clean. You can still allow `/game/:id` to auto-redirect to `/replay/:id` once the game is known to be completed and not present in memory.

Not mandatory, but worth at least considering.

### 4.5 Chat disabled

You did a nice job piping “Chat is not preserved” into the controller, and graying out the chat.

Just ensure:

* Live games still use the same component but with a different `chatDisabledMessage` = `null`.
* You don’t accidentally hide the move history tab if you’ve coupled them (you currently map `formattedHistory` into chat as the “history” tab – that might be a bit too intertwined. If you split “move history” and “chat” visually, replay mode becomes cleaner to reason about.)

---

## 5. UX / Spec Mismatches & Small Gaps

A few places where the implementation plan drifts from your original UX spec.

1. **Board size filter disabled per variant**

   Spec: board dimensions selector may be disabled depending on variant.

   * Plan doesn’t discuss this; right now `/past-games` search schema just has `boardSize`.
   * You’ll want logic in the React filters to disable or hide the dropdown when `variant` makes it meaningless.

2. **Clickable table cells updating filters**

   Spec: clicking variant, rated, time control, board size, name, “vs” etc. all update filters.

   * Implementation plan shows how to hook some of these (`handlePlayerClick`, `handleVsClick`).
   * Make sure you also wire:

     * Click on variant → set `variant`.
     * Click on time control text → set `timeControl`.
     * Click on the board size label → set `boardSize`.

   It’s easy to forget to do these once the table renders “close enough.”

3. **Time period as date range vs shortcuts** (already mentioned)

4. **“Views” column**

   You have it in the data model; just ensure:

   * It’s actually displayed in the past games table.
   * The replay banner uses the same value (or you’re clear that the banner number may be one ahead due to immediate increment).

5. **Highlighting winner**

   Spec: winning player’s name is highlighted; draws indicated.

   * In `PastGameSummary` / `PastGameReplayPlayer` you have `isWinner` and `isDraw`.
   * Make sure the table rendering uses those flags for highlight and a small “½–½” or “draw” badge somewhere.

---

## 6. Suggested “Past Games v1” Cut-Down

If you were starting implementation right now, I’d probably aim at:

1. **DB:**

   * Add `games`, `game_details`, `game_players` tables (or extend existing).
   * Don’t change primary key yet. Add `publicId`/`sessionId` mapped from current session ID if needed.
   * Add minimal indices.

2. **Backend:**

   * `persistCompletedGame(session)` hooked into all end paths.
   * `GET /api/games/past` with:

     * Variant, rated, timeControl, boardSize, Elo range, timePeriod filters.
     * **Player filter either:**

       * Implemented correctly in SQL, **or**
       * Deferred completely (no player filter in v1).
   * `GET /api/games/:id/replay` (increment views, return replay payload).

3. **Frontend:**

   * `usePastGameReplay` hook.
   * A minimal `useReplayGameController` that:

     * Locks interactions.
     * Renders board and a basic move list.
     * No tight coupling with player/spectator controllers yet.
   * `/past-games` page:

     * Read filters from URL.
     * Fetch and display table.
     * “Watch” button navigates to either:

       * `/replay/:id` (simpler mode split), **or**
       * `/game/:id?mode=replay=1` if you want to keep it under `/game`.
   * Simple ReplayControls component + keyboard arrows.

4. **Out of v1:**

   * Move navigation for live games (players and live spectators).
   * Rematch refactor / `rematch-started` message.
   * PK refactor to UUID (unless your DB is tiny and you want to rip that band-aid off).

Once v1 is out and stable, then:

* Phase 2: global move navigation.
* Phase 3: rematch refactor + nice UX around series of games.
* Phase 4: any PK/sessionId cleanups if still bothering you.

---

**TL;DR:**

* The design is conceptually strong and matches your mental model of “URL as identity across lifecycle.”
* Main risks: **scope creep**, **PK migration**, and **query/pagination correctness** with player filters.
* For v1, I’d ruthlessly cut it down to “persist finished games, list them, replay them in a read-only way” and leave rematch + global navigation for later, while being honest about the shortcuts (timePeriod presets, no full player search in SQL yet, etc.).
