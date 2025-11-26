import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useMemo, useState, useEffect, useRef } from "react";
import {
  settingsQueryOptions,
  settingsMutations,
  SETTINGS_QUERY_KEY,
  type SettingsResponse,
} from "@/lib/api";
import { useLocalStorageState } from "./use-local-storage";
import type { GameConfiguration } from "../../../shared/game-types";
import type {
  TimeControlPreset,
  Variant,
  PawnType,
} from "../../../shared/game-types";
import { timeControlConfigFromPreset } from "../../../shared/game-utils";

interface VariantParameters {
  boardWidth?: number;
  boardHeight?: number;
}
type VariantSettingsMap = Record<string, VariantParameters>;

// Validate display name
function isValidDisplayName(name: string): { valid: boolean; error?: string } {
  const lowerName = name.toLowerCase();
  if (
    lowerName.includes("guest") ||
    lowerName.includes("deleted") ||
    lowerName.includes("bot")
  ) {
    return {
      valid: false,
      error: "Names including 'guest', 'deleted', or 'bot' are not allowed.",
    };
  }
  if (name.trim().length < 3) {
    return {
      valid: false,
      error: "Display name must be at least 3 characters long.",
    };
  }
  return { valid: true };
}

export interface SettingsState {
  boardTheme: string;
  setBoardTheme: (value: string) => void;
  pawnColor: string;
  setPawnColor: (value: string) => void;
  catPawn: string;
  setCatPawn: (value: string) => void;
  mousePawn: string;
  setMousePawn: (value: string) => void;
  gameConfig: GameConfiguration;
  setGameConfig: (config: GameConfiguration) => void;
  // Display name (only relevant for logged-in users)
  // NOTE: For logged-out users, setDisplayName and handleChangeDisplayName are no-ops.
  // Always gate display name UI on isLoggedIn to avoid calling these unnecessarily.
  displayName: string;
  setDisplayName: (value: string) => void;
  displayNameError: string | null; // Server errors or validation errors from handleChangeDisplayName
  displayNameValidationError: string | null; // Real-time validation errors (shown before clicking button)
  handleChangeDisplayName: () => void;
  canChangeName: boolean;
  // Loading and mutation states
  isLoadingSettings: boolean;
  isSavingName: boolean; // Only tracks display name mutation (for display name button)
  isSaving: boolean; // Includes display name mutation (for button state)
  isSavingSettings: boolean; // Excludes display name mutation (for Visual Style/Game Parameters alerts)
  isSavingVisualStyle: boolean; // Tracks Visual Style section mutations (boardTheme, pawnColor, pawns)
  isSavingGameParameters: boolean; // Tracks Default Game Parameters section mutations (timeControl, rated, variant, parameters)
  loadError: Error | null; // Error loading settings from server
  saveError: Error | null; // Error saving settings to server
}

const STORAGE_KEYS = {
  BOARD_THEME: "wall-game-board-theme",
  PAWN_COLOR: "wall-game-pawn-color",
  CAT_PAWN: "wall-game-cat-pawn",
  MOUSE_PAWN: "wall-game-mouse-pawn",
  GAME_CONFIG: "wall-game-default-config",
  VARIANT_SETTINGS: "wall-game-variant-settings",
} as const;

const defaultGameConfig: GameConfiguration = {
  timeControl: {
    initialSeconds: 600,
    incrementSeconds: 2,
    preset: "rapid",
  },
  rated: false,
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
};

const DEFAULT_TIME_CONTROL_PRESET: TimeControlPreset = "rapid";
const DEFAULT_VARIANT: Variant = "standard";

/**
 * Unified settings hook that always calls the same hooks in the same order
 * (required by Rules of Hooks). Behavior differs based on isLoggedIn, but
 * hook calls remain consistent.
 */
