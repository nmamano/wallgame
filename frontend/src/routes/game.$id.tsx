import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  MessageSquare,
  History,
  Flag,
  Handshake,
  RotateCcw,
  Clock,
  Volume2,
  VolumeX,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Timer,
  User,
  Bot,
  Trophy,
  Swords,
  AlertCircle,
} from "lucide-react";
import { colorFilterMap } from "@/lib/player-colors";
import {
  Board,
  type BoardProps,
  type Arrow,
  type BoardPawn,
} from "@/components/board";
import {
  MatchingStagePanel,
  type MatchingPlayer,
} from "@/components/matching-stage-panel";
import { type GameAction } from "../../../shared/game-types";
import { GameState } from "../../../shared/game-state";
import type {
  PlayerId,
  GameResult,
  Cell,
  WallOrientation,
  PawnType,
  WallPosition,
  Move,
  Action,
} from "../../../shared/game-types";
import {
  moveToStandardNotation,
  cellToStandardNotation,
} from "../../../shared/standard-notation";
import { pawnId } from "../../../shared/game-utils";
import { PLAYER_COLORS, type PlayerColor } from "@/lib/player-colors";
import type { PlayerType } from "@/components/player-configuration";
import type { GameConfiguration } from "../../../shared/game-types";
import {
  userQueryOptions,
  fetchGameSession,
  joinGameSession,
  markGameReady,
} from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";
import {
  createPlayerController,
  isAutomatedController,
  isLocalController,
  isSupportedController,
  type GamePlayerController,
  type LocalPlayerController,
  type DrawDecision,
  type TakebackDecision,
} from "@/lib/player-controllers";
import { GameClient } from "@/lib/game-client";
import {
  getGameHandshake,
  saveGameHandshake,
  clearGameHandshake,
  type StoredGameHandshake,
} from "@/lib/game-session";
import {
  buildGameConfigurationFromSerialized,
  hydrateGameStateFromSerialized,
  serializeActions,
} from "@/lib/game-state-utils";
import type { GameSnapshot } from "../../../shared/game-types";

export const Route = createFileRoute("/game/$id")({
  component: GamePage,
});

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

interface PendingDrawOfferState {
  from: PlayerId;
  to: PlayerId;
  requestId: number;
  status: "pending";
  createdAt: number;
}

interface PendingTakebackRequestState {
  requester: PlayerId;
  responder: PlayerId;
  requestId: number;
  status: "pending";
  createdAt: number;
}

interface DrawDecisionPromptState {
  from: PlayerId;
  to: PlayerId;
  controller: LocalPlayerController;
}

interface TakebackDecisionPromptState {
  requester: PlayerId;
  responder: PlayerId;
  controller: LocalPlayerController;
}

interface PassiveNotice {
  id: number;
  type: "opponent-resigned" | "opponent-gave-time";
  message: string;
}

interface OutgoingTimeInfo {
  id: number;
  message: string;
  createdAt: number;
}

type RematchResponse = "pending" | "accepted" | "declined";

