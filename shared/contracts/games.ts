import { z } from "zod";
import type {
  GameSnapshot,
  PlayerId,
  Variant,
  TimeControlConfig,
  SerializedGameState,
  MatchType,
} from "../domain/game-types";

export type GameRole = "host" | "joiner";

export const timeControlValues = [
  "bullet",
  "blitz",
  "rapid",
  "classical",
] as const;
export const variantValues = ["standard", "classic"] as const;

export const timeControlSchema = z.object({
  initialSeconds: z
    .number()
    .int()
    .min(10)
    .max(60 * 60),
  incrementSeconds: z.number().int().min(0).max(60),
  preset: z.enum(timeControlValues).optional(),
});

export const appearanceSchema = z
  .object({
    pawnColor: z.string().max(32).optional(),
    catSkin: z.string().max(64).optional(),
    mouseSkin: z.string().max(64).optional(),
  })
  .optional();

export const matchTypeValues = ["friend", "matchmaking"] as const;

export const createGameSchema = z.object({
  config: z.object({
    timeControl: timeControlSchema,
    rated: z.boolean().optional().default(false),
    variant: z.enum(variantValues),
    boardWidth: z.number().int().min(3).max(20),
    boardHeight: z.number().int().min(3).max(20),
  }),
  matchType: z.enum(matchTypeValues).default("friend"),
  hostDisplayName: z.string().max(50).optional(),
  hostAppearance: appearanceSchema,
  /**
   * Whether the host becomes Player 1 (who starts first and has left-side pawns).
   * If true, host is Player 1 and joiner is Player 2.
   * If false, host is Player 2 and joiner is Player 1.
   * If not provided, the server randomly chooses.
   * Tests can pass this explicitly for deterministic behavior.
   */
  hostIsPlayer1: z.boolean().optional(),
});

export interface GameCreateResponse {
  gameId: string;
  hostToken: string;
  socketToken: string;
  shareUrl: string;
  snapshot: GameSnapshot;
}

export interface GameSessionDetails {
  snapshot: GameSnapshot;
  role: GameRole;
  playerId: PlayerId;
  token: string;
  socketToken: string;
  shareUrl?: string;
}

export const joinGameSchema = z.object({
  displayName: z.string().max(50).optional(),
  appearance: appearanceSchema,
});

export const readySchema = z.object({
  token: z.string(),
});

export const getGameSessionQuerySchema = z.object({
  token: z.string().optional(),
});

// Response types
export interface MatchmakingGamesResponse {
  games: GameSnapshot[];
}

export type JoinGameResponse =
  | {
      role: "player";
      seat: GameRole;
      playerId: PlayerId;
      token: string;
      socketToken: string;
      snapshot: GameSnapshot;
      shareUrl: string;
    }
  | {
      role: "spectator";
      snapshot: GameSnapshot;
      shareUrl: string;
    };

export interface ReadyGameResponse {
  success: boolean;
  snapshot: GameSnapshot;
}

export interface ErrorResponse {
  error: string;
}

export type GameAccessWaitingReason = "seat-not-filled" | "host-aborted";

export type ResolveGameAccessResponse =
  | {
      kind: "player";
      gameId: string;
      matchType: MatchType;
      seat: {
        role: GameRole;
        playerId: PlayerId;
        token: string;
        socketToken: string;
      };
      matchStatus: GameSnapshot;
      state: SerializedGameState;
      shareUrl?: string;
    }
  | {
      kind: "spectator";
      gameId: string;
      matchType: MatchType;
      matchStatus: GameSnapshot;
      state: SerializedGameState;
      shareUrl?: string;
    }
  | {
      kind: "waiting";
      gameId: string;
      reason: GameAccessWaitingReason;
      matchStatus: GameSnapshot;
      shareUrl?: string;
    }
  | {
      kind: "replay";
      gameId: string;
      matchStatus: GameSnapshot;
      shareUrl?: string;
    }
  | {
      kind: "not-found";
    };

// ============================================================================
// Live Games / Spectate Types
// ============================================================================

/**
 * A minimal, list-friendly summary of a live game.
 * Used on the /live-games page for displaying in-progress games.
 */
export interface LiveGameSummary {
  id: string;
  variant: Variant;
  rated: boolean;
  timeControl: TimeControlConfig;
  boardWidth: number;
  boardHeight: number;
  players: {
    playerId: PlayerId;
    displayName: string;
    elo?: number;
    role: "host" | "joiner";
  }[];
  status: "ready" | "in-progress";
  moveCount: number;
  averageElo: number;
  lastMoveAt: number;
  spectatorCount: number;
}

export interface LiveGamesResponse {
  games: LiveGameSummary[];
}
