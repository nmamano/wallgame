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
  X,
} from "lucide-react";
import { Board, type BoardProps, type Arrow } from "@/components/board";
import {
  MatchingStagePanel,
  type MatchingPlayer,
} from "@/components/matching-stage-panel";
import {
  Cell,
  Wall,
  type PlayerId,
  Move,
  Action,
  TimeControl as GameTimeControl,
  getAiMove,
  type PlayerWall,
} from "@/lib/game";
import { GameState, type GameResult, type GameConfig } from "@/lib/game-state";
import type { PlayerColor } from "@/lib/player-colors";
import type { PlayerType } from "@/components/player-configuration";
import type { GameConfiguration } from "@/components/game-configuration-panel";
import type { TimeControlPreset } from "@/lib/game";
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

function mapTimeControl(control: TimeControlPreset): GameTimeControl {
  return GameTimeControl.fromPreset(control);
}

function buildPlayerName(
  type: PlayerType,
  index: number,
  username?: string
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
  if (a.target.row !== b.target.row || a.target.col !== b.target.col)
    return false;
  if (a.type === "wall") {
    return a.wallOrientation === b.wallOrientation;
  }
  return true;
};

const buildDoubleStepPaths = (
  pawnType: "cat" | "mouse",
  from: Cell,
  to: Cell
): Action[][] => {
  const paths: Action[][] = [];
  const rowDiff = Math.abs(from.row - to.row);
  const colDiff = Math.abs(from.col - to.col);
  const distance = rowDiff + colDiff;
  if (distance !== 2) {
    return paths;
  }

  if (from.row === to.row) {
    // Horizontal double step
    const midCol = (from.col + to.col) / 2;
    paths.push([
      new Action(pawnType, new Cell(from.row, midCol)),
      new Action(pawnType, to),
    ]);
    return paths;
  }

  if (from.col === to.col) {
    // Vertical double step
    const midRow = (from.row + to.row) / 2;
    paths.push([
      new Action(pawnType, new Cell(midRow, from.col)),
      new Action(pawnType, to),
    ]);
    return paths;
  }

  // L-shaped double step (one row, one column)
  paths.push([
    new Action(pawnType, new Cell(from.row, to.col)),
    new Action(pawnType, to),
  ]);
  paths.push([
    new Action(pawnType, new Cell(to.row, from.col)),
    new Action(pawnType, to),
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

const DEFAULT_PLAYER_COLORS: Record<PlayerId, PlayerColor> = {
  1: "red",
  2: "blue",
};

const resolvePlayerColor = (value?: string | null): PlayerColor => {
  if (!value || value === "default") {
    return "red";
  }
  return value;
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
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [lastMove, setLastMove] = useState<
    BoardProps["lastMove"] | BoardProps["lastMoves"]
  >(undefined);
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
  const [stagedActions, setStagedActions] = useState<Action[]>([]);

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

  const simulateMove = useCallback(
    (actions: Action[]): GameState | null => {
      if (!gameState) return null;
      if (actions.length === 0) {
        return gameState;
      }
      try {
        return gameState.applyGameAction({
          kind: "move",
          move: new Move(actions),
          playerId: localPlayerId,
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error("Failed to simulate staged actions", error);
        return null;
      }
    },
    [gameState, localPlayerId]
  );

  const previewState = useMemo(
    () => (stagedActions.length ? simulateMove(stagedActions) : null),
    [stagedActions, simulateMove]
  );

  const stagedWallOverlays = useMemo<PlayerWall[]>(() => {
    if (!stagedActions.length) return [];
    return stagedActions
      .filter((action) => action.type === "wall")
      .map((action) => ({
        wall: new Wall(action.target, action.wallOrientation!),
        playerId: localPlayerId,
        state: "staged" as const,
      }));
  }, [stagedActions, localPlayerId]);

  const boardWalls = useMemo<PlayerWall[]>(() => {
    const base = gameState ? gameState.getWalls() : [];
    if (!stagedWallOverlays.length) {
      return base;
    }
    return [...base, ...stagedWallOverlays];
  }, [gameState, stagedWallOverlays]);

  const boardPawns = useMemo(() => {
    const sourceState = previewState ?? gameState;
    if (!sourceState) return [];
    const normalizedCat =
      preferredCatSkin && preferredCatSkin !== "default"
        ? preferredCatSkin
        : undefined;
    const normalizedMouse =
      preferredMouseSkin && preferredMouseSkin !== "default"
        ? preferredMouseSkin
        : undefined;
    const basePawns = sourceState.getPawns().map((pawn) => {
      if (pawn.playerId !== localPlayerId) {
        return pawn;
      }
      const preferred = pawn.type === "mouse" ? normalizedMouse : normalizedCat;
      return preferred ? { ...pawn, pawnStyle: preferred } : pawn;
    });
    if (!stagedActions.length) {
      return basePawns;
    }
    const stagedPawnTypes = new Set(
      stagedActions
        .filter((action) => action.type === "cat" || action.type === "mouse")
        .map((action) => action.type)
    );
    return basePawns.map((pawn) => {
      if (pawn.playerId === localPlayerId && stagedPawnTypes.has(pawn.type)) {
        return { ...pawn, previewState: "staged" as const };
      }
      return pawn;
    });
  }, [
    previewState,
    gameState,
    stagedActions,
    localPlayerId,
    preferredCatSkin,
    preferredMouseSkin,
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

        if (beforeState && afterState) {
          const pawnType = action1.type;
          const fromCell =
            pawnType === "cat"
              ? beforeState.pawns[localPlayerId].cat
              : beforeState.pawns[localPlayerId].mouse;
          const toCell =
            pawnType === "cat"
              ? afterState.pawns[localPlayerId].cat
              : afterState.pawns[localPlayerId].mouse;

          return [
            {
              from: new Cell(fromCell.row, fromCell.col),
              to: new Cell(toCell.row, toCell.col),
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
      if (!beforeState || !afterState) return;
      const fromCell =
        action.type === "cat"
          ? beforeState.pawns[localPlayerId].cat
          : beforeState.pawns[localPlayerId].mouse;
      const toCell =
        action.type === "cat"
          ? afterState.pawns[localPlayerId].cat
          : afterState.pawns[localPlayerId].mouse;
      arrows.push({
        from: new Cell(fromCell.row, fromCell.col),
        to: new Cell(toCell.row, toCell.col),
        type: "staged",
      });
    });
    return arrows;
  }, [gameState, stagedActions, localPlayerId, simulateMove]);

  const gameStatus = gameState?.status ?? "playing";
  const gameTurn = gameState?.turn ?? 1;
  const gameResult = gameState?.result;

  const formattedHistory = useMemo(() => {
    if (!gameState) return [];
    const rows = gameState.config.boardHeight;
    const entries = gameState.history.map((entry) => ({
      number: Math.ceil(entry.index / 2),
      notation: entry.move.toNotation(rows),
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
      gameStateRef.current = nextState;

      // Calculate last moves by comparing pawn positions
      const moves: BoardProps["lastMoves"] = [];
      const playerColor =
        playerColorsForBoard[playerId] ?? DEFAULT_PLAYER_COLORS[playerId];

      // Check Cat
      const catBefore = currentState.pawns[playerId].cat;
      const catAfter = nextState.pawns[playerId].cat;
      if (catBefore.row !== catAfter.row || catBefore.col !== catAfter.col) {
        moves.push({
          fromRow: catBefore.row,
          fromCol: catBefore.col,
          toRow: catAfter.row,
          toCol: catAfter.col,
          playerColor,
        });
      }

      // Check Mouse
      const mouseBefore = currentState.pawns[playerId].mouse;
      const mouseAfter = nextState.pawns[playerId].mouse;
      if (
        mouseBefore.row !== mouseAfter.row ||
        mouseBefore.col !== mouseAfter.col
      ) {
        moves.push({
          fromRow: mouseBefore.row,
          fromCol: mouseBefore.col,
          toRow: mouseAfter.row,
          toCol: mouseAfter.col,
          playerColor,
        });
      }

      // If we have moves, set them. Otherwise clear.
      if (moves.length > 0) {
        // We use setLastMove for backward compatibility if needed, but we should probably use a new state for lastMoves
        // Since Board accepts lastMoves, we can pass it.
        // But wait, I need to store lastMoves in state.
        // I'll update the state variable name or just store it in lastMove (as an array cast? No, type safety).
        // I'll update the state definition in the component.
        // For now, let's assume I'll rename the state or add a new one.
        // Actually, I can just use the existing setLastMove if I change the type of lastMove state.
        // But I can't change the type in this replacement block easily without changing the state definition.
        // So I will cast it for now and update the state definition in a separate step or assume I will do it.
        // Wait, I can't cast it here if the state type is strict.
        // I should update the state definition first.
        // But I am in applyMove.
        // Let's assume I will update the state definition to be LastMove | LastMove[] | undefined.
        setLastMove(moves);
      } else {
        setLastMove(undefined);
      }

      setGameState(nextState);
      if (soundEnabled) {
        playSound("move");
      }
    },
    [playerColorsForBoard, soundEnabled]
  );

  const commitStagedActions = useCallback(
    (actions?: Action[]) => {
      const moveActions = actions ?? stagedActions;
      if (!moveActions.length) return;
      if (!gameState) {
        setActionError("Game is still loading");
        return;
      }
      try {
        applyMove(localPlayerId, new Move(moveActions));
        setStagedActions([]);
        setSelectedPawnId(null);
        setDraggingPawnId(null);
        setActionError(null);
      } catch (error) {
        console.error(error);
        setActionError(
          error instanceof Error ? error.message : "Move could not be applied."
        );
      }
    },
    [stagedActions, gameState, applyMove, localPlayerId]
  );

  const undoStagedAction = useCallback(() => {
    setStagedActions((prev) => prev.slice(0, -1));
    setActionError(null);
    setSelectedPawnId(null);
  }, []);

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
      setStagedActions([]);

      const initialPlayers: GamePlayer[] = sanitizedPlayers.map(
        (type, index) => ({
          id: `p${index + 1}`,
          playerId: (index + 1) as PlayerId,
          name: buildPlayerName(type, index, settings.displayName),
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

      setGameState(state);

      addSystemMessage(
        waiting ? "Waiting for players..." : "Game created. Good luck!"
      );
    },
    [addSystemMessage, localPlayerId, preferredPawnColor, settings.displayName]
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

    initializeGame(resolvedConfig, resolvedPlayers);
    setIsLoadingConfig(false);

    return () => {
      if (aiTimeoutRef.current) {
        clearTimeout(aiTimeoutRef.current);
        aiTimeoutRef.current = null;
      }
      gameStateRef.current = null;
      setGameState(null);
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
    if (!gameState) return;
    if (gameState.turn !== localPlayerId && stagedActions.length > 0) {
      setStagedActions([]);
    }
  }, [gameState, localPlayerId, stagedActions.length]);

  const stagePawnAction = useCallback(
    (pawnId: string, targetRow: number, targetCol: number) => {
      if (interactionLocked) return;
      if (gameState?.status !== "playing") return;
      if (gameState.turn !== localPlayerId) return;

      const pawn = boardPawns.find((p) => p.id === pawnId);
      if (pawn?.playerId !== localPlayerId) return;
      const pawnType = pawn.type;
      const targetCell = new Cell(targetRow, targetCol);
      const newAction = new Action(pawnType, targetCell);
      const duplicateIndex = stagedActions.findIndex((existing) =>
        actionsEqual(existing, newAction)
      );
      if (duplicateIndex !== -1) {
        removeStagedAction(duplicateIndex);
        setSelectedPawnId(null);
        setDraggingPawnId(null);
        return;
      }

      if (pawn.cell.row === targetRow && pawn.cell.col === targetCol) return;

      const distance =
        Math.abs(pawn.cell.row - targetRow) +
        Math.abs(pawn.cell.col - targetCol);
      const isDoubleStep = distance === 2;
      if (isDoubleStep) {
        if (stagedActions.length > 0) {
          setActionError(
            "You can't make a double move after staging another action."
          );
          return;
        }
        const candidatePaths = buildDoubleStepPaths(
          pawnType,
          pawn.cell,
          targetCell
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
        setActionError("That move sequence is not legal.");
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
      localPlayerId,
    ]
  );

  const handleWallClick = useCallback(
    (row: number, col: number, orientation: "horizontal" | "vertical") => {
      if (interactionLocked) return;
      if (gameState?.status !== "playing") return;
      if (gameState.turn !== localPlayerId) return;

      const newAction = new Action("wall", new Cell(row, col), orientation);
      const duplicateIndex = stagedActions.findIndex((existing) =>
        actionsEqual(existing, newAction)
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
      localPlayerId,
      stagedActions,
      simulateMove,
      commitStagedActions,
      removeStagedAction,
    ]
  );

  const triggerAiMove = useCallback(() => {
    if (!aiEnabled || botPlayerId == null) return;
    const state = gameStateRef.current;
    if (state?.status !== "playing" || state.turn !== botPlayerId) return;

    if (aiTimeoutRef.current) {
      clearTimeout(aiTimeoutRef.current);
      aiTimeoutRef.current = null;
    }

    setAiThinking(true);
    aiTimeoutRef.current = window.setTimeout(() => {
      void (async () => {
        const current = gameStateRef.current;
        if (current?.turn !== botPlayerId || current.status !== "playing") {
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
      })();
    }, 600);
  }, [aiEnabled, botPlayerId, applyMove]);

  useEffect(() => {
    if (!aiEnabled || botPlayerId == null) return;
    if (gameState?.status !== "playing") return;
    if (gameState.turn !== botPlayerId) return;
    if (stagedActions.length > 0) return;
    triggerAiMove();
  }, [aiEnabled, botPlayerId, triggerAiMove, gameState, stagedActions.length]);

  useEffect(() => {
    if (gameState?.status !== "finished" || !gameState.result) return;
    const result = gameState.result;
    if (result.winner) {
      const player =
        playersRef.current.find((p) => p.playerId === result.winner) ?? null;
      addSystemMessage(
        player
          ? `${player.name} won by ${formatWinReason(result.reason)}.`
          : `Game finished by ${formatWinReason(result.reason)}.`
      );
    } else {
      addSystemMessage(`Game drawn (${formatWinReason(result.reason)}).`);
    }
  }, [gameState, addSystemMessage]);

  const handlePawnClick = useCallback(
    (pawnId: string) => {
      if (gameState?.status !== "playing") return;
      const pawn = boardPawns.find((p) => p.id === pawnId);
      if (pawn?.playerId !== localPlayerId) return;
      setSelectedPawnId(pawnId);
      setActionError(null);
    },
    [gameState, boardPawns, localPlayerId]
  );

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!selectedPawnId) {
        const pawn = boardPawns.find(
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
      stagePawnAction(selectedPawnId, row, col);
    },
    [selectedPawnId, boardPawns, localPlayerId, stagePawnAction]
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
      stagePawnAction(draggingPawnId, row, col);
      setDraggingPawnId(null);
    },
    [draggingPawnId, stagePawnAction]
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

  const playSound = () => {
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
              isActive={gameTurn === players[1].playerId}
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
            {gameStatus === "finished" && (
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
            />
          </div>

          {stagedActions.length > 0 && (
            <div className="bg-card/60 border border-dashed border-amber-300 rounded-xl p-3 flex flex-col gap-3">
              <div className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                Staged actions (click to remove)
              </div>
              <div className="flex flex-wrap gap-2">
                {stagedActions.map((action, index) => (
                  <button
                    key={`${action.type}-${index}-${action.target.row}-${action.target.col}`}
                    onClick={() => removeStagedAction(index)}
                    className="flex items-center gap-2 px-3 py-1 text-sm rounded-full bg-amber-200/80 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100 border border-amber-300 hover:bg-amber-300/80 transition-colors"
                  >
                    <span className="font-mono">
                      {index + 1}. {action.toNotation(rows)}
                    </span>
                    <X className="w-3 h-3" />
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={undoStagedAction}
                  disabled={stagedActions.length === 0}
                >
                  Undo last
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={clearStagedActions}
                  disabled={stagedActions.length === 0}
                >
                  Clear
                </Button>
                <Button
                  size="sm"
                  onClick={() => commitStagedActions()}
                  disabled={stagedActions.length === 0}
                >
                  Finish move
                </Button>
              </div>
            </div>
          )}

          {/* Bottom Player (You) Timer */}
          {players.length > 0 && (
            <PlayerInfo
              player={players[0]}
              isActive={gameTurn === players[0].playerId}
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