interface RematchState {
  status: "idle" | "pending" | "starting" | "declined";
  responses: Record<PlayerId, RematchResponse>;
  requestId: number;
  decliner?: PlayerId;
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

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function buildPlayerName(
  type: PlayerType,
  index: number,
  username?: string,
): string {
  switch (type) {
    case "you":
      if (username && username !== "Guest") {
        return index === 0 ? `${username} (You)` : `${username} (Also You)`;
      }
      return index === 0 ? "You" : "Also You";
    case "friend":
      return "Friend";
    case "matched-user":
      return "Matched Player";
    case "easy-bot":
      return "Easy Bot";
    case "medium-bot":
      return "Medium Bot";
    case "hard-bot":
      return "Hard Bot";
    case "custom-bot":
      return "Custom Bot";
    default:
      return `Player ${index + 1}`;
  }
}

const MAX_ACTIONS_PER_MOVE = 2;

const actionsEqual = (a: Action, b: Action): boolean => {
  if (a.type !== b.type) return false;
  if (a.target[0] !== b.target[0] || a.target[1] !== b.target[1]) return false;
  if (a.type === "wall") {
    return a.wallOrientation === b.wallOrientation;
  }
  return true;
};

const buildDoubleStepPaths = (
  pawnType: PawnType,
  from: Cell,
  to: Cell,
): Action[][] => {
  const paths: Action[][] = [];
  const rowDiff = Math.abs(from[0] - to[0]);
  const colDiff = Math.abs(from[1] - to[1]);
  const distance = rowDiff + colDiff;
  if (distance !== 2) {
    return paths;
  }

  if (from[0] === to[0]) {
    // Horizontal double step
    const midCol = (from[1] + to[1]) / 2;
    paths.push([
      { type: pawnType, target: [from[0], midCol] },
      { type: pawnType, target: to },
    ]);
    return paths;
  }

  if (from[1] === to[1]) {
    // Vertical double step
    const midRow = (from[0] + to[0]) / 2;
    paths.push([
      { type: pawnType, target: [midRow, from[1]] },
      { type: pawnType, target: to },
    ]);
    return paths;
  }

  // L-shaped double step (one row, one column)
  paths.push([
    { type: pawnType, target: [from[0], to[1]] },
    { type: pawnType, target: to },
  ]);
  paths.push([
    { type: pawnType, target: [to[0], from[1]] },
    { type: pawnType, target: to },
  ]);
  return paths;
};

function formatWinReason(reason?: GameResult["reason"]): string {
  switch (reason) {
    case "capture":
      return "capture";
    case "timeout":
      return "timeout";
    case "resignation":
      return "resignation";
    case "draw-agreement":
      return "draw";
    case "one-move-rule":
      return "one-move rule";
    default:
      return "unknown reason";
  }
}

function sanitizePlayerList(
  players: PlayerType[],
  options?: { forceYouFirst?: boolean },
): PlayerType[] {
  const { forceYouFirst = true } = options ?? {};
  const list = players.slice(0, 2);
  if (!list.includes("you")) {
    if (list.length === 0) {
      list.push("you");
    } else {
      list[0] = "you";
    }
  }
  while (list.length < 2) {
    list.push("easy-bot");
  }
  if (forceYouFirst && list.indexOf("you") === 1) {
    [list[0], list[1]] = [list[1], list[0]];
  }
  return list;
}

const DEFAULT_PLAYER_COLORS: Record<PlayerId, PlayerColor> = {
  1: "red",
  2: "blue",
};

const resolvePlayerColor = (value?: string | null): PlayerColor => {
  if (!value || value === "default") {
    return "red";
  }
  return PLAYER_COLORS.includes(value as PlayerColor)
    ? (value as PlayerColor)
    : "red";
};

function GamePage() {
  const { id } = Route.useParams();
  // const search = Route.useSearch();
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

  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;
  const settings = useSettings(isLoggedIn, userPending);
  const [gameHandshake, setGameHandshake] =
    useState<StoredGameHandshake | null>(null);
  const [matchSnapshot, setMatchSnapshot] = useState<GameSnapshot | null>(null);
  const [matchShareUrl, setMatchShareUrl] = useState<string | undefined>(
    undefined,
  );
  const [matchError, setMatchError] = useState<string | null>(null);
  const [isMultiplayerMatch, setIsMultiplayerMatch] = useState(false);
  const [isJoiningMatch, setIsJoiningMatch] = useState(false);
  const gameClientRef = useRef<GameClient | null>(null);
  const gameInitializedRef = useRef(false);
  const gameAwaitingServerRef = useRef(false);
  const hostReadyRef = useRef(false);
  const updateGameHandshake = useCallback(
    (next: StoredGameHandshake | null) => {
      if (next) {
        saveGameHandshake(next);
        setGameHandshake(next);
        setMatchShareUrl(next.shareUrl);
      } else {
        clearGameHandshake(id);
        setGameHandshake(null);
        setMatchShareUrl(undefined);
      }
    },
    [id],
  );

  const preferredPawnColor = resolvePlayerColor(settings.pawnColor);
  const preferredCatSkin = settings.catPawn;
  const preferredMouseSkin = settings.mousePawn;

  useEffect(() => {
    let cancelled = false;
    const stored = getGameHandshake(id);
    debugMatch("Bootstrapping friend match state", {
      id,
      hasStoredHandshake: Boolean(stored),
    });
    if (stored) {
      debugMatch("Using stored friend handshake", {
        id,
        role: stored.role,
        playerId: stored.playerId,
        token: maskToken(stored.token),
        socketToken: maskToken(stored.socketToken),
      });
      setMatchShareUrl(stored.shareUrl);
      setGameHandshake(stored);
      setIsMultiplayerMatch(true);
      return () => {
        cancelled = true;
      };
    } else {
      // Try to join the game directly via URL
      debugMatch(
        "No stored handshake found; attempting to join game directly",
        {
          id,
        },
      );
      setIsMultiplayerMatch(true);
      setIsJoiningMatch(true);
      void (async () => {
        try {
          const details = await joinGameSession({
            gameId: id,
            displayName: settings.displayName,
            appearance: {
              pawnColor: preferredPawnColor,
              catSkin: preferredCatSkin,
              mouseSkin: preferredMouseSkin,
            },
          });
          if (cancelled) return;
          const handshake: StoredGameHandshake = {
            gameId: id,
            token: details.token,
            socketToken: details.socketToken,
            role: details.role,
            playerId: details.playerId,
            matchType: details.snapshot.matchType,
            shareUrl: details.shareUrl,
          };
          updateGameHandshake(handshake);
          debugMatch("Joined friend game", {
            id,
            role: handshake.role,
            playerId: handshake.playerId,
            token: maskToken(handshake.token),
            socketToken: maskToken(handshake.socketToken),
          });
        } catch (error) {
          if (cancelled) return;
          debugMatch("Failed to join friend game via invite", {
            id,
            error:
              error instanceof Error
                ? { message: error.message }
                : { message: "unknown error" },
          });
          setMatchError(
            error instanceof Error
              ? error.message
              : "Unable to join friend game.",
          );
          setIsMultiplayerMatch(false);
        } finally {
          if (!cancelled) {
            setIsJoiningMatch(false);
          }
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [
    debugMatch,
    id,
    maskToken,
    preferredCatSkin,
    preferredMouseSkin,
    preferredPawnColor,
    settings.displayName,
    updateGameHandshake,
  ]);

  useEffect(() => {
    if (!gameHandshake) return;
    let cancelled = false;
    debugMatch("Fetching friend game session snapshot", {
      id,
      role: gameHandshake.role,
      playerId: gameHandshake.playerId,
      token: maskToken(gameHandshake.token),
    });
    void (async () => {
      try {
        const details = await fetchGameSession({
          gameId: id,
          token: gameHandshake.token,
        });
        if (cancelled) return;
        setMatchSnapshot(details.snapshot);
        setMatchShareUrl(details.shareUrl ?? gameHandshake.shareUrl);
        if (details.shareUrl && details.shareUrl !== gameHandshake.shareUrl) {
          updateGameHandshake({
            ...gameHandshake,
            shareUrl: details.shareUrl,
          });
        }
        debugMatch("Loaded friend session snapshot", {
          id,
          status: details.snapshot.status,
          players: details.snapshot.players.map((player) => ({
            playerId: player.playerId,
            ready: player.ready,
            connected: player.connected,
          })),
        });
        const status = details.snapshot.status;
        setIsMatchingOpen(status !== "in-progress" && status !== "completed");
        if (details.role === "host" && !hostReadyRef.current) {
          try {
            debugMatch("Marking host as ready for friend game", {
              id,
              token: maskToken(gameHandshake.token),
            });
            const snapshot = await markGameReady({
              gameId: id,
              token: gameHandshake.token,
            });
            if (!cancelled) {
              setMatchSnapshot(snapshot);
              setIsMatchingOpen(
                snapshot.status !== "in-progress" &&
                  snapshot.status !== "completed",
              );
            }
          } catch (error) {
            if (!cancelled) {
              console.error("Failed to mark friend game ready:", error);
            }
          } finally {
            hostReadyRef.current = true;
          }
        }
      } catch (error) {
        if (cancelled) return;
        debugMatch("Failed to load friend game snapshot", {
          id,
          error:
            error instanceof Error
              ? { message: error.message }
              : { message: "unknown error" },
        });
        setMatchError(
          error instanceof Error
            ? error.message
            : "Unable to load friend game.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debugMatch, gameHandshake, id, maskToken, updateGameHandshake]);

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
      const sanitizedPlayers = sanitizePlayerList(incomingPlayers, {
        forceYouFirst: options?.forceYouFirst ?? true,
      });
      const nextPrimaryLocalPlayerId = (() => {
        const idx = sanitizedPlayers.findIndex((type) => type === "you");
        return ((idx === -1 ? 0 : idx) + 1) as PlayerId;
      })();
      const state = new GameState(incomingConfig, Date.now());

      gameStateRef.current = state;
      setConfig(incomingConfig);
      setPlayerTypes(sanitizedPlayers);
      setSelectedPawnId(null);
      setDraggingPawnId(null);
      setActionError(null);
      setMessages([]);
      setChatInput("");
      setActiveTab("history");
      setChatChannel("game");
      setLastMove(undefined);
      setStagedActions([]);
      setActiveLocalPlayerId(null);
      setAutomatedPlayerId(null);
      setResignFlowPlayerId(null);
      setIncomingPassiveNotice(null);
      setOutgoingTimeInfo(null);
      setPendingDrawOffer(null);
      setPendingTakebackRequest(null);
      setDrawDecisionPrompt(null);
      setTakebackDecisionPrompt(null);
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
          name: buildPlayerName(type, index, settings.displayName),
          rating: type.includes("bot") ? 1200 : 1250,
          color:
            index + 1 === nextPrimaryLocalPlayerId
              ? preferredPawnColor
              : DEFAULT_PLAYER_COLORS[(index + 1) as PlayerId],
          type,
          isOnline: type === "you" || type.includes("bot"),
          catSkin:
            index + 1 === nextPrimaryLocalPlayerId
              ? preferredCatSkin
              : undefined,
          mouseSkin:
            index + 1 === nextPrimaryLocalPlayerId
              ? preferredMouseSkin
              : undefined,
        }),
      );
      playersRef.current = initialPlayers;
      setPlayers(initialPlayers);

      const matchingList: MatchingPlayer[] = initialPlayers.map((player) => ({
        id: player.id,
        type: player.type,
        name: player.name,
        isReady: player.type === "you" || player.type.includes("bot"),
        isYou: player.type === "you",
      }));
      setMatchingPlayers(matchingList);
      const waiting = matchingList.some((entry) => !entry.isReady);
      setIsMatchingOpen(waiting);

      setGameState(state);

      addSystemMessage(
        waiting ? "Waiting for players..." : "Game created. Good luck!",
      );
      setRematchState((prev) => ({
        status: "idle",
        responses: { 1: "pending", 2: "pending" },
        requestId: prev.requestId,
      }));
    },
    [
      addSystemMessage,
      playerControllersRef,
      preferredCatSkin,
      preferredMouseSkin,
      preferredPawnColor,
      settings.displayName,
    ],
  );

  const updateGameState = useCallback(
    (
      nextState: GameState,
      options?: {
        lastMoves?: BoardProps["lastMove"] | BoardProps["lastMoves"] | null;
      },
    ) => {
      gameStateRef.current = nextState;
      setGameState(nextState);
      if (
        options &&
        Object.prototype.hasOwnProperty.call(options, "lastMoves")
      ) {
        if (options.lastMoves) {
          setLastMove(options.lastMoves);
        } else {
          setLastMove(undefined);
        }
      } else {
        setLastMove(undefined);
      }
    },
    [],
  );

  useEffect(() => {
    if (!gameHandshake) return;
    debugMatch("Connecting GameClient", {
      id,
      playerId: gameHandshake.playerId,
      socketToken: maskToken(gameHandshake.socketToken),
    });
    const client = new GameClient({
      gameId: id,
      socketToken: gameHandshake.socketToken,
    });
    gameClientRef.current = client;
    client.connect({
      onState: (state) => {
        setMatchError(null);
        const config = buildGameConfigurationFromSerialized(state);
        if (!gameInitializedRef.current) {
          const playerTypes: PlayerType[] =
            gameHandshake.playerId === 1
              ? ["you", "friend"]
              : ["friend", "you"];
          initializeGame(config, playerTypes, { forceYouFirst: false });
          setPlayerTypes(playerTypes);
          gameInitializedRef.current = true;
        }
        const resolvedState = hydrateGameStateFromSerialized(state, config);
        updateGameState(resolvedState);
        gameAwaitingServerRef.current = false;
        if (gameHandshake.playerId === resolvedState.turn) {
          setActiveLocalPlayerId(gameHandshake.playerId);
        } else {
          setActiveLocalPlayerId(null);
        }
      },
      onMatchStatus: (snapshot) => {
        setMatchSnapshot(snapshot);
        setIsMatchingOpen(
          snapshot.status !== "in-progress" && snapshot.status !== "completed",
        );
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
    debugMatch,
    gameHandshake,
    id,
    initializeGame,
    maskToken,
    updateGameState,
  ]);

  useEffect(() => {
    if (!isMultiplayerMatch || !matchSnapshot) return;
    setPlayers((prev) => {
      if (!prev.length) return prev;
      const next = prev.map((player) => {
        const remote = matchSnapshot.players.find(
          (entry) => entry.playerId === player.playerId,
        );
        if (!remote) return player;
        const isLocal = player.playerId === primaryLocalPlayerId;
        const appearance = remote.appearance;
        return {
          ...player,
          name: remote.displayName || player.name,
          isOnline: remote.connected,
          color:
            !isLocal && appearance?.pawnColor
              ? resolvePlayerColor(appearance.pawnColor)
              : player.color,
          catSkin:
            !isLocal && appearance?.catSkin
              ? appearance.catSkin
              : player.catSkin,
          mouseSkin:
            !isLocal && appearance?.mouseSkin
              ? appearance.mouseSkin
              : player.mouseSkin,
        };
      });
      playersRef.current = next;
      return next;
    });
  }, [matchSnapshot, isMultiplayerMatch, primaryLocalPlayerId]);

  const [config, setConfig] = useState<GameConfiguration | null>(null);
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [matchingPlayers, setMatchingPlayers] = useState<MatchingPlayer[]>([]);
  const [isMatchingOpen, setIsMatchingOpen] = useState(false);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [lastMove, setLastMove] = useState<
    BoardProps["lastMove"] | BoardProps["lastMoves"]
  >(undefined);
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
  const [pendingDrawOffer, setPendingDrawOffer] =
    useState<PendingDrawOfferState | null>(null);
  const [pendingTakebackRequest, setPendingTakebackRequest] =
    useState<PendingTakebackRequestState | null>(null);
  const [drawDecisionPrompt, setDrawDecisionPrompt] =
    useState<DrawDecisionPromptState | null>(null);
  const [takebackDecisionPrompt, setTakebackDecisionPrompt] =
    useState<TakebackDecisionPromptState | null>(null);
  const [resignFlowPlayerId, setResignFlowPlayerId] = useState<PlayerId | null>(
    null,
  );
  const [incomingPassiveNotice, setIncomingPassiveNotice] =
    useState<PassiveNotice | null>(null);
  const [outgoingTimeInfo, setOutgoingTimeInfo] =
    useState<OutgoingTimeInfo | null>(null);
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
    : isMatchingOpen;
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

  const gameStateRef = useRef<GameState | null>(null);
  const playersRef = useRef<GamePlayer[]>([]);
  const pendingTurnRequestRef = useRef<PlayerId | null>(null);
  const drawOfferRequestIdRef = useRef(0);
  const takebackRequestIdRef = useRef(0);
  const lastResignedPlayerRef = useRef<PlayerId | null>(null);
  const noticeCounterRef = useRef(0);
  const seatOrderIndicesRef = useRef<[number, number]>([0, 1]);
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

  const friendColorOverrides = useMemo(() => {
    if (!isMultiplayerMatch || !matchSnapshot) return {};
    const map: Partial<Record<PlayerId, PlayerColor>> = {};
    matchSnapshot.players.forEach((player) => {
      if (player.appearance?.pawnColor) {
        map[player.playerId] = resolvePlayerColor(player.appearance.pawnColor);
      }
    });
    return map;
  }, [matchSnapshot, isMultiplayerMatch]);

  const playerColorsForBoard = useMemo(() => {
    const colors: Record<PlayerId, PlayerColor> = {
      1: DEFAULT_PLAYER_COLORS[1],
      2: DEFAULT_PLAYER_COLORS[2],
    };
    if (primaryLocalPlayerId) {
      colors[primaryLocalPlayerId] = preferredPawnColor;
    }
    Object.entries(friendColorOverrides).forEach(([key, value]) => {
      const playerId = Number(key) as PlayerId;
      if (playerId === primaryLocalPlayerId) {
        return;
      }
      colors[playerId] = value;
    });
    return colors;
  }, [friendColorOverrides, preferredPawnColor, primaryLocalPlayerId]);

  const getPlayerName = useCallback(
    (playerId: PlayerId) =>
      playersRef.current.find((p) => p.playerId === playerId)?.name ??
      `Player ${playerId}`,
    [],
  );

  const resolveBoardControlPlayerId = useCallback(
    () => activeLocalPlayerId ?? defaultLocalPlayerId ?? null,
    [activeLocalPlayerId, defaultLocalPlayerId],
  );

  const resolvePrimaryActionPlayerId = useCallback(
    () => primaryLocalPlayerId ?? null,
    [primaryLocalPlayerId],
  );

  const performGameAction = useCallback(
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
      updateGameState(nextState, {
        lastMoves: options?.lastMoves ?? null,
      });
      if (action.kind === "giveTime") {
        const recipientId: PlayerId = action.playerId === 1 ? 2 : 1;
        if (action.playerId === primaryLocalPlayerId) {
          setOutgoingTimeInfo({
            id: ++noticeCounterRef.current,
            message: `You gave ${getPlayerName(recipientId)} 1:00.`,
            createdAt: Date.now(),
          });
        } else if (recipientId === primaryLocalPlayerId) {
          setIncomingPassiveNotice({
            id: ++noticeCounterRef.current,
            type: "opponent-gave-time",
            message: `${getPlayerName(action.playerId)} gave you 1:00.`,
          });
        }
      }
      return nextState;
    },
    [
      updateGameState,
      primaryLocalPlayerId,
      getPlayerName,
      setOutgoingTimeInfo,
      setIncomingPassiveNotice,
    ],
  );

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
  }, [
    previewState,
    gameState,
    stagedActions,
    activeLocalPlayerId,
    primaryLocalPlayerId,
    players,
  ]);

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
      const currentState = gameStateRef.current;
      if (!currentState) {
        throw new Error("Game is still loading");
      }

      const nextState = currentState.applyGameAction({
        kind: "move",
        move,
        playerId,
        timestamp: Date.now(),
      });
      // Calculate last moves by comparing pawn positions
      const moves: BoardProps["lastMoves"] = [];
      const playerColor =
        playerColorsForBoard[playerId] ?? DEFAULT_PLAYER_COLORS[playerId];

      // Check Cat
      const catBefore = currentState.pawns[playerId].cat;
      const catAfter = nextState.pawns[playerId].cat;
      if (catBefore[0] !== catAfter[0] || catBefore[1] !== catAfter[1]) {
        moves.push({
          fromRow: catBefore[0],
          fromCol: catBefore[1],
          toRow: catAfter[0],
          toCol: catAfter[1],
          playerColor,
        });
      }

      // Check Mouse
      const mouseBefore = currentState.pawns[playerId].mouse;
      const mouseAfter = nextState.pawns[playerId].mouse;
      if (
        mouseBefore[0] !== mouseAfter[0] ||
        mouseBefore[1] !== mouseAfter[1]
      ) {
        moves.push({
          fromRow: mouseBefore[0],
          fromCol: mouseBefore[1],
          toRow: mouseAfter[0],
          toCol: mouseAfter[1],
          playerColor,
        });
      }

      // If we have moves, set them. Otherwise clear.
      updateGameState(nextState, {
        lastMoves: moves.length > 0 ? moves : null,
      });
      if (soundEnabled) {
        playSound();
      }
    },
    [playerColorsForBoard, soundEnabled, updateGameState],
  );

  const commitStagedActions = useCallback(
    (actions?: Action[]) => {
      const moveActions = actions ?? stagedActions;
      if (moveActions.length === 0) return;
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

  const executeTakeback = useCallback(
    (requesterId: PlayerId) => {
      const currentState = gameStateRef.current;
      if (!currentState) {
        setActionError("Game is still loading");
        return false;
      }
      if (currentState.history.length === 0) {
        setActionError("There are no moves to take back yet.");
        return false;
      }
      const stepsNeeded = currentState.turn === requesterId ? 2 : 1;
      if (currentState.history.length < stepsNeeded) {
        setActionError("Not enough moves have been played for a takeback.");
        return false;
      }
      let nextState = currentState;
      for (let i = 0; i < stepsNeeded; i++) {
        nextState = nextState.applyGameAction({
          kind: "takeback",
          playerId: requesterId,
          timestamp: Date.now(),
        });
      }
      updateGameState(nextState, { lastMoves: null });
      setStagedActions([]);
      setSelectedPawnId(null);
      setDraggingPawnId(null);
      return true;
    },
    [updateGameState],
  );

  const handleStartResign = useCallback(() => {
    const actorId = resolvePrimaryActionPlayerId();
    if (!actorId) {
      setActionError("You need to control a player to resign.");
      return;
    }
    setResignFlowPlayerId(actorId);
    setActionError(null);
  }, [resolvePrimaryActionPlayerId]);

  const handleCancelResign = useCallback(() => {
    setResignFlowPlayerId(null);
  }, []);

  const handleConfirmResign = useCallback(() => {
    const actorId = resignFlowPlayerId ?? resolvePrimaryActionPlayerId();
    if (!actorId) {
      setActionError("You need to control a player to resign.");
      setResignFlowPlayerId(null);
      return;
    }
    if (isMultiplayerMatch) {
      if (!matchReadyForPlay || !gameClientRef.current) {
        setActionError("Connection unavailable.");
      } else {
        gameClientRef.current.sendResign();
      }
      setResignFlowPlayerId(null);
      return;
    }
    try {
      lastResignedPlayerRef.current = actorId;
      performGameAction({
        kind: "resign",
        playerId: actorId,
        timestamp: Date.now(),
      });
      addSystemMessage(`${getPlayerName(actorId)} resigned.`);
    } catch (error) {
      console.error(error);
      setActionError(
        error instanceof Error ? error.message : "Unable to resign the game.",
      );
    } finally {
      setResignFlowPlayerId(null);
    }
  }, [
    matchReadyForPlay,
    isMultiplayerMatch,
    resignFlowPlayerId,
    resolvePrimaryActionPlayerId,
    performGameAction,
    addSystemMessage,
    getPlayerName,
  ]);

  const handleOfferDraw = useCallback(() => {
    const actorId = resolvePrimaryActionPlayerId();
    if (!actorId) {
      setActionError("You need to control a player to offer a draw.");
      return;
    }
    if (isMultiplayerMatch) {
      setActionError("Draw offers are not available in friend games yet.");
      return;
    }
    const currentState = gameStateRef.current;
    if (!currentState) {
      setActionError("Game is still loading.");
      return;
    }
    if (currentState.status !== "playing") {
      setActionError("Draw offers are only available during active games.");
      return;
    }
    if (pendingDrawOffer) {
      setActionError("You already have a draw offer pending.");
      return;
    }
    const opponentId: PlayerId = actorId === 1 ? 2 : 1;
    const opponentController = playerControllersRef.current[opponentId];
    if (!opponentController || !isSupportedController(opponentController)) {
      setActionError("This opponent cannot respond to draw offers yet.");
      return;
    }
    const requestId = ++drawOfferRequestIdRef.current;
    setActionError(null);
    setPendingDrawOffer({
      from: actorId,
      to: opponentId,
      status: "pending",
      createdAt: Date.now(),
      requestId,
    });
    addSystemMessage(
      `${getPlayerName(actorId)} offered a draw to ${getPlayerName(
        opponentId,
      )}.`,
    );
    const shouldAutoAccept = autoAcceptingLocalIds.includes(opponentId);
    const responsePromise = shouldAutoAccept
      ? new Promise<DrawDecision>((resolve) =>
          window.setTimeout(() => resolve("accept"), 300),
        )
      : opponentController.respondToDrawOffer({
          state: currentState.clone(),
          playerId: opponentId,
          opponentId: actorId,
          offeredBy: actorId,
        });
    const shouldShowPrompt =
      isLocalController(opponentController) &&
      opponentId === primaryLocalPlayerId &&
      !shouldAutoAccept;
    if (shouldShowPrompt) {
      setDrawDecisionPrompt({
        from: actorId,
        to: opponentId,
        controller: opponentController,
      });
    }
    responsePromise
      .then((decision) => {
        if (drawOfferRequestIdRef.current !== requestId) return;
        if (decision === "accept") {
          try {
            performGameAction({
              kind: "draw",
              playerId: opponentId,
              timestamp: Date.now(),
            });
            addSystemMessage(
              `${getPlayerName(opponentId)} accepted the draw offer.`,
            );
          } catch (error) {
            console.error(error);
            setActionError(
              error instanceof Error
                ? error.message
                : "Unable to convert the draw offer into a result.",
            );
          }
        } else {
          addSystemMessage(
            `${getPlayerName(opponentId)} declined the draw offer.`,
          );
        }
      })
      .catch((error) => {
        if (drawOfferRequestIdRef.current !== requestId) return;
        console.error(error);
        setActionError(
          error instanceof Error
            ? error.message
            : "The draw offer could not be processed.",
        );
      })
      .finally(() => {
        if (drawOfferRequestIdRef.current === requestId) {
          setPendingDrawOffer(null);
          if (shouldShowPrompt) {
            setDrawDecisionPrompt(null);
          }
        }
      });
  }, [
    resolvePrimaryActionPlayerId,
    pendingDrawOffer,
    performGameAction,
    addSystemMessage,
    getPlayerName,
    autoAcceptingLocalIds,
    primaryLocalPlayerId,
    isMultiplayerMatch,
  ]);

  const handleCancelDrawOffer = useCallback(() => {
    if (!pendingDrawOffer) return;
    const canCancel =
      Date.now() - pendingDrawOffer.createdAt >= 2000 &&
      pendingDrawOffer.status === "pending";
    if (!canCancel) return;
    drawOfferRequestIdRef.current++;
    setPendingDrawOffer(null);
    addSystemMessage("You cancelled your draw offer.");
  }, [pendingDrawOffer, addSystemMessage]);

  const handleRequestTakeback = useCallback(() => {
    const requesterId = resolvePrimaryActionPlayerId();
    if (!requesterId) {
      setActionError("You need to control a player to request a takeback.");
      return;
    }
    if (isMultiplayerMatch) {
      setActionError("Takebacks are not available in friend games yet.");
      return;
    }
    const currentState = gameStateRef.current;
    if (!currentState) {
      setActionError("Game is still loading.");
      return;
    }
    if (currentState.history.length === 0) {
      setActionError("There are no moves to take back yet.");
      return;
    }
    if (pendingTakebackRequest) {
      setActionError("A takeback request is already pending.");
      return;
    }
    const responderId: PlayerId = requesterId === 1 ? 2 : 1;
    const responderController = playerControllersRef.current[responderId];
    if (!responderController || !isSupportedController(responderController)) {
      setActionError("This opponent cannot respond to takeback requests yet.");
      return;
    }
    const requestId = ++takebackRequestIdRef.current;
    setActionError(null);
    setPendingTakebackRequest({
      requester: requesterId,
      responder: responderId,
      status: "pending",
      createdAt: Date.now(),
      requestId,
    });
    addSystemMessage(
      `${getPlayerName(requesterId)} requested a takeback from ${getPlayerName(
        responderId,
      )}.`,
    );
    const shouldAutoAccept = autoAcceptingLocalIds.includes(responderId);
    const responsePromise = shouldAutoAccept
      ? new Promise<TakebackDecision>((resolve) =>
          window.setTimeout(() => resolve("allow"), 300),
        )
      : responderController.respondToTakebackRequest({
          state: currentState.clone(),
          playerId: responderId,
          opponentId: requesterId,
          requestedBy: requesterId,
        });
    const shouldShowPrompt =
      isLocalController(responderController) &&
      responderId === primaryLocalPlayerId &&
      !shouldAutoAccept;
    if (shouldShowPrompt) {
      setTakebackDecisionPrompt({
        requester: requesterId,
        responder: responderId,
        controller: responderController,
      });
    }
    responsePromise
      .then((decision) => {
        if (takebackRequestIdRef.current !== requestId) return;
        if (decision === "allow") {
          const success = executeTakeback(requesterId);
          if (success) {
            addSystemMessage(
              `${getPlayerName(responderId)} accepted the takeback request.`,
            );
          }
        } else {
          addSystemMessage(
            `${getPlayerName(responderId)} declined the takeback request.`,
          );
        }
      })
      .catch((error) => {
        if (takebackRequestIdRef.current !== requestId) return;
        console.error(error);
        setActionError(
          error instanceof Error
            ? error.message
            : "The takeback request could not be processed.",
        );
      })
      .finally(() => {
        if (takebackRequestIdRef.current === requestId) {
          setPendingTakebackRequest(null);
          if (shouldShowPrompt) {
            setTakebackDecisionPrompt(null);
          }
        }
      });
  }, [
    resolvePrimaryActionPlayerId,
    pendingTakebackRequest,
    executeTakeback,
    addSystemMessage,
    getPlayerName,
    autoAcceptingLocalIds,
    primaryLocalPlayerId,
    isMultiplayerMatch,
  ]);

  const handleCancelTakebackRequest = useCallback(() => {
    if (!pendingTakebackRequest) return;
    const canCancel =
      Date.now() - pendingTakebackRequest.createdAt >= 2000 &&
      pendingTakebackRequest.status === "pending";
    if (!canCancel) return;
    takebackRequestIdRef.current++;
    setPendingTakebackRequest(null);
    addSystemMessage("You cancelled your takeback request.");
  }, [pendingTakebackRequest, addSystemMessage]);

  const handleGiveTime = useCallback(() => {
    const giverId = resolvePrimaryActionPlayerId();
    if (!giverId) {
      setActionError("You need to control a player to give time.");
      return;
    }
    if (isMultiplayerMatch) {
      setActionError("Manual time adjustments are disabled in friend games.");
      return;
    }
    const currentState = gameStateRef.current;
    if (!currentState) {
      setActionError("Game is still loading.");
      return;
    }
    if (currentState.status !== "playing") {
      setActionError("You can only adjust clocks during an active game.");
      return;
    }
    const opponentId: PlayerId = giverId === 1 ? 2 : 1;
    try {
      performGameAction({
        kind: "giveTime",
        playerId: giverId,
        seconds: 60,
        timestamp: Date.now(),
      });
      addSystemMessage(
        `${getPlayerName(giverId)} gave ${getPlayerName(
          opponentId,
        )} one minute.`,
      );
    } catch (error) {
      console.error(error);
      setActionError(
        error instanceof Error
          ? error.message
          : "Unable to adjust the clocks right now.",
      );
    }
  }, [
    resolvePrimaryActionPlayerId,
    performGameAction,
    addSystemMessage,
    getPlayerName,
    isMultiplayerMatch,
  ]);

  const handleDismissIncomingNotice = useCallback(() => {
    setIncomingPassiveNotice(null);
  }, []);

  const handleDismissOutgoingInfo = useCallback(() => {
    setOutgoingTimeInfo(null);
  }, []);

  const openRematchWindow = useCallback(() => {
    rematchRequestIdRef.current += 1;
    const requestId = rematchRequestIdRef.current;
    setRematchState({
      status: "pending",
      responses: { 1: "pending", 2: "pending" },
      requestId,
    });
    addSystemMessage("Rematch offer opened. Waiting for responses...");
  }, [addSystemMessage]);

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
    respondToRematch(primaryLocalPlayerId, "accepted");
  }, [primaryLocalPlayerId, respondToRematch]);

  const handleDeclineRematch = useCallback(() => {
    if (!primaryLocalPlayerId) return;
    respondToRematch(primaryLocalPlayerId, "declined");
  }, [primaryLocalPlayerId, respondToRematch]);

  const handleExitAfterMatch = useCallback(() => {
    if (rematchState.status === "pending" && primaryLocalPlayerId) {
      respondToRematch(primaryLocalPlayerId, "declined");
    }
    window.history.back();
  }, [primaryLocalPlayerId, rematchState.status, respondToRematch]);

  const respondToDrawPrompt = useCallback(
    (decision: DrawDecision) => {
      if (!drawDecisionPrompt) return;
      try {
        drawDecisionPrompt.controller.submitDrawDecision(decision);
        setDrawDecisionPrompt(null);
      } catch (error) {
        console.error(error);
        setActionError(
          error instanceof Error
            ? error.message
            : "Unable to respond to the draw offer.",
        );
      }
    },
    [drawDecisionPrompt],
  );

  const respondToTakebackPrompt = useCallback(
    (decision: TakebackDecision) => {
      if (!takebackDecisionPrompt) return;
      try {
        takebackDecisionPrompt.controller.submitTakebackDecision(decision);
        setTakebackDecisionPrompt(null);
      } catch (error) {
        console.error(error);
        setActionError(
          error instanceof Error
            ? error.message
            : "Unable to respond to the takeback request.",
        );
      }
    },
    [takebackDecisionPrompt],
  );

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
      const stored = sessionStorage.getItem(`game-config-${id}`);
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
      setPendingDrawOffer(null);
      setPendingTakebackRequest(null);
      setDrawDecisionPrompt(null);
      setTakebackDecisionPrompt(null);
      setGameState(null);
    };
  }, [id, initializeGame, isMultiplayerMatch]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClockTick(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setPlayers((prev) => {
      const next = prev.map((player) =>
        player.playerId === primaryLocalPlayerId
          ? { ...player, color: preferredPawnColor }
          : player,
      );
      playersRef.current = next;
      return next;
    });
  }, [primaryLocalPlayerId, preferredPawnColor]);

  useEffect(() => {
    if (!gameState) return;
    if (stagedActions.length > 0 && gameState.turn !== activeLocalPlayerId) {
      setStagedActions([]);
    }
  }, [gameState, activeLocalPlayerId, stagedActions.length]);

  useEffect(() => {
    if (gameState?.status === "finished") {
      setPendingDrawOffer(null);
      setPendingTakebackRequest(null);
      setDrawDecisionPrompt(null);
      setTakebackDecisionPrompt(null);
      setResignFlowPlayerId(null);
      lastResignedPlayerRef.current = null;
    }
  }, [gameState?.status]);

  useEffect(() => {
    if (!matchParticipants.length) return;
    if (gameState?.status !== "finished" || !gameState.result) return;
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
    matchParticipants.length,
    openRematchWindow,
  ]);

  useEffect(() => {
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
    autoAcceptingLocalIds,
    primaryLocalPlayerId,
    rematchState,
    respondToRematch,
  ]);

  useEffect(() => {
    if (rematchState.status !== "starting") return;
    startRematch();
  }, [rematchState.status, startRematch]);

  useEffect(() => {
    if (
      gameState?.status === "finished" &&
      gameState.result?.reason === "resignation"
    ) {
      const winner = gameState.result.winner;
      const resignedPlayer: PlayerId = winner === 1 ? 2 : 1;
      if (
        resignedPlayer &&
        resignedPlayer !== primaryLocalPlayerId &&
        resignedPlayer !== lastResignedPlayerRef.current
      ) {
        setIncomingPassiveNotice({
          id: ++noticeCounterRef.current,
          type: "opponent-resigned",
          message: `${getPlayerName(resignedPlayer)} resigned.`,
        });
      }
      lastResignedPlayerRef.current = null;
    }
  }, [
    gameState?.status,
    gameState?.result,
    primaryLocalPlayerId,
    getPlayerName,
  ]);

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
        setActionError("That wall placement is not legal.");
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
            const payload = serializeActions(move.actions);
            debugMatch("Sending move over websocket", {
              actionCount: payload.length,
              turn: playerId,
            });
            gameClientRef.current?.sendMove(payload);
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

  // Board sizing constants (matching Board component internals)
  const maxCellSize = 3;
  const gapSize = 0.9;
  const boardPadding = 2;
  const containerMargin = 1;
  const boardWidth = cols * maxCellSize + (cols - 1) * gapSize + boardPadding;
  const boardHeight = rows * maxCellSize + (rows - 1) * gapSize + boardPadding;

  // Calculate board container dimensions (board + margin)
  const boardContainerWidth = boardWidth + containerMargin * 2;

  // Fixed component heights
  const timerHeight = 4;
  const infoCardHeight = 6.5;
  const actionButtonsHeight = 6.3;
  const chatTabsHeight = 3;
  const chatInputHeight = 4;
  const chatChannelsHeight = 2.5;
  const stagedActionsButtonsHeight = 3.5; // Space for buttons below board (mt-4 + button height)

  // Minimum heights for adjustable components
  const minBoardContainerHeight =
    boardHeight + containerMargin * 2 + stagedActionsButtonsHeight;
  const minChatScrollableHeight = 12;

  // Calculate gap size
  const gap = 1;

  // Right column max width
  const rightColumnMaxWidth = 25;

  // Left column total height = timer + gap + board container + gap + timer
  const leftColumnHeight =
    timerHeight + gap + minBoardContainerHeight + gap + timerHeight;

  // Right column total height = info + gap + buttons + gap + chat card
  // Chat card total includes: tabs + (channels + scrollable content + input)
  const minChatCardHeight =
    chatTabsHeight +
    chatChannelsHeight +
    minChatScrollableHeight +
    chatInputHeight;
  const rightColumnHeight =
    infoCardHeight + gap + actionButtonsHeight + gap + minChatCardHeight;

  // Determine which component needs to grow to match column heights
  const heightDiff = leftColumnHeight - rightColumnHeight;
  const adjustedBoardContainerHeight =
    heightDiff < 0
      ? minBoardContainerHeight - heightDiff
      : minBoardContainerHeight;

  // When chat card grows, only the scrollable content area grows (not tabs, channels, or input)
  const adjustedChatScrollableHeight =
    heightDiff > 0
      ? minChatScrollableHeight + heightDiff
      : minChatScrollableHeight;
  const adjustedChatCardHeight =
    chatTabsHeight +
    chatChannelsHeight +
    adjustedChatScrollableHeight +
    chatInputHeight;

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
    pendingDrawOffer?.status === "pending" &&
    actionPanelPlayerId != null &&
    pendingDrawOffer.from === actionPanelPlayerId;
  const takebackPendingForLocal =
    pendingTakebackRequest?.status === "pending" &&
    actionPanelPlayerId != null &&
    pendingTakebackRequest.requester === actionPanelPlayerId;
  const hasTakebackHistory = (gameState?.history.length ?? 0) > 0;
  const actionPanelLocked =
    Boolean(resignFlowPlayerId) ||
    Boolean(drawDecisionPrompt) ||
    Boolean(takebackDecisionPrompt) ||
    Boolean(pendingDrawForLocal) ||
    Boolean(takebackPendingForLocal);
  const actionButtonsDisabled = !actionPanelAvailable || actionPanelLocked;
  const canCancelDrawOffer =
    pendingDrawForLocal &&
    clockTick - (pendingDrawOffer?.createdAt ?? 0) >= 2000;
  const canCancelTakebackRequest =
    takebackPendingForLocal &&
    clockTick - (pendingTakebackRequest?.createdAt ?? 0) >= 2000;
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

  const incomingSection = (() => {
    if (drawDecisionPrompt) {
      return (
        <>
          <div className="flex items-center gap-2 text-sm">
            <Handshake className="w-4 h-4 text-primary" />
            {`${getPlayerName(drawDecisionPrompt.from)} offered a draw.`}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => respondToDrawPrompt("accept")}>
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => respondToDrawPrompt("reject")}
            >
              Decline
            </Button>
          </div>
        </>
      );
    }
    if (takebackDecisionPrompt) {
      return (
        <>
          <div className="flex items-center gap-2 text-sm">
            <RotateCcw className="w-4 h-4" />
            {`${getPlayerName(
              takebackDecisionPrompt.requester,
            )} requested a takeback.`}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => respondToTakebackPrompt("allow")}>
              Allow
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => respondToTakebackPrompt("decline")}
            >
              Decline
            </Button>
          </div>
        </>
      );
    }
    if (incomingPassiveNotice) {
      return (
        <>
          <div className="flex items-center gap-2 text-sm">
            {incomingPassiveNotice.type === "opponent-resigned" ? (
              <Flag className="w-4 h-4 text-destructive" />
            ) : (
              <Timer className="w-4 h-4 text-primary" />
            )}
            {incomingPassiveNotice.message}
          </div>
          <div>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs px-2"
              onClick={handleDismissIncomingNotice}
            >
              Dismiss
            </Button>
          </div>
        </>
      );
    }
    return (
      <p className="text-sm text-muted-foreground">
        No active incoming offers.
      </p>
    );
  })();

  const outgoingSection = (() => {
    if (resignFlowPlayerId) {
      return (
        <>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleCancelResign}>
              Keep playing
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleConfirmResign}
            >
              Resign
            </Button>
          </div>
        </>
      );
    }
    if (pendingDrawForLocal && pendingDrawOffer) {
      return (
        <>
          <div className="flex items-center gap-2 text-sm">
            <Handshake className="w-4 h-4" />
            {`Waiting for a response to your draw offer.`}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCancelDrawOffer}
            disabled={!canCancelDrawOffer}
          >
            {canCancelDrawOffer ? "Cancel offer" : "Can cancel in 2s"}
          </Button>
        </>
      );
    }
    if (takebackPendingForLocal && pendingTakebackRequest) {
      return (
        <>
          <div className="flex items-center gap-2 text-sm">
            <RotateCcw className="w-4 h-4" />
            {`Waiting for a response to your takeback request.`}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCancelTakebackRequest}
            disabled={!canCancelTakebackRequest}
          >
            {canCancelTakebackRequest ? "Cancel request" : "Can cancel in 2s"}
          </Button>
        </>
      );
    }
    if (outgoingTimeInfo) {
      return (
        <>
          <div className="flex items-center gap-2 text-sm">
            <Timer className="w-4 h-4 text-primary" />
            {outgoingTimeInfo.message}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs px-2 self-start"
            onClick={handleDismissOutgoingInfo}
          >
            Dismiss
          </Button>
        </>
      );
    }
    return (
      <p className="text-sm text-muted-foreground">
        No active outgoing offers.
      </p>
    );
  })();

  return (
    <>
      <div className="min-h-screen bg-background flex flex-col">
        <MatchingStagePanel
          isOpen={matchingPanelOpen}
          players={matchingPanelPlayers}
          shareUrl={resolvedShareUrl}
          statusMessage={matchingStatusMessage}
          canAbort={matchingCanAbort}
          onAbort={handleAbort}
        />

        <div
          className="flex-1 py-4 px-4"
          style={{
            display: "grid",
            gridTemplateColumns: `${boardContainerWidth}rem ${rightColumnMaxWidth}rem`,
            gap: `${gap}rem`,
            alignItems: "start",
            justifyContent: "center",
            margin: "0 auto",
            width: "fit-content",
          }}
        >
          {/* Left Column: Timers & Board */}
          <div
            className="flex flex-col"
            style={{
              width: `${boardContainerWidth}rem`,
              gap: `${gap}rem`,
            }}
          >
            {/* Top Player (Opponent) Timer */}
            {topTimerPlayer && (
              <PlayerInfo
                player={topTimerPlayer}
                isActive={gameTurn === topTimerPlayer.playerId}
                timeLeft={displayedTimeLeft[topTimerPlayer.playerId] ?? 0}
                isThinking={
                  thinkingPlayer?.playerId === topTimerPlayer.playerId
                }
                score={getPlayerMatchScore(topTimerPlayer)}
              />
            )}

            {/* Board Container */}
            <div
              className="flex flex-col items-center justify-center bg-card/50 backdrop-blur rounded-xl border border-border shadow-sm p-4 relative"
              style={{
                minHeight: `${adjustedBoardContainerHeight}rem`,
                height: `${adjustedBoardContainerHeight}rem`,
              }}
            >
              {/* Game Over Overlay */}
              {gameStatus === "finished" && (
                <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center rounded-xl">
                  <Card className="p-8 max-w-md w-full text-center space-y-6 shadow-2xl border-primary/20">
                    <Trophy className="w-16 h-16 mx-auto text-yellow-500" />
                    <div>
                      <h2 className="text-3xl font-bold mb-2">
                        {winnerPlayer ? `${winnerPlayer.name} won` : "Draw"}
                      </h2>
                      <p className="text-muted-foreground text-lg">
                        {winReason}
                      </p>
                    </div>
                    {scoreboardEntries.length === 2 && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground font-semibold">
                          <Trophy className="w-4 h-4" />
                          <span>Match score</span>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          {scoreboardEntries.map((entry) => (
                            <div
                              key={entry.id}
                              className="rounded-lg border border-dashed border-border/60 px-3 py-2"
                            >
                              <div className="text-xs text-muted-foreground">
                                {entry.name}
                              </div>
                              <div className="text-2xl font-semibold">
                                {entry.score}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="space-y-3">
                      <div className="flex items-center justify-center gap-2 text-sm font-semibold">
                        <RotateCcw className="w-4 h-4" />
                        Rematch
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {rematchStatusText}
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {rematchResponseSummary.map((entry, idx) => (
                          <div
                            key={`${entry.label}-${idx}`}
                            className="rounded-lg border border-border/60 px-3 py-2 text-left"
                          >
                            <div className="text-xs text-muted-foreground">
                              {entry.label}
                            </div>
                            <Badge
                              variant={
                                entry.response === "accepted"
                                  ? "default"
                                  : entry.response === "declined"
                                    ? "destructive"
                                    : "secondary"
                              }
                              className="mt-1"
                            >
                              {entry.response === "pending"
                                ? "Pending"
                                : entry.response.charAt(0).toUpperCase() +
                                  entry.response.slice(1)}
                            </Badge>
                          </div>
                        ))}
                      </div>
                      {rematchState.status === "pending" && (
                        <div className="flex justify-center gap-3">
                          <Button
                            onClick={handleAcceptRematch}
                            disabled={
                              !primaryLocalPlayerId ||
                              userRematchResponse === "accepted"
                            }
                          >
                            {userRematchResponse === "accepted"
                              ? "Accepted"
                              : "Accept rematch"}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={handleDeclineRematch}
                            disabled={userRematchResponse === "declined"}
                          >
                            {userRematchResponse === "declined"
                              ? "Declined"
                              : "Decline"}
                          </Button>
                        </div>
                      )}
                      {rematchState.status === "declined" && (
                        <div className="flex justify-center">
                          <Button
                            variant="ghost"
                            onClick={openRematchWindow}
                            className="text-sm"
                          >
                            Offer rematch again
                          </Button>
                        </div>
                      )}
                      {rematchState.status === "starting" && (
                        <p className="text-sm text-muted-foreground">
                          Setting up the next game...
                        </p>
                      )}
                    </div>
                    <div className="flex justify-center gap-3">
                      <Button variant="outline" onClick={handleExitAfterMatch}>
                        Exit
                      </Button>
                    </div>
                  </Card>
                </div>
              )}

              <div className="absolute top-2 left-4 right-4 flex flex-col gap-2 text-sm text-muted-foreground">
                {isLoadingConfig && (
                  <div className="flex items-center gap-2 text-xs">
                    <AlertCircle className="w-4 h-4" />
                    Loading game settings...
                  </div>
                )}
                {loadError && (
                  <div className="flex items-center gap-2 text-xs text-amber-600">
                    <AlertCircle className="w-4 h-4" />
                    {loadError}
                  </div>
                )}
              </div>

              <Board
                rows={rows}
                cols={cols}
                pawns={boardPawns}
                walls={boardWalls}
                arrows={stagedArrows}
                className="p-0"
                maxWidth="max-w-full"
                playerColors={playerColorsForBoard}
                onCellClick={handleCellClick}
                onWallClick={handleWallClick}
                onPawnClick={handlePawnClick}
                onPawnDragStart={
                  interactionLocked ? undefined : handlePawnDragStart
                }
                onPawnDragEnd={handlePawnDragEnd}
                onCellDrop={interactionLocked ? undefined : handleCellDrop}
                lastMove={!Array.isArray(lastMove) ? lastMove : undefined}
                lastMoves={Array.isArray(lastMove) ? lastMove : undefined}
                draggingPawnId={draggingPawnId}
                selectedPawnId={selectedPawnId}
                stagedActionsCount={stagedActions.length}
                controllablePlayerId={actionablePlayerId ?? undefined}
              />

              {/* Action messaging + staged action buttons */}
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 mt-4 w-full">
                <div className="flex items-center text-xs text-muted-foreground min-h-[1.25rem] justify-self-start">
                  {hasActionMessage && (
                    <>
                      <AlertCircle
                        className={`w-4 h-4 mr-2 ${
                          actionError ? "text-red-500" : "text-muted-foreground"
                        }`}
                      />
                      <span
                        className={actionError ? "text-red-500" : undefined}
                      >
                        {actionStatusText}
                      </span>
                    </>
                  )}
                </div>
                <div className="flex gap-3 justify-center">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={clearStagedActions}
                    disabled={stagedActions.length === 0}
                  >
                    Clear staged actions
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => commitStagedActions()}
                    disabled={
                      gameState?.status !== "playing" ||
                      gameState?.turn !== activeLocalPlayerId
                    }
                  >
                    Finish move
                  </Button>
                </div>
                <div />
              </div>
            </div>

            {/* Bottom Player (You) Timer */}
            {bottomTimerDisplayPlayer && (
              <PlayerInfo
                player={bottomTimerDisplayPlayer}
                isActive={gameTurn === bottomTimerDisplayPlayer.playerId}
                timeLeft={
                  displayedTimeLeft[bottomTimerDisplayPlayer.playerId] ?? 0
                }
                isThinking={
                  thinkingPlayer?.playerId === bottomTimerDisplayPlayer.playerId
                }
                score={getPlayerMatchScore(bottomTimerDisplayPlayer)}
              />
            )}
          </div>

          {/* Right Column: Info, Actions & Chat */}
          <div
            className="flex flex-col"
            style={{
              gap: `${gap}rem`,
              maxWidth: `${rightColumnMaxWidth}rem`,
            }}
          >
            <Card className="p-4 space-y-3 bg-card/50 backdrop-blur">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Swords className="w-4 h-4 text-muted-foreground" />
                  <span className="font-medium capitalize">
                    {config?.variant ?? DEFAULT_CONFIG.variant}
                  </span>
                </div>
                <Badge variant={config?.rated ? "default" : "secondary"}>
                  {config?.rated ? "Rated" : "Casual"}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  <span className="capitalize">
                    {config?.timeControl.preset ??
                      DEFAULT_CONFIG.timeControl.preset ??
                      "blitz"}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setSoundEnabled((prev) => !prev)}
                >
                  {soundEnabled ? (
                    <Volume2 className="w-4 h-4" />
                  ) : (
                    <VolumeX className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </Card>

            {interactionLocked && !isMultiplayerMatch && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="space-y-1">
                  {unsupportedPlayers
                    .map((type) => PLACEHOLDER_COPY[type])
                    .filter(Boolean)
                    .map((text, idx) => (
                      <div key={`${text}-${idx}`}>{text}</div>
                    ))}
                </AlertDescription>
              </Alert>
            )}

            <Card className="p-3 bg-card/50 backdrop-blur">
              <div className="min-h-[80px] rounded-lg border border-dashed border-border/60 p-2.5 flex flex-col justify-center gap-2">
                {incomingSection}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2"
                  size="sm"
                  onClick={handleStartResign}
                  disabled={actionButtonsDisabled}
                >
                  <Flag className="w-4 h-4" /> Resign
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2"
                  size="sm"
                  onClick={handleOfferDraw}
                  disabled={
                    actionButtonsDisabled ||
                    manualActionsDisabled ||
                    Boolean(pendingDrawOffer)
                  }
                >
                  <Handshake className="w-4 h-4" /> Draw
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2"
                  size="sm"
                  onClick={handleRequestTakeback}
                  disabled={
                    actionButtonsDisabled ||
                    manualActionsDisabled ||
                    Boolean(pendingTakebackRequest) ||
                    !hasTakebackHistory
                  }
                >
                  <RotateCcw className="w-4 h-4" /> Takeback
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2"
                  size="sm"
                  onClick={handleGiveTime}
                  disabled={actionButtonsDisabled || manualActionsDisabled}
                >
                  <Timer className="w-4 h-4" /> Give time
                </Button>
              </div>
              <div className="min-h-[80px] rounded-lg border border-dashed border-border/60 p-2.5 flex flex-col justify-center gap-1.5">
                {outgoingSection}
              </div>
            </Card>

            <Card
              className="flex flex-col overflow-hidden bg-card/50 backdrop-blur"
              style={{
                height: `${adjustedChatCardHeight}rem`,
                minHeight: `${adjustedChatCardHeight}rem`,
              }}
            >
              <div className="flex border-b flex-shrink-0">
                <button
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${
                    activeTab === "history"
                      ? "border-b-2 border-primary text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setActiveTab("history")}
                >
                  <div className="flex items-center justify-center gap-2">
                    <History className="w-4 h-4" />
                    Moves
                  </div>
                </button>
                <button
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${
                    activeTab === "chat"
                      ? "border-b-2 border-primary text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setActiveTab("chat")}
                >
                  <div className="flex items-center justify-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    Chat
                  </div>
                </button>
              </div>

              <div className="flex-1 overflow-hidden relative flex flex-col">
                {activeTab === "chat" ? (
                  <>
                    <div className="flex p-2 gap-1 bg-muted/30 flex-shrink-0">
                      {(["game", "team", "audience"] as const).map(
                        (channel) => (
                          <button
                            key={channel}
                            onClick={() => setChatChannel(channel)}
                            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                              chatChannel === channel
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-muted text-muted-foreground"
                            }`}
                          >
                            {channel.charAt(0).toUpperCase() + channel.slice(1)}
                          </button>
                        ),
                      )}
                    </div>
                    <ScrollArea className="flex-1 p-4">
                      <div className="space-y-3">
                        {messages
                          .filter(
                            (message) =>
                              message.channel === chatChannel ||
                              message.isSystem,
                          )
                          .map((message) => (
                            <div
                              key={message.id}
                              className={`flex flex-col ${
                                message.sender === "You"
                                  ? "items-end"
                                  : "items-start"
                              }`}
                            >
                              {!message.isSystem && (
                                <span className="text-[10px] text-muted-foreground mb-1">
                                  {message.sender}
                                </span>
                              )}
                              <div
                                className={`px-3 py-2 rounded-lg text-sm max-w-[85%] ${
                                  message.isSystem
                                    ? "bg-muted text-muted-foreground text-center w-full italic"
                                    : message.sender === "You"
                                      ? "bg-primary text-primary-foreground"
                                      : "bg-muted"
                                }`}
                              >
                                {message.text}
                              </div>
                            </div>
                          ))}
                      </div>
                    </ScrollArea>
                    <form
                      onSubmit={handleSendMessage}
                      className="p-3 border-t bg-background/50 flex-shrink-0"
                    >
                      <Input
                        value={chatInput}
                        onChange={(event) => setChatInput(event.target.value)}
                        placeholder={`Message ${chatChannel}...`}
                        className="bg-background"
                      />
                    </form>
                  </>
                ) : (
                  <>
                    <ScrollArea className="flex-1 p-0">
                      <div className="grid grid-cols-[3rem_1fr_1fr] text-sm">
                        {formattedHistory.map((row, index) => (
                          <div
                            key={index}
                            className={`contents group ${
                              index % 2 === 1 ? "bg-muted/30" : ""
                            }`}
                          >
                            <div className="p-2 text-muted-foreground text-center border-r">
                              {row.num}.
                            </div>
                            <button className="p-2 hover:bg-accent text-center transition-colors border-r font-mono">
                              {row.white}
                            </button>
                            <button className="p-2 hover:bg-accent text-center transition-colors font-mono">
                              {row.black}
                            </button>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                    <div className="p-2 border-t grid grid-cols-4 gap-1 bg-muted/30 flex-shrink-0">
                      <Button variant="ghost" size="icon" className="h-8">
                        <ChevronsLeft className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8">
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8">
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8">
                        <ChevronsRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
function PlayerInfo({
  player,
  isActive,
  timeLeft,
  isThinking = false,
  score = null,
}: {
  player: GamePlayer;
  isActive: boolean;
  timeLeft: number;
  isThinking?: boolean;
  score?: number | null;
}) {
  // Determine if we should show cat SVG for this player
  const shouldShowCatSvg =
    player.catSkin && player.catSkin !== "default" && player.catSkin.length > 0;
  const catSvgPath = shouldShowCatSvg ? `/pawns/cat/${player.catSkin}` : null;
  const colorFilter = colorFilterMap[player.color]
    ? { filter: colorFilterMap[player.color] }
    : undefined;

  return (
    <div
      className={`flex items-center justify-between gap-3 p-3 rounded-lg transition-colors shadow-sm ${
        isActive
          ? "bg-accent/50 border border-accent"
          : "bg-card/50 backdrop-blur border border-border"
      }`}
    >
      {/* Left side: Profile pic, Name/Rating/Online, Score card */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* Profile pic */}
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
            player.color === "red"
              ? "bg-red-100 text-red-700"
              : "bg-blue-100 text-blue-700"
          }`}
        >
          {catSvgPath ? (
            <img
              src={catSvgPath}
              alt="player avatar"
              className="w-full h-full object-contain rounded-full"
              style={colorFilter}
            />
          ) : player.type.includes("bot") ? (
            <Bot size={20} />
          ) : (
            <User size={20} />
          )}
        </div>

        {/* Name with rating and online indicator */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate">{player.name}</span>
            <Badge variant="outline" className="text-xs flex-shrink-0">
              {player.rating}
            </Badge>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span
              className={`w-2 h-2 rounded-full ${
                player.isOnline ? "bg-green-500" : "bg-gray-300"
              }`}
            />
            {player.isOnline ? "Online" : "Offline"}
          </div>
        </div>

        {/* Match score card */}
        {typeof score === "number" && (
          <Badge
            variant="outline"
            className="text-[12px] px-2 py-0.5 flex-shrink-0 bg-card/50 border-border"
          >
            Score {score}
          </Badge>
        )}
      </div>

      {/* Right side: "Bot is thinking" message, Timer */}
      <div className="flex items-center gap-3 flex-shrink-0">
        {/* "Bot is thinking" info message */}
        {isThinking && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Bot className="w-3 h-3" />
            <span>{`Thinking...`}</span>
          </div>
        )}

        {/* Timer */}
        <div
          className={`text-2xl font-mono font-bold whitespace-nowrap ${
            isActive ? "text-foreground" : "text-muted-foreground/50"
          } ${timeLeft < 30 ? "text-red-500 animate-pulse" : ""}`}
        >
          {formatTime(Math.max(0, Math.round(timeLeft)))}
        </div>
      </div>
    </div>
  );
}
