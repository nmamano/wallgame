import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { type BoardProps, type BoardPawn } from "@/components/board";
import { type MatchingPlayer } from "@/components/matching-stage-panel";
import { type GameAction } from "../../../shared/domain/game-types";
import { GameState } from "../../../shared/domain/game-state";
import {
  generateFreestyleInitialState,
  normalizeFreestyleConfig,
} from "../../../shared/domain/freestyle-setup";
import {
  buildSurvivalInitialState,
  type SurvivalSetupInput,
} from "../../../shared/domain/survival-setup";
import { buildStandardInitialState } from "../../../shared/domain/standard-setup";
import { buildClassicInitialState } from "../../../shared/domain/classic-setup";
import type {
  PlayerId,
  WallPosition,
  Move,
  Action,
  MatchType,
  GameSnapshot,
  GameInitialState,
  SurvivalInitialState,
} from "../../../shared/domain/game-types";
import {
  moveToStandardNotation,
  cellToStandardNotation,
} from "../../../shared/domain/standard-notation";
import type { MoveHistoryRow } from "@/components/move-list-panel";
import { pawnId } from "../../../shared/domain/game-utils";
import { type PlayerColor } from "@/lib/player-colors";
import type { GameConfiguration } from "../../../shared/domain/game-types";
import {
  userQueryOptions,
  fetchGameSession,
  abortGameSession,
} from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";
import { sounds, play } from "@/lib/sounds";
import { MusicController } from "@/lib/music";
import { useSound } from "@/components/sound-provider";
import { useMetaGameActions } from "@/hooks/use-meta-game-actions";
import {
  createPlayerController,
  isLocalController,
  isRemoteController,
  isSupportedController,
  type ControllerActionKind,
  type GamePlayerController,
  type PlayerControllerContext,
} from "@/lib/player-controllers";
import { RemotePlayerController } from "@/lib/remote-player-controller";
import { useOnlineGameSession } from "@/hooks/use-online-game-session";
import {
  saveGameHandshake,
  type StoredGameHandshake,
} from "@/lib/game-session";
import {
  buildGameConfigurationFromSerialized,
  hydrateGameStateFromSerialized,
} from "@/lib/game-state-utils";
import type { SerializedGameState } from "../../../shared/domain/game-types";
import { useGameViewModel } from "@/hooks/use-game-view-model";
import { buildHistoryState } from "@/lib/history-utils";
import type { HistoryNav } from "@/types/history";
import {
  type PlayerType,
  computeLastMoves,
  buildPlayerName,
  formatWinReason,
  sanitizePlayerList,
  resolvePlayerColor,
} from "@/lib/gameViewModel";
import { SpectatorSession } from "@/lib/spectator-controller";
import { describeControllerError } from "@/lib/controller-errors";
import type { ResolveGameAccessResponse } from "../../../shared/contracts/games";
import { parseReplayNavState } from "@/lib/navigation-state";
import { cloneQueue as cloneLocalActionQueue } from "@/game/local-actions";
import {
  canActNow as selectCanActNow,
  shouldQueueAsPremove,
  isViewingHistory as selectIsViewingHistory,
  type ControllerSelectorState,
} from "@/game/controller-selectors";
import { useBoardInteractions } from "@/hooks/use-board-interactions";

export interface LocalPreferences {
  pawnColor: PlayerColor;
  catSkin: string | undefined;
  mouseSkin: string | undefined;
  homeSkin: string | undefined;
  displayName: string;
}

export interface GamePlayer {
  id: string;
  playerId: PlayerId;
  name: string;
  rating: number;
  color: PlayerColor;
  type: PlayerType;
  isOnline: boolean;
  catSkin?: string;
  mouseSkin?: string;
  homeSkin?: string;
}

export interface ScoreboardEntry {
  id: string | number;
  name: string;
  score: number;
}

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: Date;
  channel: "game" | "team" | "audience";
  isSystem?: boolean;
  isError?: boolean;
}

type RematchResponse = "pending" | "accepted" | "declined";

export interface RematchState {
  status: "idle" | "pending" | "starting" | "declined";
  responses: Record<PlayerId, RematchResponse>;
  requestId: number;
  decliner?: PlayerId;
  offerer?: PlayerId;
}

type ReadOnlyAccess = Extract<
  ResolveGameAccessResponse,
  { kind: "spectator" | "replay" }
>;

function buildUnexpectedControllerErrorMessage(
  action: ControllerActionKind,
  error: unknown,
): string {
  return describeControllerError(action, {
    kind: "Unknown",
    message:
      error instanceof Error
        ? error.message
        : "Unexpected error while talking to the controller.",
    cause: error,
  });
}

const DEFAULT_CONFIG: GameConfiguration = {
  timeControl: {
    initialSeconds: 180,
    incrementSeconds: 2,
    preset: "blitz",
  },
  rated: false,
  variant: "standard",
  boardWidth: 9,
  boardHeight: 9,
  variantConfig: buildStandardInitialState(9, 9),
};

const DEFAULT_PLAYERS: PlayerType[] = ["you", "you"];

const PLACEHOLDER_COPY: Partial<Record<PlayerType, string>> = {
  friend: "Inviting a friend requires the server backend. Coming soon.",
  "matched-user": "Be matched with other players.",
};

const DEFAULT_PLAYER_COLORS: Record<PlayerId, PlayerColor> = {
  1: "red",
  2: "blue",
};

interface StoredLocalGameConfig {
  config?: Partial<GameConfiguration>;
  players?: PlayerType[];
  nextSeatOrder?: [number, number];
  matchScore?: number[];
  matchDraws?: number;
}

const generateLocalGameId = () => Math.random().toString(36).substring(2, 15);

const SPECTATOR_PLAYER_TYPES: PlayerType[] = ["friend", "friend"];
const NOOP = () => undefined;

function buildSeatViewsFromSnapshot(
  snapshot: GameSnapshot,
  options: {
    primaryLocalPlayerId: PlayerId | null;
    localPreferences: LocalPreferences;
    playerColorsForBoard: Record<PlayerId, PlayerColor>;
  },
): GamePlayer[] {
  const { primaryLocalPlayerId, localPreferences, playerColorsForBoard } =
    options;
  const ordered = [...snapshot.players].sort((a, b) => {
    if (a.role === "host" && b.role !== "host") return -1;
    if (b.role === "host" && a.role !== "host") return 1;
    return a.playerId - b.playerId;
  });

  return ordered.map((player) => ({
    id: `p${player.playerId}`,
    playerId: player.playerId,
    name:
      player.playerId === primaryLocalPlayerId
        ? player.displayName || localPreferences.displayName
        : player.displayName,
    rating: player.elo ?? 1500,
    color:
      playerColorsForBoard[player.playerId] ??
      DEFAULT_PLAYER_COLORS[player.playerId],
    type:
      player.playerId === primaryLocalPlayerId
        ? ("you" as PlayerType)
        : ("friend" as PlayerType),
    isOnline: player.connected,
    catSkin:
      player.playerId === primaryLocalPlayerId
        ? localPreferences.catSkin
        : player.appearance?.catSkin,
    mouseSkin:
      player.playerId === primaryLocalPlayerId
        ? localPreferences.mouseSkin
        : player.appearance?.mouseSkin,
    homeSkin:
      player.playerId === primaryLocalPlayerId
        ? localPreferences.homeSkin
        : player.appearance?.homeSkin,
  }));
}

