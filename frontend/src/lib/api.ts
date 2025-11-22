import { hc } from "hono/client";
import { type ApiRoutes } from "@server/index";
import { queryOptions } from "@tanstack/react-query";
import type { TimeControlPreset, Variant } from "@/lib/game";

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
      `Server error: Failed to fetch current user: ${res.statusText}`
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
        `Server error: Failed to fetch settings: ${res.statusText}`
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
  body: Record<string, unknown>
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
      errorData.error ?? `Failed to update setting: ${res.statusText}`
    );
  }

  return res.json() as Promise<{ success: boolean }>;
}

export const settingsMutations = {
  updateBoardTheme: (boardTheme: string) =>
    updateSetting("board-theme", { boardTheme }),

  updatePawnColor: (pawnColor: string) =>
    updateSetting("pawn-color", { pawnColor }),

  updatePawn: (pawnType: string, pawnShape: string) =>
    updateSetting("pawn", { pawnType, pawnShape }),

  updateTimeControl: (timeControl: TimeControlPreset) =>
    updateSetting("time-control", { timeControl }),

  updateRatedStatus: (rated: boolean) =>
    updateSetting("rated-status", { rated }),

  updateDefaultVariant: (variant: Variant) =>
    updateSetting("default-variant", { variant }),

  updateVariantParameters: (
    variant: Variant,
    parameters: { boardWidth: number; boardHeight: number }
  ) => updateSetting("variant-parameters", { variant, parameters }),

  updateDisplayName: (displayName: string) =>
    updateSetting("display-name", { displayName }),
};
