import { z } from "zod";
import { ANONYMOUS_ID_PATTERN } from "../domain/anonymous-id";
import type { PastGamesActivityDay } from "../domain/past-games";
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
  "unlimited",
] as const;
export const variantValues = ["standard", "classic", "freestyle"] as const;
export const customSetupVariantValues = [
  "custom-setup-standard",
  "custom-setup-classic",
] as const;

export const cellSchema = z
  .tuple([z.number().int().min(0).max(19), z.number().int().min(0).max(19)])
  .readonly();

const neutralWallSchema = z
  .object({
    cell: cellSchema,
    orientation: z.enum(["vertical", "horizontal"]),
  })
  .strict();

const setupActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["cat", "mouse"]),
    source: cellSchema,
    target: cellSchema,
  }),
  z.object({
    type: z.literal("wall"),
    target: cellSchema,
    wallOrientation: z.enum(["vertical", "horizontal"]),
  }),
]);

const setupTurnSchema = z.object({
  playerId: z.union([z.literal(1), z.literal(2)]),
  actionsTaken: z.union([z.tuple([]), z.tuple([setupActionSchema])]),
});

const standardInitialStateSchema = z.object({
  pawns: z.object({
    p1: z.object({ cat: cellSchema, mouse: cellSchema }),
    p2: z.object({ cat: cellSchema, mouse: cellSchema }),
  }),
  walls: z.array(neutralWallSchema),
  turn: setupTurnSchema,
});

const classicInitialStateSchema = z.object({
  pawns: z.object({
    p1: z.object({ cat: cellSchema, home: cellSchema }),
    p2: z.object({ cat: cellSchema, home: cellSchema }),
  }),
  walls: z.array(neutralWallSchema),
  turn: setupTurnSchema,
});

export const customSetupConfigSchema = z
  .discriminatedUnion("variant", [
    z.object({
      variant: z.literal("custom-setup-standard"),
      boardWidth: z.number().int().min(3).max(20),
      boardHeight: z.number().int().min(3).max(20),
      variantConfig: standardInitialStateSchema,
    }),
    z.object({
      variant: z.literal("custom-setup-classic"),
      boardWidth: z.number().int().min(3).max(20),
      boardHeight: z.number().int().min(3).max(20),
      variantConfig: classicInitialStateSchema,
    }),
  ])
  .superRefine((config, ctx) => {
    const cells =
      config.variant === "custom-setup-classic"
        ? [
            config.variantConfig.pawns.p1.cat,
            config.variantConfig.pawns.p1.home,
            config.variantConfig.pawns.p2.cat,
            config.variantConfig.pawns.p2.home,
          ]
        : [
            config.variantConfig.pawns.p1.cat,
            config.variantConfig.pawns.p1.mouse,
            config.variantConfig.pawns.p2.cat,
            config.variantConfig.pawns.p2.mouse,
          ];
    for (const [index, [row, col]] of cells.entries()) {
      if (row >= config.boardHeight || col >= config.boardWidth) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variantConfig", "pawns"],
          message: `pawn ${index + 1} is outside the board`,
        });
      }
    }
    for (const [index, wall] of config.variantConfig.walls.entries()) {
      const [row, col] = wall.cell;
      const outside =
        row >= config.boardHeight ||
        col >= config.boardWidth ||
        (wall.orientation === "vertical"
          ? col >= config.boardWidth - 1
          : row === 0);
      if (outside) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variantConfig", "walls", index],
          message: "wall is outside the playable board boundary",
        });
      }
    }

    const wallKeys = new Set<string>();
    for (const [index, wall] of config.variantConfig.walls.entries()) {
      const key = `${wall.cell[0]}:${wall.cell[1]}:${wall.orientation}`;
      if (wallKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variantConfig", "walls", index],
          message: "duplicate wall",
        });
      }
      wallKeys.add(key);
    }

    const [actionTaken] = config.variantConfig.turn.actionsTaken;
    if (!actionTaken) return;

    if (actionTaken.type === "wall") {
      const matchingWall = config.variantConfig.walls.some(
        (wall) =>
          wall.cell[0] === actionTaken.target[0] &&
          wall.cell[1] === actionTaken.target[1] &&
          wall.orientation === actionTaken.wallOrientation,
      );
      if (!matchingWall) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variantConfig", "turn", "actionsTaken", 0],
          message: "the spent wall action is not present in the position",
        });
      }
      return;
    }

    const [sourceRow, sourceCol] = actionTaken.source;
    const sourceInBounds =
      sourceRow < config.boardHeight && sourceCol < config.boardWidth;
    const distance =
      Math.abs(sourceRow - actionTaken.target[0]) +
      Math.abs(sourceCol - actionTaken.target[1]);
    if (
      config.variant === "custom-setup-classic" &&
      actionTaken.type === "mouse"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variantConfig", "turn", "actionsTaken", 0],
        message: "classic setup turns cannot contain a mouse action",
      });
      return;
    }
    const playerKey = config.variantConfig.turn.playerId === 1 ? "p1" : "p2";
    const pawnPosition =
      actionTaken.type === "cat"
        ? config.variantConfig.pawns[playerKey].cat
        : config.variant === "custom-setup-standard"
          ? config.variantConfig.pawns[playerKey].mouse
          : actionTaken.target;
    const targetMatchesPosition =
      pawnPosition[0] === actionTaken.target[0] &&
      pawnPosition[1] === actionTaken.target[1];
    const [targetRow, targetCol] = actionTaken.target;
    const blockingWall =
      sourceCol < targetCol
        ? config.variantConfig.walls.some(
            (wall) =>
              wall.orientation === "vertical" &&
              wall.cell[0] === sourceRow &&
              wall.cell[1] === sourceCol,
          )
        : sourceCol > targetCol
          ? config.variantConfig.walls.some(
              (wall) =>
                wall.orientation === "vertical" &&
                wall.cell[0] === targetRow &&
                wall.cell[1] === targetCol,
            )
          : sourceRow < targetRow
            ? config.variantConfig.walls.some(
                (wall) =>
                  wall.orientation === "horizontal" &&
                  wall.cell[0] === targetRow &&
                  wall.cell[1] === targetCol,
              )
            : config.variantConfig.walls.some(
                (wall) =>
                  wall.orientation === "horizontal" &&
                  wall.cell[0] === sourceRow &&
                  wall.cell[1] === sourceCol,
              );
    if (
      !sourceInBounds ||
      distance !== 1 ||
      !targetMatchesPosition ||
      blockingWall
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variantConfig", "turn", "actionsTaken", 0],
        message:
          "the spent pawn action must be one unblocked in-bounds step ending at the authored pawn position",
      });
    }
  });