export function useGamePageController(gameId: string) {
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;
  const settings = useSettings(isLoggedIn, userPending);
  const navigate = useNavigate();
  const router = useRouterState();
  const replayPlyIndex = useMemo(
    () => parseReplayNavState(router.location.state),
    [router.location.state],
  );

  // Sound settings from global provider (persisted to localStorage)
  const {
    sfxEnabled,
    setSfxEnabled,
    sfxEnabledRef,
    musicEnabled,
    setMusicEnabled,
    musicEnabledRef,
  } = useSound();

  // ============================================================================
  // Music Controller - plays background music only during game sessions
  // ============================================================================
  const musicControllerRef = useRef<MusicController | null>(null);

  // Create music controller on mount, teardown on unmount.
  // Note: Music is NOT started here - it's controlled by the matchingPanelOpen effect
  // to avoid playing music when the "waiting for players" modal is blocking sound controls.
  useEffect(() => {
    const controller = new MusicController(musicEnabledRef);
    musicControllerRef.current = controller;

    return () => {
      controller.teardown();
      musicControllerRef.current = null;
    };
  }, [musicEnabledRef]);

  // React to musicEnabled policy changes
  useEffect(() => {
    musicControllerRef.current?.onPolicyChange(musicEnabled);
  }, [musicEnabled]);

  // ============================================================================
  // Local Preferences (derived from settings hook)
  // ============================================================================
  const localPreferences = useMemo<LocalPreferences>(
    () => ({
      pawnColor: resolvePlayerColor(settings.pawnColor),
      catSkin: settings.catPawn,
      mouseSkin: settings.mousePawn,
      homeSkin: settings.homePawn,
      displayName: settings.displayName,
    }),
    [
      settings.pawnColor,
      settings.catPawn,
      settings.mousePawn,
      settings.homePawn,
      settings.displayName,
    ],
  );

  const [hasLocalConfig, setHasLocalConfig] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return sessionStorage.getItem(`game-config-${gameId}`) != null;
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      setHasLocalConfig(false);
      return;
    }
    setHasLocalConfig(sessionStorage.getItem(`game-config-${gameId}`) != null);
  }, [gameId]);

  const {
    viewModel,
    applyServerUpdate,
    updateGameState,
    resetViewModel,
    playerColorsForBoardRef,
  } = useGameViewModel(DEFAULT_PLAYER_COLORS);

  // ============================================================================
  // Connection & Session State
  // ============================================================================
  const seatViewsRef = useRef<GamePlayer[]>([]);
  const seatActionsRef = useRef<Record<PlayerId, GamePlayerController | null>>({
    1: null,
    2: null,
  });
  const remotePlayerIdRef = useRef<PlayerId | null>(null);
  const remoteControllerRef = useRef<{
    key: string;
    playerId: PlayerId;
    controller: RemotePlayerController;
  } | null>(null);
  const gameInitializedRef = useRef(false);
  const gameAwaitingServerRef = useRef(false);

  const teardownRemoteController = useCallback(
    (reason = "unspecified") => {
      const active = remoteControllerRef.current;
      if (!active) {
        return;
      }
      console.warn("[friend-game] teardown remote controller", {
        reason,
        previousKey: active.key,
        stack: new Error().stack,
      });
      active.controller.disconnect();
      if (remotePlayerIdRef.current === active.playerId) {
        remotePlayerIdRef.current = null;
        seatActionsRef.current[active.playerId] = createPlayerController({
          playerId: active.playerId,
          playerType: "you",
        });
      }
      remoteControllerRef.current = null;
      gameInitializedRef.current = false;
      gameAwaitingServerRef.current = false;
    },
    [seatActionsRef],
  );

  const getPlayerName = useCallback(
    (playerId: PlayerId) =>
      seatViewsRef.current.find((p) => p.playerId === playerId)?.name ??
      `Player ${playerId}`,
    [],
  );

  const debugMatch = useCallback(
    (message: string, extra?: Record<string, unknown>) => {
      console.debug(`[friend-game] ${message}`, extra);
    },
    [],
  );

  const applyMatchSnapshotIfCurrent = useCallback(
    (snapshot: GameSnapshot): boolean => {
      applyServerUpdate({ type: "match", snapshot });
      return true;
    },
    [applyServerUpdate],
  );

  const handleMatchSnapshotUpdate = useCallback(
    (snapshot: GameSnapshot) => {
      void applyMatchSnapshotIfCurrent(snapshot);
    },
    [applyMatchSnapshotIfCurrent],
  );

  const maskToken = useCallback((value?: string | null) => {
    if (!value) return undefined;
    if (value.length <= 8) return value;
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }, []);

  const shouldUseOnlineSession = !hasLocalConfig;
  const isRemoteFlow = shouldUseOnlineSession;
  useEffect(() => {
    if (typeof window === "undefined") return;
    console.debug("[game-page] session mode", {
      gameId,
      hasLocalConfig,
      shouldUseOnlineSession,
      localConfigPresent: Boolean(
        sessionStorage.getItem(`game-config-${gameId}`),
      ),
    });
  }, [gameId, hasLocalConfig, shouldUseOnlineSession]);

  const {
    gameHandshake,
    matchShareUrl,
    isMultiplayerMatch,
    isResolvingAccess,
    isClaimingSeat,
    matchError,
    setMatchError,
    updateGameHandshake,
    access,
    claimSeat,
  } = useOnlineGameSession({
    gameId,
    localPreferences,
    onMatchSnapshotUpdate: handleMatchSnapshotUpdate,
    debugMatch,
    enabled: shouldUseOnlineSession,
  });

  const localRole = gameHandshake?.role ?? null;
  const isCreator = localRole === "host";

  const accessKind = access?.kind ?? null;
  const readOnlyAccess = useMemo<ReadOnlyAccess | null>(() => {
    if (!access) {
      return null;
    }
    if (access.kind === "spectator" || access.kind === "replay") {
      return access;
    }
    return null;
  }, [access]);
  const isSpectatorSession = useMemo(
    () => !hasLocalConfig && accessKind === "spectator",
    [hasLocalConfig, accessKind],
  );
  const isReplaySession = useMemo(
    () => !hasLocalConfig && accessKind === "replay",
    [hasLocalConfig, accessKind],
  );
  const isReadOnlySession = isSpectatorSession || isReplaySession;
  useEffect(() => {
    console.debug("[game-page] remote access state", {
      gameId,
      isSpectatorSession,
      isReplaySession,
      isReadOnlySession,
      isMultiplayerMatch,
      accessKind,
    });
  }, [
    gameId,
    isSpectatorSession,
    isReplaySession,
    isReadOnlySession,
    isMultiplayerMatch,
    accessKind,
  ]);

  const remoteSeatIdentity = useMemo(() => {
    if (!shouldUseOnlineSession) return null;
    if (access?.kind !== "player") return null;
    return {
      gameId,
      role: access.seat.role,
      playerId: access.seat.playerId,
      socketToken: access.seat.socketToken,
      token: access.seat.token,
    };
  }, [shouldUseOnlineSession, access, gameId]);

  const remoteConnection = useMemo(() => {
    if (!remoteSeatIdentity) {
      return null;
    }
    return {
      key: `${remoteSeatIdentity.gameId}:${remoteSeatIdentity.role}:${remoteSeatIdentity.playerId}:${remoteSeatIdentity.socketToken}`,
      seat: remoteSeatIdentity,
    };
  }, [remoteSeatIdentity]);

  const remoteSeatResolvedRef = useRef(false);
  useEffect(() => {
    if (remoteConnection) {
      remoteSeatResolvedRef.current = true;
      return;
    }
    if (!remoteSeatResolvedRef.current) {
      return;
    }
    if (isResolvingAccess) {
      return;
    }
    if (remoteControllerRef.current) {
      teardownRemoteController("remote-seat-cleared");
      remoteSeatResolvedRef.current = false;
    }
  }, [remoteConnection, isResolvingAccess, teardownRemoteController]);

  const spectatorSessionRef = useRef<SpectatorSession | null>(null);
  const spectatorInitializedRef = useRef(false);
  const isMultiplayerMatchRef = useRef(isMultiplayerMatch);
  const chatHandlerRef = useRef<{
    onMessage: (msg: {
      channel: "game" | "team" | "audience";
      senderId: string;
      senderName: string;
      text: string;
      timestamp: number;
    }) => void;
    onError: (err: { code: string; message: string }) => void;
  } | null>(null);
  const mySocketIdRef = useRef<string | null>(null);
  useEffect(() => {
    isMultiplayerMatchRef.current = isMultiplayerMatch;
  }, [isMultiplayerMatch]);
  const [spectatorStatus, setSpectatorStatus] = useState<{
    isLoading: boolean;
    error: string | null;
  }>({
    isLoading: false,
    error: null,
  });
  const spectatorBootstrap = useMemo(() => {
    if (!readOnlyAccess) {
      return null;
    }
    return {
      snapshot: readOnlyAccess.matchStatus,
      state: readOnlyAccess.state,
    };
  }, [readOnlyAccess]);
  const displayMatchError = isReadOnlySession ? null : matchError;

  const addSystemMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        sender: "System",
        text,
        timestamp: new Date(),
        channel: "game",
        isSystem: true,
      },
    ]);
  }, []);

  const waitingAccessReason = access?.kind === "waiting" ? access.reason : null;

  const handleClaimSeat = useCallback(() => {
    if (access?.kind !== "waiting" || isClaimingSeat) return;
    if (waitingAccessReason === "host-aborted") return;
    void claimSeat();
  }, [access, claimSeat, isClaimingSeat, waitingAccessReason]);

  // Sync handshake playerId with match snapshot if roles swapped (e.g. rematch)
  useEffect(() => {
    if (!isMultiplayerMatch || !viewModel.match || !gameHandshake) return;

    const myRole = gameHandshake.role;
    const myPlayerEntry = viewModel.match.players.find(
      (p) => p.role === myRole,
    );

    if (myPlayerEntry && myPlayerEntry.playerId !== gameHandshake.playerId) {
      debugMatch("Detected playerId change from match snapshot", {
        oldId: gameHandshake.playerId,
        newId: myPlayerEntry.playerId,
        role: myRole,
      });

      updateGameHandshake({
        ...gameHandshake,
        playerId: myPlayerEntry.playerId,
      });
    }
  }, [
    viewModel.match,
    gameHandshake,
    isMultiplayerMatch,
    updateGameHandshake,
    debugMatch,
  ]);

  const [playerTypes, setPlayerTypes] = useState<PlayerType[]>(DEFAULT_PLAYERS);

  useEffect(() => {
    if (!isMultiplayerMatch) return;
    if (!playerTypes.length) return;
    setMatchParticipants(playerTypes);
  }, [isMultiplayerMatch, playerTypes]);

  const primaryLocalPlayerId = useMemo<PlayerId | null>(() => {
    const idx = playerTypes.findIndex((type) => type === "you");
    if (idx === -1) return null;
    return (idx + 1) as PlayerId;
  }, [playerTypes]);

  const friendColorOverrides = useMemo(() => {
    if ((!isMultiplayerMatch && !isReadOnlySession) || !viewModel.match) {
      return {};
    }
    const map: Partial<Record<PlayerId, PlayerColor>> = {};
    viewModel.match.players.forEach((player) => {
      if (player.appearance?.pawnColor) {
        map[player.playerId] = resolvePlayerColor(player.appearance.pawnColor);
      }
    });
    return map;
  }, [viewModel.match, isMultiplayerMatch, isReadOnlySession]);

  const playerColorsForBoard = useMemo(() => {
    const colors: Record<PlayerId, PlayerColor> = {
      1: DEFAULT_PLAYER_COLORS[1],
      2: DEFAULT_PLAYER_COLORS[2],
    };
    if (primaryLocalPlayerId) {
      colors[primaryLocalPlayerId] = localPreferences.pawnColor;
    }
    Object.entries(friendColorOverrides).forEach(([key, value]) => {
      const playerId = Number(key) as PlayerId;
      if (playerId === primaryLocalPlayerId) {
        return;
      }
      colors[playerId] = value;
    });

    // Handle color collision: fall back to defaults if both players match.
    if (colors[1] === colors[2]) {
      colors[1] = DEFAULT_PLAYER_COLORS[1];
      colors[2] = DEFAULT_PLAYER_COLORS[2];
    }

    return colors;
  }, [friendColorOverrides, localPreferences.pawnColor, primaryLocalPlayerId]);

  // Keep ref in sync with computed value
  useEffect(() => {
    playerColorsForBoardRef.current = playerColorsForBoard;
  }, [playerColorsForBoard, playerColorsForBoardRef]);

  const stagedActionsSnapshotRef = useRef<Action[] | null>(null);
  const latestStagedActionsRef = useRef<Action[]>([]);
  const previousHistoryCursorRef = useRef<number | null>(null);
  const previousHistoryLengthRef = useRef(0);
  const replayCursorAppliedRef = useRef<{
    gameInstanceId: number;
    applied: boolean;
  }>({ gameInstanceId: -1, applied: false });

  const getSeatController = useCallback((playerId: PlayerId | null) => {
    if (playerId == null) return null;
    return seatActionsRef.current[playerId] ?? null;
  }, []);

  const metaGameActionsRef = useRef<ReturnType<
    typeof useMetaGameActions
  > | null>(null);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [hasNewMovesWhileRewound, setHasNewMovesWhileRewound] = useState(false);

  const initializeGame = useCallback(
    (
      incomingConfig: GameConfiguration,
      incomingPlayers: PlayerType[],
      options?: { forceYouFirst?: boolean },
    ) => {
      const nextGameId = currentGameIdRef.current + 1;
      currentGameIdRef.current = nextGameId;
      setGameInstanceId(nextGameId);
      const normalizedConfig = normalizeFreestyleConfig(incomingConfig);
      const sanitizedPlayers = sanitizePlayerList(incomingPlayers, {
        forceYouFirst: options?.forceYouFirst ?? true,
      });
      const nextPrimaryLocalPlayerId = (() => {
        const idx = sanitizedPlayers.findIndex((type) => type === "you");
        return ((idx === -1 ? 0 : idx) + 1) as PlayerId;
      })();
      const state = new GameState(normalizedConfig, Date.now());

      // Update view model with new game state
      applyServerUpdate({
        type: "game-state",
        config: normalizedConfig,
        gameState: state,
        isInitial: true,
      });

      setPlayerTypes(sanitizedPlayers);
      setSelectedPawnId(null);
      setDraggingPawnId(null);
      setActionError(null);
      setMessages([]);
      setChatInput("");
      setActiveTab("history");
      setChatChannel("game");
      setStagedActions([]);
      setPremovedActions([]);
      setActiveLocalPlayerId(null);
      pendingTurnRequestRef.current = null;

      Object.values(seatActionsRef.current).forEach((controller) =>
        controller?.cancel?.(new Error("Game reset")),
      );
      const controllers: Record<PlayerId, GamePlayerController | null> = {
        1: null,
        2: null,
      };
      sanitizedPlayers.forEach((type, index) => {
        const playerId = (index + 1) as PlayerId;
        controllers[playerId] = createPlayerController({
          playerId,
          playerType: type,
        });
      });
      seatActionsRef.current = controllers;

      const initialPlayers: GamePlayer[] = sanitizedPlayers.map(
        (type, index) => ({
          id: `p${index + 1}`,
          playerId: (index + 1) as PlayerId,
          name: buildPlayerName(type, index, localPreferences.displayName),
          rating: 1500,
          color:
            index + 1 === nextPrimaryLocalPlayerId
              ? localPreferences.pawnColor
              : DEFAULT_PLAYER_COLORS[(index + 1) as PlayerId],
          type,
          isOnline: type === "you" || type.includes("bot"),
          catSkin:
            index + 1 === nextPrimaryLocalPlayerId
              ? localPreferences.catSkin
              : undefined,
          mouseSkin:
            index + 1 === nextPrimaryLocalPlayerId
              ? localPreferences.mouseSkin
              : undefined,
          homeSkin:
            index + 1 === nextPrimaryLocalPlayerId
              ? localPreferences.homeSkin
              : undefined,
        }),
      );
      seatViewsRef.current = initialPlayers;
      setFallbackSeatViews(initialPlayers);

      const matchingList: MatchingPlayer[] = initialPlayers.map((player) => ({
        id: player.id,
        type: player.type,
        name: player.name,
        isReady: player.type === "you",
        isYou: player.type === "you",
      }));
      setMatchingPlayers(matchingList);

      setRematchState((prev) => ({
        status: "idle",
        responses: { 1: "pending", 2: "pending" },
        requestId: prev.requestId,
        offerer: undefined,
        decliner: undefined,
      }));
    },
    [
      applyServerUpdate,
      localPreferences,
      seatActionsRef,
      setDraggingPawnId,
      setPremovedActions,
      setSelectedPawnId,
      setStagedActions,
    ],
  );

  useEffect(() => {
    if (!remoteConnection) {
      return;
    }
    const { key, seat } = remoteConnection;
    if (remoteControllerRef.current?.key === key) {
      return;
    }
    teardownRemoteController("connection-key-changed");
    debugMatch("Connecting remote controller", {
      id: gameId,
      playerId: seat.playerId,
      socketToken: maskToken(seat.socketToken),
    });
    const controller = new RemotePlayerController(seat.playerId, "you", {
      gameId,
      socketToken: seat.socketToken,
    });
    remoteControllerRef.current = {
      key,
      playerId: seat.playerId,
      controller,
    };
    remotePlayerIdRef.current = seat.playerId;
    seatActionsRef.current[seat.playerId] = controller;
    controller.connect({
      onState: (state) => {
        setMatchError(null);
        const config = buildGameConfigurationFromSerialized(state);
        const isInitial = !gameInitializedRef.current;
        if (isInitial) {
          const playerTypes: PlayerType[] =
            seat.playerId === 1 ? ["you", "friend"] : ["friend", "you"];
          initializeGame(config, playerTypes, { forceYouFirst: false });
          setPlayerTypes(playerTypes);
          seatActionsRef.current[seat.playerId] = controller;
          gameInitializedRef.current = true;
        }

        if (
          state.moveCount === 0 &&
          isMultiplayerMatchRef.current &&
          seat &&
          gameInitializedRef.current
        ) {
          fetchGameSession({
            gameId,
            token: seat.token,
          })
            .then((details) => {
              applyMatchSnapshotIfCurrent(details.snapshot);
            })
            .catch((err) => {
              console.error(
                "[game-page] Failed to refresh match snapshot on new game",
                err,
              );
            });
        }
        const resolvedState = hydrateGameStateFromSerialized(state, config);
        if (resolvedState.status === "playing") {
          setRematchState((prev) => {
            if (prev.status === "idle") return prev;
            return {
              status: "idle",
              responses: { 1: "pending", 2: "pending" },
              requestId: prev.requestId,
              offerer: undefined,
              decliner: undefined,
            };
          });
        }
        applyServerUpdate({
          type: "game-state",
          config,
          gameState: resolvedState,
          isInitial,
        });
        gameAwaitingServerRef.current = false;
        // Play sound for opponent moves (when it becomes your turn after their move)
        if (!isInitial && seat.playerId === resolvedState.turn) {
          const lastEntry =
            resolvedState.history[resolvedState.history.length - 1];
          if (lastEntry && sfxEnabledRef.current) {
            const hasWall = lastEntry.move.actions.some(
              (a) => a.type === "wall",
            );
            play(hasWall ? sounds.wall : sounds.pawn);
          }
        }
        if (seat.playerId === resolvedState.turn) {
          setActiveLocalPlayerId(seat.playerId);
        } else {
          setActiveLocalPlayerId(null);
        }
      },
      onMatchStatus: (snapshot) => {
        applyMatchSnapshotIfCurrent(snapshot);
      },
      onRematchOffer: (playerId) => {
        const offerer = playerId as PlayerId;
        rematchRequestIdRef.current += 1;
        const requestId = rematchRequestIdRef.current;
        setRematchState({
          status: "pending",
          responses: {
            1: offerer === 1 ? "accepted" : "pending",
            2: offerer === 2 ? "accepted" : "pending",
          },
          requestId,
          offerer,
        });
        addSystemMessage(`${getPlayerName(offerer)} proposed a rematch.`);
      },
      onRematchRejected: (playerId) => {
        const decliner = playerId as PlayerId;
        setRematchState((prev) => ({
          ...prev,
          status: "declined",
          decliner,
          responses: {
            ...prev.responses,
            [decliner]: "declined",
          },
        }));
        addSystemMessage(`${getPlayerName(decliner)} declined the rematch.`);
      },
      onRematchStarted: (payload) =>
        rematchStartedHandlerRef.current?.(payload),
      onDrawOffer: (playerId) => {
        metaGameActionsRef.current?.handleIncomingDrawOffer(
          playerId as PlayerId,
        );
      },
      onDrawRejected: (playerId) => {
        metaGameActionsRef.current?.handleIncomingDrawRejected(
          playerId as PlayerId,
        );
      },
      onTakebackOffer: (playerId) => {
        metaGameActionsRef.current?.handleIncomingTakebackOffer(
          playerId as PlayerId,
        );
      },
      onTakebackRejected: (playerId) => {
        metaGameActionsRef.current?.handleIncomingTakebackRejected(
          playerId as PlayerId,
        );
      },
      onWelcome: (socketId) => {
        mySocketIdRef.current = socketId;
      },
      onChatMessage: (msg) => chatHandlerRef.current?.onMessage(msg),
      onChatError: (err) => chatHandlerRef.current?.onError(err),
      onError: (message) => {
        setMatchError(message);
      },
    });
  }, [
    remoteConnection,
    addSystemMessage,
    applyMatchSnapshotIfCurrent,
    applyServerUpdate,
    debugMatch,
    gameId,
    getPlayerName,
    initializeGame,
    maskToken,
    seatActionsRef,
    setMatchError,
    sfxEnabledRef,
    teardownRemoteController,
  ]);

  // ============================================================================
  // Derived Values from View Model
  // ============================================================================
  const config = viewModel.config;
  const gameState = viewModel.gameState;
  const matchSnapshot = viewModel.match;
  const historyEntries = useMemo(() => gameState?.history ?? [], [gameState]);
  const historyEntryCount = historyEntries.length;
  const historyState = useMemo(() => {
    if (historyCursor === null) return null;
    if (!gameState || !config) return null;
    return buildHistoryState({
      config,
      historyEntries,
      cursor: historyCursor,
    });
  }, [historyCursor, gameState, config, historyEntries]);
  const historyLastMoves = useMemo(() => {
    if (!historyState) return null;
    return computeLastMoves(historyState, playerColorsForBoard);
  }, [historyState, playerColorsForBoard]);
  const resolvedLastMoves = historyState
    ? historyLastMoves
    : viewModel.lastMoves;
  // Convert null to undefined for Board component compatibility
  const lastMove = resolvedLastMoves ?? undefined;
  // Refs for synchronous access in callbacks
  const gameStateRef = useRef<GameState | null>(null);
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  const [fallbackSeatViews, setFallbackSeatViews] = useState<GamePlayer[]>([]);

  const players = useMemo((): GamePlayer[] => {
    if (matchSnapshot) {
      return buildSeatViewsFromSnapshot(matchSnapshot, {
        primaryLocalPlayerId,
        localPreferences,
        playerColorsForBoard,
      });
    }

    if (fallbackSeatViews.length === 0) {
      return fallbackSeatViews;
    }

    // No snapshot yet; reuse the fallback list but reapply local overrides.
    const normalizedFallback = fallbackSeatViews.map((player) => {
      const isLocal = player.playerId === primaryLocalPlayerId;
      const resolvedColor =
        playerColorsForBoard[player.playerId] ?? player.color;

      if (isLocal) {
        return {
          ...player,
          color: resolvedColor,
          catSkin: localPreferences.catSkin,
          mouseSkin: localPreferences.mouseSkin,
          homeSkin: localPreferences.homeSkin,
        };
      }

      return {
        ...player,
        color: resolvedColor,
      };
    });

    return normalizedFallback;
  }, [
    matchSnapshot,
    fallbackSeatViews,
    primaryLocalPlayerId,
    localPreferences,
    playerColorsForBoard,
  ]);

  // Keep seatViewsRef in sync with the derived seat views
  useEffect(() => {
    seatViewsRef.current = players;
  }, [players]);

  useEffect(() => {
    if (!gameState) return;
    Object.values(seatActionsRef.current).forEach((controller) => {
      if (!controller) return;
      if (typeof controller.handleStateUpdate !== "function") return;
      const opponentId = controller.playerId === 1 ? 2 : 1;
      (
        controller.handleStateUpdate as (
          context: PlayerControllerContext,
        ) => void
      )({
        state: gameState,
        playerId: controller.playerId,
        opponentId,
      });
    });
  }, [gameState]);

  const applySpectatorSnapshotUpdate = useCallback(
    (snapshot: GameSnapshot) => {
      const applied = applyMatchSnapshotIfCurrent(snapshot);
      if (!applied) {
        return;
      }
      setPlayerTypes((prev) => {
        const matches =
          prev.length === SPECTATOR_PLAYER_TYPES.length &&
          prev.every((type, index) => type === SPECTATOR_PLAYER_TYPES[index]);
        return matches ? prev : SPECTATOR_PLAYER_TYPES;
      });
      setMatchParticipants((prev) => {
        const matches =
          prev.length === SPECTATOR_PLAYER_TYPES.length &&
          prev.every((type, index) => type === SPECTATOR_PLAYER_TYPES[index]);
        return matches ? prev : SPECTATOR_PLAYER_TYPES;
      });
    },
    [applyMatchSnapshotIfCurrent],
  );

  const applySpectatorStateUpdate = useCallback(
    (serializedState: SerializedGameState) => {
      const config = buildGameConfigurationFromSerialized(serializedState);
      const resolvedState = hydrateGameStateFromSerialized(
        serializedState,
        config,
      );
      const isInitial = !spectatorInitializedRef.current;
      applyServerUpdate({
        type: "game-state",
        config,
        gameState: resolvedState,
        isInitial,
      });
      spectatorInitializedRef.current = true;
    },
    [applyServerUpdate],
  );

  useEffect(() => {
    if (!isReadOnlySession) {
      spectatorSessionRef.current?.disconnect();
      spectatorSessionRef.current = null;
      spectatorInitializedRef.current = false;
      setSpectatorStatus({ isLoading: false, error: null });
      return;
    }

    if (!spectatorBootstrap) {
      setSpectatorStatus({
        isLoading: false,
        error: "Unable to load spectator data.",
      });
      return;
    }

    Object.values(seatActionsRef.current).forEach((controller) =>
      controller?.cancel?.(new Error("Spectator session started")),
    );
    seatActionsRef.current = { 1: null, 2: null };

    if (isReplaySession) {
      spectatorSessionRef.current?.disconnect();
      spectatorSessionRef.current = null;
      spectatorInitializedRef.current = false;
      applySpectatorSnapshotUpdate(spectatorBootstrap.snapshot);
      applySpectatorStateUpdate(spectatorBootstrap.state);
      setSpectatorStatus({ isLoading: false, error: null });
      return;
    }

    const session = new SpectatorSession(gameId);
    spectatorSessionRef.current = session;

    setSpectatorStatus({ isLoading: false, error: null });
    let cancelled = false;

    void session.connect(
      {
        onSnapshot: (snapshot: GameSnapshot) => {
          if (cancelled) return;
          applySpectatorSnapshotUpdate(snapshot);
          setSpectatorStatus((prev) => ({ ...prev, isLoading: false }));
        },
        onState: (state: SerializedGameState) => {
          if (cancelled) return;
          applySpectatorStateUpdate(state);
          setSpectatorStatus((prev) => ({ ...prev, isLoading: false }));
        },
        onError: (message) => {
          if (cancelled) return;
          setSpectatorStatus((prev) => ({
            ...prev,
            isLoading: false,
            error: message,
          }));
        },
        onStatusChange: (status) => {
          if (cancelled) return;
          setSpectatorStatus((prev) => ({
            ...prev,
            isLoading: !status.isConnected,
          }));
        },
        onRematchStarted: (newGameId) => {
          if (cancelled) return;
          rematchStartedHandlerRef.current?.({ newGameId });
        },
        onWelcome: (socketId) => {
          if (cancelled) return;
          mySocketIdRef.current = socketId;
        },
        onChatMessage: (msg) => {
          if (cancelled) return;
          chatHandlerRef.current?.onMessage(msg);
        },
        onChatError: (err) => {
          if (cancelled) return;
          chatHandlerRef.current?.onError(err);
        },
      },
      spectatorBootstrap,
    );

    return () => {
      cancelled = true;
      session.disconnect();
      if (spectatorSessionRef.current === session) {
        spectatorSessionRef.current = null;
      }
      spectatorInitializedRef.current = false;
      setSpectatorStatus({ isLoading: false, error: null });
      seatActionsRef.current = { 1: null, 2: null };
    };
  }, [
    isReadOnlySession,
    isReplaySession,
    gameId,
    applySpectatorSnapshotUpdate,
    applySpectatorStateUpdate,
    seatActionsRef,
    spectatorBootstrap,
  ]);
  const [matchingPlayers, setMatchingPlayers] = useState<MatchingPlayer[]>([]);
  const [activeTab, setActiveTab] = useState<"chat" | "history">("history");
  const [chatChannel, setChatChannel] = useState<"game" | "team" | "audience">(
    "game",
  );
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatTabHighlighted, setChatTabHighlighted] = useState(false);
  const [isSendingChat, setIsSendingChat] = useState(false);
  const pendingChatTextRef = useRef<string>("");

  // Set up chat message handlers (uses refs to avoid recreating WebSocket)
  useEffect(() => {
    chatHandlerRef.current = {
      onMessage: (msg) => {
        setMessages((prev) => [
          ...prev,
          {
            id: `${msg.timestamp}-${msg.senderName}`,
            sender: msg.senderName,
            text: msg.text,
            timestamp: new Date(msg.timestamp),
            channel: msg.channel,
          },
        ]);
        // Clear pending state only when we receive our own echoed message.
        // We use senderId for reliable identity matching instead of text.
        const isOwnMessage =
          mySocketIdRef.current !== null &&
          msg.senderId === mySocketIdRef.current;
        if (isSendingChat && isOwnMessage) {
          setIsSendingChat(false);
          setChatInput("");
          pendingChatTextRef.current = "";
        }
        // Highlight chat tab if not currently viewing it (but not for own messages)
        if (activeTab !== "chat" && !isOwnMessage) {
          setChatTabHighlighted(true);
        }
      },
      onError: (err) => {
        setIsSendingChat(false);
        // Restore the pending text so user can retry
        setChatInput(pendingChatTextRef.current);
        pendingChatTextRef.current = "";
        // Show error message locally
        const errorText =
          err.code === "MODERATION"
            ? "Message not allowed."
            : err.code === "TOO_LONG"
              ? "Message too long."
              : err.code === "RATE_LIMITED"
                ? "Please wait before sending another message."
                : "Failed to send message.";
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            sender: "System",
            text: errorText,
            timestamp: new Date(),
            channel: chatChannel,
            isSystem: true,
            isError: true,
          },
        ]);
      },
    };
  }, [activeTab, chatChannel, isSendingChat]);

  // Clear chat tab highlight when switching to chat tab
  useEffect(() => {
    if (activeTab === "chat") {
      setChatTabHighlighted(false);
    }
  }, [activeTab]);

  // Set default chat channel based on role
  useEffect(() => {
    if (isSpectatorSession) {
      setChatChannel("audience");
    } else {
      setChatChannel("game");
    }
  }, [isSpectatorSession]);

  const [actionError, setActionError] = useState<string | null>(null);
  const [activeLocalPlayerId, setActiveLocalPlayerId] =
    useState<PlayerId | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [matchParticipants, setMatchParticipants] = useState<PlayerType[]>([]);
  const [localMatchScore, setLocalMatchScore] = useState<number[]>([]);
  const [matchDraws, setMatchDraws] = useState(0);
  const [rematchState, setRematchState] = useState<RematchState>({
    status: "idle",
    responses: { 1: "pending", 2: "pending" },
    requestId: 0,
  });
  const [spectatorRematchGameId, setSpectatorRematchGameId] = useState<
    string | null
  >(null);

  const localPlayerIds = useMemo<PlayerId[]>(() => {
    return playerTypes.reduce((acc, type, index) => {
      if (type === "you") {
        acc.push((index + 1) as PlayerId);
      }
      return acc;
    }, [] as PlayerId[]);
  }, [playerTypes]);

  const defaultLocalPlayerId = localPlayerIds[0] ?? null;
  const autoAcceptingLocalIds = useMemo(
    () =>
      localPlayerIds.filter(
        (playerId) => playerId !== primaryLocalPlayerId && playerId != null,
      ),
    [localPlayerIds, primaryLocalPlayerId],
  );

  const unsupportedPlayers = useMemo(
    () => playerTypes.filter((type) => type !== "you"),
    [playerTypes],
  );
  const matchReadyForPlay =
    isMultiplayerMatch &&
    Boolean(gameHandshake) &&
    (matchSnapshot?.status === "in-progress" ||
      matchSnapshot?.status === "ready");
  const localSeatController =
    primaryLocalPlayerId != null
      ? seatActionsRef.current[primaryLocalPlayerId]
      : null;
  const seatCapabilities = localSeatController?.capabilities;
  const canMovePieces = seatCapabilities?.canMove ?? false;
  const canOfferRematch = seatCapabilities?.canOfferRematch ?? false;
  const canOfferDraw = seatCapabilities?.canOfferDraw ?? false;
  const canRespondToDraw = seatCapabilities?.canRespondToDraw ?? false;
  const canRequestTakeback = seatCapabilities?.canRequestTakeback ?? false;
  const canRespondToTakeback = seatCapabilities?.canRespondToTakeback ?? false;
  // Chat is available for online players and spectators, but not for local games or replays
  const canUseChat =
    !isReplaySession && (isMultiplayerMatch || isSpectatorSession);
  const controllerAllowsInteraction = canMovePieces;
  const interactionLocked =
    isReadOnlySession ||
    !controllerAllowsInteraction ||
    (!isMultiplayerMatch && unsupportedPlayers.length > 0) ||
    (isMultiplayerMatch && !matchReadyForPlay);

  const resolveBoardControlPlayerId = useCallback(
    () => activeLocalPlayerId ?? defaultLocalPlayerId ?? null,
    [activeLocalPlayerId, defaultLocalPlayerId],
  );

  const resolvePrimaryActionPlayerId = useCallback(
    () => primaryLocalPlayerId ?? null,
    [primaryLocalPlayerId],
  );

  const actionablePlayerId = resolveBoardControlPlayerId();

  // Note: commitStagedActions and enqueueLocalAction are now handled by
  // useBoardInteractions hook. The hook's onMoveReady callback handles
  // auto-commits, and we define commitStagedActions after the hook call
  // for manual commits from UI.

  // Ref for the board interactions clear function (used by useMetaGameActions)
  const clearStagingRef = useRef<() => void>(NOOP);

  const rematchStartedHandlerRef = useRef<
    | ((payload: {
        newGameId: string;
        seat?: { token: string; socketToken: string };
      }) => void)
    | null
  >(null);

  const handleRematchStarted = useCallback(
    (payload: {
      newGameId: string;
      seat?: { token: string; socketToken: string };
    }) => {
      if (payload.seat && isMultiplayerMatch) {
        const currentHandshake = gameHandshake;
        if (!currentHandshake) return;
        const nextPlayerId: PlayerId = currentHandshake.playerId === 1 ? 2 : 1;
        const inferredShareUrl =
          currentHandshake.shareUrl?.replace(
            currentHandshake.gameId,
            payload.newGameId,
          ) ??
          (typeof window !== "undefined"
            ? `${window.location.origin}/game/${payload.newGameId}`
            : undefined);
        const nextHandshake: StoredGameHandshake = {
          gameId: payload.newGameId,
          token: payload.seat.token,
          socketToken: payload.seat.socketToken,
          role: currentHandshake.role,
          playerId: nextPlayerId,
          shareUrl: inferredShareUrl,
        };
        saveGameHandshake(nextHandshake);
        updateGameHandshake(null);
        rematchRequestIdRef.current += 1;
        setSpectatorRematchGameId(null);
        setRematchState({
          status: "idle",
          responses: { 1: "pending", 2: "pending" },
          requestId: rematchRequestIdRef.current,
        });
        addSystemMessage("Players accepted the rematch. Redirecting…");
        void navigate({ to: `/game/${payload.newGameId}` });
        return;
      }

      setSpectatorRematchGameId(payload.newGameId);
      setRematchState((prev) => ({
        ...prev,
        status: "idle",
        responses: { 1: "pending", 2: "pending" },
      }));
      addSystemMessage(
        isReadOnlySession
          ? `Players started a rematch. You can follow them at /game/${payload.newGameId}.`
          : `Players started a rematch. Watch it at /game/${payload.newGameId}.`,
      );
    },
    [
      addSystemMessage,
      gameHandshake,
      isMultiplayerMatch,
      isReadOnlySession,
      navigate,
      updateGameHandshake,
    ],
  );

  useEffect(() => {
    rematchStartedHandlerRef.current = handleRematchStarted;
  }, [handleRematchStarted]);

  const handleFollowSpectatorRematch = useCallback(() => {
    if (!spectatorRematchGameId) return;
    addSystemMessage("Opening the rematch…");
    const targetId = spectatorRematchGameId;
    setSpectatorRematchGameId(null);
    void navigate({ to: `/game/${targetId}` });
  }, [addSystemMessage, navigate, spectatorRematchGameId]);

  useEffect(() => {
    setSpectatorRematchGameId(null);
  }, [gameId]);
  const defaultShareUrl =
    typeof window !== "undefined" ? window.location.href : undefined;
  const resolvedShareUrl = isRemoteFlow
    ? (matchShareUrl ?? defaultShareUrl)
    : defaultShareUrl;
  const authoritativeMatchStatus = useMemo<GameSnapshot | null>(() => {
    if (matchSnapshot) {
      return matchSnapshot;
    }
    if (access) {
      if (
        access.kind === "player" ||
        access.kind === "spectator" ||
        access.kind === "waiting" ||
        access.kind === "replay"
      ) {
        return access.matchStatus;
      }
    }
    return null;
  }, [matchSnapshot, access]);
  const authoritativeLifecycle = authoritativeMatchStatus?.status ?? null;
  const resolvedMatchType: MatchType | null = useMemo(() => {
    if (!isRemoteFlow) {
      return null;
    }
    return authoritativeMatchStatus?.matchType ?? null;
  }, [isRemoteFlow, authoritativeMatchStatus]);
  const remoteFallbackPlayers = useMemo<MatchingPlayer[]>(() => {
    if (!isRemoteFlow) return [];
    const youName = localPreferences.displayName || "You";
    const opponentType: PlayerType =
      resolvedMatchType === "friend"
        ? "friend"
        : resolvedMatchType === "matchmaking"
          ? "matched-user"
          : "matched-user";
    const opponentLabel =
      resolvedMatchType === "friend"
        ? "Friend"
        : resolvedMatchType === "matchmaking"
          ? "Matched Player"
          : "Opponent";
    return [
      {
        id: "player-you",
        type: "you",
        name: youName,
        isReady: true,
        isYou: true,
        role: "host",
      },
      {
        id: "player-opponent",
        type: opponentType,
        name: opponentLabel,
        isReady: false,
        isYou: false,
        role: "joiner",
      },
    ];
  }, [isRemoteFlow, localPreferences.displayName, resolvedMatchType]);
  const hostAbortedLatch = waitingAccessReason === "host-aborted";

  const matchingPanelPlayers: MatchingPlayer[] = useMemo(() => {
    if (isRemoteFlow && authoritativeMatchStatus) {
      const resolvedOpponentType: PlayerType =
        authoritativeMatchStatus.matchType === "matchmaking"
          ? "matched-user"
          : "friend";
      const localPlayerId = gameHandshake?.playerId ?? null;
      return authoritativeMatchStatus.players.map((player) => {
        const isYou =
          localPlayerId != null && player.playerId === localPlayerId;
        const type: PlayerType = isYou ? "you" : resolvedOpponentType;
        return {
          id: `player-${player.playerId}`,
          type,
          name: player.displayName,
          isReady: player.ready,
          isYou,
          isConnected: player.connected,
          role: player.role,
          statusOverride:
            hostAbortedLatch && player.role === "host" ? "aborted" : undefined,
        };
      });
    }
    if (isRemoteFlow) {
      return remoteFallbackPlayers;
    }
    return matchingPlayers;
  }, [
    isRemoteFlow,
    authoritativeMatchStatus,
    gameHandshake?.playerId,
    remoteFallbackPlayers,
    matchingPlayers,
    hostAbortedLatch,
  ]);
  const isAuthoritativeWaiting =
    isRemoteFlow &&
    !isReadOnlySession &&
    (authoritativeLifecycle === "waiting" || authoritativeLifecycle == null);
  const matchingPanelOpen = isRemoteFlow
    ? !isReadOnlySession &&
      (authoritativeLifecycle === "waiting" || authoritativeLifecycle == null)
    : matchingPlayers.some((entry) => !entry.isReady);
  const matchingCanAbort = isRemoteFlow
    ? isCreator &&
      (authoritativeLifecycle === "waiting" || authoritativeLifecycle == null)
    : true;
  const matchingStatusMessage = useMemo(() => {
    if (!isRemoteFlow) return undefined;
    if (displayMatchError) return displayMatchError;
    if (isResolvingAccess && !access) return "Resolving game access...";
    if (isClaimingSeat) return "Joining game...";
    if (waitingAccessReason === "host-aborted") {
      return "The creator aborted this game.";
    }
    switch (authoritativeLifecycle) {
      case "waiting":
        return "Waiting for players...";
      case "ready":
        return "Both players almost ready...";
      case "completed":
        return "Game finished.";
      case null:
      case undefined:
        return "Waiting for players...";
      case "in-progress":
        return undefined;
      default:
        return undefined;
    }
  }, [
    isRemoteFlow,
    displayMatchError,
    isResolvingAccess,
    isClaimingSeat,
    authoritativeLifecycle,
    access,
    waitingAccessReason,
  ]);

  const pendingTurnRequestRef = useRef<PlayerId | null>(null);
  const seatOrderIndicesRef = useRef<[number, number]>([0, 1]);
  const [gameInstanceId, setGameInstanceId] = useState(0);
  const currentGameIdRef = useRef(0);
  const lastScoredGameIdRef = useRef(0);
  const rematchRequestIdRef = useRef(0);

  useEffect(() => {
    setHistoryCursor(null);
    setHasNewMovesWhileRewound(false);
    stagedActionsSnapshotRef.current = null;
    previousHistoryCursorRef.current = null;
    previousHistoryLengthRef.current = 0;
    replayCursorAppliedRef.current = {
      gameInstanceId,
      applied: false,
    };
  }, [gameInstanceId]);

  useEffect(() => {
    if (replayPlyIndex == null) return;
    if (!isReplaySession) return;
    if (
      replayCursorAppliedRef.current.applied &&
      replayCursorAppliedRef.current.gameInstanceId === gameInstanceId
    ) {
      return;
    }
    if (historyEntryCount === 0 && replayPlyIndex > -1) {
      return;
    }
    setHistoryCursor(replayPlyIndex);
    replayCursorAppliedRef.current = {
      gameInstanceId,
      applied: true,
    };
  }, [replayPlyIndex, isReplaySession, historyEntryCount, gameInstanceId]);

  const prevMatchingPanelOpenRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevMatchingPanelOpenRef.current;
    prevMatchingPanelOpenRef.current = matchingPanelOpen;
    // Play sound when matching panel closes (all seats filled, game starts)
    if (prev === true && matchingPanelOpen === false) {
      if (sfxEnabled && !isReadOnlySession) {
        play(sounds.gameStart);
      }
    }
  }, [matchingPanelOpen, sfxEnabled, isReadOnlySession]);

  // Control music based on matching panel state:
  // - Don't play music when "waiting for players" modal is open (can't dismiss to reach controls)
  // - Start/resume music when the game actually begins (panel closes)
  useEffect(() => {
    const controller = musicControllerRef.current;
    if (!controller) return;

    if (matchingPanelOpen) {
      controller.pause();
    } else {
      // Use resume() - it handles both first-time start and resuming paused music
      controller.resume();
    }
  }, [matchingPanelOpen]);

  useEffect(() => {
    if (historyCursor === null) return;
    if (historyEntryCount === 0) {
      if (historyCursor !== -1) {
        setHistoryCursor(-1);
      }
      return;
    }
    const maxIndex = historyEntryCount - 1;
    if (historyCursor > maxIndex) {
      setHistoryCursor(maxIndex);
    }
  }, [historyCursor, historyEntryCount]);

  useEffect(() => {
    const previousLength = previousHistoryLengthRef.current;
    if (historyCursor !== null && historyEntryCount > previousLength) {
      setHasNewMovesWhileRewound(true);
    }
    previousHistoryLengthRef.current = historyEntryCount;
  }, [historyEntryCount, historyCursor]);

  const controllerSelectorState = useMemo<ControllerSelectorState>(
    () => ({
      historyCursor,
      isReadOnlySession,
      controllerAllowsInteraction,
      gameStatus: gameState?.status ?? null,
      gameTurn: gameState?.turn ?? null,
      actionablePlayerId,
      activeLocalPlayerId,
    }),
    [
      historyCursor,
      isReadOnlySession,
      controllerAllowsInteraction,
      gameState?.status,
      gameState?.turn,
      actionablePlayerId,
      activeLocalPlayerId,
    ],
  );

  const viewingHistory = selectIsViewingHistory(controllerSelectorState);
  const canActNow = selectCanActNow(controllerSelectorState);
  const canBufferPremoves = shouldQueueAsPremove(controllerSelectorState);

  // Compute values needed for board interactions hook
  const isClassicVariant = gameState?.config.variant === "classic";
  const survivalSettings =
    gameState?.config.variant === "survival"
      ? (gameState.config.variantConfig as SurvivalInitialState)
      : null;
  const mouseMoveLocked =
    isClassicVariant ||
    (survivalSettings ? !survivalSettings.mouseCanMove : false);
  const mouseMoveLockedMessage = isClassicVariant
    ? "Goal is fixed."
    : "Mouse cannot move.";

  // Basic board pawns for hook (positions from historyState when viewing history)
  const baseBoardPawns = useMemo((): BoardPawn[] => {
    const boardState = historyState ?? gameState;
    if (!boardState) return [];
    return boardState.getPawns().map((pawn) => ({
      ...pawn,
      id: pawnId(pawn),
    }));
  }, [gameState, historyState]);

  // Submit move to the seat controller (used by both onMoveReady and manual commit)
  const submitMoveToController = useCallback(
    (actions: Action[]): boolean => {
      const currentState = gameStateRef.current;
      if (!currentState) {
        setActionError("Game is still loading");
        return false;
      }

      const currentTurn = currentState.turn;
      const controller = seatActionsRef.current[currentTurn];
      if (!controller || !isLocalController(controller)) {
        setActionError("This player can't submit moves manually right now.");
        return false;
      }

      try {
        controller.submitMove({ actions });
        setActionError(null);
        return true;
      } catch (error) {
        console.error(error);
        setActionError(
          error instanceof Error ? error.message : "Move could not be applied.",
        );
        return false;
      }
    },
    [setActionError],
  );

  // Board interactions hook - manages staged/premoved actions, selection, and handlers
  const boardInteractions = useBoardInteractions({
    gameState,
    boardPawns: baseBoardPawns,
    controllablePlayerId: actionablePlayerId,
    canStage: canActNow && !viewingHistory && !interactionLocked,
    canPremove: canBufferPremoves && !viewingHistory,
    mouseMoveLocked,
    mouseMoveLockedMessage,
    sfxEnabled,
    onMoveReady: submitMoveToController,
    onError: setActionError,
  });

  // Update the ref so useMetaGameActions can clear staging
  clearStagingRef.current = boardInteractions.clearAllActions;

  // Extract values from hook for convenience
  const {
    stagedActions,
    premovedActions,
    selectedPawnId,
    draggingPawnId,
    handlePawnClick,
    handleCellClick,
    handleWallClick,
    handlePawnDragStart,
    handlePawnDragEnd,
    handleCellDrop,
    arrows: boardInteractionArrows,
    clearStagedActions: clearBoardStagedActions,
    clearAllActions,
    setStagedActions,
    setPremovedActions,
    setSelectedPawnId,
    setDraggingPawnId,
    // Annotation handlers and state (for board right-click interactions)
    onWallSlotRightClick,
    onCellRightClickDragStart,
    onCellRightClickDragMove,
    onCellRightClickDragEnd,
    onArrowDragFinalize,
    arrowDragStateRef,
    annotations,
    previewAnnotation,
    clearAnnotations,
  } = boardInteractions;

  // Manual commit for when user clicks commit button (fewer than 2 actions)
  const commitStagedActions = useCallback(
    (actions?: Action[]) => {
      if (historyCursor !== null) return;
      const moveActions = actions ?? stagedActions;
      if (moveActions.length === 0) return;
      if (submitMoveToController(moveActions)) {
        clearBoardStagedActions();
      }
    },
    [
      historyCursor,
      stagedActions,
      submitMoveToController,
      clearBoardStagedActions,
    ],
  );

  const performGameActionRef = useRef<(action: GameAction) => GameState>(() => {
    throw new Error("performGameAction not initialized");
  });

  const performGameActionImpl = useCallback(
    (
      action: GameAction,
      options?: {
        lastMoves?: BoardProps["lastMove"] | BoardProps["lastMoves"] | null;
      },
    ) => {
      const currentState = gameStateRef.current;
      if (!currentState) {
        throw new Error("Game is still loading");
      }
      const nextState = currentState.applyGameAction(action);
      // Only pass lastMoves option if explicitly provided; otherwise preserve existing arrows
      if (
        options &&
        Object.prototype.hasOwnProperty.call(options, "lastMoves")
      ) {
        updateGameState(nextState, { lastMoves: options.lastMoves });
      } else {
        updateGameState(nextState);
      }
      return nextState;
    },
    [updateGameState, gameStateRef],
  );

  // Meta game actions hook
  const metaGameActions = useMetaGameActions({
    gameInstanceId,
    gameState,
    gameStateRef,
    primaryLocalPlayerId,
    autoAcceptingLocalIds,
    getSeatController,
    performGameAction: performGameActionImpl,
    updateGameState,
    computeLastMoves,
    playerColorsForBoard,
    addSystemMessage,
    getPlayerName,
    setActionError,
    resolvePrimaryActionPlayerId,
    clearStaging: () => clearStagingRef.current(),
  });
  metaGameActionsRef.current = metaGameActions;

  const handleStartResignAction = useCallback(() => {
    if (!canMovePieces) return;
    metaGameActions.handleStartResign();
  }, [canMovePieces, metaGameActions]);

  const handleOfferDrawAction = useCallback(() => {
    if (!canOfferDraw) return;
    metaGameActions.handleOfferDraw();
  }, [canOfferDraw, metaGameActions]);

  const respondToDrawPromptAction = useCallback(
    (decision: "accept" | "reject") => {
      if (!canRespondToDraw) return;
      metaGameActions.respondToDrawPrompt(decision);
    },
    [canRespondToDraw, metaGameActions],
  );

  const handleRequestTakebackAction = useCallback(() => {
    if (!canRequestTakeback) return;
    metaGameActions.handleRequestTakeback();
  }, [canRequestTakeback, metaGameActions]);

  const respondToTakebackPromptAction = useCallback(
    (decision: "allow" | "decline") => {
      if (!canRespondToTakeback) return;
      metaGameActions.respondToTakebackPrompt(decision);
    },
    [canRespondToTakeback, metaGameActions],
  );

  const handleGiveTimeAction = useCallback(() => {
    if (!canMovePieces) return;
    metaGameActions.handleGiveTime();
  }, [canMovePieces, metaGameActions]);

  // Wrapper that handles notices
  const performGameAction = useCallback(
    (
      action: GameAction,
      options?: {
        lastMoves?: BoardProps["lastMove"] | BoardProps["lastMoves"] | null;
      },
    ) => {
      const result = performGameActionImpl(action, options);
      if (action.kind === "giveTime") {
        metaGameActions.handleGiveTimeNotice(action);
      }
      return result;
    },
    [performGameActionImpl, metaGameActions],
  );

  performGameActionRef.current = performGameAction;

  const simulateMove = useCallback(
    (
      actions: Action[],
      options?: { playerId?: PlayerId },
    ): GameState | null => {
      if (!gameState) return null;
      if (actions.length === 0) {
        return gameState;
      }
      const actorId = options?.playerId ?? gameState.turn;
      try {
        const stateForSimulation =
          actorId === gameState.turn
            ? gameState
            : (() => {
                const clone = gameState.clone();
                clone.turn = actorId;
                return clone;
              })();
        return stateForSimulation.applyGameAction({
          kind: "move",
          move: { actions },
          playerId: actorId,
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error("Failed to simulate staged actions", error);
        return null;
      }
    },
    [gameState],
  );

  const previewDescriptor = useMemo(() => {
    if (viewingHistory) return null;
    if (stagedActions.length) {
      return {
        actions: stagedActions,
        playerId: gameState?.turn ?? activeLocalPlayerId ?? null,
      };
    }
    if (premovedActions.length) {
      return {
        actions: premovedActions,
        playerId: actionablePlayerId ?? activeLocalPlayerId ?? null,
      };
    }
    return null;
  }, [
    stagedActions,
    premovedActions,
    gameState?.turn,
    actionablePlayerId,
    activeLocalPlayerId,
    viewingHistory,
  ]);

  const previewState = useMemo(() => {
    if (!previewDescriptor?.playerId) return null;
    return simulateMove(previewDescriptor.actions, {
      playerId: previewDescriptor.playerId,
    });
  }, [previewDescriptor, simulateMove]);

  const stagedWallOverlays = useMemo<WallPosition[]>(() => {
    if (!stagedActions.length) return [];
    const wallPlayerId = gameState?.turn ?? activeLocalPlayerId ?? undefined;
    return stagedActions
      .filter((action) => action.type === "wall")
      .map((action) => ({
        cell: action.target,
        orientation: action.wallOrientation!,
        ...(wallPlayerId ? { playerId: wallPlayerId } : {}),
      }));
  }, [stagedActions, gameState, activeLocalPlayerId]);

  const premoveWallOverlays = useMemo<WallPosition[]>(() => {
    if (!premovedActions.length) return [];
    const wallPlayerId = actionablePlayerId ?? activeLocalPlayerId ?? undefined;
    if (!wallPlayerId) return [];
    return premovedActions
      .filter((action) => action.type === "wall")
      .map((action) => ({
        cell: action.target,
        orientation: action.wallOrientation!,
        playerId: wallPlayerId,
      }));
  }, [premovedActions, actionablePlayerId, activeLocalPlayerId]);

  type WallPositionWithState = WallPosition & {
    state?: "placed" | "staged" | "premoved" | "calculated" | "missing";
  };

  const boardWalls = useMemo<WallPositionWithState[]>(() => {
    const wallSource = historyState ?? gameState;
    const base = wallSource
      ? wallSource.grid
          .getWalls()
          .map((wall) => ({ ...wall, state: "placed" as const }))
      : [];
    if (viewingHistory) {
      return base;
    }
    const staged = stagedWallOverlays.map((wall) => ({
      ...wall,
      state: "staged" as const,
    }));
    const premoved = premoveWallOverlays.map((wall) => ({
      ...wall,
      state: "premoved" as const,
    }));
    return [...base, ...staged, ...premoved];
  }, [
    gameState,
    historyState,
    stagedWallOverlays,
    premoveWallOverlays,
    viewingHistory,
  ]);

  const boardPawns = useMemo((): BoardPawn[] => {
    const boardState = historyState ?? gameState;
    const sourceState =
      viewingHistory || !previewState ? boardState : previewState;
    if (!sourceState) return [];
    const isClassicVariant = sourceState.config.variant === "classic";
    const basePawns = sourceState.getPawns().map((pawn) => {
      const isClassicGoal = isClassicVariant && pawn.type === "mouse";
      const visualType = isClassicGoal ? "home" : pawn.type;
      const visualPlayerId = isClassicGoal
        ? pawn.playerId === 1
          ? 2
          : 1
        : pawn.playerId;
      const player = players.find((p) => p.playerId === visualPlayerId);

      let pawnStyle: string | undefined;
      if (
        visualType === "cat" &&
        player?.catSkin &&
        player.catSkin !== "default"
      ) {
        pawnStyle = player.catSkin;
      } else if (
        visualType === "mouse" &&
        player?.mouseSkin &&
        player.mouseSkin !== "default"
      ) {
        pawnStyle = player.mouseSkin;
      } else if (
        visualType === "home" &&
        player?.homeSkin &&
        player.homeSkin !== "default"
      ) {
        pawnStyle = player.homeSkin;
      }

      if (isClassicGoal) {
        return {
          ...pawn,
          pawnStyle,
          visualType,
          visualPlayerId,
        };
      }

      return pawnStyle ? { ...pawn, pawnStyle } : pawn;
    });
    const pawnsWithIds: BoardPawn[] = basePawns.map((pawn) => ({
      ...pawn,
      id: pawnId(pawn),
    }));

    if (viewingHistory) {
      return pawnsWithIds;
    }

    const previewStateByPawnId = new Map<string, "staged" | "premoved">();
    const stagingPlayerId = gameState?.turn ?? activeLocalPlayerId;
    if (stagedActions.length && stagingPlayerId) {
      const stagedPawnTypes = new Set(
        stagedActions
          .filter((action) => action.type === "cat" || action.type === "mouse")
          .map((action) => action.type),
      );
      pawnsWithIds.forEach((pawn) => {
        if (pawn.type !== "cat" && pawn.type !== "mouse") return;
        if (
          pawn.playerId === stagingPlayerId &&
          stagedPawnTypes.has(pawn.type) &&
          !previewStateByPawnId.has(pawn.id)
        ) {
          previewStateByPawnId.set(pawn.id, "staged");
        }
      });
    }

    const premovePlayerId = actionablePlayerId ?? activeLocalPlayerId;
    if (premovedActions.length && premovePlayerId) {
      const premovePawnTypes = new Set(
        premovedActions
          .filter((action) => action.type === "cat" || action.type === "mouse")
          .map((action) => action.type),
      );
      pawnsWithIds.forEach((pawn) => {
        if (pawn.type !== "cat" && pawn.type !== "mouse") return;
        if (
          pawn.playerId === premovePlayerId &&
          premovePawnTypes.has(pawn.type) &&
          !previewStateByPawnId.has(pawn.id)
        ) {
          previewStateByPawnId.set(pawn.id, "premoved");
        }
      });
    }

    return pawnsWithIds.map((pawn) => {
      const previewState = previewStateByPawnId.get(pawn.id);
      return previewState ? { ...pawn, previewState } : pawn;
    });
  }, [
    previewState,
    gameState,
    historyState,
    stagedActions,
    premovedActions,
    actionablePlayerId,
    activeLocalPlayerId,
    players,
    viewingHistory,
  ]);

  // Arrows from the board interactions hook (staged and premoved move arrows)
  const boardArrows = viewingHistory ? [] : boardInteractionArrows;

  const gameStatus = gameState?.status ?? "playing";
  const gameTurn = gameState?.turn ?? 1;
  const gameResult = gameState?.result;

  const formattedHistory = useMemo<MoveHistoryRow[]>(() => {
    if (!gameState) return [];
    const rows = gameState.config.boardHeight;
    const entries = gameState.history.map((entry, index) => ({
      number: Math.ceil(entry.index / 2),
      notation: moveToStandardNotation(entry.move, rows),
      plyIndex: index,
    }));
    const paired: MoveHistoryRow[] = [];
    for (let i = 0; i < entries.length; i += 2) {
      paired.push({
        num: entries[i].number,
        white: entries[i]
          ? { notation: entries[i].notation, plyIndex: entries[i].plyIndex }
          : undefined,
        black: entries[i + 1]
          ? {
              notation: entries[i + 1].notation,
              plyIndex: entries[i + 1].plyIndex,
            }
          : undefined,
      });
    }
    return paired;
  }, [gameState]);

  const historyNav = useMemo<HistoryNav>(() => {
    const lastPlyIndex = historyEntryCount - 1;
    const hasHistory = historyEntryCount > 0;
    const canStepBack =
      hasHistory && (historyCursor === null || historyCursor > -1);
    const canStepForward = historyCursor !== null;
    const latestPlyIndex = lastPlyIndex >= 0 ? lastPlyIndex : null;

    const stepBackFromLive = () => {
      if (!hasHistory) return null;
      if (historyEntryCount === 1) return -1;
      return Math.max(-1, lastPlyIndex - 1);
    };

    return {
      cursor: historyCursor,
      latestPlyIndex,
      canStepBack,
      canStepForward,
      stepBack: () => {
        if (!hasHistory) return;
        setHistoryCursor((prev) => {
          if (prev === null) {
            return stepBackFromLive();
          }
          const next = prev - 1;
          return next < -1 ? -1 : next;
        });
      },
      stepForward: () => {
        setHistoryCursor((prev) => {
          if (prev === null) return prev;
          if (lastPlyIndex < 0) return null;
          const next = prev + 1;
          return next >= lastPlyIndex ? null : next;
        });
      },
      jumpStart: () => {
        if (!hasHistory) return;
        setHistoryCursor(-1);
      },
      jumpEnd: () => {
        setHistoryCursor(null);
      },
      goTo: (plyIndex: number) => {
        if (!hasHistory) return;
        if (Number.isNaN(plyIndex)) return;
        if (lastPlyIndex >= 0 && plyIndex >= lastPlyIndex) {
          setHistoryCursor(null);
          return;
        }
        const clamped = Math.max(-1, Math.min(plyIndex, lastPlyIndex - 1));
        setHistoryCursor(clamped);
      },
    };
  }, [historyCursor, historyEntryCount]);

  const applyMove = useCallback(
    (playerId: PlayerId, move: Move) => {
      const before = gameStateRef.current;
      if (!before) {
        throw new Error("Game is still loading");
      }

      const nextState = before.applyGameAction({
        kind: "move",
        move,
        playerId,
        timestamp: Date.now(),
      });
      const lastMoves = computeLastMoves(nextState, playerColorsForBoard);
      updateGameState(nextState, { lastMoves });
    },
    [updateGameState, playerColorsForBoard],
  );

  const clearStagedActions = useCallback(() => {
    if (viewingHistory) return;
    clearAllActions();
    setActionError(null);
  }, [viewingHistory, clearAllActions]);

  const openRematchWindow = useCallback(
    (offerer?: PlayerId) => {
      rematchRequestIdRef.current += 1;
      const requestId = rematchRequestIdRef.current;
      setRematchState({
        status: "pending",
        responses: { 1: "pending", 2: "pending" },
        requestId,
        offerer,
      });
      addSystemMessage("Rematch offer opened. Waiting for responses...");
    },
    [addSystemMessage],
  );

  const respondToRematch = useCallback(
    (playerId: PlayerId, response: Exclude<RematchResponse, "pending">) => {
      setRematchState((prev) => {
        if (prev.status !== "pending") return prev;
        if (prev.responses[playerId] === response) return prev;
        const nextResponses = { ...prev.responses, [playerId]: response };
        if (response === "declined") {
          addSystemMessage(`${getPlayerName(playerId)} declined the rematch.`);
          return {
            ...prev,
            status: "declined",
            responses: nextResponses,
            decliner: playerId,
          };
        }

        addSystemMessage(`${getPlayerName(playerId)} accepted the rematch.`);
        const bothAccepted =
          nextResponses[1] === "accepted" && nextResponses[2] === "accepted";
        if (bothAccepted) {
          return {
            ...prev,
            status: "starting",
            responses: nextResponses,
          };
        }
        return {
          ...prev,
          responses: nextResponses,
        };
      });
    },
    [addSystemMessage, getPlayerName],
  );

  const handleAcceptRematch = useCallback(() => {
    if (!primaryLocalPlayerId) return;
    if (!canOfferRematch) return;
    if (isMultiplayerMatch) {
      const actionKind: ControllerActionKind = "respondRematch";
      const seatController = getSeatController(primaryLocalPlayerId);
      if (
        !seatController ||
        typeof seatController.respondToRematch !== "function"
      ) {
        setActionError(
          describeControllerError(actionKind, {
            kind: "ControllerUnavailable",
            action: actionKind,
          }),
        );
        return;
      }
      setActionError(null);
      void seatController
        .respondToRematch("accepted")
        .then((result) => {
          if (!result.ok) {
            setActionError(describeControllerError(actionKind, result.error));
            return;
          }
          setRematchState((prev) => {
            if (prev.status !== "pending") return prev;
            return {
              ...prev,
              status: "starting",
              responses: {
                ...prev.responses,
                [primaryLocalPlayerId]: "accepted",
              },
            };
          });
          addSystemMessage(
            `${getPlayerName(primaryLocalPlayerId)} accepted the rematch.`,
          );
        })
        .catch((error) => {
          console.error(error);
          setActionError(
            buildUnexpectedControllerErrorMessage(actionKind, error),
          );
        });
      return;
    }
    respondToRematch(primaryLocalPlayerId, "accepted");
  }, [
    addSystemMessage,
    canOfferRematch,
    getPlayerName,
    isMultiplayerMatch,
    primaryLocalPlayerId,
    respondToRematch,
    setActionError,
    getSeatController,
  ]);

  const handleDeclineRematch = useCallback(() => {
    if (!primaryLocalPlayerId) return;
    if (!canOfferRematch) return;
    if (isMultiplayerMatch) {
      const actionKind: ControllerActionKind = "respondRematch";
      const seatController = getSeatController(primaryLocalPlayerId);
      if (
        !seatController ||
        typeof seatController.respondToRematch !== "function"
      ) {
        setActionError(
          describeControllerError(actionKind, {
            kind: "ControllerUnavailable",
            action: actionKind,
          }),
        );
        return;
      }
      setActionError(null);
      void seatController
        .respondToRematch("declined")
        .then((result) => {
          if (!result.ok) {
            setActionError(describeControllerError(actionKind, result.error));
            return;
          }
          setRematchState((prev) => ({
            ...prev,
            status: "declined",
            decliner: primaryLocalPlayerId,
            responses: {
              ...prev.responses,
              [primaryLocalPlayerId]: "declined",
            },
          }));
          addSystemMessage(
            `${getPlayerName(primaryLocalPlayerId)} declined the rematch.`,
          );
        })
        .catch((error) => {
          console.error(error);
          setActionError(
            buildUnexpectedControllerErrorMessage(actionKind, error),
          );
        });
      return;
    }
    respondToRematch(primaryLocalPlayerId, "declined");
  }, [
    addSystemMessage,
    canOfferRematch,
    getPlayerName,
    isMultiplayerMatch,
    primaryLocalPlayerId,
    respondToRematch,
    setActionError,
    getSeatController,
  ]);

  const handleProposeRematch = useCallback(() => {
    if (!canOfferRematch) return;
    if (!isMultiplayerMatch) {
      openRematchWindow();
      return;
    }
    const actionKind: ControllerActionKind = "offerRematch";
    const seatController = getSeatController(primaryLocalPlayerId);
    if (!seatController || typeof seatController.offerRematch !== "function") {
      setActionError(
        describeControllerError(actionKind, {
          kind: "ControllerUnavailable",
          action: actionKind,
        }),
      );
      return;
    }
    if (!primaryLocalPlayerId) return;
    setActionError(null);
    void seatController
      .offerRematch()
      .then((result) => {
        if (!result.ok) {
          setActionError(describeControllerError(actionKind, result.error));
          return;
        }
        rematchRequestIdRef.current += 1;
        const requestId = rematchRequestIdRef.current;
        setRematchState({
          status: "pending",
          responses: {
            1: primaryLocalPlayerId === 1 ? "accepted" : "pending",
            2: primaryLocalPlayerId === 2 ? "accepted" : "pending",
          },
          requestId,
          offerer: primaryLocalPlayerId,
        });
        addSystemMessage("Rematch proposed. Waiting for opponent...");
      })
      .catch((error) => {
        console.error(error);
        setActionError(
          buildUnexpectedControllerErrorMessage(actionKind, error),
        );
      });
  }, [
    addSystemMessage,
    canOfferRematch,
    isMultiplayerMatch,
    openRematchWindow,
    primaryLocalPlayerId,
    setActionError,
    getSeatController,
  ]);

  const handleExitAfterMatch = useCallback(() => {
    if (rematchState.status === "pending" && primaryLocalPlayerId) {
      if (isMultiplayerMatch) {
        const seatController = getSeatController(primaryLocalPlayerId);
        if (
          seatController &&
          typeof seatController.respondToRematch === "function"
        ) {
          void seatController
            .respondToRematch("declined")
            .catch((error) => console.error(error));
        }
        setRematchState((prev) => ({
          ...prev,
          status: "declined",
          decliner: primaryLocalPlayerId,
          responses: {
            ...prev.responses,
            [primaryLocalPlayerId]: "declined",
          },
        }));
      } else {
        respondToRematch(primaryLocalPlayerId, "declined");
      }
    }
    void navigate({ to: "/" });
  }, [
    isMultiplayerMatch,
    primaryLocalPlayerId,
    rematchState.status,
    respondToRematch,
    getSeatController,
    navigate,
  ]);

  const navigateToLocalRematch = useCallback(() => {
    if (typeof window === "undefined") return;
    const nextGameId = generateLocalGameId();
    const stored = sessionStorage.getItem(`game-config-${gameId}`);
    let payload: StoredLocalGameConfig | null = null;
    if (stored) {
      try {
        payload = JSON.parse(stored) as StoredLocalGameConfig;
      } catch {
        payload = null;
      }
    }
    payload ??= {
      config: config ?? DEFAULT_CONFIG,
      players: playerTypes.length ? playerTypes : DEFAULT_PLAYERS,
    };
    payload.nextSeatOrder = [
      seatOrderIndicesRef.current[1] ?? 0,
      seatOrderIndicesRef.current[0] ?? 1,
    ];
    payload.matchScore = [...localMatchScore];
    payload.matchDraws = matchDraws;
    sessionStorage.setItem(
      `game-config-${nextGameId}`,
      JSON.stringify(payload),
    );
    rematchRequestIdRef.current += 1;
    setRematchState({
      status: "idle",
      responses: { 1: "pending", 2: "pending" },
      requestId: rematchRequestIdRef.current,
    });
    addSystemMessage("Starting the next game...");
    void navigate({ to: `/game/${nextGameId}` });
  }, [
    addSystemMessage,
    config,
    gameId,
    localMatchScore,
    matchDraws,
    navigate,
    playerTypes,
  ]);

  useEffect(() => {
    if (isReadOnlySession) {
      setHasLocalConfig(false);
      setLoadError(null);
      setIsLoadingConfig(false);
      return;
    }
    if (isResolvingAccess) {
      setHasLocalConfig(false);
      setLoadError(null);
      setIsLoadingConfig(true);
      return;
    }
    if (isMultiplayerMatch) {
      setHasLocalConfig(false);
      setLoadError(null);
      setIsLoadingConfig(false);
      return;
    }
    setIsLoadingConfig(true);
    setLoadError(null);

    let resolvedConfig = DEFAULT_CONFIG;
    let resolvedPlayers = DEFAULT_PLAYERS;

    let storedSeatOrder: [number, number] | null = null;
    let storedMatchScore: number[] | null = null;
    let storedMatchDraws: number | null = null;

    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem(`game-config-${gameId}`);
      if (stored) {
        setHasLocalConfig(true);
        try {
          const parsed = JSON.parse(stored) as StoredLocalGameConfig;
          resolvedConfig = normalizeFreestyleConfig({
            ...DEFAULT_CONFIG,
            ...(parsed?.config ?? {}),
          } as GameConfiguration);
          resolvedPlayers = Array.isArray(parsed?.players)
            ? parsed.players
            : DEFAULT_PLAYERS;
          if (
            Array.isArray(parsed?.nextSeatOrder) &&
            parsed.nextSeatOrder.length === 2 &&
            parsed.nextSeatOrder.every(
              (value) => typeof value === "number" && value >= 0,
            )
          ) {
            storedSeatOrder = [
              parsed.nextSeatOrder[0],
              parsed.nextSeatOrder[1],
            ];
          }
          if (Array.isArray(parsed?.matchScore)) {
            storedMatchScore = parsed.matchScore.map((value) =>
              typeof value === "number" ? value : 0,
            );
          }
          if (typeof parsed?.matchDraws === "number") {
            storedMatchDraws = parsed.matchDraws;
          }
        } catch {
          setHasLocalConfig(false);
          setLoadError("We couldn't read the saved game. Using defaults.");
        }
      } else {
        setHasLocalConfig(false);
        setLoadError("No saved game found. We'll start a local game.");
      }
    } else {
      setHasLocalConfig(false);
    }

    const participants = sanitizePlayerList(resolvedPlayers);
    setMatchParticipants(participants);
    const seededScores =
      storedMatchScore && storedMatchScore.length >= participants.length
        ? storedMatchScore.slice(0, participants.length)
        : null;
    setLocalMatchScore(seededScores ?? Array(participants.length).fill(0));
    setMatchDraws(storedMatchDraws ?? 0);
    rematchRequestIdRef.current = 0;
    lastScoredGameIdRef.current = 0;
    currentGameIdRef.current = 0;
    setGameInstanceId(0);

    // Randomly determine which participant becomes Player 1 (who starts first).
    // seatOrder[0] is the participant index for Player 1, seatOrder[1] for Player 2.
    // See game-types.ts for terminology: Player A/B (setup roles) vs Player 1/2 (game logic).
    const seatOrder =
      storedSeatOrder ?? (Math.random() < 0.5 ? [0, 1] : [1, 0]);
    seatOrderIndicesRef.current = seatOrder;
    const playersForGame = seatOrder.map(
      (participantIndex) => participants[participantIndex],
    );

    // Build variantConfig based on variant
    const variantConfig: GameInitialState = (() => {
      if (resolvedConfig.variant === "freestyle") {
        return generateFreestyleInitialState();
      }
      if (resolvedConfig.variant === "survival") {
        // The game setup UI would need survival-specific controls to let users
        // configure these settings.
        const survivalInput: SurvivalSetupInput = {
          boardWidth: resolvedConfig.boardWidth,
          boardHeight: resolvedConfig.boardHeight,
          turnsToSurvive: 10, // Default; should come from config
          mouseCanMove: true, // Default; should come from config
        };
        return buildSurvivalInitialState(survivalInput);
      }
      if (resolvedConfig.variant === "classic") {
        return buildClassicInitialState(
          resolvedConfig.boardWidth,
          resolvedConfig.boardHeight,
        );
      }
      // Standard variant
      return buildStandardInitialState(
        resolvedConfig.boardWidth,
        resolvedConfig.boardHeight,
      );
    })();

    const configWithVariant: GameConfiguration = {
      ...resolvedConfig,
      variantConfig,
    };

    initializeGame(configWithVariant, playersForGame, {
      forceYouFirst: false,
    });
    setIsLoadingConfig(false);

    return () => {
      Object.values(seatActionsRef.current).forEach((controller) =>
        controller?.cancel?.(new Error("Game closed")),
      );
      seatActionsRef.current = { 1: null, 2: null };
      pendingTurnRequestRef.current = null;
      gameStateRef.current = null;
      setActiveLocalPlayerId(null);
      // Meta game actions will be reset via useEffect in the hook when game finishes
      resetViewModel();
    };
  }, [
    gameId,
    initializeGame,
    isResolvingAccess,
    isMultiplayerMatch,
    isReadOnlySession,
    resetViewModel,
  ]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClockTick(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!gameState) return;
    if (stagedActions.length > 0 && gameState.turn !== activeLocalPlayerId) {
      setStagedActions([]);
    }
  }, [gameState, activeLocalPlayerId, stagedActions.length, setStagedActions]);

  useEffect(() => {
    latestStagedActionsRef.current = stagedActions;
  }, [stagedActions]);

  useEffect(() => {
    const prevCursor = previousHistoryCursorRef.current;
    if (prevCursor === historyCursor) return;
    const enteringHistory = prevCursor === null && historyCursor !== null;
    const exitingHistory = prevCursor !== null && historyCursor === null;

    if (enteringHistory) {
      const pendingSnapshot = cloneLocalActionQueue(
        latestStagedActionsRef.current,
      );
      stagedActionsSnapshotRef.current = pendingSnapshot.length
        ? pendingSnapshot
        : null;
      if (pendingSnapshot.length) {
        setStagedActions([]);
      }
      setSelectedPawnId(null);
      setDraggingPawnId(null);
    } else if (exitingHistory) {
      const snapshot = stagedActionsSnapshotRef.current;
      if (snapshot?.length) {
        setStagedActions(snapshot);
      }
      stagedActionsSnapshotRef.current = null;
    }

    if (historyCursor === null) {
      setHasNewMovesWhileRewound(false);
    }

    previousHistoryCursorRef.current = historyCursor;
  }, [historyCursor, setStagedActions, setSelectedPawnId, setDraggingPawnId]);

  useEffect(() => {
    if (!matchParticipants.length) return;
    if (gameState?.status !== "finished" || !gameState.result) return;
    if (isMultiplayerMatch || isReadOnlySession) return;
    const activeGameId = currentGameIdRef.current;
    if (lastScoredGameIdRef.current === activeGameId) return;
    lastScoredGameIdRef.current = activeGameId;

    const winnerId = gameState.result.winner;
    if (winnerId) {
      const participantIndex = seatOrderIndicesRef.current[winnerId - 1];
      if (participantIndex != null) {
        setLocalMatchScore((prev) => {
          const targetLength = prev.length || matchParticipants.length || 2;
          const next: number[] =
            prev.length === targetLength
              ? [...prev]
              : Array<number>(targetLength).fill(0);
          next[participantIndex] = (next[participantIndex] ?? 0) + 1;
          return next;
        });
      }
    } else {
      setLocalMatchScore((prev) => {
        const targetLength = prev.length || matchParticipants.length || 2;
        const next: number[] =
          prev.length === targetLength
            ? [...prev]
            : Array<number>(targetLength).fill(0);
        for (let i = 0; i < targetLength; i += 1) {
          next[i] = (next[i] ?? 0) + 0.5;
        }
        return next;
      });
      setMatchDraws((prev) => prev + 1);
    }

    openRematchWindow();
  }, [
    gameState,
    gameState?.result,
    gameState?.status,
    isMultiplayerMatch,
    isReadOnlySession,
    matchParticipants.length,
    openRematchWindow,
  ]);

  useEffect(() => {
    if (isMultiplayerMatch || isReadOnlySession) return;
    if (rematchState.status !== "pending") return;
    const timers: number[] = [];
    ([1, 2] as PlayerId[]).forEach((playerId) => {
      if (rematchState.responses[playerId] !== "pending") return;
      if (playerId === primaryLocalPlayerId) return;
      const controller = seatActionsRef.current[playerId];
      if (!controller) return;
      if (
        isLocalController(controller) &&
        autoAcceptingLocalIds.includes(playerId)
      ) {
        const timeoutId = window.setTimeout(
          () => respondToRematch(playerId, "accepted"),
          400,
        );
        timers.push(timeoutId);
      }
    });
    return () => {
      timers.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, [
    isMultiplayerMatch,
    isReadOnlySession,
    autoAcceptingLocalIds,
    primaryLocalPlayerId,
    rematchState,
    respondToRematch,
  ]);

  useEffect(() => {
    if (isMultiplayerMatch || isReadOnlySession) return;
    if (rematchState.status !== "starting") return;
    navigateToLocalRematch();
  }, [
    isMultiplayerMatch,
    isReadOnlySession,
    rematchState.status,
    navigateToLocalRematch,
  ]);

  const requestMoveForPlayer = useCallback(
    (playerId: PlayerId) => {
      if (interactionLocked) return;
      if (pendingTurnRequestRef.current === playerId) return;

      const currentState = gameStateRef.current;
      if (currentState?.status !== "playing") return;

      const controller = seatActionsRef.current[playerId];
      if (!controller || !isSupportedController(controller)) return;

      pendingTurnRequestRef.current = playerId;

      if (isLocalController(controller)) {
        setActiveLocalPlayerId(playerId);
      }

      controller
        .makeMove({
          state: currentState,
          playerId,
          opponentId: playerId === 1 ? 2 : 1,
        })
        .then((move) => {
          if (isMultiplayerMatch) {
            if (isRemoteController(controller)) {
              gameAwaitingServerRef.current = true;
              setActionError(null);
              return;
            }
            gameAwaitingServerRef.current = true;
            setActionError(null);
            return;
          }
          applyMove(playerId, move);
          setActionError(null);
        })
        .catch((error) => {
          if (error) {
            console.error(error);
            setActionError(
              error instanceof Error
                ? error.message
                : "Player failed to provide a move.",
            );
          }
        })
        .finally(() => {
          if (pendingTurnRequestRef.current === playerId) {
            pendingTurnRequestRef.current = null;
          }
          if (isLocalController(controller)) {
            setActiveLocalPlayerId((prev) => (prev === playerId ? null : prev));
          }
        });
    },
    [applyMove, interactionLocked, isMultiplayerMatch],
  );

  useEffect(() => {
    if (!gameState) return;
    if (gameState.status !== "playing") return;
    if (interactionLocked) return;
    if (isMultiplayerMatch && gameAwaitingServerRef.current) return;
    if (pendingTurnRequestRef.current === gameState.turn) return;
    requestMoveForPlayer(gameState.turn);
  }, [gameState, interactionLocked, isMultiplayerMatch, requestMoveForPlayer]);

  useEffect(() => {
    if (gameState?.status !== "finished" || !gameState.result) return;
    if (sfxEnabledRef.current) {
      play(sounds.gameEnd);
    }
    const result = gameState.result;
    if (result.winner) {
      const player =
        seatViewsRef.current.find((p) => p.playerId === result.winner) ?? null;
      addSystemMessage(
        player
          ? `${player.name} won by ${formatWinReason(result.reason)}.`
          : `Game finished by ${formatWinReason(result.reason)}.`,
      );
    } else {
      addSystemMessage(`Game drawn (${formatWinReason(result.reason)}).`);
    }
  }, [gameState, addSystemMessage, sfxEnabledRef]);

  // Clear annotations when turn changes (move is committed)
  const prevTurnRef = useRef(gameState?.turn);
  useEffect(() => {
    const currentTurn = gameState?.turn;
    if (
      prevTurnRef.current !== undefined &&
      currentTurn !== prevTurnRef.current &&
      annotations.length > 0
    ) {
      clearAnnotations();
    }
    prevTurnRef.current = currentTurn;
  }, [gameState?.turn, annotations.length, clearAnnotations]);

  const handleSendMessage = (event: React.FormEvent) => {
    event.preventDefault();
    if (!chatInput.trim()) return;

    const text = chatInput.trim();
    pendingChatTextRef.current = text;
    setIsSendingChat(true);

    // For spectators, send via spectator session (always audience channel)
    if (isSpectatorSession) {
      spectatorSessionRef.current?.sendChatMessage(text);
      return;
    }

    // For players, send via the player controller
    if (primaryLocalPlayerId) {
      const controller = seatActionsRef.current[primaryLocalPlayerId];
      if (controller?.kind === "remote-human") {
        (controller as RemotePlayerController).sendChatMessage(
          chatChannel,
          text,
        );
      }
    }
  };

  const handleAbort = useCallback(() => {
    const exitToHome = () => {
      void navigate({ to: "/game-setup" });
    };
    void (async () => {
      if (isRemoteFlow && isCreator && gameHandshake) {
        try {
          await abortGameSession({
            gameId,
            token: gameHandshake.token,
          });
        } catch (error) {
          console.error("[game-page] Failed to abort remote game", error);
        } finally {
          updateGameHandshake(null);
        }
      } else if (isMultiplayerMatch) {
        updateGameHandshake(null);
      }
      exitToHome();
    })();
  }, [
    gameHandshake,
    gameId,
    isCreator,
    isMultiplayerMatch,
    isRemoteFlow,
    navigate,
    updateGameHandshake,
  ]);

  const handleJoinerDismiss = useCallback(() => {
    void navigate({ to: "/game-setup" });
  }, [navigate]);

  const rows = config?.boardHeight ?? DEFAULT_CONFIG.boardHeight;
  const cols = config?.boardWidth ?? DEFAULT_CONFIG.boardWidth;

  const displayedTimeLeft = useMemo(() => {
    const base: Record<PlayerId, number> = {
      1: gameState?.timeLeft?.[1] ?? 0,
      2: gameState?.timeLeft?.[2] ?? 0,
    };
    const state = gameStateRef.current;
    if (
      state &&
      gameState &&
      state.status === "playing" &&
      gameState.status === "playing" &&
      state.turn === gameState.turn &&
      state.moveCount > 0
    ) {
      const elapsed = (Date.now() - state.lastMoveTime) / 1000;
      base[state.turn] = Math.max(0, base[state.turn] - elapsed);
    }
    return base;
    // clockTick is intentionally included to trigger clock updates every second
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, clockTick]);

  const goalDistances = useMemo(() => {
    const base: Record<PlayerId, number | null> = {
      1: null,
      2: null,
    };
    const sourceState =
      viewingHistory || !previewState
        ? (historyState ?? gameState)
        : previewState;
    if (!sourceState) {
      return base;
    }
    const goalFor = (playerId: PlayerId) => {
      const opponentId: PlayerId = playerId === 1 ? 2 : 1;
      return sourceState.grid.distance(
        sourceState.pawns[playerId].cat,
        sourceState.pawns[opponentId].mouse,
      );
    };
    return {
      1: goalFor(1),
      2: goalFor(2),
    };
  }, [gameState, historyState, previewState, viewingHistory]);

  const winnerPlayer =
    gameResult?.winner != null
      ? (players.find((p) => p.playerId === gameResult.winner) ?? null)
      : null;
  const winReason = formatWinReason(gameResult?.reason);

  const selectedPawn = selectedPawnId
    ? boardPawns.find((pawn) => pawn.id === selectedPawnId)
    : null;

  const boardActionablePlayerId = viewingHistory ? null : actionablePlayerId;
  const boardActiveLocalPlayerId = viewingHistory ? null : activeLocalPlayerId;
  const actionPanelPlayerId = primaryLocalPlayerId ?? null;
  const pendingDrawOffer = metaGameActions.pendingDrawOffer;
  const pendingTakebackRequest = metaGameActions.pendingTakebackRequest;
  const actionPanelAvailable =
    actionPanelPlayerId != null &&
    !interactionLocked &&
    gameState?.status === "playing";
  const pendingDrawForLocal =
    pendingDrawOffer?.status === "pending" &&
    actionPanelPlayerId != null &&
    pendingDrawOffer.actorSeatId === actionPanelPlayerId;
  const takebackPendingForLocal =
    pendingTakebackRequest?.status === "pending" &&
    actionPanelPlayerId != null &&
    pendingTakebackRequest.actorSeatId === actionPanelPlayerId;
  const takebackHistoryLength = gameState?.history.length ?? 0;
  const hasTakebackHistory =
    actionPanelPlayerId != null
      ? actionPanelPlayerId === 1
        ? takebackHistoryLength >= 1
        : takebackHistoryLength >= 2
      : false;
  const actionPanelLocked =
    Boolean(metaGameActions.resignFlowPlayerId) ||
    Boolean(metaGameActions.drawDecisionPrompt) ||
    Boolean(metaGameActions.takebackDecisionPrompt) ||
    Boolean(pendingDrawForLocal) ||
    Boolean(takebackPendingForLocal);
  const actionButtonsDisabled = !actionPanelAvailable || actionPanelLocked;
  const canCancelDrawOffer =
    pendingDrawForLocal && pendingDrawOffer?.channel === "local-state"
      ? Boolean(
          seatCapabilities?.canOfferDraw &&
          clockTick - (pendingDrawOffer.createdAt ?? 0) >= 2000,
        )
      : null;
  const canCancelTakebackRequest =
    takebackPendingForLocal && pendingTakebackRequest?.channel === "local-state"
      ? Boolean(
          seatCapabilities?.canRequestTakeback &&
          clockTick - (pendingTakebackRequest.createdAt ?? 0) >= 2000,
        )
      : null;
  const manualActionsDisabled = !controllerAllowsInteraction;
  const hasActionMessage = Boolean(actionError) || Boolean(selectedPawn);
  const actionStatusText =
    actionError ??
    (selectedPawn
      ? `Selected ${selectedPawn.type} (${cellToStandardNotation(selectedPawn.cell, rows)})`
      : null);

  const pendingActionsCount = canActNow
    ? stagedActions.length
    : premovedActions.length;
  const boardPendingActionsCount = viewingHistory ? 0 : pendingActionsCount;

  const bottomTimerPlayer =
    (primaryLocalPlayerId &&
      players.find((player) => player.playerId === primaryLocalPlayerId)) ??
    players[0] ??
    null;

  const topTimerPlayer =
    players.find((player) => player.playerId !== bottomTimerPlayer?.playerId) ??
    (players.length > 1 ? players[1] : null);

  const bottomTimerDisplayPlayer =
    bottomTimerPlayer?.type === "you"
      ? {
          ...bottomTimerPlayer,
          name: bottomTimerPlayer.name.includes("Also You")
            ? bottomTimerPlayer.name.replace("(Also You)", "(You)")
            : bottomTimerPlayer.name,
        }
      : bottomTimerPlayer;

  const snapshotMatchScore = matchSnapshot?.matchScore ?? null;

  const participantSeatInfos = useMemo(() => {
    const seats = players.map((player) => ({ player, used: false }));
    const claimSeat = (matcher: (player: GamePlayer) => boolean) => {
      const entry = seats.find((seat) => !seat.used && matcher(seat.player));
      if (entry) {
        entry.used = true;
        return entry.player;
      }
      return null;
    };
    const claimSeatForParticipant = (type: PlayerType) => {
      switch (type) {
        case "you": {
          if (primaryLocalPlayerId != null) {
            const localSeat = claimSeat(
              (seatPlayer) => seatPlayer.playerId === primaryLocalPlayerId,
            );
            if (localSeat) return localSeat;
          }
          return claimSeat((seatPlayer) => seatPlayer.type === "you");
        }
        case "friend":
        case "matched-user": {
          if (primaryLocalPlayerId != null) {
            const opponentSeat = claimSeat(
              (seatPlayer) => seatPlayer.playerId !== primaryLocalPlayerId,
            );
            if (opponentSeat) return opponentSeat;
          }
          const fallbackTypes: PlayerType[] =
            type === "matched-user"
              ? ["matched-user", "friend"]
              : ["friend", "matched-user"];
          for (const seatType of fallbackTypes) {
            const seat = claimSeat(
              (seatPlayer) => seatPlayer.type === seatType,
            );
            if (seat) return seat;
          }
          return null;
        }
        default:
          return claimSeat((seatPlayer) => seatPlayer.type === type);
      }
    };
    const appendSuffix = (name: string, suffix: string | null) => {
      if (!suffix) return name;
      const normalized = suffix.toLowerCase();
      return name.toLowerCase().includes(normalized)
        ? name
        : `${name} ${suffix}`;
    };
    let youSeen = 0;
    return matchParticipants.map((type, index) => {
      const seat = claimSeatForParticipant(type);
      let label: string;
      if (seat) {
        if (type === "you") {
          const suffix = youSeen === 0 ? "(You)" : "(Also You)";
          label = appendSuffix(seat.name, suffix);
          youSeen += 1;
        } else {
          label = seat.name;
        }
      } else {
        label = buildPlayerName(type, index, settings.displayName);
        if (type === "you") {
          youSeen += 1;
        }
      }
      return {
        label,
        playerId: seat?.playerId ?? null,
      };
    });
  }, [matchParticipants, players, primaryLocalPlayerId, settings.displayName]);

  const resolvedMatchScore = useMemo(() => {
    const fallbackScores = participantSeatInfos.map(
      (_, index) => localMatchScore[index] ?? 0,
    );
    if ((isMultiplayerMatch || isReadOnlySession) && snapshotMatchScore) {
      return participantSeatInfos.map((seat, index) => {
        if (seat.playerId == null) {
          return fallbackScores[index];
        }
        const remoteScore = snapshotMatchScore[seat.playerId];
        return typeof remoteScore === "number"
          ? remoteScore
          : fallbackScores[index];
      });
    }
    return fallbackScores;
  }, [
    participantSeatInfos,
    localMatchScore,
    isMultiplayerMatch,
    isReadOnlySession,
    snapshotMatchScore,
  ]);

  const scoreboardEntries = useMemo(() => {
    return participantSeatInfos.map((seat, index) => ({
      id: seat.playerId ?? `seat-${index}`,
      name: seat.label,
      score: resolvedMatchScore[index] ?? 0,
    }));
  }, [participantSeatInfos, resolvedMatchScore]);

  const scoreByPlayerId = useMemo<Record<PlayerId, number>>(() => {
    const map: Record<PlayerId, number> = { 1: 0, 2: 0 };
    participantSeatInfos.forEach((seat, index) => {
      if (seat.playerId != null) {
        map[seat.playerId] = resolvedMatchScore[index] ?? 0;
      }
    });
    return map;
  }, [participantSeatInfos, resolvedMatchScore]);

  const getPlayerMatchScore = (player: GamePlayer | null) => {
    if (!player) return null;
    return scoreByPlayerId[player.playerId] ?? 0;
  };

  const opponentPlayerId =
    primaryLocalPlayerId === 1
      ? (2 as PlayerId)
      : primaryLocalPlayerId === 2
        ? (1 as PlayerId)
        : null;
  const resolveSeatName = (playerId: PlayerId | null): string | null => {
    if (playerId == null) return null;
    const seat = players.find((player) => player.playerId === playerId);
    return seat?.name ?? getPlayerName(playerId);
  };

  const userRematchResponse =
    primaryLocalPlayerId != null
      ? rematchState.responses[primaryLocalPlayerId]
      : null;
  const opponentRematchResponse =
    opponentPlayerId != null ? rematchState.responses[opponentPlayerId] : null;
  const opponentName = resolveSeatName(opponentPlayerId) ?? "Opponent";
  const rematchStatusText = (() => {
    switch (rematchState.status) {
      case "pending":
        if (userRematchResponse === "pending") {
          return "Choose whether to rematch.";
        }
        if (opponentRematchResponse === "pending") {
          return `Waiting for ${opponentName} to respond...`;
        }
        return "Waiting for responses...";
      case "starting":
        return "Both players accepted. Setting up the next game...";
      case "declined": {
        const declinerName =
          resolveSeatName(rematchState.decliner ?? null) ?? opponentName;
        return `${declinerName} declined the rematch.`;
      }
      default:
        return "";
    }
  })();

  const spectatorPlayerSlots = useMemo(() => {
    if (!isReadOnlySession) return null;
    if (players.length >= 2) {
      return players.slice(0, 2);
    }
    return [
      {
        id: "p1",
        playerId: 1 as PlayerId,
        name: "Host",
        rating: 1500,
        color: DEFAULT_PLAYER_COLORS[1],
        type: "friend" as PlayerType,
        isOnline: true,
        catSkin: undefined,
        mouseSkin: undefined,
      },
      {
        id: "p2",
        playerId: 2 as PlayerId,
        name: "Joiner",
        rating: 1500,
        color: DEFAULT_PLAYER_COLORS[2],
        type: "friend" as PlayerType,
        isOnline: true,
        catSkin: undefined,
        mouseSkin: undefined,
      },
    ];
  }, [isReadOnlySession, players]);

  const matchingPlayersForView = spectatorPlayerSlots ?? matchingPanelPlayers;
  const matchingShareUrl = isReadOnlySession ? undefined : resolvedShareUrl;
  const matchingStatusForView = isReadOnlySession
    ? undefined
    : matchingStatusMessage;
  const waitingMessage = isAuthoritativeWaiting
    ? waitingAccessReason === "host-aborted"
      ? "The creator aborted this game."
      : "Waiting for another player to join before the match starts."
    : undefined;
  const matchingJoinAction =
    !isReadOnlySession && access?.kind === "waiting"
      ? {
          label:
            waitingAccessReason === "host-aborted"
              ? "Join Game"
              : isClaimingSeat
                ? "Joining…"
                : "Join Game",
          description:
            waitingAccessReason === "host-aborted"
              ? "The creator aborted this game."
              : waitingAccessReason === "seat-not-filled"
                ? "Seat is open. Join to start playing."
                : undefined,
          onClick: handleClaimSeat,
          disabled: isClaimingSeat || waitingAccessReason === "host-aborted",
        }
      : undefined;
  const matchingAbortEnabled = !isReadOnlySession && matchingCanAbort;
  const matchingIsOpen = !isReadOnlySession && matchingPanelOpen;

  const boardIsMultiplayer = isReadOnlySession ? true : isRemoteFlow;
  const boardShouldRender = isReadOnlySession || !isAuthoritativeWaiting;
  const boardIsLoading = isReadOnlySession
    ? spectatorStatus.isLoading
    : isLoadingConfig;
  const boardLoadError = isReadOnlySession ? spectatorStatus.error : loadError;
  const boardPrimaryPlayerId = isReadOnlySession ? null : primaryLocalPlayerId;
  const boardUserRematchResponse = isReadOnlySession
    ? null
    : userRematchResponse;
  const rematchHandlersEnabled =
    !isReadOnlySession && canOfferRematch && primaryLocalPlayerId != null;
  const rematchAcceptHandler = rematchHandlersEnabled
    ? handleAcceptRematch
    : NOOP;
  const rematchDeclineHandler = rematchHandlersEnabled
    ? handleDeclineRematch
    : NOOP;
  const rematchProposeHandler = rematchHandlersEnabled
    ? handleProposeRematch
    : NOOP;
  const rematchWindowHandler = rematchHandlersEnabled
    ? openRematchWindow
    : NOOP;

  const infoIsMultiplayerMatch = isReadOnlySession ? true : isRemoteFlow;

  const showShareInstructions = isCreator && resolvedMatchType === "friend";
  const matchingSection = {
    isOpen: matchingIsOpen,
    players: matchingPanelPlayers,
    spectatorPlayers: matchingPlayersForView,
    shareUrl: matchingShareUrl,
    statusMessage: matchingStatusForView,
    canAbort: matchingAbortEnabled,
    onAbort: matchingAbortEnabled ? handleAbort : NOOP,
    primaryAction: matchingJoinAction,
    matchType: isRemoteFlow ? resolvedMatchType : null,
    waitingMessage,
    isWaiting: isAuthoritativeWaiting,
    lifecycle: authoritativeLifecycle,
    accessKind,
    localRole,
    showShareInstructions,
    waitingReason: waitingAccessReason,
    onJoinerDismiss: handleJoinerDismiss,
  };

  const boardSection = {
    shouldRender: boardShouldRender,
    waitingMessage,
    isMultiplayerMatch: boardIsMultiplayer,
    accessKind,
    isReadOnly: isReadOnlySession,
    gameStatus,
    gameState: viewingHistory ? (historyState ?? gameState) : gameState,
    isLoadingConfig: boardIsLoading,
    loadError: boardLoadError,
    winnerPlayer,
    winReason,
    scoreboardEntries,
    rematchState,
    rematchStatusText,
    primaryLocalPlayerId: boardPrimaryPlayerId,
    userRematchResponse: boardUserRematchResponse,
    handleAcceptRematch: rematchAcceptHandler,
    handleDeclineRematch: rematchDeclineHandler,
    handleProposeRematch: rematchProposeHandler,
    openRematchWindow: rematchWindowHandler,
    spectatorRematchGameId,
    handleFollowSpectatorRematch: isSpectatorSession
      ? handleFollowSpectatorRematch
      : NOOP,
    handleExitAfterMatch,
    rows,
    cols,
    boardPawns,
    boardWalls,
    stagedArrows: boardArrows,
    playerColorsForBoard,
    interactionLocked,
    lastMove,
    draggingPawnId,
    selectedPawnId,
    disableMousePawnInteraction: mouseMoveLocked,
    actionablePlayerId: boardActionablePlayerId,
    onCellClick: handleCellClick,
    onWallClick: handleWallClick,
    onPawnClick: handlePawnClick,
    onPawnDragStart: handlePawnDragStart,
    onPawnDragEnd: handlePawnDragEnd,
    onCellDrop: handleCellDrop,
    stagedActions: viewingHistory ? [] : stagedActions,
    premovedActions: viewingHistory ? [] : premovedActions,
    pendingActionsCount: boardPendingActionsCount,
    activeLocalPlayerId: boardActiveLocalPlayerId,
    hasActionMessage,
    actionError,
    actionStatusText,
    clearStagedActions,
    commitStagedActions,
    // Annotation handlers and state (for board right-click interactions)
    annotations,
    previewAnnotation,
    arrowDragStateRef,
    onWallSlotRightClick,
    onCellRightClickDragStart,
    onCellRightClickDragMove,
    onCellRightClickDragEnd,
    onArrowDragFinalize,
  };

  const timerSection = {
    topPlayer: topTimerPlayer,
    bottomPlayer: bottomTimerDisplayPlayer,
    displayedTimeLeft,
    gameTurn,
    getPlayerMatchScore,
    goalDistances,
  };

  const actionsSection = {
    live: {
      drawDecisionPrompt: metaGameActions.drawDecisionPrompt,
      takebackDecisionPrompt: metaGameActions.takebackDecisionPrompt,
      getPlayerName,
      respondToDrawPrompt: respondToDrawPromptAction,
      respondToTakebackPrompt: respondToTakebackPromptAction,
      resignFlowPlayerId: metaGameActions.resignFlowPlayerId,
      pendingDrawForLocal,
      pendingDrawOffer: metaGameActions.pendingDrawOffer,
      takebackPendingForLocal,
      pendingTakebackRequest: metaGameActions.pendingTakebackRequest,
      outgoingTimeInfo: metaGameActions.outgoingTimeInfo,
      canCancelDrawOffer,
      canCancelTakebackRequest,
      incomingPassiveNotice: metaGameActions.incomingPassiveNotice,
      handleCancelResign: metaGameActions.handleCancelResign,
      handleConfirmResign: metaGameActions.handleConfirmResign,
      handleCancelDrawOffer: metaGameActions.handleCancelDrawOffer,
      handleCancelTakebackRequest: metaGameActions.handleCancelTakebackRequest,
      handleDismissOutgoingInfo: metaGameActions.handleDismissOutgoingInfo,
      handleDismissIncomingNotice: metaGameActions.handleDismissIncomingNotice,
      actionButtonsDisabled,
      manualActionsDisabled,
      hasTakebackHistory,
      handleStartResign: handleStartResignAction,
      handleOfferDraw: handleOfferDrawAction,
      handleRequestTakeback: handleRequestTakebackAction,
      handleGiveTime: handleGiveTimeAction,
    },
    endgame: {
      gameStatus,
      winnerPlayer,
      winReason,
      scoreboardEntries,
      rematchState,
      rematchStatusText,
      userRematchResponse: boardUserRematchResponse,
      handleAcceptRematch: rematchAcceptHandler,
      handleDeclineRematch: rematchDeclineHandler,
      handleProposeRematch: rematchProposeHandler,
      openRematchWindow: rematchWindowHandler,
      handleExitAfterMatch,
      isMultiplayerMatch: boardIsMultiplayer,
      primaryLocalPlayerId: boardPrimaryPlayerId,
      accessKind,
      isReadOnly: isReadOnlySession,
      spectatorRematchGameId,
      handleFollowSpectatorRematch:
        isSpectatorSession && spectatorRematchGameId
          ? handleFollowSpectatorRematch
          : undefined,
      canFollowSpectatorRematch:
        isSpectatorSession &&
        Boolean(spectatorRematchGameId && handleFollowSpectatorRematch),
    },
  };

  const chatSection = {
    activeTab,
    onTabChange: setActiveTab,
    formattedHistory,
    historyNav,
    hasNewMovesWhileRewound,
    historyTabHighlighted:
      activeTab === "chat" && hasNewMovesWhileRewound && historyCursor !== null,
    chatTabHighlighted,
    chatChannel,
    messages,
    chatInput,
    onChannelChange: setChatChannel,
    onInputChange: canUseChat ? setChatInput : NOOP,
    onSendMessage: canUseChat
      ? handleSendMessage
      : (event: React.FormEvent) => {
          event.preventDefault();
        },
    isSpectator: isSpectatorSession,
    isReplay: isReplaySession,
    isTeamVariant: false, // Currently all variants are 1v1
    isSending: isSendingChat,
    isOnlineGame: isMultiplayerMatch || isSpectatorSession,
  };
  const controller = {
    accessKind,
    isReadOnly: isReadOnlySession,
    isSpectator: isSpectatorSession,
    matching: matchingSection,
    board: boardSection,
    timers: timerSection,
    actions: actionsSection,
    chat: chatSection,
    info: {
      config,
      defaultVariant: DEFAULT_CONFIG.variant,
      defaultTimeControlPreset: DEFAULT_CONFIG.timeControl.preset,
      sfxEnabled,
      onSfxToggle: () => setSfxEnabled((prev) => !prev),
      musicEnabled,
      onMusicToggle: () => setMusicEnabled((prev) => !prev),
      interactionLocked,
      isMultiplayerMatch: infoIsMultiplayerMatch,
      unsupportedPlayers,
      placeholderCopy: PLACEHOLDER_COPY,
    },
  };

  return controller;
}
