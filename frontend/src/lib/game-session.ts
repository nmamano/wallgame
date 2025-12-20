import type { PlayerId } from "../../../shared/domain/game-types";
import type { GameRole } from "../../../shared/contracts/games";

export interface StoredGameHandshake {
  gameId: string;
  token: string;
  socketToken: string;
  role: GameRole;
  playerId: PlayerId;
  shareUrl?: string;
}

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
