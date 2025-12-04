# Spectate Games – Final Implementation Plan

## 0. High-Level Goals

- Show all ongoing server games (friend or matchmaking) on a **Live Games** page.
- Allow users to click a live game and enter **spectator mode**:
  - They see the current position and full move history.
  - They see host on the bottom, joiner on the top.
  - They cannot interact with the game (no moves, no meta-actions, no chat).
- Keep the existing **Game Setup** page behavior intact:
  - `/game-setup`: games where a host is looking for an opponent.
  - `/live-games`: games already in-progress that anyone can spectate.
- All in-progress games are spectatable by everyone.
- Spectators auto-follow rematches without reloading.

---

## 1. Routes and Responsibilities

- `/game-setup` (existing):
  - Shows games in status "waiting" (matchmaking lobby).
  - Used for players to find a game to join.
- `/live-games` (existing page, needs wiring):
  - Shows games in status "in-progress" (live games only, no completed ones).
  - Backed by `/api/games/live` (REST, initial load) + `/ws/live-games` (WebSocket, real-time updates).
- `/game/:id`:
  - Player mode (existing): accessed with join/host flow using existing handshake/link.
  - Spectator mode (new): accessed without joining, just a plain `/game/:id`.
- `/api/games/:id/spectate`:
  - REST endpoint to fetch the initial snapshot/state for spectators.
- `/ws/games/:id`:
  - Existing game WebSocket extended to support both players and spectators.

---

## 2. Shared Types (shared/contracts/\*)

Add or update types in `shared/contracts/websocket-messages.ts` and/or `shared/contracts/games.ts`.

### 2.1 LiveGameSummary

A minimal, list-friendly summary used on `/live-games`. Extends fields from `GameSnapshot` with computed fields:

```typescript
// shared/contracts/games.ts
export interface LiveGameSummary {
  id: string;
  variant: Variant;
  rated: boolean;
  timeControl: TimeControlConfig;
  boardWidth: number;
  boardHeight: number;
  players: Array<{
    playerId: PlayerId;
    displayName: string;
    elo?: number;
    role: "host" | "joiner";
  }>;
  status: "in-progress"; // Only in-progress games appear in live list
  moveCount: number;
  averageElo: number; // Precomputed = average of players' elos (or 1500 if missing)
  lastMoveAt: number; // Timestamp; useful for sorting/tie-breaking
  spectatorCount: number; // Number of spectators currently watching
}
```

### 2.2 LiveGamesServerMessage

Tagged union protocol for `/ws/live-games`:

```typescript
// shared/contracts/websocket-messages.ts
export type LiveGamesServerMessage =
  | { type: "snapshot"; games: LiveGameSummary[] }
  | { type: "upsert"; game: LiveGameSummary }
  | { type: "remove"; gameId: string };
```

### 2.3 SpectateResponse

Response type for the spectate REST endpoint:

```typescript
// shared/contracts/games.ts
export interface SpectateResponse {
  snapshot: GameSnapshot;
  state: SerializedGameState;
}
```

### 2.4 Spectator-related WebSocket messages

No new server-to-client message types are needed. Spectators receive the same "state" and "match-status" messages as players.

Ensure existing messages in `websocket-messages.ts` document that they are sent to both players and spectators.

---

## 3. Backend Changes

### 3.1 Game Store – listLiveGames and spectator tracking (server/games/store.ts)

Add spectator tracking and live games listing:

```typescript
// Track spectator counts per game
const spectatorCounts = new Map<string, number>();

export const incrementSpectatorCount = (gameId: string): number => {
  const count = (spectatorCounts.get(gameId) ?? 0) + 1;
  spectatorCounts.set(gameId, count);
  return count;
};

export const decrementSpectatorCount = (gameId: string): number => {
  const count = Math.max(0, (spectatorCounts.get(gameId) ?? 1) - 1);
  if (count === 0) {
    spectatorCounts.delete(gameId);
  } else {
    spectatorCounts.set(gameId, count);
  }
  return count;
};

export const getSpectatorCount = (gameId: string): number => {
  return spectatorCounts.get(gameId) ?? 0;
};

export const listLiveGames = (limit: number = 100): LiveGameSummary[] => {
  return [...sessions.values()]
    .filter((session) => session.status === "in-progress")
    .map((session) => {
      const players = [session.players.host, session.players.joiner];
      const elos = players.map((p) => p.elo ?? 1500);
      const averageElo = Math.round((elos[0] + elos[1]) / 2);

      return {
        id: session.id,
        variant: session.config.variant,
        rated: session.config.rated,
        timeControl: session.config.timeControl,
        boardWidth: session.config.boardWidth,
        boardHeight: session.config.boardHeight,
        players: players.map((p) => ({
          playerId: p.playerId,
          displayName: p.displayName,
          elo: p.elo,
          role: p.role,
        })),
        status: "in-progress" as const,
        moveCount: session.gameState.moveCount,
        averageElo,
        lastMoveAt: session.updatedAt,
        spectatorCount: getSpectatorCount(session.id),
      };
    })
    .sort((a, b) => b.averageElo - a.averageElo || b.lastMoveAt - a.lastMoveAt)
    .slice(0, limit);
};

export const getLiveGameSummary = (gameId: string): LiveGameSummary | null => {
  const session = sessions.get(gameId);
  if (!session || session.status !== "in-progress") return null;
  // ... same mapping as above for single game
};
```

**Session Status Clarification:**

The actual status flow is:

1. `"waiting"` – Host created game, waiting for joiner OR joiner joined but not both ready
2. `"ready"` – Both players marked ready, game about to start
3. `"in-progress"` – First move made (transition happens in `applyActionToSession`)
4. `"completed"` – Game finished

Games only appear in live-games list when status === `"in-progress"`.

### 3.2 Live Games WebSocket – /ws/live-games (server/routes/game-socket.ts)

Add a new WebSocket endpoint separate from the existing lobby:

```typescript
// Separate connection set for live-games viewers
const liveGamesConnections = new Set<WebSocket>();

export const addLiveGamesConnection = (ws: WebSocket) => {
  liveGamesConnections.add(ws);
};

export const removeLiveGamesConnection = (ws: WebSocket) => {
  liveGamesConnections.delete(ws);
};

export const broadcastLiveGamesUpsert = (gameId: string) => {
  const summary = getLiveGameSummary(gameId);
  if (!summary) return;
  const message = JSON.stringify({ type: "upsert", game: summary });
  liveGamesConnections.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
};

export const broadcastLiveGamesRemove = (gameId: string) => {
  const message = JSON.stringify({ type: "remove", gameId });
  liveGamesConnections.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
};
```

Register the endpoint:

```typescript
app.get(
  "/ws/live-games",
  originCheckMiddleware,
  upgradeWebSocket(() => ({
    onOpen(_event: Event, ws: WSContext) {
      if (ws.raw && typeof ws.raw === "object") {
        addLiveGamesConnection(ws.raw as WebSocket);
      }
      // Send initial snapshot
      const games = listLiveGames(100);
      ws.send(JSON.stringify({ type: "snapshot", games }));
    },
    onMessage(event: MessageEvent, ws: WSContext) {
      // Handle ping for keepalive
      const raw = event.data;
      if (typeof raw === "string") {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
          }
        } catch {
          /* ignore */
        }
      }
    },
    onClose(_event: CloseEvent, ws: WSContext) {
      if (ws.raw && typeof ws.raw === "object") {
        removeLiveGamesConnection(ws.raw as WebSocket);
      }
    },
  })),
);
```

**Broadcast trigger points** (add to existing handlers):

1. In `handleMove`: After status changes to "in-progress", call `broadcastLiveGamesUpsert(sessionId)`. Also call on every move to update `moveCount` and `lastMoveAt`.
2. In `handleResign`, `handleDrawAccept`, and timeout handling: Call `broadcastLiveGamesRemove(sessionId)` when game ends.
3. In `handleRematchAccept`: After the new game state is set, call `broadcastLiveGamesUpsert(sessionId)`.

### 3.3 Game WebSocket – Spectator Support (server/routes/game-socket.ts)

**Extend the socket tracking types:**

```typescript
interface SessionSocket {
  ctx: WSContext;
  sessionId: string;
  socketToken: string | null; // null for spectators
  role: "host" | "joiner" | "spectator";
}
```

**Modify `gameSocketAuth` middleware** to allow spectator connections:

