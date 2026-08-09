import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BotsPanel } from "@/components/game-setup/bots-panel";
import {
  HumanGamesPanel,
  type GameWithMatchStatus,
} from "@/components/game-setup/human-games-panel";
import type {
  GameConfiguration,
  TimeControlPreset,
  Variant,
  GameSnapshot,
} from "../../../shared/domain/game-types";
import { timeControlConfigFromPreset } from "../../../shared/domain/game-utils";
import { BoardSizePicker } from "@/components/game-setup/board-size-picker";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useMediaQuery } from "@/hooks/use-media-query";
import { userQueryOptions, fetchMatchmakingGames } from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";
import { createGameSession, joinGameSession } from "@/lib/api";
import { saveGameHandshake, clearGameHandshake } from "@/lib/game-session";
import { usePlayVsBotMutation } from "@/hooks/use-bots";
import { isEmbedded } from "@/lib/embedded-mode";

export const Route = createFileRoute("/play")({
  component: GameSetup,
});

// --- Tab types and constants ---

type SetupTab = "vs-ai" | "find-others" | "invite-friend" | "local-play";

const TABS: SetupTab[] = [
  "find-others",
  "invite-friend",
  "vs-ai",
  "local-play",
];

const TAB_LABELS: Record<SetupTab, string> = {
  "find-others": "Find Others",
  "invite-friend": "Invite Friend",
  "vs-ai": "Play vs AI",
  "local-play": "Play Locally",
};

function getDefaultTab(mode?: string): SetupTab {
  switch (mode) {
    case "vs-ai":
      return "vs-ai";
    case "with-others":
      return "find-others";
    case "invite-friend":
      return "invite-friend";
    default:
      return "vs-ai";
  }
}

// --- Main component ---

