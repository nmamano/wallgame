import { hc } from "hono/client";
import { type ApiRoutes } from "@server/index";
import { queryOptions } from "@tanstack/react-query";
import type {
  GameSnapshot,
  GameConfiguration,
  PlayerAppearance,
  TimeControlPreset,
  TimeControlConfig,
  Variant,
  PlayerId,
  PawnType,
  MatchType,
} from "../../../shared/game-types";
import { timeControlConfigFromPreset } from "../../../shared/game-utils";
import type { GameRole } from "@/lib/game-session";

const client = hc<ApiRoutes>("/");

export const api = client.api;

export const userQueryOptions = queryOptions({
  queryKey: ["get-current-user"],
  queryFn: getCurrentUser,
  staleTime: Infinity,
});

async function getCurrentUser() {
  const res = await api.me.$get();
  if (!res.ok) {
    // Throw error for real failures (network errors, server crashes, etc.)
    // so React Query can retry. The server handles unauthenticated users
    // by returning 200 OK with { user: null }, so this only triggers on real errors.
    throw new Error(
      `Server error: Failed to fetch current user: ${res.statusText}`,
    );
  }
  const data = await res.json();
  return data;
}

// Shared query key constant to prevent coupling issues
export const SETTINGS_QUERY_KEY = ["settings"] as const;

export interface SettingsResponse {
  displayName: string;
  capitalizedDisplayName?: string;
  boardTheme: string;
  pawnColor: string;
  pawnSettings: {
    pawn_type: string;
    pawn_shape: string;
  }[];
  defaultVariant: Variant;
  defaultTimeControl: TimeControlPreset;
  defaultRatedStatus: boolean;
  variantSettings: {
    variant: Variant;
    default_parameters: {
      boardWidth?: number;
      boardHeight?: number;
    };
  }[];
}

export const settingsQueryOptions = queryOptions({
  queryKey: SETTINGS_QUERY_KEY,
  queryFn: async (): Promise<SettingsResponse> => {
    const res = await (
      api as unknown as {
        settings: { $get: () => Promise<Response> };
      }
    ).settings.$get();

    if (!res.ok) {
      throw new Error(
        `Server error: Failed to fetch settings: ${res.statusText}`,
      );
    }

    // Parse JSON and assert type once
    const data = (await res.json()) as SettingsResponse;
    return data;
  },
  staleTime: 5 * 60 * 1000,
  gcTime: 10 * 60 * 1000,
  enabled: false,
});

// Settings mutation functions
async function updateSetting(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ success: boolean }> {
  const res = await fetch(`/api/settings/${endpoint}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      errorData.error ?? `Failed to update setting: ${res.statusText}`,
    );
  }

  return res.json() as Promise<{ success: boolean }>;
}

export const settingsMutations = {
  updateBoardTheme: (boardTheme: string) =>
    updateSetting("board-theme", { boardTheme }),

  updatePawnColor: (pawnColor: string) =>
    updateSetting("pawn-color", { pawnColor }),

  updatePawn: (pawnType: PawnType, pawnShape: string) =>
    updateSetting("pawn", { pawnType, pawnShape }),

  updateTimeControl: (timeControl: TimeControlPreset) =>
    updateSetting("time-control", { timeControl }),

  updateRatedStatus: (rated: boolean) =>
    updateSetting("rated-status", { rated }),

  updateDefaultVariant: (variant: Variant) =>
    updateSetting("default-variant", { variant }),

  updateVariantParameters: (
    variant: Variant,
    parameters: { boardWidth: number; boardHeight: number },
  ) => updateSetting("variant-parameters", { variant, parameters }),

  updateDisplayName: (displayName: string) =>
    updateSetting("display-name", { displayName }),
};

const parseJsonResponse = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      data?.error ?? `Request failed: ${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
};

export interface GameCreateResponse {
  gameId: string;
  hostToken: string;
  socketToken: string;
  inviteCode?: string; // Only present for friend games
  shareUrl: string;
  snapshot: GameSnapshot;
}

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

  const payload = {
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
  };
  const res = await fetch("/api/games", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse<GameCreateResponse>(res);
};

export interface GameSessionDetails {
  snapshot: GameSnapshot;
  role: GameRole;
  playerId: PlayerId;
  token: string;
  socketToken: string;
  shareUrl?: string;
}

export const fetchGameSession = async (args: {
  gameId: string;
  token: string;
}): Promise<GameSessionDetails> => {
  const res = await fetch(`/api/games/${args.gameId}?token=${args.token}`);
  return parseJsonResponse<GameSessionDetails>(res);
};

export const joinGameSession = async (args: {
  gameId: string;
  inviteCode?: string; // Optional for matchmaking games
  displayName?: string;
  appearance?: PlayerAppearance;
}): Promise<GameSessionDetails> => {
  const res = await fetch(`/api/games/${args.gameId}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inviteCode: args.inviteCode,
      displayName: args.displayName,
      appearance: args.appearance,
    }),
  });
  const data = await parseJsonResponse<{
    gameId: string;
    token: string;
    socketToken: string;
    snapshot: GameSnapshot;
    shareUrl?: string;
  }>(res);
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
  const res = await fetch(`/api/games/${args.gameId}/ready`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: args.token }),
  });
  const data = await parseJsonResponse<{
    success: boolean;
    snapshot: GameSnapshot;
  }>(res);
  return data.snapshot;
};

// Fetch list of available matchmaking games
export const fetchMatchmakingGames = async (): Promise<GameSnapshot[]> => {
  const res = await fetch("/api/games/matchmaking");
  const data = await parseJsonResponse<{ games: GameSnapshot[] }>(res);
  return data.games;
};