```typescript
const gameSocketAuth: MiddlewareHandler = async (c, next) => {
  if (!checkOrigin(c)) {
    return c.text("Unauthorized origin", 403);
  }

  const sessionId = c.req.param("id");
  if (!sessionId) {
    return c.text("Missing session id", 400);
  }

  const socketToken = c.req.query("token");

  // If no token provided, this is a spectator connection
  if (!socketToken) {
    // Verify game exists and is spectatable
    try {
      const session = getSession(sessionId);
      if (session.status === "waiting") {
        return c.text("Game not yet in progress", 400);
      }
      c.set("gameSocketMeta", {
        sessionId,
        socketToken: null,
        player: null,
        isSpectator: true,
      });
      await next();
      return;
    } catch {
      return c.text("Game not found", 404);
    }
  }

  // Existing player validation logic
  const resolved = resolveSessionForSocketToken({ id: sessionId, socketToken });
  if (!resolved) {
    return c.text("Invalid socket token", 401);
  }

  c.set("gameSocketMeta", {
    sessionId,
    socketToken,
    player: resolved.player,
    isSpectator: false,
  });
  await next();
};
```

**Update WebSocket handler** for spectators:

```typescript
// In the upgradeWebSocket callback:
onOpen(_event: Event, ws: WSContext) {
  const meta = c.get("gameSocketMeta");

  if (meta.isSpectator) {
    // Track as spectator
    const entry: SessionSocket = {
      ctx: ws,
      sessionId: meta.sessionId,
      socketToken: null,
      role: "spectator",
    };
    addSocket(entry);
    incrementSpectatorCount(meta.sessionId);
    broadcastLiveGamesUpsert(meta.sessionId); // Update spectator count in list

    // Send current state
    sendStateOnce(entry);
    sendMatchStatusOnce(entry);
  } else {
    // Existing player logic
    // ...
  }
},

onMessage(event: MessageEvent, ws: WSContext) {
  const entry = getEntryForContext(ws);
  if (!entry) return;

  // Spectators cannot send game messages
  if (entry.role === "spectator") {
    ws.send(JSON.stringify({
      type: "error",
      message: "Spectators cannot send game messages"
    }));
    return;
  }

  // Existing player message handling
  // ...
},

onClose(_event: CloseEvent, ws: WSContext) {
  const entry = getEntryForContext(ws);
  if (!entry) return;

  removeSocket(entry);

  if (entry.role === "spectator") {
    decrementSpectatorCount(entry.sessionId);
    broadcastLiveGamesUpsert(entry.sessionId); // Update spectator count
  } else {
    // Existing player disconnect logic
    updateConnectionState({ id: entry.sessionId, socketToken: entry.socketToken!, connected: false });
    sendMatchStatus(entry.sessionId);
  }
}
```

### 3.4 REST Endpoints (server/routes/games.ts)

**Add REST endpoint for live games list** (fallback if WebSocket fails):

```typescript
.get("/live", (c) => {
  try {
    const games = listLiveGames(100);
    return c.json({ games });
  } catch (error) {
    console.error("Failed to list live games:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
})
```

**Add spectate endpoint:**

```typescript
.get("/:id/spectate", (c) => {
  try {
    const { id } = c.req.param();
    const session = getSession(id);

    // Only allow spectating in-progress or completed games
    if (session.status === "waiting" || session.status === "ready") {
      return c.json({
        error: "This game is not currently spectatable",
        code: "GAME_NOT_STARTED"
      }, 404);
    }

    const snapshot = getSessionSnapshot(id);
    const state = getSerializedState(id);

    return c.json({ snapshot, state });
  } catch (error) {
    console.error("Failed to get spectate data:", error);
    return c.json({ error: "Game not found" }, 404);
  }
})
```

---

## 4. Frontend Changes

### 4.1 Spectator Client – NEW FILE (frontend/src/lib/spectator-client.ts)

Create a **separate, simpler client** for spectators instead of modifying `GameClient`. This reduces risk of breaking player connections:

```typescript
import type {
  GameSnapshot,
  SerializedGameState,
} from "../../../shared/domain/game-types";
import type { ServerMessage } from "../../../shared/contracts/websocket-messages";

export interface SpectatorClientHandlers {
  onState?: (state: SerializedGameState) => void;
  onMatchStatus?: (snapshot: GameSnapshot) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

const buildSpectatorSocketUrl = (gameId: string): string => {
  const base = new URL(window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `/ws/games/${gameId}`;
  // No token parameter = spectator mode
  return base.toString();
};

export class SpectatorClient {
  private socket: WebSocket | null = null;
  private handlers: SpectatorClientHandlers = {};

  constructor(private readonly gameId: string) {}

  connect(handlers: SpectatorClientHandlers): void {
    this.handlers = handlers;
    if (typeof window === "undefined") {
      handlers.onError?.("WebSocket not available");
      return;
    }

    const url = buildSpectatorSocketUrl(this.gameId);
    this.socket = new WebSocket(url);

    this.socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : null;
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as ServerMessage;
        if (payload.type === "state") {
          this.handlers.onState?.(payload.state);
        } else if (payload.type === "match-status") {
          this.handlers.onMatchStatus?.(payload.snapshot);
        } else if (payload.type === "error") {
          this.handlers.onError?.(payload.message);
        }
      } catch (error) {
        console.error("Failed to parse spectator message", error);
      }
    });

    this.socket.addEventListener("close", () => {
      this.handlers.onClose?.();
    });

    this.socket.addEventListener("error", () => {
      this.handlers.onError?.("WebSocket error occurred");
    });
  }

  close(): void {
    this.socket?.close();
  }

  // No sendMove, sendResign, etc. - spectators are read-only
}
```

### 4.2 Spectator Session Hook – NEW FILE (frontend/src/hooks/use-spectator-session.ts)

Create a **dedicated hook for spectator sessions** rather than extending `use-online-game-session.ts`:

```typescript
import { useState, useEffect, useRef, useCallback } from "react";
import { SpectatorClient } from "@/lib/spectator-client";
import type {
  GameSnapshot,
  SerializedGameState,
} from "../../../shared/domain/game-types";

interface SpectatorSessionState {
  snapshot: GameSnapshot | null;
  state: SerializedGameState | null;
  isLoading: boolean;
  error: string | null;
  isConnected: boolean;
}

export function useSpectatorSession(gameId: string) {
  const [sessionState, setSessionState] = useState<SpectatorSessionState>({
    snapshot: null,
    state: null,
    isLoading: true,
    error: null,
    isConnected: false,
  });

  const clientRef = useRef<SpectatorClient | null>(null);

  // Fetch initial state via REST
  useEffect(() => {
    let cancelled = false;

    const fetchInitialState = async () => {
      try {
        const res = await fetch(`/api/games/${gameId}/spectate`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to load game");
        }
        const data = await res.json();
        if (!cancelled) {
          setSessionState((prev) => ({
            ...prev,
            snapshot: data.snapshot,
            state: data.state,
            isLoading: false,
          }));
        }
      } catch (error) {
        if (!cancelled) {
          setSessionState((prev) => ({
            ...prev,
            isLoading: false,
            error:
              error instanceof Error ? error.message : "Failed to load game",
          }));
        }
      }
    };

    fetchInitialState();
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  // Connect WebSocket after initial load
  useEffect(() => {
    if (sessionState.isLoading || sessionState.error) return;

    const client = new SpectatorClient(gameId);
    clientRef.current = client;

    client.connect({
      onState: (state) => {
        setSessionState((prev) => ({ ...prev, state }));
      },
      onMatchStatus: (snapshot) => {
        setSessionState((prev) => ({ ...prev, snapshot }));
      },
      onError: (message) => {
        setSessionState((prev) => ({ ...prev, error: message }));
      },
      onClose: () => {
        setSessionState((prev) => ({ ...prev, isConnected: false }));
      },
    });

    setSessionState((prev) => ({ ...prev, isConnected: true }));

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [gameId, sessionState.isLoading, sessionState.error]);

  return sessionState;
}
```

### 4.3 Game Page Controller Updates (frontend/src/hooks/use-game-page-controller.ts)

**This is a critical section.** The controller is ~1900 lines and handles many player-specific concerns. For spectators, we need to:

1. **Early branch** to avoid initializing player controllers
2. **Null-safe handling** of `primaryLocalPlayerId`
3. **Simplified return value** for spectators

**Recommended approach: Add spectator detection at the top of the hook:**

```typescript
export function useGamePageController(gameId: string) {
  // Check for stored handshake FIRST
  const storedHandshake = useMemo(() => getGameHandshake(gameId), [gameId]);
  const isSpectator = !storedHandshake;

  // If spectator, use the simplified spectator hook
  if (isSpectator) {
    return useSpectatorGameController(gameId);
  }

  // ... existing player logic continues here ...
}
```