function useSettingsInternal(
  isLoggedIn: boolean,
  userPending: boolean,
): SettingsState {
  const queryClient = useQueryClient();

  // Always call React Query hook (disabled for logged-out users)
  // IMPORTANT: Gate on both isLoggedIn AND userPending to prevent:
  // 1. Unauthorized requests when user is logged out (isLoggedIn = false)
  // 2. Premature requests before auth state settles (userPending = true)
  const {
    data: dbSettings,
    isPending: isLoadingSettings,
    error: settingsLoadError,
  } = useQuery({
    ...settingsQueryOptions,
    enabled: isLoggedIn && !userPending,
  });

  // Always call localStorage hooks (used for logged-out users, fallback for logged-in)
  const [localBoardTheme, setLocalBoardTheme] = useLocalStorageState<string>(
    STORAGE_KEYS.BOARD_THEME,
    "default",
  );
  const [localPawnColor, setLocalPawnColor] = useLocalStorageState<string>(
    STORAGE_KEYS.PAWN_COLOR,
    "default",
  );
  const [localCatPawn, setLocalCatPawn] = useLocalStorageState<string>(
    STORAGE_KEYS.CAT_PAWN,
    "default",
  );
  const [localMousePawn, setLocalMousePawn] = useLocalStorageState<string>(
    STORAGE_KEYS.MOUSE_PAWN,
    "default",
  );
  const [localVariantSettings, setLocalVariantSettings] =
    useLocalStorageState<VariantSettingsMap>(STORAGE_KEYS.VARIANT_SETTINGS, {});

  // Compute default gameConfig from variantSettings
  // NOTE: gameConfig reads VARIANT_SETTINGS directly from localStorage in its initializer,
  // independent of the localVariantSettings hook. This removes hook-order dependency and
  // makes the hooks independent - each reads from localStorage in its own initializer.
  const [localGameConfig, setLocalGameConfig] =
    useLocalStorageState<GameConfiguration>(STORAGE_KEYS.GAME_CONFIG, () => {
      if (typeof window === "undefined") {
        return { ...defaultGameConfig, rated: false };
      }

      // Read VARIANT_SETTINGS directly from localStorage (independent of localVariantSettings hook)
      try {
        const variantSettingsStr = localStorage.getItem(
          STORAGE_KEYS.VARIANT_SETTINGS,
        );
        if (variantSettingsStr) {
          const variantSettings = JSON.parse(
            variantSettingsStr,
          ) as VariantSettingsMap;
          const variantParams = variantSettings[defaultGameConfig.variant];
          if (variantParams) {
            return {
              ...defaultGameConfig,
              boardWidth: variantParams.boardWidth ?? 8,
              boardHeight: variantParams.boardHeight ?? 8,
              rated: false,
            };
          }
        }
      } catch {
        // If parsing fails, fall back to default
      }

      return { ...defaultGameConfig, rated: false };
    });

  // Display name state (always initialized, but only used for logged-in users)
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);

  // Derive display name from DB settings
  const dbDisplayName = useMemo(() => {
    if (isLoggedIn && dbSettings?.displayName !== undefined) {
      return dbSettings.capitalizedDisplayName ?? dbSettings.displayName;
    }
    return "";
  }, [isLoggedIn, dbSettings?.displayName, dbSettings?.capitalizedDisplayName]);

  // Display name state - initialized with DB value, updated only on DB changes
  const [displayName, setDisplayName] = useState(() => dbDisplayName);
  const [originalDisplayName, setOriginalDisplayName] = useState<string>(
    () => dbDisplayName,
  );

  // Sync display name with DB changes (only when DB value actually changes)
  const prevDbDisplayNameRef = useRef(dbDisplayName);
  useEffect(() => {
    if (prevDbDisplayNameRef.current !== dbDisplayName) {
      setDisplayName(dbDisplayName);
      setOriginalDisplayName(dbDisplayName);
      prevDbDisplayNameRef.current = dbDisplayName;
    }
  }, [dbDisplayName]);

  // Display name mutation
  // Note: No optimistic update - we rely on server response for correctness.
  // The input already shows user's typed value immediately, and display name
  // changes are fast enough that optimistic updates aren't necessary.
  //
  // IMPORTANT: This mutation is always defined regardless of isLoggedIn state.
  // It will make API calls and manipulate the settings query cache even if
  // the settings query is disabled. Always guard calls to this mutation with
  // isLoggedIn checks. The handleChangeDisplayName wrapper includes this guard,
  // but if you call updateDisplayNameMutation.mutate() directly elsewhere,
  // you must check isLoggedIn first.
  const updateDisplayNameMutation = useMutation<
    { success: boolean; displayName?: string; capitalizedDisplayName?: string },
    Error,
    string
  >({
    mutationFn: async (displayName: string) => {
      if (!isLoggedIn) {
        // Dev safety net: this should never happen if callers gate correctly
        if (import.meta.env.MODE !== "production") {
          console.error(
            "updateDisplayNameMutation called while logged out. Did you forget to gate on isLoggedIn?",
          );
        }
        // Fail with a generic user-facing error
        throw new Error("You must be logged in to change your display name.");
      }

      return settingsMutations.updateDisplayName(displayName) as Promise<{
        success: boolean;
        displayName?: string;
        capitalizedDisplayName?: string;
      }>;
    },
    onSuccess: (data) => {
      // Apply server response (with proper capitalization/normalization)
      const serverDisplayName = data.capitalizedDisplayName ?? data.displayName;
      if (serverDisplayName) {
        setDisplayName(serverDisplayName);
        setOriginalDisplayName(serverDisplayName);
        // Update cache with server's version
        queryClient.setQueryData<SettingsResponse>(
          SETTINGS_QUERY_KEY,
          (prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              displayName: data.displayName ?? prev.displayName,
              capitalizedDisplayName:
                data.capitalizedDisplayName ?? prev.capitalizedDisplayName,
            };
          },
        );
      }
      // Refetch to ensure cache is in sync with server
      void queryClient.invalidateQueries({
        queryKey: SETTINGS_QUERY_KEY,
      });
      setDisplayNameError(null);
    },
    onError: (error: unknown) => {
      console.error("Error updating display name:", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Failed to update display name";
      setDisplayNameError(errorMessage);
    },
  });

  // Wrapper for display name mutation that includes isLoggedIn guard.
  // NOTE: This function is only used when isLoggedIn is true. For logged-out users,
  // the hook returns a no-op function instead. If you need to call
  // updateDisplayNameMutation.mutate() directly elsewhere, you must check isLoggedIn
  // first, as the mutation will fail if called when not logged in.
  const handleChangeDisplayName = () => {
    if (!isLoggedIn) {
      // Safety guard: this should never be called when !isLoggedIn because
      // the hook returns a no-op function for logged-out users
      return;
    }
    const validation = isValidDisplayName(displayName);
    if (!validation.valid) {
      setDisplayNameError(validation.error ?? "Invalid display name");
      return;
    }

    setDisplayNameError(null);
    updateDisplayNameMutation.mutate(displayName);
  };

  const canChangeName =
    isLoggedIn &&
    displayName !== originalDisplayName &&
    displayName.trim().length >= 3 &&
    isValidDisplayName(displayName).valid;

  // Compute real-time validation error (shown when name is changed but invalid)
  const displayNameValidationError = useMemo<string | null>(() => {
    if (!isLoggedIn) return null;
    if (displayName === originalDisplayName) return null; // No change, no error
    const validation = isValidDisplayName(displayName);
    return validation.valid ? null : (validation.error ?? null);
  }, [isLoggedIn, displayName, originalDisplayName]);

  // Derive variant settings from DB (only for logged-in users)
  const variantSettingsFromDb = useMemo<VariantSettingsMap>(() => {
    if (!isLoggedIn) return {};
    if (
      !dbSettings?.variantSettings ||
      !Array.isArray(dbSettings.variantSettings)
    ) {
      return {};
    }

    const variantSettingsList = dbSettings.variantSettings;

    const map: VariantSettingsMap = {};
    for (const setting of variantSettingsList) {
      map[setting.variant] = setting.default_parameters ?? {};
    }
    return map;
  }, [isLoggedIn, dbSettings?.variantSettings]);

  // Derive pawn settings from DB (only for logged-in users)
  const pawnSettingsFromDb = useMemo<Record<string, string> | null>(() => {
    if (!isLoggedIn) return null;
    if (!dbSettings?.pawnSettings) return null;
    const pawnMap: Record<string, string> = {};
    for (const pawn of dbSettings.pawnSettings) {
      pawnMap[pawn.pawn_type] = pawn.pawn_shape;
    }
    return pawnMap;
  }, [isLoggedIn, dbSettings?.pawnSettings]);

  // Derive game config from DB (only for logged-in users)
  const gameConfigFromDb = useMemo<GameConfiguration | null>(() => {
    if (!isLoggedIn) return null;
    if (!dbSettings) return null;
    const currentVariant = dbSettings.defaultVariant ?? DEFAULT_VARIANT;
    const currentVariantParams = variantSettingsFromDb[currentVariant];
    return {
      timeControl: timeControlConfigFromPreset(
        dbSettings.defaultTimeControl ?? DEFAULT_TIME_CONTROL_PRESET,
      ),
      rated: dbSettings.defaultRatedStatus ?? false,
      variant: currentVariant,
      boardWidth: currentVariantParams?.boardWidth ?? 8,
      boardHeight: currentVariantParams?.boardHeight ?? 8,
    };
  }, [isLoggedIn, dbSettings, variantSettingsFromDb]);

  // Track mutation states
  const updateBoardThemeMutation = useMutation({
    mutationFn: settingsMutations.updateBoardTheme,
    onMutate: async (newBoardTheme) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
      queryClient.setQueryData<SettingsResponse>(SETTINGS_QUERY_KEY, (prev) => {
        if (!prev) return prev;
        return { ...prev, boardTheme: newBoardTheme };
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: SETTINGS_QUERY_KEY,
        refetchType: "none",
      });
    },
  });

  const updatePawnColorMutation = useMutation({
    mutationFn: settingsMutations.updatePawnColor,
    onMutate: async (newPawnColor) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
      queryClient.setQueryData<SettingsResponse>(SETTINGS_QUERY_KEY, (prev) => {
        if (!prev) return prev;
        return { ...prev, pawnColor: newPawnColor };
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: SETTINGS_QUERY_KEY,
        refetchType: "none",
      });
    },
  });

  const updatePawnMutation = useMutation({
    mutationFn: ({
      pawnType,
      pawnShape,
    }: {
      pawnType: string;
      pawnShape: string;
    }) => settingsMutations.updatePawn(pawnType as PawnType, pawnShape),
    onMutate: async ({ pawnType, pawnShape }) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
      queryClient.setQueryData<SettingsResponse>(SETTINGS_QUERY_KEY, (prev) => {
        if (!prev) return prev;
        const pawnSettings = Array.isArray(prev.pawnSettings)
          ? [...prev.pawnSettings]
          : [];
        const existingIndex = pawnSettings.findIndex(
          (ps) => ps.pawn_type === pawnType,
        );
        if (existingIndex >= 0) {
          pawnSettings[existingIndex] = {
            pawn_type: pawnType,
            pawn_shape: pawnShape,
          };
        } else {
          pawnSettings.push({
            pawn_type: pawnType,
            pawn_shape: pawnShape,
          });
        }
        return { ...prev, pawnSettings };
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: SETTINGS_QUERY_KEY,
        refetchType: "none",
      });
    },
  });

  const updateTimeControlMutation = useMutation({
    mutationFn: settingsMutations.updateTimeControl,
    onMutate: async (newTimeControl) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
      queryClient.setQueryData<SettingsResponse>(SETTINGS_QUERY_KEY, (prev) => {
        if (!prev) return prev;
        return { ...prev, defaultTimeControl: newTimeControl };
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: SETTINGS_QUERY_KEY,
        refetchType: "none",
      });
    },
  });

  const updateRatedStatusMutation = useMutation({
    mutationFn: settingsMutations.updateRatedStatus,
    onMutate: async (newRated) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
      queryClient.setQueryData<SettingsResponse>(SETTINGS_QUERY_KEY, (prev) => {
        if (!prev) return prev;
        return { ...prev, defaultRatedStatus: newRated };
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: SETTINGS_QUERY_KEY,
        refetchType: "none",
      });
    },
  });

  const updateDefaultVariantMutation = useMutation({
    mutationFn: settingsMutations.updateDefaultVariant,
    onMutate: async (newVariant) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
      queryClient.setQueryData<SettingsResponse>(SETTINGS_QUERY_KEY, (prev) => {
        if (!prev) return prev;
        return { ...prev, defaultVariant: newVariant };
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: SETTINGS_QUERY_KEY,
        refetchType: "none",
      });
    },
  });

  const updateVariantParametersMutation = useMutation({
    mutationFn: ({
      variant,
      parameters,
    }: {
      variant: Variant;
      parameters: { boardWidth: number; boardHeight: number };
    }) => settingsMutations.updateVariantParameters(variant, parameters),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
      queryClient.setQueryData<SettingsResponse>(SETTINGS_QUERY_KEY, (prev) => {
        if (!prev) return prev;
        const previousVariantSettings = Array.isArray(prev.variantSettings)
          ? prev.variantSettings
          : [];

        const nextVariantSettings = previousVariantSettings.some(
          (vs) => vs.variant === variables.variant,
        )
          ? previousVariantSettings.map((vs) =>
              vs.variant === variables.variant
                ? {
                    ...vs,
                    default_parameters: {
                      ...vs.default_parameters,
                      ...variables.parameters,
                    },
                  }
                : vs,
            )
          : [
              ...previousVariantSettings,
              {
                variant: variables.variant,
                default_parameters: variables.parameters,
              },
            ];

        return {
          ...prev,
          variantSettings: nextVariantSettings,
        };
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: SETTINGS_QUERY_KEY,
        refetchType: "none",
      });
    },
  });

  // Derived values: use DB for logged-in users, localStorage for logged-out users
  // NOTE: For logged-in users, these will initially show default values while
  // isLoadingSettings is true, then "jump" to real values when dbSettings loads.
  // If this causes visual flicker, consider using isLoadingSettings to show skeletons
  // or gate rendering until settings are loaded.
  const boardTheme = isLoggedIn
    ? (dbSettings?.boardTheme ?? "default")
    : localBoardTheme;
  const pawnColor = isLoggedIn
    ? (dbSettings?.pawnColor ?? "default")
    : localPawnColor;
  const catPawn = isLoggedIn
    ? (pawnSettingsFromDb?.cat ?? "default")
    : localCatPawn;
  const mousePawn = isLoggedIn
    ? (pawnSettingsFromDb?.mouse ?? "default")
    : localMousePawn;
  const gameConfig = isLoggedIn
    ? (gameConfigFromDb ??
      ({ ...defaultGameConfig, rated: false } as GameConfiguration))
    : localGameConfig;

  // Aggregate mutation states (excluding display name mutation - it has its own error state)
  const isSavingSettings =
    updateBoardThemeMutation.isPending ||
    updatePawnColorMutation.isPending ||
    updatePawnMutation.isPending ||
    updateTimeControlMutation.isPending ||
    updateRatedStatusMutation.isPending ||
    updateDefaultVariantMutation.isPending ||
    updateVariantParametersMutation.isPending;

  // Per-section saving states
  const isSavingVisualStyle =
    updateBoardThemeMutation.isPending ||
    updatePawnColorMutation.isPending ||
    updatePawnMutation.isPending;

  const isSavingGameParameters =
    updateTimeControlMutation.isPending ||
    updateRatedStatusMutation.isPending ||
    updateDefaultVariantMutation.isPending ||
    updateVariantParametersMutation.isPending;

  const saveError =
    updateBoardThemeMutation.error ??
    updatePawnColorMutation.error ??
    updatePawnMutation.error ??
    updateTimeControlMutation.error ??
    updateRatedStatusMutation.error ??
    updateDefaultVariantMutation.error ??
    updateVariantParametersMutation.error;

  // Setters: use mutations for logged-in users, localStorage for logged-out users
  const setBoardTheme = (value: string) => {
    if (isLoggedIn) {
      updateBoardThemeMutation.mutate(value);
    } else {
      setLocalBoardTheme(value);
    }
  };

  const setPawnColor = (value: string) => {
    if (isLoggedIn) {
      updatePawnColorMutation.mutate(value);
    } else {
      setLocalPawnColor(value);
    }
  };

  const setCatPawn = (value: string) => {
    if (isLoggedIn) {
      updatePawnMutation.mutate({ pawnType: "cat", pawnShape: value });
    } else {
      setLocalCatPawn(value);
    }
  };

  const setMousePawn = (value: string) => {
    if (isLoggedIn) {
      updatePawnMutation.mutate({ pawnType: "mouse", pawnShape: value });
    } else {
      setLocalMousePawn(value);
    }
  };

  const setGameConfig = (incoming: GameConfiguration) => {
    if (isLoggedIn) {
      // IMPORTANT: For logged-in users, gameConfig is derived from dbSettings (via gameConfigFromDb),
      // not stored in local state. This function only calls mutations; it never directly updates
      // local state. The UI updates immediately because each mutation's onMutate callback performs
      // optimistic cache updates (setQueryData), which cause dbSettings to change, which causes
      // gameConfigFromDb (and thus gameConfig) to recompute.
      //
      // This means:
      // - Removing or breaking optimistic updates in mutations will make setGameConfig feel
      //   unresponsive (UI won't update until the server responds)
      // - All optimistic updates must be kept in sync with the mutations called here
      // - This is intentional: React Query cache is the single source of truth for logged-in users
      //
      // Create a new object to avoid mutating
      let newConfig = { ...incoming };

      // When variant changes, load saved parameters for the new variant
      if (newConfig.variant !== gameConfig.variant) {
        const variantParams = variantSettingsFromDb[newConfig.variant];
        if (variantParams) {
          newConfig = {
            ...newConfig,
            boardWidth: variantParams.boardWidth ?? 8,
            boardHeight: variantParams.boardHeight ?? 8,
          };
        }
        // Mutation's onMutate handles the optimistic update
        updateDefaultVariantMutation.mutate(newConfig.variant);
      }

      // Handle time control change
      if (
        newConfig.timeControl.preset !== gameConfig.timeControl.preset ||
        newConfig.timeControl.initialSeconds !==
          gameConfig.timeControl.initialSeconds ||
        newConfig.timeControl.incrementSeconds !==
          gameConfig.timeControl.incrementSeconds
      ) {
        // Only update preset if it changed, API still uses preset
        if (newConfig.timeControl.preset) {
          updateTimeControlMutation.mutate(newConfig.timeControl.preset);
        }
      }

      // Handle rated status change
      if (newConfig.rated !== gameConfig.rated) {
        updateRatedStatusMutation.mutate(newConfig.rated);
      }

      // Handle variant parameters change (when variant stays the same)
      if (
        newConfig.variant === gameConfig.variant &&
        (newConfig.boardWidth !== gameConfig.boardWidth ||
          newConfig.boardHeight !== gameConfig.boardHeight)
      ) {
        updateVariantParametersMutation.mutate({
          variant: newConfig.variant,
          parameters: {
            boardWidth: newConfig.boardWidth ?? 8,
            boardHeight: newConfig.boardHeight ?? 8,
          },
        });
      }
    } else {
      // For logged-out users, handle variant settings in localStorage
      let newConfig = { ...incoming };

      // When variant changes, save current variant's parameters and load new ones
      if (newConfig.variant !== gameConfig.variant) {
        setLocalVariantSettings((prev) => ({
          ...prev,
          [gameConfig.variant]: {
            boardWidth: gameConfig.boardWidth,
            boardHeight: gameConfig.boardHeight,
          },
        }));

        // Load saved parameters for the new variant
        const variantParams = localVariantSettings[newConfig.variant];
        if (variantParams) {
          newConfig = {
            ...newConfig,
            boardWidth: variantParams.boardWidth ?? 8,
            boardHeight: variantParams.boardHeight ?? 8,
          };
        }
      }

      // Save variant parameters when dimensions change (but variant stays the same)
      if (
        newConfig.variant === gameConfig.variant &&
        (newConfig.boardWidth !== gameConfig.boardWidth ||
          newConfig.boardHeight !== gameConfig.boardHeight)
      ) {
        setLocalVariantSettings((prev) => ({
          ...prev,
          [newConfig.variant]: {
            boardWidth: newConfig.boardWidth,
            boardHeight: newConfig.boardHeight,
          },
        }));
      }

      setLocalGameConfig(newConfig);
    }
  };

  return {
    boardTheme,
    setBoardTheme,
    pawnColor,
    setPawnColor,
    catPawn,
    setCatPawn,
    mousePawn,
    setMousePawn,
    gameConfig,
    setGameConfig,
    displayName: isLoggedIn ? displayName : "Guest",
    setDisplayName: isLoggedIn
      ? setDisplayName
      : () => {
          // No-op for logged-out users - display name cannot be changed when not logged in
          // Callers should gate display name UI on isLoggedIn to avoid calling this
        },
    displayNameError: isLoggedIn ? displayNameError : null,
    displayNameValidationError: isLoggedIn ? displayNameValidationError : null,
    handleChangeDisplayName: isLoggedIn
      ? handleChangeDisplayName
      : () => {
          // No-op for logged-out users - display name cannot be changed when not logged in
          // Callers should gate display name UI on isLoggedIn to avoid calling this
        },
    canChangeName,
    isLoadingSettings: isLoggedIn ? isLoadingSettings : false,
    // isSavingName only tracks display name mutation (for display name button)
    isSavingName: isLoggedIn ? updateDisplayNameMutation.isPending : false,
    // isSaving includes display name mutation for button state
    isSaving: isLoggedIn
      ? isSavingSettings || updateDisplayNameMutation.isPending
      : false,
    // isSavingSettings excludes display name mutation (for Visual Style/Game Parameters alerts)
    isSavingSettings: isLoggedIn ? isSavingSettings : false,
    // Per-section saving states
    isSavingVisualStyle: isLoggedIn ? isSavingVisualStyle : false,
    isSavingGameParameters: isLoggedIn ? isSavingGameParameters : false,
    loadError: isLoggedIn
      ? settingsLoadError instanceof Error
        ? settingsLoadError
        : settingsLoadError
          ? new Error(String(settingsLoadError))
          : null
      : null,
    saveError: isLoggedIn
      ? saveError instanceof Error
        ? saveError
        : saveError
          ? new Error(String(saveError))
          : null
      : null,
  };
}

/**
 * Public hook that abstracts logged-in vs logged-out settings implementation.
 *
 * IMPORTANT: This hook always calls the same hooks in the same order (Rules of Hooks).
 * The logged-in vs logged-out behavior is handled internally via conditional logic,
 * not by calling different hooks.
 *
 * @param isLoggedIn - Whether the user is currently logged in
 * @param userPending - Whether the user authentication check is still pending.
 *                      IMPORTANT: Pass the actual userPending state from useQuery to prevent
 *                      querying settings before auth settles. Defaults to false (auth settled).
 *                      The hook uses this to gate the settings query: enabled: isLoggedIn && !userPending
 * @returns SettingsState with all settings values and setters
 *
 * @note Loading states:
 *       - isLoadingSettings: true while settings are being fetched (logged-in users only)
 *       - userPending: should be passed from user auth query to prevent premature settings queries
 *
 * @note Display name functions:
 *       - For logged-out users, setDisplayName and handleChangeDisplayName are no-ops.
 *       - Always gate display name UI on isLoggedIn to avoid calling these unnecessarily.
 */
export function useSettings(
  isLoggedIn: boolean,
  userPending = false,
): SettingsState {
  return useSettingsInternal(isLoggedIn, userPending);
}
