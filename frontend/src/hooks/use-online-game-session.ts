import { useState, useEffect, useCallback, useRef } from "react";
import {
  resolveGameAccess,
  joinGameSession,
  type JoinGameSessionResult,
} from "@/lib/api";
import {
  getGameHandshake,
  saveGameHandshake,
  clearGameHandshake,
  type StoredGameHandshake,
} from "@/lib/game-session";
import type { GameSnapshot } from "../../../shared/domain/game-types";
import type { ResolveGameAccessResponse } from "../../../shared/contracts/games";
import type { LocalPreferences } from "@/hooks/use-game-page-controller";

interface UseOnlineGameSessionOptions {
  gameId: string;
  localPreferences: LocalPreferences;
  onMatchSnapshotUpdate?: (snapshot: GameSnapshot) => void;
  debugMatch?: (message: string, extra?: Record<string, unknown>) => void;
  enabled?: boolean;
}

export function useOnlineGameSession({
  gameId,
  localPreferences,
  onMatchSnapshotUpdate,
  debugMatch,
  enabled = true,
}: UseOnlineGameSessionOptions) {
  const initialHandshake =
    typeof window === "undefined" ? null : getGameHandshake(gameId);
  const [gameHandshake, setGameHandshake] =
    useState<StoredGameHandshake | null>(initialHandshake);
  const [matchShareUrl, setMatchShareUrl] = useState<string | undefined>(
    initialHandshake?.shareUrl,
  );
  const [matchError, setMatchError] = useState<string | null>(null);
  const [isMultiplayerMatch, setIsMultiplayerMatch] = useState(false);
  const [isResolvingAccess, setIsResolvingAccess] = useState(false);
  const [isClaimingSeat, setIsClaimingSeat] = useState(false);
  const [access, setAccess] = useState<ResolveGameAccessResponse | null>(null);
  const [resolveTick, setResolveTick] = useState(0);

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
      }
    },
    [gameId],
  );

  const handshakesEqual = useCallback(
    (a: StoredGameHandshake | null, b: StoredGameHandshake | null): boolean => {
      if (a === b) return true;
      if (!a || !b) return false;
      return (
        a.gameId === b.gameId &&
        a.token === b.token &&
        a.socketToken === b.socketToken &&
        a.role === b.role &&
        a.playerId === b.playerId &&
        a.shareUrl === b.shareUrl
      );
    },
    [],
  );

  const bootstrapRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setGameHandshake((prev) => (prev === null ? prev : null));
      setMatchShareUrl(undefined);
      bootstrapRef.current = null;
      return;
    }
    if (bootstrapRef.current === gameId) {
      return;
    }
    bootstrapRef.current = gameId;
    const stored =
      typeof window === "undefined" ? null : getGameHandshake(gameId);
    debugMatch?.("Bootstrapping stored match handshake", {
      id: gameId,
      hasStoredHandshake: Boolean(stored),
    });
    if (stored) {
      debugMatch?.("Using stored handshake", {
        id: gameId,
        role: stored.role,
        playerId: stored.playerId,
        token: maskToken(stored.token),
        socketToken: maskToken(stored.socketToken),
      });
      setGameHandshake((prev) =>
        handshakesEqual(prev, stored) ? prev : stored,
      );
      setMatchShareUrl((prev) =>
        prev === stored.shareUrl ? prev : stored.shareUrl,
      );
    } else {
      setGameHandshake((prev) => (prev === null ? prev : null));
      setMatchShareUrl((prev) => (prev === undefined ? prev : undefined));
    }
  }, [enabled, gameId, debugMatch, maskToken, handshakesEqual]);

  const resolveCacheRef = useRef<
    Map<string, Promise<ResolveGameAccessResponse>>
  >(new Map());

  useEffect(() => {
    if (!enabled) {
      setAccess(null);
      setIsMultiplayerMatch(false);
      setIsResolvingAccess(false);
      return;
    }

    const resolveKey = `${gameId}:${gameHandshake?.token ?? "public"}`;

    let cancelled = false;
    setIsResolvingAccess(true);

    const run = async () => {
      let cachedPromise: Promise<ResolveGameAccessResponse> | null = null;

      try {
        debugMatch?.("Resolving game access", {
          id: gameId,
          hasToken: Boolean(gameHandshake?.token),
        });
        cachedPromise = resolveCacheRef.current.get(resolveKey) ?? null;
        if (!cachedPromise) {
          cachedPromise = resolveGameAccess({
            gameId,
            token: gameHandshake?.token,
          });
          resolveCacheRef.current.set(resolveKey, cachedPromise);
        } else {
          debugMatch?.("Reusing in-flight resolve access", {
            cacheKey: resolveKey,
          });
        }
        const response = await cachedPromise;
        debugMatch?.("Finished resolve game access", {
          id: gameId,
          cancelled,
          kind: response.kind,
        });
        if (resolveCacheRef.current.get(resolveKey) === cachedPromise) {
          resolveCacheRef.current.delete(resolveKey);
        }
        if (cancelled) return;

        setAccess(response);
        debugMatch?.("Resolved game access result", {
          id: gameId,
          kind: response.kind,
          lifecycle:
            response.kind === "player" ||
            response.kind === "spectator" ||
            response.kind === "waiting" ||
            response.kind === "replay"
              ? response.matchStatus.status
              : undefined,
          matchType:
            response.kind === "player" ||
            response.kind === "spectator" ||
            response.kind === "waiting" ||
            response.kind === "replay"
              ? response.matchStatus.matchType
              : undefined,
        });

        if (response.kind === "not-found") {
          setIsMultiplayerMatch(false);
          setMatchShareUrl(undefined);
          setMatchError("Game not found.");
          if (gameHandshake) {
            updateGameHandshake(null);
          }
          return;
        }

        const isActiveMatch =
          response.kind === "player" ||
          response.kind === "spectator" ||
          response.kind === "waiting";
        debugMatch?.("Resolved access active flag", {
          id: gameId,
          isActiveMatch,
          responseKind: response.kind,
        });
        setIsMultiplayerMatch(isActiveMatch);
        setMatchError(null);
        if (response.shareUrl) {
          setMatchShareUrl(response.shareUrl);
        }
        onMatchSnapshotUpdate?.(response.matchStatus);

        if (response.kind === "player") {
          const nextHandshake: StoredGameHandshake = {
            gameId,
            token: response.seat.token,
            socketToken: response.seat.socketToken,
            role: response.seat.role,
            playerId: response.seat.playerId,
            shareUrl: response.shareUrl,
          };
          const handshakeChanged =
            !gameHandshake ||
            gameHandshake.token !== nextHandshake.token ||
            gameHandshake.socketToken !== nextHandshake.socketToken ||
            gameHandshake.playerId !== nextHandshake.playerId ||
            gameHandshake.role !== nextHandshake.role ||
            gameHandshake.shareUrl !== nextHandshake.shareUrl;
          if (handshakeChanged) {
            debugMatch?.("Updating stored handshake from resolve access", {
              id: gameId,
              role: nextHandshake.role,
              playerId: nextHandshake.playerId,
              token: maskToken(nextHandshake.token),
              socketToken: maskToken(nextHandshake.socketToken),
            });
            updateGameHandshake(nextHandshake);
          }
          return;
        }

        if (gameHandshake) {
          updateGameHandshake(null);
        }
      } catch (error) {
        if (
          cachedPromise &&
          resolveCacheRef.current.get(resolveKey) === cachedPromise
        ) {
          resolveCacheRef.current.delete(resolveKey);
        }
        if (cancelled) return;
        debugMatch?.("Failed to resolve game access", {
          id: gameId,
          error:
            error instanceof Error
              ? { message: error.message }
              : { message: "unknown error" },
        });
        setAccess(null);
        setIsMultiplayerMatch(false);
        setMatchError(
          error instanceof Error
            ? error.message
            : "Unable to load game session.",
        );
      } finally {
        if (!cancelled) {
          setIsResolvingAccess(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    gameId,
    gameHandshake,
    onMatchSnapshotUpdate,
    updateGameHandshake,
    debugMatch,
    maskToken,
    resolveTick,
  ]);

  const refetchAccess = useCallback(() => {
    setResolveTick((tick) => tick + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    if (access?.kind !== "waiting") return;
    const interval = window.setInterval(() => {
      refetchAccess();
    }, 4000);
    return () => {
      window.clearInterval(interval);
    };
  }, [enabled, access?.kind, refetchAccess]);

  const claimSeat = useCallback(async () => {
    if (!enabled || isClaimingSeat) {
      return;
    }
    setIsClaimingSeat(true);
    setMatchError(null);
    debugMatch?.("Attempting to claim available seat", { id: gameId });
    try {
      const result: JoinGameSessionResult = await joinGameSession({
        gameId,
        displayName: localPreferences.displayName,
        appearance: {
          pawnColor: localPreferences.pawnColor,
          catSkin: localPreferences.catSkin,
          mouseSkin: localPreferences.mouseSkin,
        },
      });
      if (result.kind !== "player") {
        debugMatch?.("Join result was not a player seat", {
          id: gameId,
          kind: result.kind,
        });
        setMatchError(
          "Unable to claim the seat. It may have been taken by another player.",
        );
        refetchAccess();
        return;
      }
      const handshake: StoredGameHandshake = {
        gameId,
        token: result.token,
        socketToken: result.socketToken,
        role: result.role,
        playerId: result.playerId,
        shareUrl: result.shareUrl,
      };
      updateGameHandshake(handshake);
      setMatchShareUrl(result.shareUrl);
      refetchAccess();
    } catch (error) {
      debugMatch?.("Seat claim failed", {
        id: gameId,
        error:
          error instanceof Error
            ? { message: error.message }
            : { message: "unknown error" },
      });
      setMatchError(
        error instanceof Error ? error.message : "Unable to join game.",
      );
    } finally {
      setIsClaimingSeat(false);
    }
  }, [
    debugMatch,
    enabled,
    gameId,
    isClaimingSeat,
    localPreferences.catSkin,
    localPreferences.displayName,
    localPreferences.mouseSkin,
    localPreferences.pawnColor,
    refetchAccess,
    updateGameHandshake,
  ]);

  return {
    gameHandshake,
    matchShareUrl,
    isMultiplayerMatch,
    isResolvingAccess,
    isClaimingSeat,
    matchError,
    setMatchError,
    updateGameHandshake,
    access,
    claimSeat,
    refetchAccess,
  };
}
