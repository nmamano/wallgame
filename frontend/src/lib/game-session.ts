import type { PlayerId, PuzzleRef } from "../../../shared/domain/game-types";
import type { GameRole } from "../../../shared/contracts/games";

export interface StoredGameHandshake {
  gameId: string;
  token: string;
  socketToken: string;
  role: GameRole;
  playerId: PlayerId;
  shareUrl?: string;
  /**
   * Which puzzle launched this game and its name, carried client-side only
   * (no name on the game record — doc §G). Present only on the launching
   * client; spectators and shared links fall back to a generic "Puzzle".
   * Retry relaunches `ref`.
   */
  puzzle?: { ref: PuzzleRef; name: string };
}

const puzzlesEqual = (
  a: StoredGameHandshake["puzzle"],
  b: StoredGameHandshake["puzzle"],
): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Structural equality including puzzle metadata — a rewrite that dropped
 * puzzleId/puzzleName must not read as "unchanged".
 */
export const handshakesEqual = (
  a: StoredGameHandshake | null,
  b: StoredGameHandshake | null,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.gameId === b.gameId &&
    a.token === b.token &&
    a.socketToken === b.socketToken &&
    a.role === b.role &&
    a.playerId === b.playerId &&
    a.shareUrl === b.shareUrl &&
    puzzlesEqual(a.puzzle, b.puzzle)
  );
};

/**
 * Carry puzzle metadata from a previous handshake onto a rebuilt one.
 * Every path that reconstructs a handshake (resolve-access refresh, seat
 * claim, rematch, Retry) must route through this so the fields survive
 * every rewrite, not just the initial launch.
 */
export const withPuzzleMetadataFrom = (
  next: StoredGameHandshake,
  previous: StoredGameHandshake | null | undefined,
): StoredGameHandshake => {
  if (!previous?.puzzle) return next;
  return { ...next, puzzle: previous.puzzle };
};

/**
 * The banner's puzzle name: only a handshake carrying the puzzle yields a
 * name; anything else (spectators, shared links) resolves to null and the UI
 * shows the generic label.
 */
export const getPuzzleBannerName = (
  handshake: StoredGameHandshake | null,
): string | null => handshake?.puzzle?.name ?? null;

const STORAGE_PREFIX = "game-handshake";

const buildKey = (gameId: string) => `${STORAGE_PREFIX}:${gameId}`;

export const saveGameHandshake = (payload: StoredGameHandshake) => {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(buildKey(payload.gameId), JSON.stringify(payload));
};

export const getGameHandshake = (
  gameId: string,
): StoredGameHandshake | null => {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(buildKey(gameId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredGameHandshake;
  } catch {
    sessionStorage.removeItem(buildKey(gameId));
    return null;
  }
};

export const clearGameHandshake = (gameId: string) => {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(buildKey(gameId));
};
