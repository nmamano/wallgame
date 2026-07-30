import {
  savedPuzzlesResponseSchema,
  puzzleProgressResponseSchema,
  puzzleVoteStateSchema,
  type SavedPuzzle,
  type SavedPuzzlesResponse,
  type PuzzleProgressResponse,
  type PuzzleVoteState,
} from "../../../shared/contracts/puzzles";
import { hc, type ClientResponse } from "hono/client";
import { type ApiRoutes } from "@server/index";
import { queryOptions } from "@tanstack/react-query";
import type {
  GameSnapshot,
  GameConfiguration,
  PlayerAppearance,
  TimeControlPreset,
  TimeControlConfig,
  Variant,
  NonSurvivalVariant,
  CustomSetupClassicInitialState,
  CustomSetupStandardInitialState,
  MatchType,
} from "../../../shared/domain/game-types";
import { timeControlConfigFromPreset } from "../../../shared/domain/game-utils";
import type {
  GameCreateResponse,
  GameSessionDetails,
  JoinGameResponse,
  MatchmakingGamesResponse,
  PlayerConfigType,
  ReadyGameResponse,
  ResolveGameAccessResponse,
  CreateBotGameResponse,
  GameShowcaseResponse,
} from "../../../shared/contracts/games";
import type {
  ListedBot,
  RecommendedBotEntry,
} from "../../../shared/contracts/custom-bot-protocol";
import type {
  PawnSkinType,
  SettingsResponse,
  SuccessResponse,
  UpdateDisplayNameResponse,
  VariantParameters,
} from "../../../shared/contracts/settings";
import type { MeResponse } from "../../../shared/contracts/user";

const client = hc<ApiRoutes>("/");

export const api = client.api;

