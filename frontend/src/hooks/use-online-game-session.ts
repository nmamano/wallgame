import { useState, useEffect, useRef, useCallback } from "react";
import { fetchGameSession, joinGameSession, markGameReady } from "@/lib/api";
import {
  getGameHandshake,
  saveGameHandshake,
  clearGameHandshake,
  type StoredGameHandshake,
} from "@/lib/game-session";
import type { GameSnapshot } from "../../../shared/game-types";
import type { LocalPreferences } from "@/hooks/use-game-page-controller";

interface UseOnlineGameSessionOptions {
  gameId: string;
  localPreferences: LocalPreferences;
  onMatchSnapshotUpdate?: (snapshot: GameSnapshot) => void;
  debugMatch?: (message: string, extra?: Record<string, unknown>) => void;
}

export function useOnlineGameSession({
  gameId,
  localPreferences,
  onMatchSnapshotUpdate,
  debugMatch,
}: UseOnlineGameSessionOptions) {
  const [gameHandshake, setGameHandshake] =
    useState<StoredGameHandshake | null>(null);
  const [matchShareUrl, setMatchShareUrl] = useState<string | undefined>(
    undefined,
  );
  const [matchError, setMatchError] = useState<string | null>(null);
  const [isMultiplayerMatch, setIsMultiplayerMatch] = useState(false);
  const [isJoiningMatch, setIsJoiningMatch] = useState(false);
  const hostReadyRef = useRef(false);

  const maskToken = useCallback((value?: string | null) => {
    if (!value) return undefined;
    if (value.length <= 8) return value;
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }, []);

  const updateGameHandshake = useCallback(
    (next: StoredGameHandshake | null) => {
      if (next) {
        saveGameHandshake(next);
        setGameHandshake(next);
        setMatchShareUrl(next.shareUrl);
      } else {
        clearGameHandshake(gameId);
        setGameHandshake(null);
        setMatchShareUrl(undefined);
      }
    },
    [gameId],
  );

  // Bootstrap: Load stored handshake or join game via URL
  useEffect(() => {
    let cancelled = false;
    const stored = getGameHandshake(gameId);
    debugMatch?.("Bootstrapping friend match state", {
      id: gameId,
      hasStoredHandshake: Boolean(stored),
    });
    if (stored) {
      debugMatch?.("Using stored friend handshake", {
        id: gameId,
        role: stored.role,
        playerId: stored.playerId,
        token: maskToken(stored.token),
        socketToken: maskToken(stored.socketToken),
      });
      setMatchShareUrl(stored.shareUrl);
      setGameHandshake(stored);
      setIsMultiplayerMatch(true);
      return () => {
        cancelled = true;
      };
    } else {
      // Try to join the game directly via URL
      debugMatch?.(
        "No stored handshake found; attempting to join game directly",
        {
          id: gameId,
        },
      );
      setIsMultiplayerMatch(true);
      setIsJoiningMatch(true);
      void (async () => {
        try {
          const details = await joinGameSession({
            gameId,
            displayName: localPreferences.displayName,
            appearance: {
              pawnColor: localPreferences.pawnColor,
              catSkin: localPreferences.catSkin,
              mouseSkin: localPreferences.mouseSkin,
            },
          });
          if (cancelled) return;
          const handshake: StoredGameHandshake = {
            gameId,
            token: details.token,
            socketToken: details.socketToken,
            role: details.role,
            playerId: details.playerId,
            matchType: details.snapshot.matchType,
            shareUrl: details.shareUrl,
          };
          updateGameHandshake(handshake);
          debugMatch?.("Joined friend game", {
            id: gameId,
            role: handshake.role,
            playerId: handshake.playerId,
            token: maskToken(handshake.token),
            socketToken: maskToken(handshake.socketToken),
          });
        } catch (error) {
          if (cancelled) return;
          debugMatch?.("Failed to join friend game via invite", {
            id: gameId,
            error:
              error instanceof Error
                ? { message: error.message }
                : { message: "unknown error" },
          });
          setMatchError(
            error instanceof Error
              ? error.message
              : "Unable to join friend game.",
          );
          setIsMultiplayerMatch(false);
        } finally {
          if (!cancelled) {
            setIsJoiningMatch(false);
          }
        }
      })();
    }
    return () => {
      cancelled = true;
    };
    // debugMatch is intentionally excluded from deps - it's just for logging
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    gameId,
    maskToken,
    localPreferences.displayName,
    localPreferences.pawnColor,
    localPreferences.catSkin,
    localPreferences.mouseSkin,
    updateGameHandshake,
  ]);

  // Fetch game session snapshot and mark host as ready if needed
  useEffect(() => {
    if (!gameHandshake) return;
    let cancelled = false;
    debugMatch?.("Fetching friend game session snapshot", {
      id: gameId,
      role: gameHandshake.role,
      playerId: gameHandshake.playerId,
      token: maskToken(gameHandshake.token),
    });
    void (async () => {
      try {
        const details = await fetchGameSession({
          gameId,
          token: gameHandshake.token,
        });
        if (cancelled) return;
        const snapshot = details.snapshot;
        onMatchSnapshotUpdate?.(snapshot);
        setMatchShareUrl(details.shareUrl ?? gameHandshake.shareUrl);
        if (details.shareUrl && details.shareUrl !== gameHandshake.shareUrl) {
          updateGameHandshake({
            ...gameHandshake,
            shareUrl: details.shareUrl,
          });
        }
        debugMatch?.("Loaded friend session snapshot", {
          id: gameId,
          status: snapshot.status,
          players: snapshot.players.map((player) => ({
            playerId: player.playerId,
            ready: player.ready,
            connected: player.connected,
          })),
        });
        if (details.role === "host" && !hostReadyRef.current) {
          try {
            debugMatch?.("Marking host as ready for friend game", {
              id: gameId,
              token: maskToken(gameHandshake.token),
            });
            const readySnapshot = await markGameReady({
              gameId,
              token: gameHandshake.token,
            });
            if (!cancelled) {
              onMatchSnapshotUpdate?.(readySnapshot);
            }
          } catch (error) {
            if (!cancelled) {
              console.error("Failed to mark friend game ready:", error);
            }
          } finally {
            hostReadyRef.current = true;
          }
        }
      } catch (error) {
        if (cancelled) return;
        debugMatch?.("Failed to load friend game snapshot", {
          id: gameId,
          error:
            error instanceof Error
              ? { message: error.message }
              : { message: "unknown error" },
        });
        setMatchError(
          error instanceof Error
            ? error.message
            : "Unable to load friend game.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // debugMatch is intentionally excluded from deps - it's just for logging
    // onMatchSnapshotUpdate should be stable (memoized in caller)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameHandshake, gameId, maskToken, updateGameHandshake]);

  return {
    gameHandshake,
    matchShareUrl,
    isMultiplayerMatch,
    isJoiningMatch,
    matchError,
    setMatchError,
    updateGameHandshake,
  };
}
