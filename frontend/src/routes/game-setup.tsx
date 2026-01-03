import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PlayerConfiguration } from "@/components/player-configuration";
import { ReadyToJoinTable } from "@/components/ready-to-join-table";
import type { GameConfiguration } from "../../../shared/domain/game-types";
import type {
  TimeControlPreset,
  Variant,
  GameSnapshot,
} from "../../../shared/domain/game-types";
import { timeControlConfigFromPreset } from "../../../shared/domain/game-utils";
import {
  FREESTYLE_BOARD_HEIGHT,
  FREESTYLE_BOARD_WIDTH,
  normalizeFreestyleConfig,
} from "../../../shared/domain/freestyle-setup";
import { Input } from "@/components/ui/input";
import type { PlayerType } from "@/lib/gameViewModel";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Info, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { userQueryOptions, fetchMatchmakingGames } from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";
import { createGameSession, joinGameSession } from "@/lib/api";
import { saveGameHandshake, clearGameHandshake } from "@/lib/game-session";
import { usePlayVsBotMutation } from "@/hooks/use-bots";

export const Route = createFileRoute("/game-setup")({
  component: GameSetup,
});

// Helper function to determine number of players based on variant
function getPlayerCountForVariant(variant: Variant): number {
  // For now, assume all variants support 2 players
  // This can be extended later for variants with more players
  switch (variant) {
    case "standard":
    case "classic":
    case "freestyle":
      return 2;
    default:
      return 2;
  }
}

// Helper function to get default player type for other players based on mode
function getDefaultOtherPlayerType(mode?: string): PlayerType {
  switch (mode) {
    case "vs-ai":
      // In V2, bots are selected from the bots table, not as a player type
      return "you";
    case "with-others":
      return "matched-user";
    case "invite-friend":
      return "friend";
    default:
      return "you";
  }
}

function buildDefaultPlayerConfigs(
  variant: Variant,
  mode?: string,
): PlayerType[] {
  const playerCount = getPlayerCountForVariant(variant);
  const defaultOtherPlayerType = getDefaultOtherPlayerType(mode);
  const newConfigs: PlayerType[] = Array.from(
    { length: playerCount },
    () => defaultOtherPlayerType,
  );
  newConfigs[0] = "you";
  return newConfigs;
}

const PLAYER_B_BASE_OPTIONS: PlayerType[] = ["friend", "matched-user"];

const PLAYER_B_ALLOWED_OPTIONS: PlayerType[] = [
  "you",
  ...PLAYER_B_BASE_OPTIONS,
];

const BOARD_SIZE_MIN = 4;
const BOARD_SIZE_MAX = 20;

const isBoardSizeDraft = (value: string): boolean => {
  if (!/^\d{0,2}$/.test(value)) {
    return false;
  }
  if (value === "") {
    return true;
  }
  const numeric = Number(value);
  if (numeric >= BOARD_SIZE_MIN && numeric <= BOARD_SIZE_MAX) {
    return true;
  }
  return value.length === 1 && (value === "1" || value === "2");
};

const clampBoardSize = (value: number): number =>
  Math.min(Math.max(value, BOARD_SIZE_MIN), BOARD_SIZE_MAX);

// Type for tracking which fields don't match
interface GameMatchStatus {
  variant: boolean;
  rated: boolean;
  timeControl: boolean;
  boardSize: boolean;
  allMatch: boolean;
}

// Extended type with match status
interface GameWithMatchStatus extends GameSnapshot {
  matchStatus: GameMatchStatus;
}