**Create a separate spectator controller function:**

```typescript
// Can be in the same file or a separate file
function useSpectatorGameController(gameId: string) {
  const spectatorSession = useSpectatorSession(gameId);

  // Derive simple display values from spectatorSession.state and spectatorSession.snapshot
  const gameState = useMemo(() => {
    if (!spectatorSession.state) return null;
    // Hydrate from serialized state
    const config = buildGameConfigurationFromSerialized(spectatorSession.state);
    return hydrateGameStateFromSerialized(spectatorSession.state, config);
  }, [spectatorSession.state]);

  const config = spectatorSession.state?.config ?? null;
  const matchSnapshot = spectatorSession.snapshot;

  // Determine player positions: host on bottom, joiner on top
  const players = useMemo(() => {
    if (!matchSnapshot) return { bottom: null, top: null };
    const host = matchSnapshot.players.find((p) => p.role === "host") ?? null;
    const joiner =
      matchSnapshot.players.find((p) => p.role === "joiner") ?? null;
    return { bottom: host, top: joiner };
  }, [matchSnapshot]);

  // Build display pawns
  const boardPawns = useMemo(() => {
    if (!gameState) return [];
    return gameState.getPawns().map((pawn) => ({
      ...pawn,
      id: pawnId(pawn),
    }));
  }, [gameState]);

  const boardWalls = useMemo(() => {
    if (!gameState) return [];
    return gameState.grid.getWalls().map((wall) => ({
      ...wall,
      state: "placed" as const,
    }));
  }, [gameState]);

  // Format history for display
  const formattedHistory = useMemo(() => {
    if (!gameState) return [];
    const rows = gameState.config.boardHeight;
    const entries = gameState.history.map((entry) => ({
      number: Math.ceil(entry.index / 2),
      notation: moveToStandardNotation(entry.move, rows),
    }));
    const paired: { num: number; white?: string; black?: string }[] = [];
    for (let i = 0; i < entries.length; i += 2) {
      paired.push({
        num: entries[i].number,
        white: entries[i]?.notation,
        black: entries[i + 1]?.notation,
      });
    }
    return paired;
  }, [gameState]);

  // Compute time left (read-only display)
  const displayedTimeLeft = useMemo(() => {
    if (!gameState) return { 1: 0, 2: 0 };
    const base: Record<PlayerId, number> = {
      1: gameState.timeLeft[1] ?? 0,
      2: gameState.timeLeft[2] ?? 0,
    };
    if (gameState.status === "playing") {
      const elapsed = (Date.now() - gameState.lastMoveTime) / 1000;
      base[gameState.turn] = Math.max(0, base[gameState.turn] - elapsed);
    }
    return base;
  }, [gameState]);

  const gameStatus = gameState?.status ?? "playing";
  const gameResult = gameState?.result ?? null;

  // Rematch status for spectators (read-only observation)
  const rematchStatusText = useMemo(() => {
    if (gameStatus !== "finished") return "";
    // Spectators just see a waiting message
    return "Waiting for players to decide on a rematch...";
  }, [gameStatus]);

  // Return a shape compatible with the game page
  return {
    isSpectator: true,
    matching: {
      isOpen: false,
      players: [],
      shareUrl: undefined,
      statusMessage: undefined,
      canAbort: false,
      onAbort: () => {},
    },
    board: {
      gameStatus,
      gameState,
      isLoadingConfig: spectatorSession.isLoading,
      loadError: spectatorSession.error,
      winnerPlayer: null, // Can derive from gameResult if needed
      winReason: gameResult?.reason ? formatWinReason(gameResult.reason) : null,
      scoreboardEntries: [],
      rematchState: {
        status: "idle",
        responses: { 1: "pending", 2: "pending" },
        requestId: 0,
      },
      rematchResponseSummary: [],
      rematchStatusText,
      primaryLocalPlayerId: null,
      userRematchResponse: null,
      handleAcceptRematch: () => {},
      handleDeclineRematch: () => {},
      openRematchWindow: () => {},
      handleExitAfterMatch: () => window.history.back(),
      rows: config?.boardHeight ?? 9,
      cols: config?.boardWidth ?? 9,
      boardPawns,
      boardWalls,
      stagedArrows: [],
      playerColorsForBoard: { 1: "red", 2: "blue" }, // Derive from player appearances
      interactionLocked: true, // Always locked for spectators
      lastMove: undefined,
      draggingPawnId: null,
      selectedPawnId: null,
      stagedActionsCount: 0,
      actionablePlayerId: null,
      onCellClick: () => {},
      onWallClick: () => {},
      onPawnClick: () => {},
      onPawnDragStart: () => {},
      onPawnDragEnd: () => {},
      onCellDrop: () => {},
      stagedActions: [],
      activeLocalPlayerId: null,
      hasActionMessage: false,
      actionError: null,
      actionStatusText: null,
      clearStagedActions: () => {},
      commitStagedActions: () => {},
    },
    timers: {
      topPlayer: players.top
        ? {
            id: `p${players.top.playerId}`,
            playerId: players.top.playerId,
            name: players.top.displayName,
            rating: players.top.elo ?? 1500,
            color: "blue" as const,
            type: "friend" as const,
            isOnline: players.top.connected,
          }
        : null,
      bottomPlayer: players.bottom
        ? {
            id: `p${players.bottom.playerId}`,
            playerId: players.bottom.playerId,
            name: players.bottom.displayName,
            rating: players.bottom.elo ?? 1500,
            color: "red" as const,
            type: "friend" as const,
            isOnline: players.bottom.connected,
          }
        : null,
      displayedTimeLeft,
      gameTurn: gameState?.turn ?? 1,
      thinkingPlayer: null,
      getPlayerMatchScore: () => null,
    },
    actions: {
      // All action-related props are no-ops for spectators
      drawDecisionPrompt: null,
      takebackDecisionPrompt: null,
      incomingPassiveNotice: null,
      getPlayerName: (id: PlayerId) =>
        matchSnapshot?.players.find((p) => p.playerId === id)?.displayName ??
        `Player ${id}`,
      respondToDrawPrompt: () => {},
      respondToTakebackPrompt: () => {},
      handleDismissIncomingNotice: () => {},
      resignFlowPlayerId: null,
      pendingDrawForLocal: false,
      pendingDrawOffer: null,
      takebackPendingForLocal: false,
      pendingTakebackRequest: null,
      outgoingTimeInfo: null,
      canCancelDrawOffer: false,
      canCancelTakebackRequest: false,
      handleCancelResign: () => {},
      handleConfirmResign: () => {},
      handleCancelDrawOffer: () => {},
      handleCancelTakebackRequest: () => {},
      handleDismissOutgoingInfo: () => {},
      actionButtonsDisabled: true,
      manualActionsDisabled: true,
      hasTakebackHistory: false,
      handleStartResign: () => {},
      handleOfferDraw: () => {},
      handleRequestTakeback: () => {},
      handleGiveTime: () => {},
    },
    chat: {
      activeTab: "history" as const,
      onTabChange: () => {},
      formattedHistory,
      chatChannel: "game" as const,
      messages: [],
      chatInput: "",
      onChannelChange: () => {},
      onInputChange: () => {},
      onSendMessage: () => {},
    },
    info: {
      config,
      defaultVariant: "standard" as const,
      defaultTimeControlPreset: "blitz" as const,
      soundEnabled: false,
      onSoundToggle: () => {},
      interactionLocked: true,
      isMultiplayerMatch: true,
      unsupportedPlayers: [],
      placeholderCopy: {},
    },
  };
}
```

