import { useState, useEffect, useRef } from "react";
import { SpectatorClient } from "@/lib/spectator-client";
import type {
  GameSnapshot,
  SerializedGameState,
} from "../../../shared/domain/game-types";
import type { SpectateResponse } from "../../../shared/contracts/games";

interface SpectatorSessionState {
  snapshot: GameSnapshot | null;
  state: SerializedGameState | null;
  isLoading: boolean;
  error: string | null;
  isConnected: boolean;
}

/**
 * Hook for managing a spectator session.
 * Fetches initial state via REST, then connects via WebSocket for real-time updates.
 */
export function useSpectatorSession(gameId: string) {
  const [sessionState, setSessionState] = useState<SpectatorSessionState>({
    snapshot: null,
    state: null,
    isLoading: true,
    error: null,
    isConnected: false,
  });

  const clientRef = useRef<SpectatorClient | null>(null);
  const hasInitializedRef = useRef(false);

  // Fetch initial state via REST
  useEffect(() => {
    let cancelled = false;
    hasInitializedRef.current = false;

    const fetchInitialState = async () => {
      try {
        const res = await fetch(`/api/games/${gameId}/spectate`);
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(data.error ?? "Failed to load game");
        }
        const data = (await res.json()) as SpectateResponse;
        if (!cancelled) {
          setSessionState((prev) => ({
            ...prev,
            snapshot: data.snapshot,
            state: data.state,
            isLoading: false,
          }));
          hasInitializedRef.current = true;
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

    void fetchInitialState();
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  // Connect WebSocket after initial load succeeds
  useEffect(() => {
    if (
      sessionState.isLoading ||
      sessionState.error ||
      !hasInitializedRef.current
    ) {
      return;
    }

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
        console.error("[useSpectatorSession] WebSocket error:", message);
        // Don't set error state for transient WebSocket errors
        // as we already have state from the REST endpoint
      },
      onOpen: () => {
        setSessionState((prev) => ({ ...prev, isConnected: true }));
      },
      onClose: () => {
        setSessionState((prev) => ({ ...prev, isConnected: false }));
      },
    });

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [gameId, sessionState.isLoading, sessionState.error]);

  return sessionState;
}
