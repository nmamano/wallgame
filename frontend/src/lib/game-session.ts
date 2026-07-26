import type { PlayerId } from "../../../shared/domain/game-types";
import type { GameRole } from "../../../shared/contracts/games";

export interface StoredGameHandshake {
  gameId: string;
  token: string;
  socketToken: string;
  role: GameRole;
  playerId: PlayerId;
  shareUrl?: string;
  /**
   * Which saved puzzle launched this game, carried client-side only (no
   * field on the game record — doc §G). Present only on the launching
   * client; spectators and shared links fall back to a generic "Puzzle".
   */
  puzzleId?: string;
  puzzleName?: string;
}

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
    a.puzzleId === b.puzzleId &&
    a.puzzleName === b.puzzleName
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
  // The pair is atomic: a lone id or lone name (malformed storage) is not
  // carried — the banner would have nothing trustworthy to show anyway.
  if (!previous?.puzzleId || !previous.puzzleName) return next;
  return {
    ...next,
    puzzleId: previous.puzzleId,
    puzzleName: previous.puzzleName,
  };
};

/**
 * The banner's puzzle name: only a handshake carrying the full atomic
 * id+name pair yields a name; anything else (spectators, shared links,
 * malformed halves) resolves to null and the UI shows the generic label.
 */
export const getPuzzleBannerName = (
  handshake: StoredGameHandshake | null,
): string | null =>
  handshake?.puzzleId && handshake.puzzleName ? handshake.puzzleName : null;

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
