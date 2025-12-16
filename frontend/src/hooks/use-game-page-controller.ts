import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type BoardProps,
  type Arrow,
  type BoardPawn,
} from "@/components/board";
import { type MatchingPlayer } from "@/components/matching-stage-panel";
import { type GameAction } from "../../../shared/domain/game-types";
import { GameState } from "../../../shared/domain/game-state";
import type {
  PlayerId,
  Cell,
  WallOrientation,
  WallPosition,
  Move,
  Action,
} from "../../../shared/domain/game-types";
import {
  moveToStandardNotation,
  cellToStandardNotation,
} from "../../../shared/domain/standard-notation";
import { pawnId } from "../../../shared/domain/game-utils";
import { type PlayerColor } from "@/lib/player-colors";
import type { GameConfiguration } from "../../../shared/domain/game-types";
import { userQueryOptions, fetchGameSession } from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";
import { useMetaGameActions } from "@/hooks/use-meta-game-actions";
import {
  createPlayerController,
  isAutomatedController,
  isLocalController,
  isSupportedController,
  type GamePlayerController,
} from "@/lib/player-controllers";
import { GameClient } from "@/lib/game-client";
import { useOnlineGameSession } from "@/hooks/use-online-game-session";
import {
  buildGameConfigurationFromSerialized,
  hydrateGameStateFromSerialized,
} from "@/lib/game-state-utils";
import { useSpectatorGameController } from "@/hooks/use-spectator-game-controller";
import type { GameSnapshot } from "../../../shared/domain/game-types";
import {
  type GameViewModel,
  type ServerUpdate,
  type PlayerType,
  DEFAULT_VIEW_MODEL,
  applyServerUpdate as applyServerUpdatePure,
  computeLastMoves,
  buildPlayerName,
  actionsEqual,
  buildDoubleStepPaths,
  formatWinReason,
  sanitizePlayerList,
  resolvePlayerColor,
} from "@/lib/gameViewModel";

export interface LocalPreferences {
  pawnColor: PlayerColor;
  catSkin: string | undefined;
  mouseSkin: string | undefined;
  displayName: string;
}

interface GamePlayer {
  id: string;
  playerId: PlayerId;
  name: string;
  rating: number;
  color: PlayerColor;
  type: PlayerType;
  isOnline: boolean;
  catSkin?: string;
  mouseSkin?: string;
}

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: Date;
  channel: "game" | "team" | "audience";
  isSystem?: boolean;
}

type RematchResponse = "pending" | "accepted" | "declined";

interface RematchState {
  status: "idle" | "pending" | "starting" | "declined";
  responses: Record<PlayerId, RematchResponse>;
  requestId: number;
  decliner?: PlayerId;
  offerer?: PlayerId;
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
};

const DEFAULT_PLAYERS: PlayerType[] = ["you", "easy-bot"];

const PLACEHOLDER_COPY: Partial<Record<PlayerType, string>> = {
  friend: "Inviting a friend requires the server backend. Coming soon.",
  "matched-user":
    "Live matchmaking isn't wired up yet. Try an AI opponent for now.",
  "medium-bot": "The medium AI is still training. The easy bot is available.",
  "hard-bot": "Hard AI support will arrive after the evaluation server ships.",
  "custom-bot":
    "Uploading your own bot needs an API token from the server (not yet available).",
};

const MAX_ACTIONS_PER_MOVE = 2;

const DEFAULT_PLAYER_COLORS: Record<PlayerId, PlayerColor> = {
  1: "red",
  2: "blue",
};

