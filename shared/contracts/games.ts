import { z } from "zod";
import type { GameSnapshot, PlayerId } from "../domain/game-types";

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
    boardWidth: z.number().int().min(4).max(20),
    boardHeight: z.number().int().min(4).max(20),
  }),
  matchType: z.enum(matchTypeValues).default("friend"),
  hostDisplayName: z.string().max(50).optional(),
  hostAppearance: appearanceSchema,
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
  token: z.string(),
});

// Response types
export interface MatchmakingGamesResponse {
  games: GameSnapshot[];
}

export interface JoinGameResponse {
  gameId: string;
  token: string;
  socketToken: string;
  snapshot: GameSnapshot;
  shareUrl: string;
}

export interface ReadyGameResponse {
  success: boolean;
  snapshot: GameSnapshot;
}

export interface ErrorResponse {
  error: string;
}
