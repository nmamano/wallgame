import { z } from "zod";
import { ANONYMOUS_ID_PATTERN } from "../domain/anonymous-id";
import { isValidTimeZone } from "../domain/past-games";
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
export const variantValues = ["standard", "animal-cycle", "classic"] as const;

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
    type: z.enum(["dog", "cat", "mouse", "elephant"]),
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

const animalCycleInitialStateSchema = z.object({
  pawns: z.object({
    p1: z.object({ cat: cellSchema, elephant: cellSchema }),
    p2: z.object({ mouse: cellSchema, dog: cellSchema }),
  }),
  walls: z.array(neutralWallSchema),
  turn: setupTurnSchema.optional(),
});

const suppliedStandardInitialStateSchema = standardInitialStateSchema.extend({
  turn: setupTurnSchema.optional(),
});
const suppliedClassicInitialStateSchema = classicInitialStateSchema.extend({
  turn: setupTurnSchema.optional(),
});

export const authoredPositionConfigSchema = z
  .discriminatedUnion("variant", [
    z.object({
      variant: z.literal("standard"),
      boardWidth: z.number().int().min(3).max(20),
      boardHeight: z.number().int().min(3).max(20),
      initialState: standardInitialStateSchema,
    }),
    z.object({
      variant: z.literal("classic"),
      boardWidth: z.number().int().min(3).max(20),
      boardHeight: z.number().int().min(3).max(20),
      initialState: classicInitialStateSchema,
    }),
  ])
  .superRefine((config, ctx) => {
    const cells =
      config.variant === "classic"
        ? [
            config.initialState.pawns.p1.cat,
            config.initialState.pawns.p1.home,
            config.initialState.pawns.p2.cat,
            config.initialState.pawns.p2.home,
          ]
        : [
            config.initialState.pawns.p1.cat,
            config.initialState.pawns.p1.mouse,
            config.initialState.pawns.p2.cat,
            config.initialState.pawns.p2.mouse,
          ];
    for (const [index, [row, col]] of cells.entries()) {
      if (row >= config.boardHeight || col >= config.boardWidth) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["initialState", "pawns"],
          message: `pawn ${index + 1} is outside the board`,
        });
      }
    }
    for (const [index, wall] of config.initialState.walls.entries()) {
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
          path: ["initialState", "walls", index],
          message: "wall is outside the playable board boundary",
        });
      }
    }

    const wallKeys = new Set<string>();
    for (const [index, wall] of config.initialState.walls.entries()) {
      const key = `${wall.cell[0]}:${wall.cell[1]}:${wall.orientation}`;
      if (wallKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["initialState", "walls", index],
          message: "duplicate wall",
        });
      }
      wallKeys.add(key);
    }

    const [actionTaken] = config.initialState.turn.actionsTaken;
    if (!actionTaken) return;

    if (actionTaken.type === "wall") {
      const matchingWall = config.initialState.walls.some(
        (wall) =>
          wall.cell[0] === actionTaken.target[0] &&
          wall.cell[1] === actionTaken.target[1] &&
          wall.orientation === actionTaken.wallOrientation,
      );
      if (!matchingWall) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["initialState", "turn", "actionsTaken", 0],
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
    const allowedPawnAction =
      actionTaken.type === "cat" ||
      (config.variant === "standard" && actionTaken.type === "mouse");
    if (!allowedPawnAction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initialState", "turn", "actionsTaken", 0],
        message: `${config.variant} cannot contain a ${actionTaken.type} action`,
      });
      return;
    }
    const playerKey = config.initialState.turn.playerId === 1 ? "p1" : "p2";
    const pawnPosition =
      actionTaken.type === "cat"
        ? config.initialState.pawns[playerKey].cat
        : config.variant === "standard"
          ? config.initialState.pawns[playerKey].mouse
          : actionTaken.target;
    const targetMatchesPosition =
      pawnPosition[0] === actionTaken.target[0] &&
      pawnPosition[1] === actionTaken.target[1];
    const [targetRow, targetCol] = actionTaken.target;
    const blockingWall =
      sourceCol < targetCol
        ? config.initialState.walls.some(
            (wall) =>
              wall.orientation === "vertical" &&
              wall.cell[0] === sourceRow &&
              wall.cell[1] === sourceCol,
          )
        : sourceCol > targetCol
          ? config.initialState.walls.some(
              (wall) =>
                wall.orientation === "vertical" &&
                wall.cell[0] === targetRow &&
                wall.cell[1] === targetCol,
            )
          : sourceRow < targetRow
            ? config.initialState.walls.some(
                (wall) =>
                  wall.orientation === "horizontal" &&
                  wall.cell[0] === targetRow &&
                  wall.cell[1] === targetCol,
              )
            : config.initialState.walls.some(
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
        path: ["initialState", "turn", "actionsTaken", 0],
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
    dogSkin: z.string().max(64).optional(),
    catSkin: z.string().max(64).optional(),
    mouseSkin: z.string().max(64).optional(),
    elephantSkin: z.string().max(64).optional(),
    homeSkin: z.string().max(64).optional(),
  })
  .optional();

