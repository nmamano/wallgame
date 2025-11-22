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
import { Board, type BoardProps } from "@/components/board";
import {
  MatchingStagePanel,
  type MatchingPlayer,
} from "@/components/matching-stage-panel";
import {
  Cell,
  type Pawn,
  type PlayerWall,
  type PlayerId,
  Move,
  Action,
  TimeControl as GameTimeControl,
  getAiMove,
} from "@/lib/game";
import {
  GameState,
  type GameStatus,
  type GameResult,
  type GameConfig,
} from "@/lib/game-state";
import type { PlayerColor } from "@/lib/player-colors";
import type { PlayerType } from "@/components/player-configuration";
import type {
  GameConfiguration,
  TimeControl as SetupTimeControl,
} from "@/components/game-configuration-panel";
import { userQueryOptions } from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";

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
}

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: Date;
  channel: "game" | "team" | "audience";
  isSystem?: boolean;
}

interface HistoryMove {
  number: number;
  notation: string;
  playerColor: PlayerColor;
}

const DEFAULT_CONFIG: GameConfiguration = {
  timeControl: "blitz",
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

const VARIANT_LABELS: Record<string, "Standard" | "Classic" | "Freestyle"> = {
  standard: "Standard",
  classic: "Classic",
};

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function mapTimeControl(control: SetupTimeControl): GameTimeControl {
  switch (control) {
    case "bullet":
      return new GameTimeControl(60, 0);
    case "rapid":
      return new GameTimeControl(600, 2);
    case "classical":
      return new GameTimeControl(1800, 0);
    case "blitz":
    default:
      return new GameTimeControl(180, 2);
  }
}

function buildPlayerName(type: PlayerType, index: number): string {
  switch (type) {
    case "you":
      return index === 0 ? "You" : "Second You";
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

function convertHistory(state: GameState): HistoryMove[] {
  const rows = state.config.boardHeight;
  return state.history.map((entry) => {
    const playerId: PlayerId = (entry.index % 2 === 1 ? 1 : 2) as PlayerId;
    return {
      number: Math.ceil(entry.index / 2),
      notation: entry.move.toNotation(rows),
      playerColor: DEFAULT_PLAYER_COLORS[playerId],
    };
  });
}

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
    case "stalemate":
      return "stalemate";
    default:
      return "unknown reason";
  }
}

function sanitizePlayerList(players: PlayerType[]): PlayerType[] {
  const list = players.slice(0, 2);
  if (list.includes("you")) {
    const idx = list.indexOf("you");
    if (idx === 1) {
      [list[0], list[1]] = [list[1], list[0]];
    }
  } else {
    list[0] = "you";
  }
  while (list.length < 2) {
    list.push("easy-bot");
  }
  return list;
}

type GameSnapshot = {
  pawns: Pawn[];
  walls: PlayerWall[];
  status: GameStatus;
  result?: GameResult;
  turn: PlayerId;
  history: HistoryMove[];
  timeLeft: Record<PlayerId, number>;
};

const EMPTY_SNAPSHOT: GameSnapshot = {
  pawns: [],
  walls: [],
  status: "playing",
  result: undefined,
  turn: 1,
  history: [],
  timeLeft: { 1: 0, 2: 0 },
};

const DEFAULT_PLAYER_COLORS: Record<PlayerId, PlayerColor> = {
  1: "red",
  2: "blue",
};

const resolvePlayerColor = (value?: string | null): PlayerColor => {
  if (!value || value === "default") {
    return "red";
  }
  return value as PlayerColor;
};

function buildStartPositions(
  width: number,
  height: number
): NonNullable<GameConfig["startPos"]> {
  const leftFile = "a";
  const rightFile = String.fromCharCode("a".charCodeAt(0) + width - 1);
  const topRank = height;
  const bottomRank = 1;

  return {
    p1Cat: `${leftFile}${topRank}`,
    p1Mouse: `${leftFile}${bottomRank}`,
    p2Cat: `${rightFile}${topRank}`,
    p2Mouse: `${rightFile}${bottomRank}`,
  };
}

function buildSnapshot(
  state: GameState | null,
  localPlayerId: PlayerId,
  catSkin?: string | null,
  mouseSkin?: string | null
): GameSnapshot {
  if (!state) {
    return EMPTY_SNAPSHOT;
  }

  const normalizedCat = catSkin && catSkin !== "default" ? catSkin : undefined;
  const normalizedMouse =
    mouseSkin && mouseSkin !== "default" ? mouseSkin : undefined;

  const pawns = state.getPawns().map((pawn) => {
    if (pawn.playerId !== localPlayerId) {
      return pawn;
    }
    const preferred = pawn.type === "mouse" ? normalizedMouse : normalizedCat;
    return preferred ? { ...pawn, pawnStyle: preferred } : pawn;
  });

  return {
    pawns,
    walls: state.getWalls(),
    status: state.status,
    result: state.result ? { ...state.result } : undefined,
    turn: state.turn,
    history: convertHistory(state),
    timeLeft: { ...state.timeLeft },
  };
}

function GamePage() {
  const { id } = Route.useParams();

  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;
  const settings = useSettings(isLoggedIn, userPending);

  const [config, setConfig] = useState<GameConfiguration | null>(null);
  const [playerTypes, setPlayerTypes] = useState<PlayerType[]>(DEFAULT_PLAYERS);
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [matchingPlayers, setMatchingPlayers] = useState<MatchingPlayer[]>([]);
  const [isMatchingOpen, setIsMatchingOpen] = useState(false);
  const [gameSnapshot, setGameSnapshot] =
    useState<GameSnapshot>(EMPTY_SNAPSHOT);
  const [lastMove, setLastMove] = useState<BoardProps["lastMove"] | undefined>(
    undefined
  );
  const [activeTab, setActiveTab] = useState<"chat" | "history">("chat");
  const [chatChannel, setChatChannel] = useState<"game" | "team" | "audience">(
    "game"
  );
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [selectedPawnId, setSelectedPawnId] = useState<string | null>(null);
  const [draggingPawnId, setDraggingPawnId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [clockTick, setClockTick] = useState(() => Date.now());

  const gameStateRef = useRef<GameState | null>(null);
  const playersRef = useRef<GamePlayer[]>([]);
  const aiTimeoutRef = useRef<number | null>(null);

  const localPlayerId = useMemo<PlayerId>(() => {
    const idx = playerTypes.findIndex((type) => type === "you");
    return ((idx === -1 ? 0 : idx) + 1) as PlayerId;
  }, [playerTypes]);

  const botPlayerId = useMemo<PlayerId | null>(() => {
    const idx = playerTypes.findIndex((type) => type.includes("bot"));
    return idx === -1 ? null : ((idx + 1) as PlayerId);
  }, [playerTypes]);

  const unsupportedPlayers = useMemo(
    () => playerTypes.filter((type) => type !== "you" && type !== "easy-bot"),
    [playerTypes]
  );
  const interactionLocked = unsupportedPlayers.length > 0;
  const aiEnabled = Boolean(botPlayerId) && !interactionLocked;

  const preferredCatSkin = settings.catPawn;
  const preferredMouseSkin = settings.mousePawn;
  const preferredPawnColor = resolvePlayerColor(settings.pawnColor);

  const playerColorsForBoard = useMemo(() => {
    const colors: Record<PlayerId, PlayerColor> = {
      1: DEFAULT_PLAYER_COLORS[1],
      2: DEFAULT_PLAYER_COLORS[2],
    };
    colors[localPlayerId] = preferredPawnColor;
    if (botPlayerId && botPlayerId !== localPlayerId) {
      const fallback = localPlayerId === 1 ? 2 : 1;
      colors[botPlayerId] = DEFAULT_PLAYER_COLORS[fallback];
    }
    return colors;
  }, [localPlayerId, botPlayerId, preferredPawnColor]);

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

  const syncFromState = useCallback(
    (state: GameState) => {
      setGameSnapshot(
        buildSnapshot(
          state,
          localPlayerId,
          preferredCatSkin,
          preferredMouseSkin
        )
      );
    },
    [localPlayerId, preferredCatSkin, preferredMouseSkin]
  );

  const initializeGame = useCallback(
    (incomingConfig: GameConfiguration, incomingPlayers: PlayerType[]) => {
      const sanitizedPlayers = sanitizePlayerList(incomingPlayers);
      const boardWidth =
        incomingConfig.boardWidth ?? DEFAULT_CONFIG.boardWidth!;
      const boardHeight =
        incomingConfig.boardHeight ?? DEFAULT_CONFIG.boardHeight!;
      const variant =
        VARIANT_LABELS[incomingConfig.variant] ?? VARIANT_LABELS.standard;
      const timeControl = mapTimeControl(incomingConfig.timeControl);
      const state = new GameState(
        {
          boardWidth,
          boardHeight,
          variant,
          timeControl,
          startPos: buildStartPositions(boardWidth, boardHeight),
        },
        Date.now()
      );

      gameStateRef.current = state;
      setConfig(incomingConfig);
      setPlayerTypes(sanitizedPlayers);
      setSelectedPawnId(null);
      setDraggingPawnId(null);
      setActionError(null);
      setMessages([]);
      setChatInput("");
      setActiveTab("chat");
      setChatChannel("game");
      setLastMove(undefined);

      const initialPlayers: GamePlayer[] = sanitizedPlayers.map(
        (type, index) => ({
          id: `p${index + 1}`,
          playerId: (index + 1) as PlayerId,
          name: buildPlayerName(type, index),
          rating: type.includes("bot") ? 1200 : 1250,
          color:
            index + 1 === localPlayerId
              ? preferredPawnColor
              : DEFAULT_PLAYER_COLORS[(index + 1) as PlayerId],
          type,
          isOnline: type === "you" || type.includes("bot"),
        })
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

      setGameSnapshot(
        buildSnapshot(
          state,
          localPlayerId,
          preferredCatSkin,
          preferredMouseSkin
        )
      );

      addSystemMessage(
        waiting ? "Waiting for players..." : "Game created. Good luck!"
      );
    },
    [addSystemMessage, localPlayerId, preferredCatSkin, preferredMouseSkin]
  );

  useEffect(() => {
    setIsLoadingConfig(true);
    setLoadError(null);

    let resolvedConfig = DEFAULT_CONFIG;
    let resolvedPlayers = DEFAULT_PLAYERS;

    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem(`game-config-${id}`);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          resolvedConfig = {
            ...DEFAULT_CONFIG,
            ...(parsed?.config ?? {}),
          };
          resolvedPlayers = Array.isArray(parsed?.players)
            ? parsed.players
            : DEFAULT_PLAYERS;
        } catch (error) {
          setLoadError("We couldn't read the saved game. Using defaults.");
        }
      } else {
        setLoadError("No saved game found. We'll start a new easy bot game.");
      }
    }

    initializeGame(resolvedConfig, resolvedPlayers);
    setIsLoadingConfig(false);

    return () => {
      if (aiTimeoutRef.current) {
        clearTimeout(aiTimeoutRef.current);
        aiTimeoutRef.current = null;
      }
      gameStateRef.current = null;
    };
  }, [id, initializeGame]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClockTick(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setPlayers((prev) => {
      const next = prev.map((player) =>
        player.playerId === localPlayerId
          ? { ...player, color: preferredPawnColor }
          : player
      );
      playersRef.current = next;
      return next;
    });
  }, [localPlayerId, preferredPawnColor]);

  useEffect(() => {
    if (!gameStateRef.current) return;
    setGameSnapshot(
      buildSnapshot(
        gameStateRef.current,
        localPlayerId,
        preferredCatSkin,
        preferredMouseSkin
      )
    );
  }, [localPlayerId, preferredCatSkin, preferredMouseSkin]);

  const applyMove = useCallback(
    (playerId: PlayerId, move: Move) => {
      const currentState = gameStateRef.current;
      if (!currentState) {
        throw new Error("Game is still loading");
      }

      const nextState = currentState.clone();
      nextState.applyGameAction({
        kind: "move",
        move,
        playerId,
        timestamp: Date.now(),
      });
      gameStateRef.current = nextState;

      const firstAction = move.actions.find(
        (action) => action.type === "cat" || action.type === "mouse"
      );
      if (firstAction) {
        const pieceBefore =
          firstAction.type === "cat"
            ? currentState.pawns[playerId].cat
            : currentState.pawns[playerId].mouse;
        setLastMove({
          fromRow: pieceBefore.row,
          fromCol: pieceBefore.col,
          toRow: firstAction.target.row,
          toCol: firstAction.target.col,
          playerColor:
            playerColorsForBoard[playerId] ?? DEFAULT_PLAYER_COLORS[playerId],
        });
      } else {
        setLastMove(undefined);
      }

      syncFromState(nextState);
      if (soundEnabled) {
        playSound("move");
      }
    },
    [playerColorsForBoard, soundEnabled, syncFromState]
  );

  const attemptMove = useCallback(
    (pawnId: string, targetRow: number, targetCol: number) => {
      if (interactionLocked) return;
      if (gameSnapshot.status !== "playing") return;
      if (gameSnapshot.turn !== localPlayerId) return;

      const pawn = gameSnapshot.pawns.find((p) => p.id === pawnId);
      if (!pawn || pawn.playerId !== localPlayerId) return;
      if (pawn.cell.row === targetRow && pawn.cell.col === targetCol) return;

      try {
        const move = new Move([
          new Action(pawn.type, new Cell(targetRow, targetCol)),
        ]);
        applyMove(localPlayerId, move);
        setSelectedPawnId(null);
        setActionError(null);
      } catch (error) {
        console.error(error);
        setActionError(
          error instanceof Error ? error.message : "Move could not be applied."
        );
      } finally {
        setDraggingPawnId(null);
      }
    },
    [interactionLocked, gameSnapshot, localPlayerId, applyMove]
  );

  const handleWallClick = useCallback(
    (row: number, col: number, orientation: "horizontal" | "vertical") => {
      if (interactionLocked) return;
      if (gameSnapshot.status !== "playing") return;
      if (gameSnapshot.turn !== localPlayerId) return;

      try {
        const move = new Move([
          new Action("wall", new Cell(row, col), orientation),
        ]);
        applyMove(localPlayerId, move);
        setActionError(null);
      } catch (error) {
        console.error(error);
        setActionError(
          error instanceof Error
            ? error.message
            : "Wall placement was rejected."
        );
      }
    },
    [interactionLocked, gameSnapshot, localPlayerId, applyMove]
  );

  const triggerAiMove = useCallback(() => {
    if (!aiEnabled || botPlayerId == null) return;
    const state = gameStateRef.current;
    if (!state || state.status !== "playing" || state.turn !== botPlayerId)
      return;

    if (aiTimeoutRef.current) {
      clearTimeout(aiTimeoutRef.current);
      aiTimeoutRef.current = null;
    }

    setAiThinking(true);
    aiTimeoutRef.current = window.setTimeout(async () => {
      const current = gameStateRef.current;
      if (
        !current ||
        current.turn !== botPlayerId ||
        current.status !== "playing"
      ) {
        setAiThinking(false);
        aiTimeoutRef.current = null;
        return;
      }
      try {
        const opponentId: PlayerId = botPlayerId === 1 ? 2 : 1;
        const aiCatPos: [number, number] = [
          current.pawns[botPlayerId].cat.row,
          current.pawns[botPlayerId].cat.col,
        ];
        const opponentMousePos: [number, number] = [
          current.pawns[opponentId].mouse.row,
          current.pawns[opponentId].mouse.col,
        ];
        const botMove = await getAiMove(
          current.grid.clone(),
          aiCatPos,
          opponentMousePos
        );
        applyMove(botPlayerId, botMove);
        setActionError(null);
      } catch (error) {
        console.error(error);
        setActionError("The bot failed to find a move.");
      } finally {
        setAiThinking(false);
        if (aiTimeoutRef.current) {
          clearTimeout(aiTimeoutRef.current);
          aiTimeoutRef.current = null;
        }
      }
    }, 600);
  }, [aiEnabled, botPlayerId, applyMove]);

  useEffect(() => {
    if (!aiEnabled || botPlayerId == null) return;
    if (gameSnapshot.status !== "playing") return;
    if (gameSnapshot.turn !== botPlayerId) return;
    triggerAiMove();
  }, [
    aiEnabled,
    botPlayerId,
    triggerAiMove,
    gameSnapshot.status,
    gameSnapshot.turn,
  ]);

  useEffect(() => {
    if (gameSnapshot.status !== "finished" || !gameSnapshot.result) return;
    const result = gameSnapshot.result;
    if (result.winner) {
      const player =
        playersRef.current.find((p) => p.playerId === result.winner) || null;
      addSystemMessage(
        player
          ? `${player.name} won by ${formatWinReason(result.reason)}.`
          : `Game finished by ${formatWinReason(result.reason)}.`
      );
    } else {
      addSystemMessage(`Game drawn (${formatWinReason(result.reason)}).`);
    }
  }, [gameSnapshot.status, gameSnapshot.result, addSystemMessage]);

  const handlePawnClick = useCallback(
    (pawnId: string) => {
      if (gameSnapshot.status !== "playing") return;
      const pawn = gameSnapshot.pawns.find((p) => p.id === pawnId);
      if (!pawn || pawn.playerId !== localPlayerId) return;
      setSelectedPawnId(pawnId);
      setActionError(null);
    },
    [gameSnapshot, localPlayerId]
  );

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!selectedPawnId) {
        const pawn = gameSnapshot.pawns.find(
          (p) =>
            p.playerId === localPlayerId &&
            p.cell.row === row &&
            p.cell.col === col
        );
        if (pawn) {
          setSelectedPawnId(pawn.id);
        }
        return;
      }
      attemptMove(selectedPawnId, row, col);
    },
    [selectedPawnId, gameSnapshot.pawns, localPlayerId, attemptMove]
  );

  const handlePawnDragStart = useCallback((pawnId: string) => {
    setDraggingPawnId(pawnId);
    setSelectedPawnId(pawnId);
  }, []);

  const handlePawnDragEnd = useCallback(() => {
    setDraggingPawnId(null);
  }, []);

  const handleCellDrop = useCallback(
    (row: number, col: number) => {
      if (!draggingPawnId) return;
      attemptMove(draggingPawnId, row, col);
    },
    [draggingPawnId, attemptMove]
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
    window.history.back();
  };

  const playSound = (_: "move" | "capture" | "check") => {
    // Placeholder for future audio hooks
  };

  const rows = config?.boardHeight ?? DEFAULT_CONFIG.boardHeight!;
  const cols = config?.boardWidth ?? DEFAULT_CONFIG.boardWidth!;

  // Board sizing constants (matching Board component internals)
  const maxCellSize = 3;
  const gapSize = 0.9;
  const boardPadding = 2;
  const containerMargin = 1;
  const boardWidth = cols * maxCellSize + (cols - 1) * gapSize + boardPadding;
  const boardHeight = rows * maxCellSize + (rows - 1) * gapSize + boardPadding;

  // Calculate board container dimensions (board + margin)
  const boardContainerWidth = boardWidth + containerMargin * 2;

  // Minimum heights for adjustable components
  const minBoardContainerHeight = boardHeight + containerMargin * 2;
  const minChatScrollableHeight = 12;

  // Fixed component heights
  const timerHeight = 4;
  const infoCardHeight = 6.5;
  const actionButtonsHeight = 6.3;
  const chatTabsHeight = 3;
  const chatInputHeight = 4;
  const chatChannelsHeight = 2.5;

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
      1: gameSnapshot.timeLeft[1] ?? 0,
      2: gameSnapshot.timeLeft[2] ?? 0,
    };
    const state = gameStateRef.current;
    if (
      state &&
      state.status === "playing" &&
      state.turn === gameSnapshot.turn
    ) {
      const elapsed = (Date.now() - state.lastMoveTime) / 1000;
      base[state.turn] = Math.max(0, base[state.turn] - elapsed);
    }
    return base;
  }, [gameSnapshot, clockTick]);

  const winnerPlayer =
    gameSnapshot.result?.winner != null
      ? (players.find((p) => p.playerId === gameSnapshot.result?.winner) ??
        null)
      : null;
  const winReason = formatWinReason(gameSnapshot.result?.reason);

  const selectedPawn = selectedPawnId
    ? gameSnapshot.pawns.find((pawn) => pawn.id === selectedPawnId)
    : null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <MatchingStagePanel
        isOpen={isMatchingOpen}
        players={matchingPlayers}
        gameUrl={typeof window !== "undefined" ? window.location.href : ""}
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
          {players.length > 1 && (
            <PlayerInfo
              player={players[1]}
              isActive={gameSnapshot.turn === players[1].playerId}
              timeLeft={displayedTimeLeft[players[1].playerId] ?? 0}
            />
          )}

          {/* Board Container */}
          <div
            className="flex items-center justify-center bg-card/50 backdrop-blur rounded-xl border border-border shadow-sm p-4 relative"
            style={{
              minHeight: `${adjustedBoardContainerHeight}rem`,
              height: `${adjustedBoardContainerHeight}rem`,
            }}
          >
            {/* Game Over Overlay */}
            {gameSnapshot.status === "finished" && (
              <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center rounded-xl">
                <Card className="p-8 max-w-md w-full text-center space-y-6 shadow-2xl border-primary/20">
                  <Trophy className="w-16 h-16 mx-auto text-yellow-500" />
                  <div>
                    <h2 className="text-3xl font-bold mb-2">
                      {winnerPlayer ? `${winnerPlayer.name} won` : "Draw"}
                    </h2>
                    <p className="text-muted-foreground text-lg">{winReason}</p>
                  </div>
                  <div className="flex justify-center gap-4">
                    <Button onClick={() => window.location.reload()}>
                      Rematch
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => window.history.back()}
                    >
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
              {actionError && (
                <div className="flex items-center gap-2 text-xs text-red-500">
                  <AlertCircle className="w-4 h-4" />
                  {actionError}
                </div>
              )}
              {selectedPawn && (
                <div className="flex items-center gap-2 text-xs">
                  <AlertCircle className="w-4 h-4" />
                  Selected {selectedPawn.type} (
                  {selectedPawn.cell.toNotation(rows)})
                </div>
              )}
              {aiThinking && (
                <div className="flex items-center gap-2 text-xs">
                  <Bot className="w-4 h-4" />
                  Easy bot is thinking...
                </div>
              )}
            </div>

            <Board
              rows={rows}
              cols={cols}
              pawns={gameSnapshot.pawns}
              walls={gameSnapshot.walls}
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
              lastMove={lastMove}
            />
          </div>

          {/* Bottom Player (You) Timer */}
          {players.length > 0 && (
            <PlayerInfo
              player={players[0]}
              isActive={gameSnapshot.turn === players[0].playerId}
              timeLeft={displayedTimeLeft[players[0].playerId] ?? 0}
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
                  {config?.timeControl ?? DEFAULT_CONFIG.timeControl}
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

          {interactionLocked && (
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
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                size="sm"
                onClick={() => setActionError("Resign not wired up yet.")}
              >
                <Flag className="w-4 h-4" /> Resign
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                size="sm"
                onClick={() => setActionError("Draw offer not supported yet.")}
              >
                <Handshake className="w-4 h-4" /> Draw
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                size="sm"
                onClick={() =>
                  setActionError("Takebacks will be available soon.")
                }
              >
                <RotateCcw className="w-4 h-4" /> Takeback
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                size="sm"
                onClick={() =>
                  setActionError("Clock adjustments aren't implemented.")
                }
              >
                <Timer className="w-4 h-4" /> Give time
              </Button>
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
            </div>

            <div className="flex-1 overflow-hidden relative flex flex-col">
              {activeTab === "chat" ? (
                <>
                  <div className="flex p-2 gap-1 bg-muted/30 flex-shrink-0">
                    {(["game", "team", "audience"] as const).map((channel) => (
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
                    ))}
                  </div>
                  <ScrollArea className="flex-1 p-4">
                    <div className="space-y-3">
                      {messages
                        .filter(
                          (message) =>
                            message.channel === chatChannel || message.isSystem
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
                      {gameSnapshot.history
                        .reduce((acc: any[], move, index) => {
                          if (index % 2 === 0) {
                            acc.push({
                              num: move.number,
                              white: move,
                              black: null,
                            });
                          } else {
                            acc[acc.length - 1].black = move;
                          }
                          return acc;
                        }, [])
                        .map((row, index) => (
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
                              {row.white?.notation}
                            </button>
                            <button className="p-2 hover:bg-accent text-center transition-colors font-mono">
                              {row.black?.notation}
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
  );
}

function PlayerInfo({
  player,
  isActive,
  timeLeft,
}: {
  player: GamePlayer;
  isActive: boolean;
  timeLeft: number;
}) {
  return (
    <div
      className={`flex items-center justify-between p-3 rounded-lg transition-colors shadow-sm ${
        isActive
          ? "bg-accent/50 border border-accent"
          : "bg-card/50 backdrop-blur border border-border"
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center ${
            player.color === "red"
              ? "bg-red-100 text-red-700"
              : "bg-blue-100 text-blue-700"
          }`}
        >
          {player.type.includes("bot") ? <Bot size={20} /> : <User size={20} />}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{player.name}</span>
            <Badge variant="outline" className="text-xs">
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
      </div>
      <div
        className={`text-2xl font-mono font-bold ${
          isActive ? "text-foreground" : "text-muted-foreground/50"
        } ${timeLeft < 30 ? "text-red-500 animate-pulse" : ""}`}
      >
        {formatTime(Math.max(0, Math.round(timeLeft)))}
      </div>
    </div>
  );
}