function GameSetup() {
  // Get mode from sessionStorage (set when navigating from landing page)
  const [mode] = useState<string | undefined>(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("play-mode") ?? undefined;
    }
    return undefined;
  });

  // Clear mode from sessionStorage after reading it
  useEffect(() => {
    if (typeof window !== "undefined" && mode) {
      sessionStorage.removeItem("play-mode");
    }
  }, [mode]);

  const [activeTab, setActiveTab] = useState<SetupTab>(() =>
    getDefaultTab(mode),
  );

  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;
  const settings = useSettings(isLoggedIn, userPending);
  const [isCreatingGame, setIsCreatingGame] = useState(false);
  const [createGameError, setCreateGameError] = useState<string | null>(null);
  const [botGameError, setBotGameError] = useState<string | null>(null);
  const playVsBotMutation = usePlayVsBotMutation();
  const isSmallScreen = useMediaQuery("(max-width: 639px)");

  // Game configuration state - initialize from user settings
  const [gameConfig, setGameConfig] = useState<GameConfiguration>(
    () => settings.gameConfig,
  );

  // Update game config when settings are loaded (only once on initial load)
  const [hasInitialized, setHasInitialized] = useState(false);
  useEffect(() => {
    if (!hasInitialized && !settings.isLoadingSettings) {
      setGameConfig(settings.gameConfig);
      setHasInitialized(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.isLoadingSettings, hasInitialized]);

  // Rated games only available on find-others and invite-friend tabs
  const canRatedGame =
    activeTab === "find-others" || activeTab === "invite-friend";

  // gameConfig stores the user's raw preferences (never clamped by tab/variant).
  // getEffectiveConfig() applies contextual overrides for actual game creation.
  const getEffectiveConfig = (): GameConfiguration => {
    let config: GameConfiguration = { ...gameConfig };
    if (!canRatedGame || !isLoggedIn) {
      config = { ...config, rated: false };
    }
    return config;
  };

  const handleGameConfigChange = (newConfig: GameConfiguration) => {
    setGameConfig(newConfig);
    settings.setGameConfig(newConfig);
  };

  // Navigation
  const navigate = Route.useNavigate();

  // Create game handler - match type is determined by the active tab
  const handleCreateGame = async () => {
    setCreateGameError(null);
    setBotGameError(null);
    const effectiveConfig = getEffectiveConfig();

    if (activeTab === "local-play") {
      const gameId = Math.random().toString(36).substring(2, 15);
      if (typeof window !== "undefined") {
        sessionStorage.setItem(
          `game-config-${gameId}`,
          JSON.stringify({
            config: effectiveConfig,
            players: ["you", "you"],
          }),
        );
      }
      void navigate({ to: `/game/${gameId}` });
      return;
    }

    // Online game: find-others or invite-friend
    const matchType = activeTab === "find-others" ? "matchmaking" : "friend";
    setIsCreatingGame(true);
    try {
      const response = await createGameSession({
        config: effectiveConfig,
        matchType,
        hostDisplayName: settings.displayName,
        hostAppearance: {
          pawnColor: settings.pawnColor,
          catSkin: settings.catPawn,
          mouseSkin: settings.mousePawn,
          homeSkin: settings.homePawn,
        },
      });
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
  };

  // --- Matchmaking games (lobby WebSocket) ---

  const [matchmakingGames, setMatchmakingGames] = useState<GameSnapshot[]>([]);
  const [isLoadingGames, setIsLoadingGames] = useState(true);
  const lobbySocketRef = useRef<WebSocket | null>(null);
  const [isJoiningGame, setIsJoiningGame] = useState<string | null>(null);

  const buildLobbySocketUrl = useCallback((): string => {
    const base = new URL(window.location.origin);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/ws/lobby";
    return base.toString();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let isCleanedUp = false;

    const connect = () => {
      if (isCleanedUp) return;

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
          if (!isCleanedUp && event.code !== 1000) {
            reconnectTimeout = setTimeout(connect, 2000);
          }
        });

        socket.addEventListener("error", (event) => {
          console.error("[game-setup] lobby websocket error", event);
          setIsLoadingGames(false);
        });
      } catch (error) {
        console.error("[game-setup] failed to create websocket", error);
        setIsLoadingGames(false);
        if (!isCleanedUp) {
          reconnectTimeout = setTimeout(connect, 2000);
        }
      }
    };

    const initialTimeout = setTimeout(connect, 100);

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

  // Compute match status for human games using effective config
  const filteredAndSortedGames = useMemo(() => {
    const effective = getEffectiveConfig();
    const gamesWithStatus: GameWithMatchStatus[] = matchmakingGames.map(
      (game) => {
        const variantMatch =
          !effective.variant || game.config.variant === effective.variant;
        const ratedMatch =
          effective.rated === undefined ||
          game.config.rated === effective.rated;
        const timeControlMatch = !!(
          game.config.timeControl.preset &&
          effective.timeControl.preset &&
          game.config.timeControl.preset === effective.timeControl.preset
        );
        const boardSizeMatch =
          !effective.boardWidth ||
          !effective.boardHeight ||
          (game.config.boardWidth === effective.boardWidth &&
            game.config.boardHeight === effective.boardHeight);

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

    gamesWithStatus.sort((a, b) => {
      if (a.matchStatus.allMatch !== b.matchStatus.allMatch) {
        return a.matchStatus.allMatch ? -1 : 1;
      }
      return a.createdAt - b.createdAt;
    });

    return gamesWithStatus;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchmakingGames, gameConfig, activeTab, isLoggedIn]);

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

  // --- Disabled state flags ---
  // All settings are always visible, but some are disabled depending on the tab/variant.

  const timeControlDisabled = activeTab === "vs-ai";
  const ratedDisabled =
    !isLoggedIn || activeTab === "vs-ai" || activeTab === "local-play";

  // --- Render ---

  const Wrapper = isSmallScreen ? "div" : Card;

  return (
    <div className={isSmallScreen ? "py-2" : "container mx-auto py-8 px-4"}>
      <div className={isSmallScreen ? "" : "max-w-5xl mx-auto"}>
        <Wrapper
          className={
            isSmallScreen ? "" : "border-border/50 bg-card/50 backdrop-blur"
          }
        >
          {/* Tab bar */}
          <div className="flex border-b">
            {TABS.map((tab) => (
              <button
                key={tab}
                className={`flex-1 py-3 text-sm font-medium transition-colors cursor-pointer ${
                  activeTab === tab
                    ? "border-b-2 border-primary text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveTab(tab)}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>

          <div
            className={isSmallScreen ? "px-3 py-3 space-y-4" : "p-5 space-y-4"}
          >
            {/* Config section - settings vary per tab */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              {/* Variant (all tabs) */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label htmlFor="variant" className="min-w-[120px]">
                    Variant
                  </Label>
                  <Select
                    value={gameConfig.variant}
                    onValueChange={(value: Variant) =>
                      handleGameConfigChange({
                        ...gameConfig,
                        variant: value,
                      } as GameConfiguration)
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
                <p className="text-sm text-muted-foreground">
                  {gameConfig.variant === "standard" &&
                    "Catch the mouse first."}
                  {gameConfig.variant === "classic" &&
                    "Reach the corner first."}
                  {gameConfig.variant === "freestyle" &&
                    "Randomized setup with neutral starting walls."}
                </p>
              </div>

              {/* Time Control (always shown; disabled for bot games) */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label htmlFor="time-control" className="min-w-[120px]">
                    Time Control
                  </Label>
                  <Select
                    value={
                      timeControlDisabled
                        ? "none"
                        : (gameConfig.timeControl.preset ?? "blitz")
                    }
                    onValueChange={(value: string) => {
                      if (timeControlDisabled) return;
                      handleGameConfigChange({
                        ...gameConfig,
                        timeControl: timeControlConfigFromPreset(
                          value as TimeControlPreset,
                        ),
                      });
                    }}
                    disabled={timeControlDisabled}
                  >
                    <SelectTrigger
                      id="time-control"
                      className="bg-background w-[200px]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {timeControlDisabled && (
                        <SelectItem value="none">None</SelectItem>
                      )}
                      <SelectItem value="bullet">Bullet (1+0)</SelectItem>
                      <SelectItem value="blitz">Blitz (3+2)</SelectItem>
                      <SelectItem value="rapid">Rapid (10+2)</SelectItem>
                      <SelectItem value="classical">
                        Classical (30+0)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-sm text-muted-foreground">
                  {timeControlDisabled && "Bot games are untimed."}
                  {!timeControlDisabled &&
                    gameConfig.timeControl.preset === "bullet" &&
                    "1 minute, no increment."}
                  {!timeControlDisabled &&
                    gameConfig.timeControl.preset === "blitz" &&
                    "3 minutes, 2 second increment."}
                  {!timeControlDisabled &&
                    gameConfig.timeControl.preset === "rapid" &&
                    "10 minutes, 2 second increment."}
                  {!timeControlDisabled &&
                    gameConfig.timeControl.preset === "classical" &&
                    "30 minutes, no increment."}
                </p>
              </div>

              {/* Rated (always shown; disabled for bot/local games or logged-out) */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label htmlFor="rated" className="min-w-[120px]">
                    Rated
                  </Label>
                  <Switch
                    id="rated"
                    checked={ratedDisabled ? false : gameConfig.rated}
                    onCheckedChange={(checked) => {
                      if (ratedDisabled) return;
                      handleGameConfigChange({
                        ...gameConfig,
                        rated: checked,
                      });
                    }}
                    disabled={ratedDisabled}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  {/* Telling a framed player to log in points at a door that
                      is not there; see lib/embedded-mode.ts. */}
                  {!isLoggedIn &&
                    (isEmbedded()
                      ? "Rated games are not available here."
                      : "Log in to play rated games.")}
                  {isLoggedIn &&
                    (activeTab === "vs-ai" || activeTab === "local-play") &&
                    "Rated games are only available vs other players."}
                  {isLoggedIn &&
                    canRatedGame &&
                    (gameConfig.rated
                      ? "The game will affect your rating."
                      : "The game will not affect your rating.")}
                </p>
              </div>

              {/* Board size */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label className="min-w-[120px]">Board Size</Label>
                  <BoardSizePicker
                    width={gameConfig.boardWidth}
                    height={gameConfig.boardHeight}
                    onChange={(w, h) =>
                      handleGameConfigChange({
                        ...gameConfig,
                        boardWidth: w,
                        boardHeight: h,
                      })
                    }
                  />
                </div>
              </div>
            </div>

            {/* --- Tab-specific content --- */}

            {activeTab === "vs-ai" && (
              <BotsPanel
                config={gameConfig}
                onPlayBot={(args) => void handlePlayBot(args)}
                isPlaying={playVsBotMutation.isPending}
                errorMessage={botGameError}
              />
            )}

            {(activeTab === "find-others" ||
              activeTab === "invite-friend" ||
              activeTab === "local-play") && (
              <>
                <div className="flex justify-center pt-2">
                  <Button
                    onClick={() => void handleCreateGame()}
                    className="w-40"
                    size="lg"
                    disabled={isCreatingGame}
                  >
                    {isCreatingGame ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating...
                      </>
                    ) : activeTab === "local-play" ? (
                      "Start game"
                    ) : (
                      "Create game"
                    )}
                  </Button>
                </div>
                {createGameError && (
                  <p className="text-sm text-destructive text-center">
                    {createGameError}
                  </p>
                )}
              </>
            )}

            {activeTab === "find-others" && (
              <HumanGamesPanel
                matchmakingGames={filteredAndSortedGames}
                isLoadingGames={isLoadingGames}
                isJoiningGame={isJoiningGame}
                onJoinGame={(gameId) => void handleJoinGame(gameId)}
              />
            )}
          </div>
        </Wrapper>
      </div>
    </div>
  );
}