### 4.4 Game Page UI Updates (frontend/src/routes/game.$id.tsx)

Add spectator-specific UI elements:

```typescript
function GamePage() {
  const { id } = Route.useParams();
  const controller = useGamePageController(id);

  // Destructure isSpectator from controller
  const { isSpectator, matching, board, timers, actions, chat, info } = controller;

  // ... existing layout code ...

  return (
    <>
      <div className="min-h-screen bg-background flex flex-col">
        {/* Spectator indicator banner */}
        {isSpectator && (
          <div className="bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-center py-2 text-sm font-medium">
            👁️ Spectating
          </div>
        )}

        {/* Only show matching panel for players */}
        {!isSpectator && (
          <MatchingStagePanel {...matching} />
        )}

        {/* ... rest of layout ... */}

        {/* Conditionally hide ActionsPanel for spectators */}
        {!isSpectator && (
          <div className="order-1 lg:order-2">
            <ActionsPanel {...actions} />
          </div>
        )}

        {/* ... rest of layout ... */}
      </div>
    </>
  );
}
```

### 4.5 Live Games Page Updates (frontend/src/routes/live-games.tsx)

Replace mock data with real WebSocket connection:

```typescript
import { useState, useEffect, useRef } from "react";
import type { LiveGameSummary, LiveGamesServerMessage } from "../../../shared/contracts/games";

function LiveGames() {
  const navigate = useNavigate();
  const [games, setGames] = useState<LiveGameSummary[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const url = new URL(window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/live-games";

    const ws = new WebSocket(url.toString());
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setIsConnected(true);
      setError(null);
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data) as LiveGamesServerMessage;

        if (msg.type === "snapshot") {
          setGames(msg.games);
        } else if (msg.type === "upsert") {
          setGames((prev) => {
            const idx = prev.findIndex((g) => g.id === msg.game.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = msg.game;
              return next;
            }
            return [...prev, msg.game];
          });
        } else if (msg.type === "remove") {
          setGames((prev) => prev.filter((g) => g.id !== msg.gameId));
        }
      } catch (err) {
        console.error("Failed to parse live games message", err);
      }
    });

    ws.addEventListener("close", () => {
      setIsConnected(false);
    });

    ws.addEventListener("error", () => {
      setError("Connection error. Retrying...");
    });

    // Ping to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);

    return () => {
      clearInterval(pingInterval);
      ws.close();
    };
  }, []);

  // ... filters state (existing) ...

  // Filter games client-side
  const filteredGames = useMemo(() => {
    return games.filter((game) => {
      if (filters.variant !== "all" && game.variant !== filters.variant) return false;
      if (filters.rated !== "all") {
        const wantRated = filters.rated === "yes";
        if (game.rated !== wantRated) return false;
      }
      // ... more filters ...
      return true;
    });
  }, [games, filters]);

  const handleWatchGame = (gameId: string) => {
    void navigate({ to: `/game/${gameId}` });
  };

  return (
    // ... existing JSX with real data instead of mock ...
    // Update table to use filteredGames
    // Add spectatorCount column display
  );
}
```