function GameSetup() {
  // Get mode from sessionStorage (set when navigating from landing page)
  // This avoids showing it in the URL
  const [mode] = useState<string | undefined>(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("game-setup-mode") ?? undefined;
    }
    return undefined;
  });

  // Clear mode from sessionStorage after reading it
  useEffect(() => {
    if (typeof window !== "undefined" && mode) {
      sessionStorage.removeItem("game-setup-mode");
    }
  }, [mode]);

  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;
  const settings = useSettings(isLoggedIn, userPending);
  const [isCreatingGame, setIsCreatingGame] = useState(false);
  const [createGameError, setCreateGameError] = useState<string | null>(null);
  const [botGameError, setBotGameError] = useState<string | null>(null);
  const playVsBotMutation = usePlayVsBotMutation();

  // TODO: Get user rating from API when backend is ready
  // Ratings are variant and time control specific, so we'll need to fetch the appropriate rating

  // Game configuration state - initialize from user settings
  const [gameConfig, setGameConfig] = useState<GameConfiguration>(() => {
    // Use settings from useSettings hook, fallback to defaults
    return settings.gameConfig;
  });

  // Update game config when settings are loaded (only once on initial load)
  const [hasInitialized, setHasInitialized] = useState(false);
  useEffect(() => {
    if (!hasInitialized && !settings.isLoadingSettings) {
      setGameConfig(settings.gameConfig);
      setHasInitialized(true);
    }
    // Only depend on isLoadingSettings and hasInitialized - don't watch settings.gameConfig
    // to prevent resetting user changes when variant or other settings change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.isLoadingSettings, hasInitialized]);

  const [boardWidthInput, setBoardWidthInput] = useState(() =>
    String(gameConfig.boardWidth),
  );
  const [boardHeightInput, setBoardHeightInput] = useState(() =>
    String(gameConfig.boardHeight),
  );

  useEffect(() => {
    setBoardWidthInput(String(gameConfig.boardWidth));
  }, [gameConfig.boardWidth]);

  useEffect(() => {
    setBoardHeightInput(String(gameConfig.boardHeight));
  }, [gameConfig.boardHeight]);

  // Player configurations state
  const [playerConfigs, setPlayerConfigs] = useState<PlayerType[]>(() =>
    buildDefaultPlayerConfigs(gameConfig.variant, mode),
  );

  // Initialize player configs based on variant and mode
  useEffect(() => {
    setPlayerConfigs(buildDefaultPlayerConfigs(gameConfig.variant, mode));
  }, [gameConfig.variant, mode]);

  const playerBLabelOverrides = { you: "Also you" } as const;

  // Check if rated games are allowed (only vs friend/matched user, no bots)
  const canRatedGame = useMemo(() => {
    const hasFriend = playerConfigs.includes("friend");
    const hasMatchedUser = playerConfigs.includes("matched-user");

    // Rated games are only allowed if:
    // - The other player is "friend" or "matched-user"
    return (hasFriend || hasMatchedUser) && playerConfigs.length === 2;
  }, [playerConfigs]);

  // Update rated status when player configs change or when not logged in
  useEffect(() => {
    if ((!canRatedGame || !isLoggedIn) && gameConfig.rated) {
      setGameConfig((prev: GameConfiguration) => ({ ...prev, rated: false }));
    }
  }, [canRatedGame, isLoggedIn, gameConfig.rated]);

  // Update player configs when variant changes
  const handleGameConfigChange = (newConfig: GameConfiguration) => {
    // Prevent setting rated to true if not allowed
    const finalRated = canRatedGame && isLoggedIn ? newConfig.rated : false;
    const normalizedConfig = normalizeFreestyleConfig({
      ...newConfig,
      rated: finalRated,
    });
    setGameConfig(normalizedConfig);

    // If variant changed, reset player configs (preserving mode-based defaults)
    if (normalizedConfig.variant !== gameConfig.variant) {
      setPlayerConfigs(
        buildDefaultPlayerConfigs(normalizedConfig.variant, mode),
      );
    }
  };

  const handleBoardWidthChange = (nextValue: string) => {
    if (!isBoardSizeDraft(nextValue)) {
      return;
    }

    if (nextValue === "") {
      setBoardWidthInput(nextValue);
      return;
    }

    const numeric = Number(nextValue);
    if (numeric >= BOARD_SIZE_MIN && numeric <= BOARD_SIZE_MAX) {
      setBoardWidthInput(String(numeric));
      if (numeric !== gameConfig.boardWidth) {
        handleGameConfigChange({ ...gameConfig, boardWidth: numeric });
      }
      return;
    }

    setBoardWidthInput(nextValue);
  };

  const handleBoardHeightChange = (nextValue: string) => {
    if (!isBoardSizeDraft(nextValue)) {
      return;
    }

    if (nextValue === "") {
      setBoardHeightInput(nextValue);
      return;
    }

    const numeric = Number(nextValue);
    if (numeric >= BOARD_SIZE_MIN && numeric <= BOARD_SIZE_MAX) {
      setBoardHeightInput(String(numeric));
      if (numeric !== gameConfig.boardHeight) {
        handleGameConfigChange({ ...gameConfig, boardHeight: numeric });
      }
      return;
    }

    setBoardHeightInput(nextValue);
  };

  const commitBoardWidth = () => {
    if (boardWidthInput === "") {
      setBoardWidthInput(String(gameConfig.boardWidth));
      return;
    }

    const numeric = Number(boardWidthInput);
    if (!Number.isFinite(numeric)) {
      setBoardWidthInput(String(gameConfig.boardWidth));
      return;
    }

    const clamped = clampBoardSize(numeric);
    setBoardWidthInput(String(clamped));
    if (clamped !== gameConfig.boardWidth) {
      handleGameConfigChange({ ...gameConfig, boardWidth: clamped });
    }
  };

  const commitBoardHeight = () => {
    if (boardHeightInput === "") {
      setBoardHeightInput(String(gameConfig.boardHeight));
      return;
    }

    const numeric = Number(boardHeightInput);
    if (!Number.isFinite(numeric)) {
      setBoardHeightInput(String(gameConfig.boardHeight));
      return;
    }

    const clamped = clampBoardSize(numeric);
    setBoardHeightInput(String(clamped));
    if (clamped !== gameConfig.boardHeight) {
      handleGameConfigChange({ ...gameConfig, boardHeight: clamped });
    }
  };

  const navigate = Route.useNavigate();

  const handleCreateGame = async () => {
    setCreateGameError(null);
    setBotGameError(null);
    const isFriendGame = playerConfigs.includes("friend");
    const isMatchmakingGame = playerConfigs.includes("matched-user");

    if (isFriendGame || isMatchmakingGame) {
      setIsCreatingGame(true);
      try {
        const matchType = isMatchmakingGame ? "matchmaking" : "friend";
        const response = await createGameSession({
          config: gameConfig,
          matchType,
          hostDisplayName: settings.displayName,
          hostAppearance: {
            pawnColor: settings.pawnColor,
            catSkin: settings.catPawn,
            mouseSkin: settings.mousePawn,
            homeSkin: settings.homePawn,
          },
        });
        // Get host's playerId from the snapshot (server randomly assigns Player 1 or 2)
        const hostPlayer = response.snapshot.players.find(
          (p) => p.role === "host",
        );
        const hostPlayerId = hostPlayer?.playerId ?? 1;
        saveGameHandshake({
          gameId: response.gameId,
          token: response.hostToken,
          socketToken: response.socketToken,
          role: "host",
          playerId: hostPlayerId,
          shareUrl: response.shareUrl,
        });
        void navigate({ to: `/game/${response.gameId}` });
      } catch (error) {
        setCreateGameError(
          error instanceof Error
            ? error.message
            : "Unable to create game right now.",
        );
      } finally {
        setIsCreatingGame(false);
      }
      return;
    }

    // Local games (you vs you, etc.)
    const gameId = Math.random().toString(36).substring(2, 15);
    if (typeof window !== "undefined") {
      sessionStorage.setItem(
        `game-config-${gameId}`,
        JSON.stringify({
          config: gameConfig,
          players: playerConfigs,
        }),
      );
    }
    void navigate({ to: `/game/${gameId}` });
  };

  // Matchmaking games state - fetched via WebSocket for real-time updates
  const [matchmakingGames, setMatchmakingGames] = useState<GameSnapshot[]>([]);
  const [isLoadingGames, setIsLoadingGames] = useState(true);
  const lobbySocketRef = useRef<WebSocket | null>(null);
  const [isJoiningGame, setIsJoiningGame] = useState<string | null>(null);

  // Build WebSocket URL for lobby
  const buildLobbySocketUrl = useCallback((): string => {
    const base = new URL(window.location.origin);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/ws/lobby";
    return base.toString();
  }, []);

  // Connect to lobby WebSocket for real-time game list updates
  useEffect(() => {
    if (typeof window === "undefined") return;

    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let isCleanedUp = false;

    const connect = () => {
      if (isCleanedUp) return;

      // Close existing connection if any
      if (lobbySocketRef.current) {
        lobbySocketRef.current.close();
        lobbySocketRef.current = null;
      }

      const url = buildLobbySocketUrl();
      console.debug("[game-setup] connecting to lobby websocket", { url });

      try {
        const socket = new WebSocket(url);
        lobbySocketRef.current = socket;

        socket.addEventListener("open", () => {
          console.debug("[game-setup] lobby websocket open");
          setIsLoadingGames(false);
        });

        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          try {
            const msg = JSON.parse(event.data) as {
              type: string;
              games?: GameSnapshot[];
            };
            if (msg.type === "games" && msg.games) {
              setMatchmakingGames(msg.games);
            }
          } catch (error) {
            console.error("[game-setup] failed to parse lobby message", error);
          }
        });

        socket.addEventListener("close", (event) => {
          console.debug("[game-setup] lobby websocket closed", {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
          lobbySocketRef.current = null;

          // Only reconnect if not cleaned up and not a normal closure
          if (!isCleanedUp && event.code !== 1000) {
            reconnectTimeout = setTimeout(connect, 2000);
          }
        });

        socket.addEventListener("error", (event) => {
          console.error("[game-setup] lobby websocket error", event);
          setIsLoadingGames(false);
          // Error will be followed by close event, which will handle reconnection
        });
      } catch (error) {
        console.error("[game-setup] failed to create websocket", error);
        setIsLoadingGames(false);
        if (!isCleanedUp) {
          reconnectTimeout = setTimeout(connect, 2000);
        }
      }
    };

    // Small delay to ensure page is fully loaded before connecting
    const initialTimeout = setTimeout(connect, 100);

    // Also fetch initially via REST in case WebSocket is slow
    void fetchMatchmakingGames()
      .then((games) => {
        setMatchmakingGames(games);
        setIsLoadingGames(false);
      })
      .catch((error) => {
        console.error("[game-setup] failed to fetch matchmaking games", error);
        setIsLoadingGames(false);
      });

    return () => {
      isCleanedUp = true;
      clearTimeout(initialTimeout);
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (lobbySocketRef.current) {
        lobbySocketRef.current.close(1000, "Component unmounting");
        lobbySocketRef.current = null;
      }
    };
  }, [buildLobbySocketUrl]);

  // Check match status and sort games (matching first, then non-matching)
  const filteredAndSortedGames = useMemo(() => {
    // Map games to include match status
    const gamesWithStatus: GameWithMatchStatus[] = matchmakingGames.map(
      (game) => {
        const variantMatch =
          !gameConfig.variant || game.config.variant === gameConfig.variant;
        const ratedMatch =
          gameConfig.rated === undefined ||
          game.config.rated === gameConfig.rated;
        const timeControlMatch = !!(
          game.config.timeControl.preset &&
          gameConfig.timeControl.preset &&
          game.config.timeControl.preset === gameConfig.timeControl.preset
        );
        const boardSizeMatch =
          !gameConfig.boardWidth ||
          !gameConfig.boardHeight ||
          (game.config.boardWidth === gameConfig.boardWidth &&
            game.config.boardHeight === gameConfig.boardHeight);

        const allMatch =
          variantMatch && ratedMatch && timeControlMatch && boardSizeMatch;

        return {
          ...game,
          matchStatus: {
            variant: variantMatch,
            rated: ratedMatch,
            timeControl: timeControlMatch,
            boardSize: boardSizeMatch,
            allMatch,
          },
        };
      },
    );

    // Sort: matching games first, then by time created (older first)
    gamesWithStatus.sort((a, b) => {
      // First, prioritize matching games
      if (a.matchStatus.allMatch !== b.matchStatus.allMatch) {
        return a.matchStatus.allMatch ? -1 : 1;
      }

      // Prioritize older games (longer in matching stage)
      return a.createdAt - b.createdAt;
    });

    return gamesWithStatus;
  }, [matchmakingGames, gameConfig]);

  const handleJoinGame = async (gameId: string) => {
    if (isJoiningGame) return;
    setIsJoiningGame(gameId);
    setCreateGameError(null);
    setBotGameError(null);

    try {
      const response = await joinGameSession({
        gameId,
        displayName: settings.displayName,
        appearance: {
          pawnColor: settings.pawnColor,
          catSkin: settings.catPawn,
          mouseSkin: settings.mousePawn,
          homeSkin: settings.homePawn,
        },
      });
      if (response.kind === "spectator") {
        clearGameHandshake(gameId);
        void navigate({ to: `/game/${gameId}` });
        return;
      }

      saveGameHandshake({
        gameId,
        token: response.token,
        socketToken: response.socketToken,
        role: response.role,
        playerId: response.playerId,
        shareUrl: response.shareUrl,
      });

      void navigate({ to: `/game/${gameId}` });
    } catch (error) {
      setCreateGameError(
        error instanceof Error
          ? error.message
          : "Unable to join game right now.",
      );
    } finally {
      setIsJoiningGame(null);
    }
  };

  const handlePlayBot = async (args: {
    botId: string;
    config: GameConfiguration;
  }) => {
    if (playVsBotMutation.isPending) return;
    setBotGameError(null);
    try {
      const response = await playVsBotMutation.mutateAsync({
        botId: args.botId,
        config: args.config,
        hostDisplayName: settings.displayName,
        hostAppearance: {
          pawnColor: settings.pawnColor,
          catSkin: settings.catPawn,
          mouseSkin: settings.mousePawn,
          homeSkin: settings.homePawn,
        },
      });

      saveGameHandshake({
        gameId: response.gameId,
        token: response.token,
        socketToken: response.socketToken,
        role: response.role,
        playerId: response.playerId,
        shareUrl: response.shareUrl,
      });
      void navigate({ to: `/game/${response.gameId}` });
    } catch (error) {
      setBotGameError(
        error instanceof Error
          ? error.message
          : "Unable to start a bot game right now.",
      );
    }
  };

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="max-w-5xl mx-auto">
        <div className="space-y-6">
          {/* Create Game Section */}
          <Card className="p-5 border-border/50 bg-card/50 backdrop-blur">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
              {/* Row 1: Title */}
              <div>
                <h2 className="text-2xl font-semibold">Create game</h2>
              </div>

              {/* Row 1: Rated Status */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label htmlFor="rated" className="min-w-[120px]">
                    Rated Status
                  </Label>
                  <Switch
                    id="rated"
                    checked={gameConfig.rated}
                    onCheckedChange={(checked) => {
                      if ((!isLoggedIn || !canRatedGame) && checked) {
                        return;
                      }
                      handleGameConfigChange({ ...gameConfig, rated: checked });
                    }}
                    disabled={!isLoggedIn || !canRatedGame}
                  />
                </div>
                {/* Always render text container to prevent layout shift */}
                <div className="min-h-[3rem]">
                  {!isLoggedIn && (
                    <Alert className="mb-2">
                      <Info className="h-4 w-4" />
                      <AlertDescription>
                        You need to be logged in to play rated games.
                      </AlertDescription>
                    </Alert>
                  )}
                  {!isLoggedIn || !canRatedGame ? (
                    <p className="text-sm text-muted-foreground">
                      Rated games are only available vs friends or matched
                      players.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {gameConfig.rated
                        ? "The game will affect your rating."
                        : "The game will not affect your rating."}
                    </p>
                  )}
                </div>
              </div>

              {/* Row 2: Player A */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label className="min-w-[100px]">Seat A</Label>
                  <div className="flex h-10 w-[200px] items-center rounded-md border border-input bg-background px-3 text-sm text-foreground">
                    You
                  </div>
                </div>
                <div className="min-h-[3rem]">
                  <p className="text-sm text-muted-foreground">
                    {"You'll make the moves."}
                  </p>
                </div>
              </div>

              {/* Row 2: Time Control */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label htmlFor="time-control" className="min-w-[120px]">
                    Time Control
                  </Label>
                  <Select
                    value={gameConfig.timeControl.preset ?? "blitz"}
                    onValueChange={(value: TimeControlPreset) =>
                      handleGameConfigChange({
                        ...gameConfig,
                        timeControl: timeControlConfigFromPreset(value),
                      })
                    }
                  >
                    <SelectTrigger
                      id="time-control"
                      className="bg-background w-[200px]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bullet">Bullet (1+0)</SelectItem>
                      <SelectItem value="blitz">Blitz (3+2)</SelectItem>
                      <SelectItem value="rapid">Rapid (10+2)</SelectItem>
                      <SelectItem value="classical">
                        Classical (30+0)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {/* Always render text container to prevent layout shift */}
                <div className="min-h-[3rem]">
                  <p className="text-sm text-muted-foreground">
                    {gameConfig.timeControl.preset === "bullet" &&
                      "1 minute, no increment."}
                    {gameConfig.timeControl.preset === "blitz" &&
                      "3 minutes, 2 second increment."}
                    {gameConfig.timeControl.preset === "rapid" &&
                      "10 minutes, 2 second increment."}
                    {gameConfig.timeControl.preset === "classical" &&
                      "30 minutes, no increment."}
                  </p>
                </div>
              </div>

              {/* Row 3: Player B */}
              <div>
                <PlayerConfiguration
                  label="Seat B"
                  value={playerConfigs[1]}
                  onChange={(value) => {
                    const newConfigs = [...playerConfigs];
                    newConfigs[1] = value;
                    setPlayerConfigs(newConfigs);
                  }}
                  allowedOptions={PLAYER_B_ALLOWED_OPTIONS}
                  optionLabelOverrides={playerBLabelOverrides}
                />
              </div>

              {/* Row 3: Variant */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label htmlFor="variant" className="min-w-[120px]">
                    Variant
                  </Label>
                  <Select
                    value={gameConfig.variant}
                    onValueChange={(value: Variant) =>
                      handleGameConfigChange({ ...gameConfig, variant: value })
                    }
                  >
                    <SelectTrigger
                      id="variant"
                      className="bg-background w-[200px]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">Standard</SelectItem>
                      <SelectItem value="classic">Classic</SelectItem>
                      <SelectItem value="freestyle">Freestyle</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {/* Always render text container to prevent layout shift */}
                <div className="min-h-[3rem]">
                  <p className="text-sm text-muted-foreground">
                    {gameConfig.variant === "standard" &&
                      "Catch the mouse first."}
                    {gameConfig.variant === "classic" &&
                      "Reach the corner first."}
                    {gameConfig.variant === "freestyle" &&
                      `Randomized setup with neutral starting walls (${FREESTYLE_BOARD_WIDTH}x${FREESTYLE_BOARD_HEIGHT}).`}
                  </p>
                </div>
              </div>
            </div>

            {/* Variant Settings - Spanning both columns */}
            {(gameConfig.variant === "standard" ||
              gameConfig.variant === "classic") && (
              <div className="mt-3 space-y-3 p-3 border rounded-md bg-muted/30">
                <div className="grid grid-cols-2 gap-4 max-w-md">
                  <div className="flex items-center gap-3">
                    <Label htmlFor="board-width" className="min-w-[100px]">
                      Board Width
                    </Label>
                    <Input
                      id="board-width"
                      type="number"
                      min="4"
                      max="20"
                      value={boardWidthInput}
                      onChange={(e) => handleBoardWidthChange(e.target.value)}
                      onBlur={commitBoardWidth}
                      className="bg-background max-w-[100px]"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <Label htmlFor="board-height" className="min-w-[100px]">
                      Board Height
                    </Label>
                    <Input
                      id="board-height"
                      type="number"
                      min="4"
                      max="20"
                      value={boardHeightInput}
                      onChange={(e) => handleBoardHeightChange(e.target.value)}
                      onBlur={commitBoardHeight}
                      className="bg-background max-w-[100px]"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Create Game Button - Centered */}
            <div className="mt-3 flex justify-center">
              <Button
                onClick={() => void handleCreateGame()}
                className="max-w-xs"
                size="lg"
                disabled={isCreatingGame}
              >
                {isCreatingGame ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create game"
                )}
              </Button>
            </div>

            {/* Error message about invalid player configuration */}
            {createGameError && (
              <div className="mt-2 text-center">
                <p className="text-sm text-destructive">{createGameError}</p>
              </div>
            )}
          </Card>

          <ReadyToJoinTable
            config={gameConfig}
            mode={mode}
            matchmakingGames={filteredAndSortedGames}
            isLoadingGames={isLoadingGames}
            isJoiningGame={isJoiningGame}
            onJoinGame={(gameId) => void handleJoinGame(gameId)}
            onPlayBot={(args) => void handlePlayBot(args)}
            onRecommendedSelect={(boardWidth, boardHeight) =>
              handleGameConfigChange({
                ...gameConfig,
                boardWidth,
                boardHeight,
              })
            }
            isPlaying={playVsBotMutation.isPending}
            errorMessage={botGameError}
          />
        </div>
      </div>
    </div>
  );
}
