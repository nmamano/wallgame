import { hc } from "hono/client";
import { type ApiRoutes } from "@server/index";
import { queryOptions } from "@tanstack/react-query";

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

export const settingsQueryOptions = queryOptions({
  queryKey: SETTINGS_QUERY_KEY,
  queryFn: async () => {
    const res = await (api as any).settings.$get();
    if (!res.ok) {
      throw new Error(
        `Server error: Failed to fetch settings: ${res.statusText}`
      );
    }
    return res.json();
  },
  staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
  gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
  enabled: false, // Disable by default - enable when user is logged in
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
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      errorData.error || `Failed to update setting: ${res.statusText}`
    );
  }

  return res.json();
}

export const settingsMutations = {
  updateBoardTheme: (boardTheme: string) =>
    updateSetting("board-theme", { boardTheme }),

  updatePawnColor: (pawnColor: string) =>
    updateSetting("pawn-color", { pawnColor }),

  updatePawn: (pawnType: string, pawnShape: string) =>
    updateSetting("pawn", { pawnType, pawnShape }),

  updateTimeControl: (timeControl: string) =>
    updateSetting("time-control", { timeControl }),

  updateRatedStatus: (rated: boolean) =>
    updateSetting("rated-status", { rated }),

  updateDefaultVariant: (variant: string) =>
    updateSetting("default-variant", { variant }),

  updateVariantParameters: (
    variant: string,
    parameters: { boardWidth: number; boardHeight: number }
  ) => updateSetting("variant-parameters", { variant, parameters }),

  updateDisplayName: (displayName: string) =>
    updateSetting("display-name", { displayName }),
};