export const timeControlSchema = z.object({
  initialSeconds: z
    .number()
    .int()
    .min(0) // 0 for unlimited time control
    .max(60 * 60),
  incrementSeconds: z.number().int().min(0).max(60),
  preset: z.enum(timeControlValues).optional(),
});

export const appearanceSchema = z
  .object({
    pawnColor: z.string().max(32).optional(),
    catSkin: z.string().max(64).optional(),
    mouseSkin: z.string().max(64).optional(),
    homeSkin: z.string().max(64).optional(),
  })
  .optional();

export const matchTypeValues = ["friend", "matchmaking"] as const;
export const boardSizeValues = ["small", "medium", "large"] as const;
export const playerConfigTypeValues = ["friend"] as const;
export type PlayerConfigType = (typeof playerConfigTypeValues)[number];

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
  /**
   * Configuration for the joiner/opponent seat.
   * If not provided, defaults to "friend" (human opponent joining via link).
   */
  joinerConfig: z
    .object({
      type: z.enum(playerConfigTypeValues),
      displayName: z.string().max(50).optional(),
    })
    .optional(),
  /**
   * This browser's anonymous id, when it has one. Correlation telemetry only -
   * see shared/domain/anonymous-id.ts. Optional because a browser that cannot
   * store it durably sends nothing rather than something unstable.
   */
  anonymousId: z.string().regex(ANONYMOUS_ID_PATTERN).optional(),
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
  /**
   * This browser's anonymous id, when it has one. Correlation telemetry only -
   * see shared/domain/anonymous-id.ts. Optional because a browser that cannot
   * store it durably sends nothing rather than something unstable.
   */
  anonymousId: z.string().regex(ANONYMOUS_ID_PATTERN).optional(),
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

export type GameAccessWaitingReason =
  | "seat-not-filled"
  | "host-aborted"
  | "rated-requires-login";

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
      matchType: MatchType;
      matchStatus: GameSnapshot;
      state: SerializedGameState;
      shareUrl?: string;
      views?: number;
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

// ============================================================================
// Past Games Types
// ============================================================================

export interface ShowcaseGame {
  matchStatus: GameSnapshot;
  state: SerializedGameState;
}

/**
 * The home page showcase fetches a batch once per page load and loops it, so an
 * open tab costs exactly one request instead of one every few seconds forever.
 */
export interface GameShowcaseResponse {
  games: ShowcaseGame[];
}

export const showcaseQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Everything that narrows *which* games Past Games is about, with no say in how
 * they are projected. The listing extends it with paging; the activity plot
 * validates against it directly, so "the same filters" is true by construction
 * rather than by two lists being kept in sync by hand.
 */