---

## 5. Runtime Flows

### 5.1 Live Games List Flow

1. User navigates to `/live-games`.
2. Frontend opens WS connection to `/ws/live-games`.
3. Server responds immediately with `{ type: "snapshot", games: LiveGameSummary[] }`.
4. Frontend stores and renders the list, sorted by averageElo.
5. When a game's first move is played (status changes to "in-progress"):
   - `applyActionToSession` updates status
   - Server calls `broadcastLiveGamesUpsert(gameId)`
   - Connected clients receive `{ type: "upsert", game }` and add/update the game in their list
6. When a game ends:
   - Server calls `broadcastLiveGamesRemove(gameId)`
   - Clients receive `{ type: "remove", gameId }` and remove from list
7. When spectators join/leave:
   - Server updates spectator count and calls `broadcastLiveGamesUpsert(gameId)`
   - Clients see updated viewer count

**Fallback:** If WebSocket fails, page can fall back to polling `/api/games/live` (not ideal but functional).

### 5.2 Spectator Entry Flow

1. Spectator clicks "Watch" on a row in `/live-games`.
2. Router navigates to `/game/:id` with no query params.
3. `useGamePageController` checks for stored handshake:
   - None found → `isSpectator = true`
   - Returns `useSpectatorGameController(gameId)` instead of full player logic
4. `useSpectatorSession` hook:
   - Calls `GET /api/games/:id/spectate`
   - If 200: receives snapshot + state, sets initial data
   - If 404: shows error message
5. After REST succeeds, hook connects to `/ws/games/:id` (no token = spectator)
6. Server adds connection to spectator set, sends fresh state
7. Subsequent moves broadcast to all connections (players + spectators)

### 5.3 Session Status Transitions (Clarification)

The actual status flow is:

```
"waiting" → "ready" → "in-progress" → "completed"
    ↑                                      |
    └──────────── (rematch) ───────────────┘
```

- **"waiting"**: Created, waiting for joiner OR joiner joined but host not ready
- **"ready"**: Both players marked ready
- **"in-progress"**: First move made (`applyActionToSession` sets this)
- **"completed"**: Game finished (win/draw/abort)

