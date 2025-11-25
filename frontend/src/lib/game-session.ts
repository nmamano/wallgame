import type { PlayerId, MatchType } from "../../../shared/game-types";

export type GameRole = "host" | "joiner";

export interface StoredGameHandshake {
  gameId: string;
  token: string;
  socketToken: string;
  role: GameRole;
  playerId: PlayerId;
  matchType: MatchType;
  shareUrl?: string;
  inviteCode?: string;
}

const STORAGE_PREFIX = "game-handshake";

const buildKey = (gameId: string) => `${STORAGE_PREFIX}:${gameId}`;

export const saveGameHandshake = (payload: StoredGameHandshake) => {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(buildKey(payload.gameId), JSON.stringify(payload));
};

export const getGameHandshake = (
  gameId: string
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