// Helper that ensures that API errors still throw exceptions, which React Query
// and other consumers expect.
async function handleResponse<T>(
  request: Promise<ClientResponse<unknown>>,
): Promise<T> {
  const res = await request;
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      data?.error ?? `Request failed: ${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
}

const assertNonSurvivalVariant = (variant: Variant): NonSurvivalVariant => {
  if (variant === "survival")
    throw new Error("Survival games are not supported by this endpoint.");
  if (variant === "custom-setup-classic") return "classic";
  if (variant === "custom-setup-standard") return "standard";
  return variant;
};

export const userQueryOptions = queryOptions({
  queryKey: ["get-current-user"],
  queryFn: getCurrentUser,
  staleTime: Infinity,
});

async function getCurrentUser() {
  const data = await handleResponse<MeResponse>(api.me.$get());
  return data;
}

// Shared query key constant to prevent coupling issues
export const SETTINGS_QUERY_KEY = ["settings"] as const;

export const settingsQueryOptions = queryOptions({
  queryKey: SETTINGS_QUERY_KEY,
  queryFn: async (): Promise<SettingsResponse> => {
    return handleResponse<SettingsResponse>(api.settings.$get());
  },
  staleTime: 5 * 60 * 1000,
  gcTime: 10 * 60 * 1000,
  enabled: false,
});

// Settings mutation functions
export const settingsMutations = {
  updateBoardTheme: (boardTheme: string) =>
    handleResponse<SuccessResponse>(
      api.settings["board-theme"].$put({ json: { boardTheme } }),
    ),

  updatePawnColor: (pawnColor: string) =>
    handleResponse<SuccessResponse>(
      api.settings["pawn-color"].$put({ json: { pawnColor } }),
    ),

  updatePawn: (pawnType: PawnSkinType, pawnShape: string) =>
    handleResponse<SuccessResponse>(
      api.settings.pawn.$put({ json: { pawnType, pawnShape } }),
    ),

  updateTimeControl: (
    timeControl: "bullet" | "blitz" | "rapid" | "classical",
  ) =>
    handleResponse<SuccessResponse>(
      api.settings["time-control"].$put({ json: { timeControl } }),
    ),

  updateRatedStatus: (rated: boolean) =>
    handleResponse<SuccessResponse>(
      api.settings["rated-status"].$put({ json: { rated } }),
    ),

  updateDefaultVariant: (variant: Variant) =>
    handleResponse<SuccessResponse>(
      api.settings["default-variant"].$put({
        json: { variant: assertNonSurvivalVariant(variant) },
      }),
    ),

  updateVariantParameters: (variant: Variant, parameters: VariantParameters) =>
    handleResponse<SuccessResponse>(
      api.settings["variant-parameters"].$put({
        json: {
          variant: assertNonSurvivalVariant(variant),
          parameters: {
            boardWidth: parameters.boardWidth,
            boardHeight: parameters.boardHeight,
          },
        },
      }),
    ),

  updateDisplayName: (displayName: string) =>
    handleResponse<UpdateDisplayNameResponse>(
      api.settings["display-name"].$put({ json: { displayName } }),
    ),
};

/**
 * Creates a backend game session (friend or matchmaking).
 *
 * The server randomly determines whether the host will be Player 1 (who starts first)
 * or Player 2. This ensures fair assignment of the first-move advantage.
 * See game-types.ts for terminology: Player A/B (roles) vs Player 1/2 (game logic).
 */
export const createGameSession = async (args: {
  config: GameConfiguration;
  matchType: MatchType;
  hostDisplayName?: string;
  hostAppearance?: PlayerAppearance;
  joinerConfig?: {
    type: PlayerConfigType;
    displayName?: string;
  };
}): Promise<GameCreateResponse> => {
  // Normalize timeControl: handle legacy localStorage format where it was just a string
  let timeControl: TimeControlConfig;
  const rawTimeControl = args.config.timeControl as unknown;
  if (typeof rawTimeControl === "string") {
    // Legacy format: just a preset string like "rapid"
    timeControl = timeControlConfigFromPreset(
      rawTimeControl as TimeControlPreset,
    );
  } else {
    timeControl = args.config.timeControl;
  }
  const variant = assertNonSurvivalVariant(args.config.variant);

  return handleResponse<GameCreateResponse>(
    // We can hover over api.games.$post or response objects in the frontend to
    // see the exact types inferred from the server's Zod schemas.
    api.games.$post({
      json: {
        config: {
          timeControl,
          rated: args.config.rated,
          variant,
          boardWidth: args.config.boardWidth,
          boardHeight: args.config.boardHeight,
        },
        matchType: args.matchType,
        hostDisplayName: args.hostDisplayName,
        hostAppearance: args.hostAppearance,
        joinerConfig: args.joinerConfig,
        // Let server randomly decide who is Player 1
      },
    }),
  );
};

export const fetchGameSession = async (args: {
  gameId: string;
  token: string;
}): Promise<GameSessionDetails> => {
  const access = await resolveGameAccess({
    gameId: args.gameId,
    token: args.token,
  });
  if (access.kind !== "player") {
    throw new Error("Unable to resolve player access for this token.");
  }
  return {
    snapshot: access.matchStatus,
    role: access.seat.role,
    playerId: access.seat.playerId,
    token: access.seat.token,
    socketToken: access.seat.socketToken,
    shareUrl: access.shareUrl,
  };
};

export const resolveGameAccess = async (args: {
  gameId: string;
  token?: string;
}): Promise<ResolveGameAccessResponse> => {
  const query = args.token ? { token: args.token } : {};
  return handleResponse<ResolveGameAccessResponse>(
    api.games[":id"].$get({
      param: { id: args.gameId },
      query,
    }),
  );
};

export type JoinGameSessionResult =
  | (GameSessionDetails & {
      kind: "player";
    })
  | {
      kind: "spectator";
      snapshot: GameSnapshot;
      shareUrl: string;
    };

export const joinGameSession = async (args: {
  gameId: string;
  displayName?: string;
  appearance?: PlayerAppearance;
}): Promise<JoinGameSessionResult> => {
  const data = await handleResponse<JoinGameResponse>(
    api.games[":id"].join.$post({
      param: { id: args.gameId },
      json: {
        displayName: args.displayName,
        appearance: args.appearance,
      },
    }),
  );

  if (data.role === "spectator") {
    return {
      kind: "spectator",
      snapshot: data.snapshot,
      shareUrl: data.shareUrl,
    };
  }

  return {
    kind: "player",
    snapshot: data.snapshot,
    role: data.seat,
    playerId: data.playerId,
    token: data.token,
    socketToken: data.socketToken,
    shareUrl: data.shareUrl,
  };
};

export const abortGameSession = async (args: {
  gameId: string;
  token: string;
}): Promise<ReadyGameResponse> => {
  return handleResponse<ReadyGameResponse>(
    api.games[":id"].abort.$post({
      param: { id: args.gameId },
      json: { token: args.token },
    }),
  );
};

// Fetch list of available matchmaking games
export const fetchMatchmakingGames = async (): Promise<GameSnapshot[]> => {
  const data = await handleResponse<MatchmakingGamesResponse>(
    api.games.matchmaking.$get(),
  );
  return data.games;
};

export const fetchShowcaseGames = async (
  count: number,
): Promise<GameShowcaseResponse> => {
  return handleResponse<GameShowcaseResponse>(
    api.games.showcase.$get({ query: { count: String(count) } }),
  );
};

/** V3: Bot listing - no timeControl (bot games are untimed) */
/** Shared so a vote can invalidate the listing its counts appear in. */
export const SAVED_PUZZLES_QUERY_KEY = ["saved-puzzles"] as const;

/** Shared so the game page and the puzzle card read the same cache entry. */
export const puzzleVoteQueryKey = (puzzleId: string) =>
  ["puzzle-vote", puzzleId] as const;

/**
 * Saved puzzles list. The response is parsed against the shared contract —
 * a malformed payload throws rather than reaching a launch flow.
 *
 * Public: it answers for anonymous visitors, who simply get `myVote: null`
 * on every puzzle.
 */
export const fetchSavedPuzzles = async (): Promise<SavedPuzzlesResponse> => {
  const raw = await handleResponse<unknown>(api.puzzles.$get());
  return savedPuzzlesResponseSchema.parse(raw);
};

/**
 * The two queries that fill the puzzles page. They live here, shared, so the
 * route loader that warms them and the component that reads them address the
 * SAME cache entry — a loader keyed differently from its component is a
 * silent no-op, and the request simply happens twice.
 *
 * The bot listing is pinned to the 6x6 custom-setup variant because that is
 * what every generated puzzle is played on; bots register the exact variant
 * they serve, so this is what decides whether PuzzleBot is available.
 *
 * The staleTime is what stops the loader's work being thrown away: with the
 * default of 0, data arrives from the loader already stale and the component
 * refetches the instant it mounts, so every visit costs two requests for one
 * answer. Half a minute is short enough that a bot going offline becomes
 * eligible to be noticed on a visit after at most 30 seconds — a revisit
 * inside the window deliberately serves cache — and invalidation still
 * overrides it, so casting a vote refreshes the counts immediately.
 */
const PUZZLE_LIST_STALE_MS = 30_000;

export const savedPuzzlesQueryOptions = {
  queryKey: SAVED_PUZZLES_QUERY_KEY,
  queryFn: fetchSavedPuzzles,
  staleTime: PUZZLE_LIST_STALE_MS,
} as const;

export const puzzleBotsQueryOptions = {
  queryKey: ["bots", "custom-setup-standard", 6, 6] as const,
  queryFn: () =>
    fetchBots({
      variant: "custom-setup-standard" as const,
      boardWidth: 6,
      boardHeight: 6,
    }),
  staleTime: PUZZLE_LIST_STALE_MS,
} as const;

/**
 * One puzzle's vote state for the logged-in caller. Requires authentication,
 * so callers must gate this on a settled, authenticated user. The game page
 * uses it to recover a vote after a refresh without fetching the listing.
 */
export const fetchPuzzleVote = async (
  puzzleId: string,
): Promise<PuzzleVoteState> => {
  const raw = await handleResponse<unknown>(
    api.puzzles[":id"].vote.$get({ param: { id: puzzleId } }),
  );
  return puzzleVoteStateSchema.parse(raw);
};

/** Cast (1), flip (-1), or withdraw (null) a vote; returns the new state. */
export const submitPuzzleVote = async (args: {
  puzzleId: string;
  value: 1 | -1 | null;
}): Promise<PuzzleVoteState> => {
  const raw = await handleResponse<unknown>(
    api.puzzles[":id"].vote.$post({
      param: { id: args.puzzleId },
      json: { value: args.value },
    }),
  );
  return puzzleVoteStateSchema.parse(raw);
};

/** Shared so the game page can invalidate what the puzzles page reads. */
export const PUZZLE_PROGRESS_QUERY_KEY = ["puzzle-progress"] as const;

/**
 * Which puzzles the logged-in user has solved. Requires authentication: the
 * endpoint answers 401 for anonymous callers, so callers must gate the query
 * on a settled, authenticated user rather than firing it while browsing
 * logged out.
 */
export const fetchPuzzleProgress =
  async (): Promise<PuzzleProgressResponse> => {
    const raw = await handleResponse<unknown>(api.puzzles.progress.$get());
    return puzzleProgressResponseSchema.parse(raw);
  };

/** Report a scripted-puzzle solve (client-asserted; anonymous is allowed). */
export const reportScriptedPuzzleCompletion = async (
  puzzleId: string,
): Promise<void> => {
  await handleResponse<SuccessResponse>(
    api.puzzles["scripted-completions"].$post({ json: { puzzleId } }),
  );
};

export const fetchBots = async (args: {
  variant: Variant;
  boardWidth?: number;
  boardHeight?: number;
}): Promise<{ bots: ListedBot[] }> => {
  if (args.variant === "survival") {
    throw new Error("Survival games are not supported by this endpoint.");
  }
  return handleResponse<{ bots: ListedBot[] }>(
    api.bots.$get({
      query: {
        variant: args.variant,
        boardWidth:
          args.boardWidth !== undefined ? String(args.boardWidth) : undefined,
        boardHeight:
          args.boardHeight !== undefined ? String(args.boardHeight) : undefined,
      },
    }),
  );
};

/** V3: Recommended bots - no timeControl (bot games are untimed) */
export const fetchRecommendedBots = async (args: {
  variant: Variant;
}): Promise<{ bots: RecommendedBotEntry[] }> => {
  // Bot discovery uses the true variant: bots register exactly what they serve
  // (custom-setup included), so collapsing here would list the wrong bots.
  if (args.variant === "survival")
    throw new Error("Survival games are not supported by this endpoint.");
  return handleResponse<{ bots: RecommendedBotEntry[] }>(
    api.bots.recommended.$get({
      query: {
        variant: args.variant,
      },
    }),
  );
};

export const playVsBot = async (args: {
  botId: string;
  /** Full local config, or a saved puzzle's wire config (no timeControl —
   *  bot games are untimed and the server supplies it). */
  config: GameConfiguration | SavedPuzzle["config"];
  hostDisplayName?: string;
  hostAppearance?: PlayerAppearance;
  hostIsPlayer1?: boolean;
}): Promise<CreateBotGameResponse> => {
  // V3: Bot games are untimed - no timeControl in config
  if (args.config.variant === "survival") {
    throw new Error("Survival games are not supported by this endpoint.");
  }

  const config =
    args.config.variant === "custom-setup-classic"
      ? {
          variant: args.config.variant,
          boardWidth: args.config.boardWidth,
          boardHeight: args.config.boardHeight,
          variantConfig: args.config
            .variantConfig as CustomSetupClassicInitialState,
        }
      : args.config.variant === "custom-setup-standard"
        ? {
            variant: args.config.variant,
            boardWidth: args.config.boardWidth,
            boardHeight: args.config.boardHeight,
            variantConfig: args.config
              .variantConfig as CustomSetupStandardInitialState,
          }
        : {
            variant: args.config.variant,
            boardWidth: args.config.boardWidth,
            boardHeight: args.config.boardHeight,
          };

  return handleResponse<CreateBotGameResponse>(
    api.bots.play.$post({
      json: {
        botId: args.botId,
        config,
        hostDisplayName: args.hostDisplayName,
        hostAppearance: args.hostAppearance,
        hostIsPlayer1: args.hostIsPlayer1,
      },
    }),
  );
};

/**
 * Server-authoritative saved-puzzle launch (S-P1): the server derives the
 * config, seat, and bot lead-in from the puzzle row — the client never
 * supplies a config, so Retry and launch always recreate the real puzzle.
 */
export const playPuzzle = async (args: {
  botId: string;
  puzzleId: string;
  hostDisplayName?: string;
  hostAppearance?: PlayerAppearance;
}): Promise<CreateBotGameResponse> => {
  return handleResponse<CreateBotGameResponse>(
    api.bots.play.$post({
      json: {
        botId: args.botId,
        puzzleId: args.puzzleId,
        hostDisplayName: args.hostDisplayName,
        hostAppearance: args.hostAppearance,
      },
    }),
  );
};

// Campaign progress API
import { completeLevelResponseSchema } from "../../../shared/contracts/campaign";

/**
 * There is deliberately no campaign-progress READER here any more.
 *
 * Since S-FOLD the campaign level list is the first section of /puzzles and its
 * completion state comes from `fetchPuzzleProgress` — one read for all three
 * sections. The server still serves GET /api/campaign/progress for browsers
 * running an older bundle (see server/routes/campaign.ts), but this bundle has
 * no reason to call it, and a second fetcher would invite a second query key
 * and a second invalidation back onto the page.
 */

/** Report a campaign level completion (client-asserted; anonymous is allowed). */
export const reportCampaignCompletion = async (
  levelId: string,
): Promise<void> => {
  const raw = await handleResponse<unknown>(
    api.campaign.complete.$post({ json: { levelId } }),
  );
  completeLevelResponseSchema.parse(raw);
};
