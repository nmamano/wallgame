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
  PawnType,
  MatchType,
} from "../../../shared/domain/game-types";
import { timeControlConfigFromPreset } from "../../../shared/domain/game-utils";
import type {
  GameCreateResponse,
  GameSessionDetails,
  JoinGameResponse,
  ReadyGameResponse,
  MatchmakingGamesResponse,
} from "../../../shared/contracts/games";
import type {
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

  updatePawn: (pawnType: PawnType, pawnShape: string) =>
    handleResponse<SuccessResponse>(
      api.settings.pawn.$put({ json: { pawnType, pawnShape } }),
    ),

  updateTimeControl: (timeControl: TimeControlPreset) =>
    handleResponse<SuccessResponse>(
      api.settings["time-control"].$put({ json: { timeControl } }),
    ),

  updateRatedStatus: (rated: boolean) =>
    handleResponse<SuccessResponse>(
      api.settings["rated-status"].$put({ json: { rated } }),
    ),

  updateDefaultVariant: (variant: Variant) =>
    handleResponse<SuccessResponse>(
      api.settings["default-variant"].$put({ json: { variant } }),
    ),

  updateVariantParameters: (variant: Variant, parameters: VariantParameters) =>
    handleResponse<SuccessResponse>(
      api.settings["variant-parameters"].$put({
        json: {
          variant,
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

export const createGameSession = async (args: {
  config: GameConfiguration;
  matchType: MatchType;
  hostDisplayName?: string;
  hostAppearance?: PlayerAppearance;
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

  return handleResponse<GameCreateResponse>(
    // We can hover over api.games.$post or response objects in the frontend to
    // see the exact types inferred from the server's Zod schemas.
    api.games.$post({
      json: {
        config: {
          timeControl,
          rated: args.config.rated,
          variant: args.config.variant,
          boardWidth: args.config.boardWidth,
          boardHeight: args.config.boardHeight,
        },
        matchType: args.matchType,
        hostDisplayName: args.hostDisplayName,
        hostAppearance: args.hostAppearance,
      },
    }),
  );
};

export const fetchGameSession = async (args: {
  gameId: string;
  token: string;
}): Promise<GameSessionDetails> => {
  return handleResponse<GameSessionDetails>(
    api.games[":id"].$get({
      param: { id: args.gameId },
      query: { token: args.token },
    }),
  );
};

export const joinGameSession = async (args: {
  gameId: string;
  displayName?: string;
  appearance?: PlayerAppearance;
}): Promise<GameSessionDetails> => {
  const data = await handleResponse<JoinGameResponse>(
    api.games[":id"].join.$post({
      param: { id: args.gameId },
      json: {
        displayName: args.displayName,
        appearance: args.appearance,
      },
    }),
  );
  return {
    snapshot: data.snapshot,
    role: "joiner",
    playerId: 2,
    token: data.token,
    socketToken: data.socketToken,
    shareUrl: data.shareUrl,
  };
};

export const markGameReady = async (args: {
  gameId: string;
  token: string;
}): Promise<GameSnapshot> => {
  const data = await handleResponse<ReadyGameResponse>(
    api.games[":id"].ready.$post({
      param: { id: args.gameId },
      json: { token: args.token },
    }),
  );
  return data.snapshot;
};

// Fetch list of available matchmaking games
export const fetchMatchmakingGames = async (): Promise<GameSnapshot[]> => {
  const data = await handleResponse<MatchmakingGamesResponse>(
    api.games.matchmaking.$get(),
  );
  return data.games;
};