export function useGamePageController(gameId: string) {
  // Always initialize spectator controller; we may return it later.
  const spectatorController = useSpectatorGameController(gameId);

  // Early return for spectators - they use a simplified controller
  // Note: hooks must be called unconditionally, so we call both controllers
  // but only return the spectator one when appropriate

  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;
  const settings = useSettings(isLoggedIn, userPending);

  // ============================================================================
  // Local Preferences (derived from settings hook)
  // ============================================================================
  const localPreferences = useMemo<LocalPreferences>(
    () => ({
      pawnColor: resolvePlayerColor(settings.pawnColor),
      catSkin: settings.catPawn,
      mouseSkin: settings.mousePawn,
      displayName: settings.displayName,
    }),
    [
      settings.pawnColor,
      settings.catPawn,
      settings.mousePawn,
      settings.displayName,
    ],
  );

  // ============================================================================
  // View Model State - Single source of truth for server-controlled state
  // ============================================================================
  const [viewModel, setViewModel] = useState<GameViewModel>(DEFAULT_VIEW_MODEL);
  const viewModelRef = useRef<GameViewModel>(DEFAULT_VIEW_MODEL);

  // Keep ref in sync with state for use in callbacks
  useEffect(() => {
    viewModelRef.current = viewModel;
  }, [viewModel]);

  // ============================================================================
  // Connection & Session State
  // ============================================================================
  const gameClientRef = useRef<GameClient | null>(null);
  const gameInitializedRef = useRef(false);
  const gameAwaitingServerRef = useRef(false);
  const playersRef = useRef<GamePlayer[]>([]);

  const getPlayerName = useCallback(
    (playerId: PlayerId) =>
      playersRef.current.find((p) => p.playerId === playerId)?.name ??
      `Player ${playerId}`,
    [],
  );

  // ============================================================================
  // Single Entry Point for Server Updates
  // ============================================================================
  const playerColorsForBoardRef = useRef<Record<PlayerId, PlayerColor>>({
    1: DEFAULT_PLAYER_COLORS[1],
    2: DEFAULT_PLAYER_COLORS[2],
  });

  const applyServerUpdate = useCallback((update: ServerUpdate) => {
    setViewModel((prev) =>
      applyServerUpdatePure(prev, update, playerColorsForBoardRef.current),
    );
  }, []);

  const handleMatchSnapshotUpdate = useCallback(
    (snapshot: GameSnapshot) => {
      applyServerUpdate({ type: "match", snapshot });
    },
    [applyServerUpdate],
  );

  const maskToken = useCallback((value?: string | null) => {
    if (!value) return undefined;
    if (value.length <= 8) return value;
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }, []);

  const debugMatch = useCallback(
    (message: string, extra?: Record<string, unknown>) => {
      console.debug(`[friend-game] ${message}`, extra);
    },
    [],
  );

  const {
    gameHandshake,
    matchShareUrl,
    isMultiplayerMatch,
    isJoiningMatch,
    matchError,
    setMatchError,
    updateGameHandshake,
  } = useOnlineGameSession({
    gameId,
    localPreferences,
    onMatchSnapshotUpdate: handleMatchSnapshotUpdate,
    debugMatch,
  });

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

  const primaryLocalPlayerId = useMemo<PlayerId>(() => {
    const idx = playerTypes.findIndex((type) => type === "you");
    return ((idx === -1 ? 0 : idx) + 1) as PlayerId;
  }, [playerTypes]);

  const friendColorOverrides = useMemo(() => {
    if (!isMultiplayerMatch || !viewModel.match) return {};
    const map: Partial<Record<PlayerId, PlayerColor>> = {};
    viewModel.match.players.forEach((player) => {
      if (player.appearance?.pawnColor) {
        map[player.playerId] = resolvePlayerColor(player.appearance.pawnColor);
      }
    });
    return map;
  }, [viewModel.match, isMultiplayerMatch]);

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

    // Handle color collision: apply tinting if both players have the same color
    if (colors[1] === colors[2]) {
      const baseColor = colors[1];
      // Only apply tinting if it's a base color (not already a variant)
      if (!baseColor.endsWith("-dark") && !baseColor.endsWith("-light")) {
        colors[1] = `${baseColor}-dark` as PlayerColor;
        colors[2] = `${baseColor}-light` as PlayerColor;
      }
    }

    return colors;
  }, [friendColorOverrides, localPreferences.pawnColor, primaryLocalPlayerId]);

  // Keep ref in sync with computed value
  useEffect(() => {
    playerColorsForBoardRef.current = playerColorsForBoard;
  }, [playerColorsForBoard]);

  const playerControllersRef = useRef<
    Partial<Record<PlayerId, GamePlayerController>>
  >({});

  const initializeGame = useCallback(
    (
      incomingConfig: GameConfiguration,
      incomingPlayers: PlayerType[],
      options?: { forceYouFirst?: boolean },
    ) => {
      const nextGameId = currentGameIdRef.current + 1;
      currentGameIdRef.current = nextGameId;
      setGameInstanceId(nextGameId);
      const sanitizedPlayers = sanitizePlayerList(incomingPlayers, {
        forceYouFirst: options?.forceYouFirst ?? true,
      });
      const nextPrimaryLocalPlayerId = (() => {
        const idx = sanitizedPlayers.findIndex((type) => type === "you");
        return ((idx === -1 ? 0 : idx) + 1) as PlayerId;
      })();
      const state = new GameState(incomingConfig, Date.now());

      // Update view model with new game state
      applyServerUpdate({
        type: "game-state",
        config: incomingConfig,
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
      setActiveLocalPlayerId(null);
      setAutomatedPlayerId(null);
      pendingTurnRequestRef.current = null;

      Object.values(playerControllersRef.current).forEach((controller) =>
        controller.cancel?.(new Error("Game reset")),
      );
      const controllers: Partial<Record<PlayerId, GamePlayerController>> = {};
      sanitizedPlayers.forEach((type, index) => {
        const playerId = (index + 1) as PlayerId;
        controllers[playerId] = createPlayerController({
          playerId,
          playerType: type,
        });
      });
      playerControllersRef.current = controllers;

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
        }),
      );
      playersRef.current = initialPlayers;
      setBasePlayers(initialPlayers);

      const matchingList: MatchingPlayer[] = initialPlayers.map((player) => ({
        id: player.id,
        type: player.type,
        name: player.name,
        isReady: player.type === "you" || player.type.includes("bot"),
        isYou: player.type === "you",
      }));
      setMatchingPlayers(matchingList);
      const waiting = matchingList.some((entry) => !entry.isReady);

      addSystemMessage(
        waiting ? "Waiting for players..." : "Game created. Good luck!",
      );
      setRematchState((prev) => ({
        status: "idle",
        responses: { 1: "pending", 2: "pending" },
        requestId: prev.requestId,
        offerer: undefined,
        decliner: undefined,
      }));
    },
    [
      addSystemMessage,
      applyServerUpdate,
      localPreferences,
      playerControllersRef,
    ],
  );

  const updateGameState = useCallback(
    (
      nextState: GameState,
      options?: {
        lastMoves?: BoardProps["lastMove"] | BoardProps["lastMoves"] | null;
      },
    ) => {
      // Update view model with new game state
      setViewModel((prev) => {
        const shouldUpdateLastMoves =
          options && Object.prototype.hasOwnProperty.call(options, "lastMoves");

        return {
          ...prev,
          gameState: nextState,
          lastMoves: shouldUpdateLastMoves
            ? ((options.lastMoves as BoardProps["lastMoves"] | null) ?? null)
            : prev.lastMoves,
        };
      });
    },
    [],
  );

  useEffect(() => {
    if (!gameHandshake) return;
    debugMatch("Connecting GameClient", {
      id: gameId,
      playerId: gameHandshake.playerId,
      socketToken: maskToken(gameHandshake.socketToken),
    });
    const client = new GameClient({
      gameId,
      socketToken: gameHandshake.socketToken,
    });
    gameClientRef.current = client;
    client.connect({
      onState: (state) => {
        setMatchError(null);
        const config = buildGameConfigurationFromSerialized(state);
        const isInitial = !gameInitializedRef.current;
        if (isInitial) {
          const playerTypes: PlayerType[] =
            gameHandshake.playerId === 1
              ? ["you", "friend"]
              : ["friend", "you"];
          initializeGame(config, playerTypes, { forceYouFirst: false });
          setPlayerTypes(playerTypes);
          gameInitializedRef.current = true;
        }

        // Detect new game start to refresh match snapshot (roles may have swapped in rematch)
        if (
          state.moveCount === 0 &&
          isMultiplayerMatch &&
          gameHandshake &&
          gameInitializedRef.current
        ) {
          fetchGameSession({
            gameId,
            token: gameHandshake.token,
          })
            .then((details) => {
              applyServerUpdate({
                type: "match",
                snapshot: details.snapshot,
              });
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
        // Use the single entry point for server updates
        applyServerUpdate({
          type: "game-state",
          config,
          gameState: resolvedState,
          isInitial,
        });
        gameAwaitingServerRef.current = false;
        if (gameHandshake.playerId === resolvedState.turn) {
          setActiveLocalPlayerId(gameHandshake.playerId);
        } else {
          setActiveLocalPlayerId(null);
        }
      },
      onMatchStatus: (snapshot) => {
        applyServerUpdate({ type: "match", snapshot });
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
      onError: (message) => {
        setMatchError(message);
      },
    });
    return () => {
      client.close();
      if (gameClientRef.current === client) {
        gameClientRef.current = null;
      }
      gameInitializedRef.current = false;
      gameAwaitingServerRef.current = false;
    };
  }, [
    addSystemMessage,
    applyServerUpdate,
    debugMatch,
    gameHandshake,
    gameId,
    getPlayerName,
    initializeGame,
    isMultiplayerMatch,
    maskToken,
    setMatchError,
  ]);

  // ============================================================================
  // Derived Values from View Model
  // ============================================================================
  const config = viewModel.config;
  const gameState = viewModel.gameState;
  const matchSnapshot = viewModel.match;
  // Convert null to undefined for Board component compatibility
  const lastMove = viewModel.lastMoves ?? undefined;

  // Refs for synchronous access in callbacks
  const gameStateRef = useRef<GameState | null>(null);
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  const [basePlayers, setBasePlayers] = useState<GamePlayer[]>([]);

  // Derive players with:
  // 1. Local preferences (for the local player)
  // 2. Remote appearances from matchSnapshot (for multiplayer opponents)
  const players = useMemo((): GamePlayer[] => {
    if (!basePlayers.length) return basePlayers;

    return basePlayers.map((player) => {
      const isLocal = player.playerId === primaryLocalPlayerId;

      // For multiplayer, get remote player info from matchSnapshot
      const remote =
        isMultiplayerMatch && viewModel.match
          ? viewModel.match.players.find(
              (entry) => entry.playerId === player.playerId,
            )
          : null;

      // Use the calculated board color which includes tinting logic
      const resolvedColor =
        playerColorsForBoard[player.playerId] ?? player.color;

      if (isLocal) {
        // Local player: apply local preferences
        return {
          ...player,
          name: remote?.displayName ?? player.name,
          isOnline: remote?.connected ?? player.isOnline,
          color: resolvedColor,
          catSkin: localPreferences.catSkin,
          mouseSkin: localPreferences.mouseSkin,
        };
      } else if (remote) {
        // Remote player in multiplayer: apply their appearance
        const appearance = remote.appearance;
        return {
          ...player,
          name: remote.displayName ?? player.name,
          isOnline: remote.connected,
          color: resolvedColor,
          catSkin: appearance?.catSkin ?? player.catSkin,
          mouseSkin: appearance?.mouseSkin ?? player.mouseSkin,
        };
      }

      // Non-multiplayer opponent (bot): use base player info with resolved color
      return {
        ...player,
        color: resolvedColor,
      };
    });
  }, [
    basePlayers,
    isMultiplayerMatch,
    viewModel.match,
    primaryLocalPlayerId,
    localPreferences,
    playerColorsForBoard,
  ]);

  // Keep playersRef in sync with the derived players
  useEffect(() => {
    playersRef.current = players;
  }, [players]);
  const [matchingPlayers, setMatchingPlayers] = useState<MatchingPlayer[]>([]);
  const [activeTab, setActiveTab] = useState<"chat" | "history">("history");
  const [chatChannel, setChatChannel] = useState<"game" | "team" | "audience">(
    "game",
  );
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [selectedPawnId, setSelectedPawnId] = useState<string | null>(null);
  const [draggingPawnId, setDraggingPawnId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeLocalPlayerId, setActiveLocalPlayerId] =
    useState<PlayerId | null>(null);
  const [automatedPlayerId, setAutomatedPlayerId] = useState<PlayerId | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [stagedActions, setStagedActions] = useState<Action[]>([]);
  const [matchParticipants, setMatchParticipants] = useState<PlayerType[]>([]);
  const [matchScore, setMatchScore] = useState<number[]>([]);
  const [, setMatchDraws] = useState(0);
  const [rematchState, setRematchState] = useState<RematchState>({
    status: "idle",
    responses: { 1: "pending", 2: "pending" },
    requestId: 0,
  });
  const defaultShareUrl =
    typeof window !== "undefined" ? window.location.href : undefined;
  const resolvedShareUrl = isMultiplayerMatch
    ? (matchShareUrl ?? defaultShareUrl)
    : defaultShareUrl;
  const matchingPanelPlayers: MatchingPlayer[] = useMemo(() => {
    if (isMultiplayerMatch && matchSnapshot && gameHandshake) {
      // Determine the opponent type based on matchType
      const opponentType =
        gameHandshake.matchType === "matchmaking" ? "matched-user" : "friend";
      return matchSnapshot.players.map((player) => ({
        id: `player-${player.playerId}`,
        type: player.playerId === gameHandshake.playerId ? "you" : opponentType,
        name: player.displayName,
        isReady: player.ready,
        isYou: player.playerId === gameHandshake.playerId,
        isConnected: player.connected,
      }));
    }
    return matchingPlayers;
  }, [isMultiplayerMatch, matchSnapshot, gameHandshake, matchingPlayers]);
  const matchingPanelOpen = isMultiplayerMatch
    ? matchSnapshot?.status === "waiting"
    : matchingPlayers.some((entry) => !entry.isReady);
  const matchingCanAbort =
    !isMultiplayerMatch || !matchSnapshot || matchSnapshot.status === "waiting";
  const matchingStatusMessage = useMemo(() => {
    if (!isMultiplayerMatch) return undefined;
    if (matchError) return matchError;
    if (isJoiningMatch) return "Joining friend game...";
    switch (matchSnapshot?.status) {
      case "waiting":
        return "Waiting for players...";
      case "ready":
        return "Both players almost ready...";
      case "completed":
        return "Game finished.";
      default:
        return undefined;
    }
  }, [isMultiplayerMatch, matchError, isJoiningMatch, matchSnapshot?.status]);

  const pendingTurnRequestRef = useRef<PlayerId | null>(null);
  const seatOrderIndicesRef = useRef<[number, number]>([0, 1]);
  const [gameInstanceId, setGameInstanceId] = useState(0);
  const currentGameIdRef = useRef(0);
  const lastScoredGameIdRef = useRef(0);
  const rematchRequestIdRef = useRef(0);

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
    () => playerTypes.filter((type) => type !== "you" && type !== "easy-bot"),
    [playerTypes],
  );
  const matchReadyForPlay =
    isMultiplayerMatch &&
    Boolean(gameHandshake) &&
    (matchSnapshot?.status === "in-progress" ||
      matchSnapshot?.status === "ready");
  const interactionLocked =
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
    isMultiplayerMatch,
    matchReadyForPlay,
    clockTick,
    playerControllersRef,
    gameClientRef,
    performGameAction: performGameActionImpl,
    updateGameState,
    computeLastMoves,
    playerColorsForBoard,
    addSystemMessage,
    getPlayerName,
    setActionError,
    resolvePrimaryActionPlayerId,
    clearStaging: () => {
      setStagedActions([]);
      setSelectedPawnId(null);
      setDraggingPawnId(null);
    },
  });

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
    (actions: Action[]): GameState | null => {
      if (!gameState) return null;
      if (actions.length === 0) {
        return gameState;
      }
      try {
        return gameState.applyGameAction({
          kind: "move",
          move: { actions },
          playerId: gameState.turn,
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error("Failed to simulate staged actions", error);
        return null;
      }
    },
    [gameState],
  );

  const previewState = useMemo(
    () => (stagedActions.length ? simulateMove(stagedActions) : null),
    [stagedActions, simulateMove],
  );

  const stagedWallOverlays = useMemo<WallPosition[]>(() => {
    if (!stagedActions.length) return [];
    return stagedActions
      .filter((action) => action.type === "wall")
      .map((action) => ({
        cell: action.target,
        orientation: action.wallOrientation!,
        playerId: gameState?.turn ?? primaryLocalPlayerId,
      }));
  }, [stagedActions, gameState, primaryLocalPlayerId]);

  type WallPositionWithState = WallPosition & {
    state?: "placed" | "staged" | "premoved" | "calculated" | "missing";
  };

  const boardWalls = useMemo<WallPositionWithState[]>(() => {
    const base = gameState
      ? gameState.grid
          .getWalls()
          .map((wall) => ({ ...wall, state: "placed" as const }))
      : [];
    const staged = stagedWallOverlays.map((wall) => ({
      ...wall,
      state: "staged" as const,
    }));
    return [...base, ...staged];
  }, [gameState, stagedWallOverlays]);

  const boardPawns = useMemo((): BoardPawn[] => {
    const sourceState = previewState ?? gameState;
    if (!sourceState) return [];
    const basePawns = sourceState.getPawns().map((pawn) => {
      const player = players.find((p) => p.playerId === pawn.playerId);

      let pawnStyle: string | undefined;
      if (
        pawn.type === "cat" &&
        player?.catSkin &&
        player.catSkin !== "default"
      ) {
        pawnStyle = player.catSkin;
      } else if (
        pawn.type === "mouse" &&
        player?.mouseSkin &&
        player.mouseSkin !== "default"
      ) {
        pawnStyle = player.mouseSkin;
      }

      return pawnStyle ? { ...pawn, pawnStyle } : pawn;
    });
    // Convert to BoardPawn[] with IDs and preview states
    const pawnsWithIds: BoardPawn[] = basePawns.map((pawn) => ({
      ...pawn,
      id: pawnId(pawn),
    }));
    if (!stagedActions.length) {
      return pawnsWithIds;
    }
    const stagedPawnTypes = new Set(
      stagedActions
        .filter((action) => action.type === "cat" || action.type === "mouse")
        .map((action) => action.type),
    );
    const stagingPlayerId = gameState?.turn ?? activeLocalPlayerId;
    return pawnsWithIds.map((pawn) => {
      if (
        stagingPlayerId &&
        pawn.playerId === stagingPlayerId &&
        stagedPawnTypes.has(pawn.type)
      ) {
        return { ...pawn, previewState: "staged" as const };
      }
      return pawn;
    });
  }, [previewState, gameState, stagedActions, activeLocalPlayerId, players]);

  const stagedArrows = useMemo<Arrow[]>(() => {
    if (!gameState || stagedActions.length === 0) return [];

    // Check for double move with same pawn
    if (stagedActions.length === 2) {
      const [action1, action2] = stagedActions;
      const isMove1 = action1.type === "cat" || action1.type === "mouse";
      const isMove2 = action2.type === "cat" || action2.type === "mouse";

      if (isMove1 && isMove2 && action1.type === action2.type) {
        // It's a double move with the same pawn.
        // We want one arrow from start to end.
        const beforeState = gameState;
        const afterState = simulateMove(stagedActions);

        const actorId = gameState?.turn ?? primaryLocalPlayerId;
        if (beforeState && afterState && actorId) {
          const pawnType = action1.type;
          const fromCell =
            pawnType === "cat"
              ? beforeState.pawns[actorId].cat
              : beforeState.pawns[actorId].mouse;
          const toCell =
            pawnType === "cat"
              ? afterState.pawns[actorId].cat
              : afterState.pawns[actorId].mouse;

          return [
            {
              from: [fromCell[0], fromCell[1]],
              to: [toCell[0], toCell[1]],
              type: "staged",
            },
          ];
        }
      }
    }

    const arrows: Arrow[] = [];
    stagedActions.forEach((action, index) => {
      if (action.type === "wall") return;
      const beforeActions = stagedActions.slice(0, index);
      const afterActions = stagedActions.slice(0, index + 1);
      const beforeState =
        beforeActions.length === 0 ? gameState : simulateMove(beforeActions);
      const afterState = simulateMove(afterActions);
      const actorId = gameState?.turn ?? primaryLocalPlayerId;
      if (!beforeState || !afterState || !actorId) return;
      const fromCell =
        action.type === "cat"
          ? beforeState.pawns[actorId].cat
          : beforeState.pawns[actorId].mouse;
      const toCell =
        action.type === "cat"
          ? afterState.pawns[actorId].cat
          : afterState.pawns[actorId].mouse;
      arrows.push({
        from: [fromCell[0], fromCell[1]],
        to: [toCell[0], toCell[1]],
        type: "staged",
      });
    });
    return arrows;
  }, [gameState, stagedActions, primaryLocalPlayerId, simulateMove]);

  const gameStatus = gameState?.status ?? "playing";
  const gameTurn = gameState?.turn ?? 1;
  const gameResult = gameState?.result;

  const formattedHistory = useMemo(() => {
    if (!gameState) return [];
    const rows = gameState.config.boardHeight;
    const entries = gameState.history.map((entry) => ({
      number: Math.ceil(entry.index / 2),
      notation: moveToStandardNotation(entry.move, rows),
    }));
    const paired: {
      num: number;
      white?: string;
      black?: string;
    }[] = [];
    for (let i = 0; i < entries.length; i += 2) {
      paired.push({
        num: entries[i].number,
        white: entries[i]?.notation,
        black: entries[i + 1]?.notation,
      });
    }
    return paired;
  }, [gameState]);

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
      const lastMoves = computeLastMoves(
        before,
        nextState,
        playerColorsForBoard,
      );
      updateGameState(nextState, { lastMoves });
      if (soundEnabled) {
        playSound();
      }
    },
    [soundEnabled, updateGameState, playerColorsForBoard],
  );

  const commitStagedActions = useCallback(
    (actions?: Action[]) => {
      const moveActions = actions ?? stagedActions;
      if (
        isMultiplayerMatch &&
        (!matchReadyForPlay || !gameClientRef.current)
      ) {
        setActionError("Waiting for connection to stabilize.");
        return;
      }

      const currentState = gameStateRef.current;
      if (!currentState) {
        setActionError("Game is still loading");
        return;
      }

      const currentTurn = currentState.turn;
      const controller = playerControllersRef.current[currentTurn];
      if (!controller || !isLocalController(controller)) {
        setActionError("This player can't submit moves manually right now.");
        return;
      }

      try {
        controller.submitMove({ actions: moveActions });
        setStagedActions([]);
        setSelectedPawnId(null);
        setDraggingPawnId(null);
        setActionError(null);
      } catch (error) {
        console.error(error);
        setActionError(
          error instanceof Error ? error.message : "Move could not be applied.",
        );
      }
    },
    [
      matchReadyForPlay,
      isMultiplayerMatch,
      stagedActions,
      setDraggingPawnId,
      setSelectedPawnId,
    ],
  );

  const clearStagedActions = useCallback(() => {
    setStagedActions([]);
    setActionError(null);
    setSelectedPawnId(null);
  }, []);

  const removeStagedAction = useCallback((index: number) => {
    setStagedActions((prev) => prev.filter((_, idx) => idx !== index));
    setActionError(null);
    setSelectedPawnId(null);
  }, []);

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
    if (isMultiplayerMatch) {
      if (!gameClientRef.current) {
        setActionError("Connection unavailable.");
        return;
      }
      gameClientRef.current.sendRematchAccept();
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
      return;
    }
    respondToRematch(primaryLocalPlayerId, "accepted");
  }, [
    addSystemMessage,
    getPlayerName,
    isMultiplayerMatch,
    primaryLocalPlayerId,
    respondToRematch,
    setActionError,
  ]);

  const handleDeclineRematch = useCallback(() => {
    if (!primaryLocalPlayerId) return;
    if (isMultiplayerMatch) {
      if (!gameClientRef.current) {
        setActionError("Connection unavailable.");
        return;
      }
      gameClientRef.current.sendRematchReject();
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
      return;
    }
    respondToRematch(primaryLocalPlayerId, "declined");
  }, [
    addSystemMessage,
    getPlayerName,
    isMultiplayerMatch,
    primaryLocalPlayerId,
    respondToRematch,
    setActionError,
  ]);

  const handleProposeRematch = useCallback(() => {
    if (!isMultiplayerMatch) {
      openRematchWindow();
      return;
    }
    if (!gameClientRef.current) {
      setActionError("Connection unavailable.");
      return;
    }
    if (!primaryLocalPlayerId) return;
    gameClientRef.current.sendRematchOffer();
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
  }, [
    addSystemMessage,
    isMultiplayerMatch,
    openRematchWindow,
    primaryLocalPlayerId,
    setActionError,
  ]);

  const handleExitAfterMatch = useCallback(() => {
    if (rematchState.status === "pending" && primaryLocalPlayerId) {
      if (isMultiplayerMatch) {
        if (gameClientRef.current) {
          gameClientRef.current.sendRematchReject();
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
    window.history.back();
  }, [
    isMultiplayerMatch,
    primaryLocalPlayerId,
    rematchState.status,
    respondToRematch,
  ]);

  const startRematch = useCallback(() => {
    if (matchParticipants.length < 2) return;
    const nextSeatOrder: [number, number] = [
      seatOrderIndicesRef.current[1],
      seatOrderIndicesRef.current[0],
    ];
    seatOrderIndicesRef.current = nextSeatOrder;
    const playersForGame = nextSeatOrder.map(
      (participantIndex) => matchParticipants[participantIndex],
    );
    const nextConfig = config ?? DEFAULT_CONFIG;
    initializeGame(nextConfig, playersForGame, { forceYouFirst: false });
  }, [config, initializeGame, matchParticipants]);

  useEffect(() => {
    if (isMultiplayerMatch) {
      setLoadError(null);
      setIsLoadingConfig(false);
      return;
    }
    setIsLoadingConfig(true);
    setLoadError(null);

    let resolvedConfig = DEFAULT_CONFIG;
    let resolvedPlayers = DEFAULT_PLAYERS;

    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem(`game-config-${gameId}`);
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as {
            config?: Partial<GameConfiguration>;
            players?: PlayerType[];
          };
          resolvedConfig = {
            ...DEFAULT_CONFIG,
            ...(parsed?.config ?? {}),
          };
          resolvedPlayers = Array.isArray(parsed?.players)
            ? parsed.players
            : DEFAULT_PLAYERS;
        } catch {
          setLoadError("We couldn't read the saved game. Using defaults.");
        }
      } else {
        setLoadError("No saved game found. We'll start a new easy bot game.");
      }
    }

    const participants = sanitizePlayerList(resolvedPlayers);
    setMatchParticipants(participants);
    setMatchScore(Array(participants.length).fill(0));
    setMatchDraws(0);
    rematchRequestIdRef.current = 0;
    lastScoredGameIdRef.current = 0;
    currentGameIdRef.current = 0;
    setGameInstanceId(0);

    // Randomly determine which participant becomes Player 1 (who starts first).
    // seatOrder[0] is the participant index for Player 1, seatOrder[1] for Player 2.
    // See game-types.ts for terminology: Player A/B (setup roles) vs Player 1/2 (game logic).
    const seatOrder = (Math.random() < 0.5 ? [0, 1] : [1, 0]) as [
      number,
      number,
    ];
    seatOrderIndicesRef.current = seatOrder;
    const playersForGame = seatOrder.map(
      (participantIndex) => participants[participantIndex],
    );

    initializeGame(resolvedConfig, playersForGame, { forceYouFirst: false });
    setIsLoadingConfig(false);

    return () => {
      Object.values(playerControllersRef.current).forEach((controller) =>
        controller.cancel?.(new Error("Game closed")),
      );
      playerControllersRef.current = {};
      pendingTurnRequestRef.current = null;
      gameStateRef.current = null;
      setActiveLocalPlayerId(null);
      setAutomatedPlayerId(null);
      // Meta game actions will be reset via useEffect in the hook when game finishes
      setViewModel(DEFAULT_VIEW_MODEL);
    };
  }, [gameId, initializeGame, isMultiplayerMatch]);

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
  }, [gameState, activeLocalPlayerId, stagedActions.length]);

  useEffect(() => {
    if (!matchParticipants.length) return;
    if (gameState?.status !== "finished" || !gameState.result) return;
    if (isMultiplayerMatch) return;
    const activeGameId = currentGameIdRef.current;
    if (lastScoredGameIdRef.current === activeGameId) return;
    lastScoredGameIdRef.current = activeGameId;

    const winnerId = gameState.result.winner;
    if (winnerId) {
      const participantIndex = seatOrderIndicesRef.current[winnerId - 1];
      if (participantIndex != null) {
        setMatchScore((prev) => {
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
      setMatchDraws((prev) => prev + 1);
    }

    openRematchWindow();
  }, [
    gameState?.result,
    gameState?.status,
    isMultiplayerMatch,
    matchParticipants.length,
    openRematchWindow,
  ]);

  useEffect(() => {
    if (isMultiplayerMatch) return;
    if (rematchState.status !== "pending") return;
    const timers: number[] = [];
    ([1, 2] as PlayerId[]).forEach((playerId) => {
      if (rematchState.responses[playerId] !== "pending") return;
      if (playerId === primaryLocalPlayerId) return;
      const controller = playerControllersRef.current[playerId];
      if (!controller) return;
      if (isAutomatedController(controller)) {
        const timeoutId = window.setTimeout(
          () => respondToRematch(playerId, "accepted"),
          800,
        );
        timers.push(timeoutId);
      } else if (
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
    autoAcceptingLocalIds,
    primaryLocalPlayerId,
    rematchState,
    respondToRematch,
  ]);

  useEffect(() => {
    if (isMultiplayerMatch) return;
    if (rematchState.status !== "starting") return;
    startRematch();
  }, [isMultiplayerMatch, rematchState.status, startRematch]);

  const stagePawnAction = useCallback(
    (pawnId: string, targetRow: number, targetCol: number) => {
      if (interactionLocked) return;
      if (gameState?.status !== "playing") return;
      if (!activeLocalPlayerId) return;
      if (gameState.turn !== activeLocalPlayerId) return;

      const pawn = boardPawns.find((p) => p.id === pawnId);
      if (pawn?.playerId !== activeLocalPlayerId) return;
      const pawnType = pawn.type;
      const targetCell: Cell = [targetRow, targetCol];
      const newAction: Action = { type: pawnType, target: targetCell };
      const duplicateIndex = stagedActions.findIndex((existing) =>
        actionsEqual(existing, newAction),
      );
      if (duplicateIndex !== -1) {
        removeStagedAction(duplicateIndex);
        setSelectedPawnId(null);
        setDraggingPawnId(null);
        return;
      }

      if (pawn.cell[0] === targetRow && pawn.cell[1] === targetCol) return;

      const distance =
        Math.abs(pawn.cell[0] - targetRow) + Math.abs(pawn.cell[1] - targetCol);
      const isDoubleStep = distance === 2;
      if (isDoubleStep) {
        if (stagedActions.length > 0) {
          setActionError(
            "You can't make a double move after staging another action.",
          );
          return;
        }
        const candidatePaths = buildDoubleStepPaths(
          pawnType,
          pawn.cell,
          targetCell,
        );
        const validPath = candidatePaths.find((path) => !!simulateMove(path));
        if (!validPath) {
          setActionError("That double move isn't legal.");
          return;
        }
        commitStagedActions(validPath);
        return;
      }

      if (stagedActions.length >= MAX_ACTIONS_PER_MOVE) {
        setActionError("You have already staged two actions.");
        return;
      }

      const nextActions = [...stagedActions, newAction];
      const simulated = simulateMove(nextActions);
      if (!simulated) {
        setActionError("Illegal move.");
        return;
      }

      if (nextActions.length === MAX_ACTIONS_PER_MOVE) {
        commitStagedActions(nextActions);
      } else {
        setStagedActions(nextActions);
        setActionError(null);
      }
      setSelectedPawnId(null);
      setDraggingPawnId(null);
    },
    [
      interactionLocked,
      gameState,
      stagedActions,
      boardPawns,
      simulateMove,
      commitStagedActions,
      removeStagedAction,
      activeLocalPlayerId,
    ],
  );

  const handleWallClick = useCallback(
    (row: number, col: number, orientation: WallOrientation) => {
      if (interactionLocked) return;
      if (gameState?.status !== "playing") return;
      if (!activeLocalPlayerId) return;
      if (gameState.turn !== activeLocalPlayerId) return;

      const newAction: Action = {
        type: "wall",
        target: [row, col],
        wallOrientation: orientation,
      };
      const duplicateIndex = stagedActions.findIndex((existing) =>
        actionsEqual(existing, newAction),
      );
      if (duplicateIndex !== -1) {
        removeStagedAction(duplicateIndex);
        return;
      }

      if (stagedActions.length >= MAX_ACTIONS_PER_MOVE) {
        setActionError("You have already staged two actions.");
        return;
      }

      const nextActions = [...stagedActions, newAction];
      const simulated = simulateMove(nextActions);
      if (!simulated) {
        setActionError("Illegal wall placement.");
        return;
      }

      if (nextActions.length === MAX_ACTIONS_PER_MOVE) {
        commitStagedActions(nextActions);
      } else {
        setStagedActions(nextActions);
        setActionError(null);
      }
    },
    [
      interactionLocked,
      gameState,
      activeLocalPlayerId,
      stagedActions,
      simulateMove,
      commitStagedActions,
      removeStagedAction,
    ],
  );

  const requestMoveForPlayer = useCallback(
    (playerId: PlayerId) => {
      if (interactionLocked) return;
      if (pendingTurnRequestRef.current === playerId) return;

      const currentState = gameStateRef.current;
      if (currentState?.status !== "playing") return;

      const controller = playerControllersRef.current[playerId];
      if (!controller || !isSupportedController(controller)) return;

      pendingTurnRequestRef.current = playerId;

      if (isLocalController(controller)) {
        setActiveLocalPlayerId(playerId);
      } else if (isAutomatedController(controller)) {
        setAutomatedPlayerId(playerId);
      }

      controller
        .makeMove({
          state: currentState,
          playerId,
          opponentId: playerId === 1 ? 2 : 1,
        })
        .then((move) => {
          if (
            isMultiplayerMatch &&
            (!matchReadyForPlay || !gameClientRef.current)
          ) {
            setActionError("Waiting for connection to stabilize.");
            return;
          }
          if (isMultiplayerMatch) {
            gameAwaitingServerRef.current = true;
            debugMatch("Sending move over websocket", {
              actionCount: move.actions.length,
              turn: playerId,
            });
            gameClientRef.current?.sendMove(move);
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
          } else if (isAutomatedController(controller)) {
            setAutomatedPlayerId((prev) => (prev === playerId ? null : prev));
          }
        });
    },
    [
      applyMove,
      debugMatch,
      matchReadyForPlay,
      interactionLocked,
      isMultiplayerMatch,
    ],
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
    const result = gameState.result;
    if (result.winner) {
      const player =
        playersRef.current.find((p) => p.playerId === result.winner) ?? null;
      addSystemMessage(
        player
          ? `${player.name} won by ${formatWinReason(result.reason)}.`
          : `Game finished by ${formatWinReason(result.reason)}.`,
      );
    } else {
      addSystemMessage(`Game drawn (${formatWinReason(result.reason)}).`);
    }
  }, [gameState, addSystemMessage]);

  const handlePawnClick = useCallback(
    (pawnId: string) => {
      if (!activeLocalPlayerId) return;
      if (gameState?.status !== "playing") return;
      const pawn = boardPawns.find((p) => p.id === pawnId);
      if (pawn?.playerId !== activeLocalPlayerId) return;

      // Check if this pawn has staged moves
      const stagedActionsForPawn = stagedActions.filter(
        (action) => action.type === pawn.type,
      );

      if (stagedActionsForPawn.length > 0) {
        // Remove all staged actions for this pawn type
        setStagedActions((prev) =>
          prev.filter((action) => action.type !== pawn.type),
        );
        setSelectedPawnId(null);
        setActionError(null);
        return;
      }

      // If clicking the already selected pawn, unselect it
      if (selectedPawnId === pawnId) {
        setSelectedPawnId(null);
      } else {
        setSelectedPawnId(pawnId);
      }
      setActionError(null);
    },
    [gameState, boardPawns, activeLocalPlayerId, selectedPawnId, stagedActions],
  );

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!activeLocalPlayerId) return;
      if (!selectedPawnId) {
        const pawn = boardPawns.find(
          (p) =>
            p.playerId === activeLocalPlayerId &&
            p.cell[0] === row &&
            p.cell[1] === col,
        );
        if (pawn) {
          setSelectedPawnId(pawn.id);
        }
        return;
      }
      stagePawnAction(selectedPawnId, row, col);
    },
    [selectedPawnId, boardPawns, activeLocalPlayerId, stagePawnAction],
  );

  const handlePawnDragStart = useCallback(
    (pawnId: string) => {
      if (!activeLocalPlayerId) return;
      const pawn = boardPawns.find((p) => p.id === pawnId);
      if (pawn?.playerId !== activeLocalPlayerId) return;
      setDraggingPawnId(pawnId);
      setSelectedPawnId(pawnId);
    },
    [activeLocalPlayerId, boardPawns],
  );

  const handlePawnDragEnd = useCallback(() => {
    setDraggingPawnId(null);
  }, []);

  const handleCellDrop = useCallback(
    (pawnId: string, targetRow: number, targetCol: number) => {
      if (!draggingPawnId) return;
      if (!activeLocalPlayerId) return;
      // Use pawnId from parameter to ensure consistency
      stagePawnAction(pawnId, targetRow, targetCol);
      setDraggingPawnId(null);
    },
    [draggingPawnId, activeLocalPlayerId, stagePawnAction],
  );

  const handleSendMessage = (event: React.FormEvent) => {
    event.preventDefault();
    if (!chatInput.trim()) return;
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        sender: "You",
        text: chatInput,
        timestamp: new Date(),
        channel: chatChannel,
      },
    ]);
    setChatInput("");
  };

  const handleAbort = () => {
    if (isMultiplayerMatch) {
      updateGameHandshake(null);
    }
    window.history.back();
  };

  const playSound = () => {
    // Placeholder for future audio hooks
  };

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
      state.turn === gameState.turn
    ) {
      const elapsed = (Date.now() - state.lastMoveTime) / 1000;
      base[state.turn] = Math.max(0, base[state.turn] - elapsed);
    }
    return base;
    // clockTick is intentionally included to trigger clock updates every second
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, clockTick]);

  const winnerPlayer =
    gameResult?.winner != null
      ? (players.find((p) => p.playerId === gameResult.winner) ?? null)
      : null;
  const winReason = formatWinReason(gameResult?.reason);

  const selectedPawn = selectedPawnId
    ? boardPawns.find((pawn) => pawn.id === selectedPawnId)
    : null;

  const actionablePlayerId = resolveBoardControlPlayerId();
  const actionPanelPlayerId = primaryLocalPlayerId ?? null;
  const actionPanelAvailable =
    actionPanelPlayerId != null &&
    !interactionLocked &&
    gameState?.status === "playing";
  const pendingDrawForLocal =
    metaGameActions.pendingDrawOffer?.status === "pending" &&
    actionPanelPlayerId != null &&
    metaGameActions.pendingDrawOffer.from === actionPanelPlayerId;
  const takebackPendingForLocal =
    metaGameActions.pendingTakebackRequest?.status === "pending" &&
    actionPanelPlayerId != null &&
    metaGameActions.pendingTakebackRequest.requester === actionPanelPlayerId;
  const hasTakebackHistory = (gameState?.history.length ?? 0) > 0;
  const actionPanelLocked =
    Boolean(metaGameActions.resignFlowPlayerId) ||
    Boolean(metaGameActions.drawDecisionPrompt) ||
    Boolean(metaGameActions.takebackDecisionPrompt) ||
    Boolean(pendingDrawForLocal) ||
    Boolean(takebackPendingForLocal);
  const actionButtonsDisabled = !actionPanelAvailable || actionPanelLocked;
  const canCancelDrawOffer =
    pendingDrawForLocal &&
    clockTick - (metaGameActions.pendingDrawOffer?.createdAt ?? 0) >= 2000;
  const canCancelTakebackRequest =
    takebackPendingForLocal &&
    clockTick - (metaGameActions.pendingTakebackRequest?.createdAt ?? 0) >=
      2000;
  const manualActionsDisabled = isMultiplayerMatch;
  const hasActionMessage = Boolean(actionError) || Boolean(selectedPawn);
  const actionStatusText =
    actionError ??
    (selectedPawn
      ? `Selected ${selectedPawn.type} (${cellToStandardNotation(selectedPawn.cell, rows)})`
      : null);

  const thinkingPlayer =
    automatedPlayerId != null
      ? (players.find((p) => p.playerId === automatedPlayerId) ?? null)
      : null;

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

  const scoreboardEntries = useMemo(
    () =>
      matchParticipants.map((type, index) => ({
        id: index,
        name: buildPlayerName(type, index, settings.displayName),
        score: matchScore[index] ?? 0,
      })),
    [matchParticipants, matchScore, settings.displayName],
  );

  const getPlayerMatchScore = (player: GamePlayer | null) => {
    if (!player) return null;
    const participantIndex = seatOrderIndicesRef.current[player.playerId - 1];
    if (participantIndex == null) return null;
    return scoreboardEntries[participantIndex]?.score ?? 0;
  };

  const opponentPlayerId =
    primaryLocalPlayerId === 1
      ? (2 as PlayerId)
      : primaryLocalPlayerId === 2
        ? (1 as PlayerId)
        : null;

  const userRematchResponse =
    primaryLocalPlayerId != null
      ? rematchState.responses[primaryLocalPlayerId]
      : null;
  const opponentRematchResponse =
    opponentPlayerId != null ? rematchState.responses[opponentPlayerId] : null;
  const opponentName = opponentPlayerId
    ? getPlayerName(opponentPlayerId)
    : "Opponent";
  const youName =
    bottomTimerDisplayPlayer?.name ??
    (primaryLocalPlayerId ? getPlayerName(primaryLocalPlayerId) : "You");
  const rematchResponseSummary = [
    { label: youName, response: userRematchResponse ?? "pending" },
    { label: opponentName, response: opponentRematchResponse ?? "pending" },
  ];
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
      case "declined":
        return `${
          rematchState.decliner
            ? getPlayerName(rematchState.decliner)
            : opponentName
        } declined the rematch.`;
      default:
        return "";
    }
  })();

  /**
   * Spectator mode is the fallback when we *failed* to join as a player.
   * This must be derived from reactive state (not a memoized sessionStorage read),
   * otherwise invite-join can succeed but the UI stays stuck in spectator mode.
   */
  const isSpectatorSession = !gameHandshake && !isJoiningMatch && !!matchError;

  // Return spectator controller if this is a spectator session.
  if (isSpectatorSession) {
    return spectatorController;
  }

  return {
    isSpectator: false,
    matching: {
      isOpen: matchingPanelOpen,
      players: matchingPanelPlayers,
      shareUrl: resolvedShareUrl,
      statusMessage: matchingStatusMessage,
      canAbort: matchingCanAbort,
      onAbort: handleAbort,
    },
    board: {
      isMultiplayerMatch,
      gameStatus,
      gameState,
      isLoadingConfig,
      loadError,
      winnerPlayer,
      winReason,
      scoreboardEntries,
      rematchState,
      rematchResponseSummary,
      rematchStatusText,
      primaryLocalPlayerId,
      userRematchResponse,
      handleAcceptRematch,
      handleDeclineRematch,
      handleProposeRematch,
      openRematchWindow,
      handleExitAfterMatch,
      rows,
      cols,
      boardPawns,
      boardWalls,
      stagedArrows,
      playerColorsForBoard,
      interactionLocked,
      lastMove,
      draggingPawnId,
      selectedPawnId,
      stagedActionsCount: stagedActions.length,
      actionablePlayerId,
      onCellClick: handleCellClick,
      onWallClick: handleWallClick,
      onPawnClick: handlePawnClick,
      onPawnDragStart: handlePawnDragStart,
      onPawnDragEnd: handlePawnDragEnd,
      onCellDrop: handleCellDrop,
      stagedActions,
      activeLocalPlayerId,
      hasActionMessage,
      actionError,
      actionStatusText,
      clearStagedActions,
      commitStagedActions,
    },
    timers: {
      topPlayer: topTimerPlayer,
      bottomPlayer: bottomTimerDisplayPlayer,
      displayedTimeLeft,
      gameTurn,
      thinkingPlayer,
      getPlayerMatchScore,
    },
    actions: {
      drawDecisionPrompt: metaGameActions.drawDecisionPrompt,
      takebackDecisionPrompt: metaGameActions.takebackDecisionPrompt,
      incomingPassiveNotice: metaGameActions.incomingPassiveNotice,
      getPlayerName,
      respondToDrawPrompt: metaGameActions.respondToDrawPrompt,
      respondToTakebackPrompt: metaGameActions.respondToTakebackPrompt,
      handleDismissIncomingNotice: metaGameActions.handleDismissIncomingNotice,
      resignFlowPlayerId: metaGameActions.resignFlowPlayerId,
      pendingDrawForLocal,
      pendingDrawOffer: metaGameActions.pendingDrawOffer,
      takebackPendingForLocal,
      pendingTakebackRequest: metaGameActions.pendingTakebackRequest,
      outgoingTimeInfo: metaGameActions.outgoingTimeInfo,
      canCancelDrawOffer,
      canCancelTakebackRequest,
      handleCancelResign: metaGameActions.handleCancelResign,
      handleConfirmResign: metaGameActions.handleConfirmResign,
      handleCancelDrawOffer: metaGameActions.handleCancelDrawOffer,
      handleCancelTakebackRequest: metaGameActions.handleCancelTakebackRequest,
      handleDismissOutgoingInfo: metaGameActions.handleDismissOutgoingInfo,
      actionButtonsDisabled,
      manualActionsDisabled,
      hasTakebackHistory,
      handleStartResign: metaGameActions.handleStartResign,
      handleOfferDraw: metaGameActions.handleOfferDraw,
      handleRequestTakeback: metaGameActions.handleRequestTakeback,
      handleGiveTime: metaGameActions.handleGiveTime,
    },
    chat: {
      activeTab,
      onTabChange: setActiveTab,
      formattedHistory,
      chatChannel,
      messages,
      chatInput,
      onChannelChange: setChatChannel,
      onInputChange: setChatInput,
      onSendMessage: handleSendMessage,
    },
    info: {
      config,
      defaultVariant: DEFAULT_CONFIG.variant,
      defaultTimeControlPreset: DEFAULT_CONFIG.timeControl.preset,
      soundEnabled,
      onSoundToggle: () => setSoundEnabled((prev) => !prev),
      interactionLocked,
      isMultiplayerMatch,
      unsupportedPlayers,
      placeholderCopy: PLACEHOLDER_COPY,
    },
  };
}