export const pastGamesFilterSchema = z.object({
  variant: z.enum(variantValues).optional(),
  rated: z.enum(["yes", "no"]).optional(),
  timeControl: z.enum(timeControlValues).optional(),
  boardSize: z.enum(boardSizeValues).optional(),
  minElo: z.coerce.number().int().min(0).optional(),
  maxElo: z.coerce.number().int().min(0).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  player1: z.string().trim().min(1).optional(),
  player2: z.string().trim().min(1).optional(),
});

export type PastGamesFilter = z.infer<typeof pastGamesFilterSchema>;

export const pastGamesQuerySchema = pastGamesFilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
});

export const pastGamesActivityQuerySchema = pastGamesFilterSchema;

export interface PastGamePlayerSummary {
  playerOrder: PlayerId;
  displayName: string;
  ratingAtStart: number | null;
  outcomeRank: number;
  outcomeReason: string;
}

export interface PastGameSummary {
  gameId: string;
  variant: Variant;
  rated: boolean;
  timeControl: string;
  boardWidth: number;
  boardHeight: number;
  movesCount: number;
  startedAt: number;
  views: number;
  players: PastGamePlayerSummary[];
}

export interface PastGamesResponse {
  games: PastGameSummary[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * The same games the listing would return, counted per UTC day instead of
 * paged. `days` always has PAST_GAMES_ACTIVITY_DAYS entries in ascending date
 * order, zeros included, and `total` is their sum.
 */
export interface PastGamesActivityResponse {
  days: PastGamesActivityDay[];
  total: number;
}

// ============================================================================
// Bot API Types (V3 Bot Game Session Protocol)
// ============================================================================

export const botsQuerySchema = z.object({
  variant: z.enum([...variantValues, ...customSetupVariantValues]),
  // V3: timeControl removed - bot games are untimed
  boardWidth: z.coerce.number().int().min(3).max(20).optional(),
  boardHeight: z.coerce.number().int().min(3).max(20).optional(),
});

/**
 * Server-authoritative saved-puzzle launch (S-P1): the client names the
 * puzzle; the server derives config, seat, and lead-in from the DB row.
 * `.strict()` so a request carrying a client config can never match this
 * variant and silently have it ignored.
 */
export const createBotGameFromPuzzleSchema = z
  .object({
    /** Composite bot ID: clientId:botId */
    botId: z.string(),
    puzzleId: z.string().min(1),
    hostDisplayName: z.string().max(50).optional(),
    hostAppearance: appearanceSchema,
    /**
     * This browser's anonymous id, when it has one. Correlation telemetry only
     * - see shared/domain/anonymous-id.ts.
     */
    anonymousId: z.string().regex(ANONYMOUS_ID_PATTERN).optional(),
  })
  .strict();

/**
 * Also `.strict()`: with a non-strict direct shape, a malformed puzzle
 * request (puzzleId + config) would fail the strict puzzle variant and then
 * MATCH here with puzzleId silently stripped — a client-authoritative launch
 * through the back door. Strict on both variants means such a request fails
 * the whole union instead.
 */
export const createBotGameDirectSchema = z
  .object({
    /** Composite bot ID: clientId:botId */
    botId: z.string(),
    /** V3: Bot game config has no timeControl - bot games are untimed */
    config: z.union([
      z.object({
        variant: z.enum(variantValues),
        boardWidth: z.number().int().min(3).max(20),
        boardHeight: z.number().int().min(3).max(20),
      }),
      customSetupConfigSchema,
    ]),
    hostDisplayName: z.string().max(50).optional(),
    hostAppearance: appearanceSchema,
    /**
     * Whether the host becomes Player 1 (who starts first).
     * If true, host is Player 1 and bot is Player 2.
     * If false, host is Player 2 and bot is Player 1.
     * If not provided, the server randomly chooses.
     * Tests can pass this explicitly for deterministic behavior.
     */
    hostIsPlayer1: z.boolean().optional(),
    /**
     * This browser's anonymous id, when it has one. Correlation telemetry only
     * - see shared/domain/anonymous-id.ts.
     */
    anonymousId: z.string().regex(ANONYMOUS_ID_PATTERN).optional(),
  })
  .strict();

export const createBotGameSchema = z.union([
  createBotGameFromPuzzleSchema,
  createBotGameDirectSchema,
]);

/** The wire config shape a bot game is created from (no timeControl). */
export type CreateBotGameConfig = z.infer<
  typeof createBotGameDirectSchema
>["config"];

export interface CreateBotGameResponse {
  gameId: string;
  token: string;
  socketToken: string;
  role: GameRole;
  playerId: PlayerId;
  shareUrl?: string;
}