Games appear in `/live-games` ONLY when status === "in-progress".

### 5.4 Rematch Flow for Spectators

1. Game ends → spectators see final board, result, reason
2. UI shows: "Waiting for players to decide on a rematch..."
3. Players accept rematch:
   - Server resets game state via `resetSession`
   - Server broadcasts new "state" and "match-status" to ALL connections
   - Spectator UI automatically updates (board resets, clocks reset)
4. Players decline or disconnect:
   - Server broadcasts match-status with no rematch
   - Spectator UI updates: "Players did not start a rematch."

Spectators never need to navigate or reconnect to follow a rematch.

---

## 6. Test Plan (tests/integration/\*)

### 6.1 Live-games list tests

1. **Test: live-games list initial snapshot**
   - Connect to `/ws/live-games`
   - Expect `{ type: "snapshot", games: [] }` when no games in progress

2. **Test: game appears when first move is played**
   - Create and start a game (both players ready)
   - Connect to `/ws/live-games`, get empty snapshot
   - Player 1 makes a move → status becomes "in-progress"
   - Expect `{ type: "upsert", game: LiveGameSummary }`
   - Verify game has correct variant, rated, timeControl, players, moveCount=1

3. **Test: game removed when ended**
   - Start a game, verify it appears in live list
   - One player resigns
   - Expect `{ type: "remove", gameId }`

4. **Test: spectator count updates**
   - Start a game
   - Connect spectator to `/ws/games/:id`
   - Verify `/ws/live-games` receives upsert with spectatorCount=1
   - Disconnect spectator
   - Verify spectatorCount=0 in next upsert

### 6.2 Spectating tests

5. **Test: spectator REST endpoint**
   - Create game in "waiting" status
   - Call `/api/games/:id/spectate` → expect 404
   - Start game (make first move)
   - Call `/api/games/:id/spectate` → expect 200 with snapshot + state

6. **Test: spectator WebSocket connection**
   - Start game, make several moves
   - Connect to `/ws/games/:id` without token
   - Expect to receive "state" message with current board
   - Player makes move → spectator receives updated state

7. **Test: spectator cannot send messages**
   - Connect as spectator
   - Send `{ type: "submit-move", move: {...} }`
   - Expect error response, move not applied

8. **Test: multiple spectators**
   - Start game
   - Connect two spectators
   - Both receive same state updates
   - Game ends → both see final state and result

9. **Test: spectator follows rematch**
   - Spectator watching game that ends
   - Players accept rematch
   - Spectator receives new initial state without reconnecting
   - Board reset, clocks reset, moveCount=0

10. **Test: spectate completed game**
    - Complete a game
    - New spectator calls `/api/games/:id/spectate`
    - Receives final state with result
    - Can see full move history

---

## 7. Non-Goals and Constraints

- **No chat for spectators**: Spectators cannot send or see chat messages (chat is not yet implemented for players either).
- **No spectator-to-spectator chat**: Out of scope.
- **Live-games list only shows in-progress**: Completed games are not shown (but can be spectated via direct link).
- **All shared types in `shared/contracts/`**: No ad-hoc frontend or backend-only types for anything crossing the boundary.
- **Existing flows unchanged**: Token-based player joining via direct links continues to work. Spectator mode only triggers when no handshake exists.
- **Spectator count is live**: Updated on connect/disconnect, not persisted.

---

## 8. Implementation Order

Recommended order to minimize risk:

1. **Backend: Store changes** (listLiveGames, spectator counting)
2. **Backend: REST endpoints** (/api/games/live, /api/games/:id/spectate)
3. **Backend: /ws/live-games** WebSocket endpoint
4. **Backend: Modify game WebSocket auth** to allow spectators
5. **Frontend: SpectatorClient** class
6. **Frontend: useSpectatorSession** hook
7. **Frontend: useSpectatorGameController** function
8. **Frontend: Update useGamePageController** with early spectator branch
9. **Frontend: Update game page UI** for spectator mode
10. **Frontend: Wire up live-games page** to WebSocket
11. **Integration tests**
12. **Manual testing and polish**

---

This plan provides a clean, type-safe implementation with clear separation between player and spectator code paths, minimizing risk to existing functionality.