export const matchTypeValues = ["friend", "matchmaking"] as const;
export const boardSizeValues = ["small", "medium", "large"] as const;
export const playerConfigTypeValues = ["friend"] as const;
export type PlayerConfigType = (typeof playerConfigTypeValues)[number];

/**
 * The smallest board side a variant will accept, and the one place that rule
 * is written down.
 *
 * Animal Cycle Random Start needs 4 a side to lay out four animals; anything
 * else needs the general minimum of 3. Board c8e27470: this rule was enforced
 * ONLY when creating a game, while saved per-variant defaults were stored
 * unbounded, so an account could hold a board that game creation then refused
 * - with a 400 the player could not read. Both the settings write path and the
 * client-side clamp now ask this function rather than restating it.
 */
export const BOARD_SIDE_MIN = 3;
export const BOARD_SIDE_MAX = 20;
export const ANIMAL_CYCLE_RANDOM_START_MIN_SIDE = 4;

export const minimumBoardSideFor = (config: {
  variant: string;
  randomStart: boolean;
}): number =>
  config.variant === "animal-cycle" && config.randomStart
    ? ANIMAL_CYCLE_RANDOM_START_MIN_SIDE
    : BOARD_SIDE_MIN;

/**
 * A stored board size brought inside what the rules allow.
 *
 * Raising a too-small board is what repairs an account that already holds one:
 * bounding the write path alone would only stop NEW bad values, leaving the
 * player who has one stuck on an error every time they pick that variant.
 */
export const clampBoardSizeForVariant = (config: {
  variant: string;
  randomStart: boolean;
  boardWidth: number;
  boardHeight: number;
}): { boardWidth: number; boardHeight: number } => {
  const min = minimumBoardSideFor(config);
  const bring = (side: number) =>
    Math.min(BOARD_SIDE_MAX, Math.max(min, Math.round(side)));
  return {
    boardWidth: bring(config.boardWidth),
    boardHeight: bring(config.boardHeight),
  };
};

const currentCreateConfigSchema = z.object({
  timeControl: timeControlSchema,
  rated: z.boolean().optional().default(false),
  variant: z.enum(["standard", "animal-cycle", "classic"]),
  randomStart: z.boolean(),
  boardWidth: z.number().int().min(3).max(20),
  boardHeight: z.number().int().min(3).max(20),
  initialState: z
    .union([
      suppliedStandardInitialStateSchema,
      suppliedClassicInitialStateSchema,
      animalCycleInitialStateSchema,
    ])
    .optional(),
});

export const createGameSchema = z.object({
  config: currentCreateConfigSchema
    .superRefine((config, ctx) => {
      if (
        Math.min(config.boardWidth, config.boardHeight) <
        minimumBoardSideFor(config)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["randomStart"],
          message:
            "Animal Cycle Random Start requires both board dimensions to be at least 4.",
        });
      }
      if (!config.initialState) return;
      const pawns = config.initialState.pawns;
      const matchesVariant =
        (config.variant === "standard" && "mouse" in pawns.p1) ||
        (config.variant === "classic" && "home" in pawns.p1) ||
        (config.variant === "animal-cycle" && "dog" in pawns.p1);
      if (!matchesVariant) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["initialState"],
          message: `initialState does not match ${config.variant}`,
        });
      }
    })
    .transform(({ initialState, ...config }) =>
      initialState ? { ...config, variantConfig: initialState } : config,
    ),
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
  randomStart: boolean;
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

/**
 * The plot's days are the reader's own calendar days, so the browser sends its
 * zone. Projection-specific, like the 90-day window itself - it says nothing
 * about WHICH games match, only how they are grouped - so it rides on this
 * schema rather than on the shared filter.
 */
export const pastGamesActivityQuerySchema = pastGamesFilterSchema.extend({
  timeZone: z
    .string()
    .default("UTC")
    .refine(isValidTimeZone, "Unknown time zone"),
});

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
  randomStart: boolean;
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
  variant: z.enum(variantValues),
  randomStart: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  // V3: timeControl removed - bot games are untimed
  boardWidth: z.coerce.number().int().min(3).max(20).optional(),
  boardHeight: z.coerce.number().int().min(3).max(20).optional(),
  placement: z.enum(["opponent", "puzzle"]).optional().default("opponent"),
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
      z
        .object({
          variant: z.enum(["standard", "animal-cycle", "classic"]),
          randomStart: z.boolean(),
          boardWidth: z.number().int().min(3).max(20),
          boardHeight: z.number().int().min(3).max(20),
        })
        .superRefine((config, ctx) => {
          if (
            Math.min(config.boardWidth, config.boardHeight) <
            minimumBoardSideFor(config)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["randomStart"],
              message:
                "Animal Cycle Random Start requires both board dimensions to be at least 4.",
            });
          }
        }),
      authoredPositionConfigSchema.transform((config) => ({
        variant: config.variant,
        boardWidth: config.boardWidth,
        boardHeight: config.boardHeight,
        randomStart: false as const,
        variantConfig: config.initialState,
      })),
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
