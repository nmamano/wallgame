import { useState, useEffect, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PlayerConfiguration,
  PlayerType,
} from "@/components/player-configuration";
import { GameConfiguration } from "@/components/game-configuration-panel";
import type { TimeControlPreset, Variant } from "@/lib/game";
import { Input } from "@/components/ui/input";
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
import { Info } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { userQueryOptions } from "@/lib/api";
import { useSettings } from "@/hooks/use-settings";

export const Route = createFileRoute("/game-setup")({
  component: GameSetup,
});

// Helper function to determine number of players based on variant
function getPlayerCountForVariant(variant: string): number {
  // For now, assume all variants support 2 players
  // This can be extended later for variants with more players
  switch (variant) {
    case "standard":
    case "classic":
      return 2;
    default:
      return 2;
  }
}

// Helper function to get default player type for other players based on mode
function getDefaultOtherPlayerType(mode?: string): PlayerType {
  switch (mode) {
    case "vs-ai":
      return "easy-bot";
    case "with-others":
      return "matched-user";
    case "invite-friend":
      return "friend";
    default:
      return "easy-bot";
  }
}

const PLAYER_B_BASE_OPTIONS: PlayerType[] = [
  "friend",
  "matched-user",
  "easy-bot",
  "medium-bot",
  "hard-bot",
  "custom-bot",
];

// Helper function to format time control
function formatTimeControl(timeControl: string): string {
  const formats: Record<string, string> = {
    bullet: "bullet (1+0)",
    blitz: "blitz (3+2)",
    rapid: "rapid (10+2)",
    classical: "classical (30+0)",
  };
  return formats[timeControl] || timeControl;
}

// Helper function to get time control icon path
function getTimeControlIcon(timeControl: string): string {
  const iconMap: Record<string, string> = {
    bullet: "/time_control_icons/activity.lichess-bullet.webp",
    blitz: "/time_control_icons/activity.lichess-blitz.webp",
    rapid: "/time_control_icons/activity.lichess-rapid.webp",
    classical: "/time_control_icons/activity.lichess-classical.webp",
  };
  return iconMap[timeControl] || "";
}

// Helper function to format board size
function formatBoardSize(width: number, height: number): string {
  const totalCells = width * height;
  let sizeName = "custom";

  if (totalCells <= 36) {
    sizeName = "small";
  } else if (totalCells <= 81) {
    sizeName = "medium";
  } else if (totalCells <= 144) {
    sizeName = "large";
  }

  return `${sizeName} (${width}x${height})`;
}

// Mock data type for games in matching stage
interface MatchingGame {
  gameId: number;
  variant: string;
  rated: boolean;
  timeControl: string;
  boardWidth: number;
  boardHeight: number;
  players: { name: string; rating: number }[];
  createdAt: Date; // When the game entered matching stage
  creatorRating?: number; // Rating of the game creator
}

// Type for tracking which fields don't match
interface GameMatchStatus {
  variant: boolean;
  rated: boolean;
  timeControl: boolean;
  boardSize: boolean;
  allMatch: boolean;
}

// Extended type with match status
interface GameWithMatchStatus extends MatchingGame {
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

  // TODO: Get user rating from API when backend is ready
  // Ratings are variant and time control specific, so we'll need to fetch the appropriate rating
  const userRating = 1200; // Default rating for now

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

  // Player configurations state
  const [playerConfigs, setPlayerConfigs] = useState<PlayerType[]>([]);

  // Initialize player configs based on variant and mode
  useEffect(() => {
    const playerCount = getPlayerCountForVariant(gameConfig.variant);
    const defaultOtherPlayerType = getDefaultOtherPlayerType(mode);
    const newConfigs: PlayerType[] = Array.from(
      { length: playerCount },
      () => defaultOtherPlayerType
    );
    newConfigs[0] = "you"; // Player A defaults to "You"
    setPlayerConfigs(newConfigs);
  }, [gameConfig.variant, mode]);

  const playerAType = playerConfigs[0];
  const playerBType = playerConfigs[1];

  const playerBAllowedOptions = useMemo(() => {
    if (playerAType === "you") {
      return (["you", ...PLAYER_B_BASE_OPTIONS] as PlayerType[]).filter(
        (value, index, array) => array.indexOf(value) === index
      );
    }
    return PLAYER_B_BASE_OPTIONS;
  }, [playerAType]);

  useEffect(() => {
    if (playerConfigs.length < 2) return;
    if (!playerBType) return;
    if (playerBAllowedOptions.includes(playerBType)) return;
    const fallback = playerBAllowedOptions[0];
    if (!fallback) return;
    setPlayerConfigs((prev) => {
      if (prev.length < 2) {
        return prev;
      }
      const next = [...prev];
      next[1] = fallback;
      return next;
    });
  }, [playerBAllowedOptions, playerBType, playerConfigs.length]);

  const playerBLabelOverrides =
    playerAType === "you" ? ({ you: "Also you" } as const) : undefined;

  // Check if rated games are allowed (only if one player is "you" and the other is "friend" or "matched-user")
  const canRatedGame = useMemo(() => {
    const hasYou = playerConfigs.includes("you");
    const hasFriend = playerConfigs.includes("friend");
    const hasMatchedUser = playerConfigs.includes("matched-user");
    const hasOnlyBots = playerConfigs.every(
      (p) =>
        p === "easy-bot" ||
        p === "medium-bot" ||
        p === "hard-bot" ||
        p === "custom-bot"
    );

    // Rated games are only allowed if:
    // - One player is "you"
    // - The other player is "friend" or "matched-user"
    // - No bots are involved
    return (
      hasYou &&
      (hasFriend || hasMatchedUser) &&
      !hasOnlyBots &&
      playerConfigs.length === 2
    );
  }, [playerConfigs]);

  // Check if create game button should be disabled
  // Friend and Matched User can only appear against You
  const canCreateGame = useMemo(() => {
    const hasYou = playerConfigs.includes("you");
    const hasFriend = playerConfigs.includes("friend");
    const hasMatchedUser = playerConfigs.includes("matched-user");

    // If Friend or Matched User is selected, "You" must also be selected
    if ((hasFriend || hasMatchedUser) && !hasYou) {
      return false;
    }

    return true;
  }, [playerConfigs]);

  // Update rated status when player configs change or when not logged in
  useEffect(() => {
    if ((!canRatedGame || !isLoggedIn) && gameConfig.rated) {
      setGameConfig((prev) => ({ ...prev, rated: false }));
    }
  }, [canRatedGame, isLoggedIn, gameConfig.rated]);

  // Update player configs when variant changes
  const handleGameConfigChange = (newConfig: GameConfiguration) => {
    // Prevent setting rated to true if not allowed
    const finalRated = canRatedGame && isLoggedIn ? newConfig.rated : false;
    setGameConfig({ ...newConfig, rated: finalRated });

    // If variant changed, reset player configs (preserving mode-based defaults)
    if (newConfig.variant !== gameConfig.variant) {
      const playerCount = getPlayerCountForVariant(newConfig.variant);
      const defaultOtherPlayerType = getDefaultOtherPlayerType(mode);
      const newConfigs: PlayerType[] = Array.from(
        { length: playerCount },
        () => defaultOtherPlayerType
      );
      newConfigs[0] = "you";
      setPlayerConfigs(newConfigs);
    }
  };

  const navigate = Route.useNavigate();

  const handleCreateGame = () => {
    // Generate a random game ID (mocking backend generation)
    const gameId = Math.random().toString(36).substring(2, 15);

    // In a real app, we would send the config to the backend here
    // For now, we'll pass the config via state or just rely on defaults in the game page
    // Since we can't easily pass complex state via URL without encoding it,
    // and we want the URL to be shareable, we'll simulate fetching the config
    // in the game page based on the ID (or just use random defaults for this demo).

    // However, to make the demo feel real, we can store the config in sessionStorage
    // keyed by the gameId, so the game page can "fetch" it.
    if (typeof window !== "undefined") {
      sessionStorage.setItem(
        `game-config-${gameId}`,
        JSON.stringify({
          config: gameConfig,
          players: playerConfigs,
        })
      );
    }

    void navigate({ to: `/game/${gameId}` });
  };

  // Mock data for games in matching stage
  const mockMatchingGames: MatchingGame[] = useMemo(
    () => [
      {
        gameId: 1,
        variant: "standard",
        rated: true,
        timeControl: "blitz",
        boardWidth: 8,
        boardHeight: 8,
        players: [{ name: "Alice", rating: 1250 }],
        createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
        creatorRating: 1250,
      },
      {
        gameId: 2,
        variant: "classic",
        rated: false,
        timeControl: "rapid",
        boardWidth: 8,
        boardHeight: 8,
        players: [{ name: "Bob", rating: 1180 }],
        createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
        creatorRating: 1180,
      },
      {
        gameId: 3,
        variant: "standard",
        rated: true,
        timeControl: "blitz",
        boardWidth: 8,
        boardHeight: 8,
        players: [{ name: "Charlie", rating: 1320 }],
        createdAt: new Date(Date.now() - 2 * 60 * 1000), // 2 minutes ago
        creatorRating: 1320,
      },
    ],
    []
  );

  // Check match status and sort games (matching first, then non-matching)
  const filteredAndSortedGames = useMemo(() => {
    // Map games to include match status
    const gamesWithStatus: GameWithMatchStatus[] = mockMatchingGames.map(
      (game) => {
        const variantMatch =
          !gameConfig.variant || game.variant === gameConfig.variant;
        const ratedMatch =
          gameConfig.rated === undefined || game.rated === gameConfig.rated;
        const timeControlMatch =
          !gameConfig.timeControl ||
          game.timeControl === gameConfig.timeControl;
        const boardSizeMatch =
          !gameConfig.boardWidth ||
          !gameConfig.boardHeight ||
          (game.boardWidth === gameConfig.boardWidth &&
            game.boardHeight === gameConfig.boardHeight);

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
      }
    );

    // Sort: matching games first, then by ELO difference, then by time in matching stage
    gamesWithStatus.sort((a, b) => {
      // First, prioritize matching games
      if (a.matchStatus.allMatch !== b.matchStatus.allMatch) {
        return a.matchStatus.allMatch ? -1 : 1;
      }

      // Calculate ELO difference
      const eloDiffA = Math.abs((a.creatorRating ?? 1200) - userRating);
      const eloDiffB = Math.abs((b.creatorRating ?? 1200) - userRating);

      // Prioritize games with closer ELO
      if (eloDiffA !== eloDiffB) {
        return eloDiffA - eloDiffB;
      }

      // If ELO difference is the same, prioritize older games (longer in matching stage)
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return gamesWithStatus;
  }, [mockMatchingGames, gameConfig, userRating]);

  const formatPlayers = (
    players: { name: string; rating: number }[]
  ): string => {
    return players.map((p) => `${p.name} (${p.rating})`).join(" & ");
  };

  const handleJoinGame = (gameId: number) => {
    // TODO: Implement backend call to join game
    console.log("Joining game:", gameId);
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
              {playerConfigs.length > 0 && (
                <div>
                  <PlayerConfiguration
                    label="Player A"
                    value={playerConfigs[0]}
                    onChange={(value) => {
                      const newConfigs = [...playerConfigs];
                      newConfigs[0] = value;
                      setPlayerConfigs(newConfigs);
                    }}
                    excludeOptions={["friend", "matched-user"]}
                  />
                </div>
              )}

              {/* Row 2: Time Control */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label htmlFor="time-control" className="min-w-[120px]">
                    Time Control
                  </Label>
                  <Select
                    value={gameConfig.timeControl}
                    onValueChange={(value: TimeControlPreset) =>
                      handleGameConfigChange({
                        ...gameConfig,
                        timeControl: value,
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
                    {gameConfig.timeControl === "bullet" &&
                      "1 minute, no increment."}
                    {gameConfig.timeControl === "blitz" &&
                      "3 minutes, 2 second increment."}
                    {gameConfig.timeControl === "rapid" &&
                      "10 minutes, 2 second increment."}
                    {gameConfig.timeControl === "classical" &&
                      "30 minutes, no increment."}
                  </p>
                </div>
              </div>

              {/* Row 3: Player B */}
              {playerConfigs.length > 1 && (
                <div>
                  <PlayerConfiguration
                    label="Player B"
                    value={playerConfigs[1]}
                    onChange={(value) => {
                      const newConfigs = [...playerConfigs];
                      newConfigs[1] = value;
                      setPlayerConfigs(newConfigs);
                    }}
                    allowedOptions={playerBAllowedOptions}
                    optionLabelOverrides={playerBLabelOverrides}
                  />
                </div>
              )}

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
                      value={gameConfig.boardWidth ?? 8}
                      onChange={(e) =>
                        handleGameConfigChange({
                          ...gameConfig,
                          boardWidth: parseInt(e.target.value) || 8,
                        })
                      }
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
                      value={gameConfig.boardHeight ?? 8}
                      onChange={(e) =>
                        handleGameConfigChange({
                          ...gameConfig,
                          boardHeight: parseInt(e.target.value) || 8,
                        })
                      }
                      className="bg-background max-w-[100px]"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Create Game Button - Centered */}
            <div className="mt-3 flex justify-center">
              <Button
                onClick={handleCreateGame}
                className="max-w-xs"
                size="lg"
                disabled={!canCreateGame}
              >
                Create game
              </Button>
            </div>

            {/* Error message about invalid player configuration */}
            {!canCreateGame && (
              <div className="mt-1 text-center">
                <p className="text-sm text-destructive">
                  Friend and Matched User can only be selected when
                  &quot;You&quot; is also selected as a player.
                </p>
              </div>
            )}
          </Card>

          {/* Join Game Section */}
          <Card className="p-5 border-border/50 bg-card/50 backdrop-blur">
            <h2 className="text-2xl font-semibold mb-4">Join game</h2>
            {filteredAndSortedGames.length === 0 ? (
              <p className="text-muted-foreground">
                No games available to join.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-center">Variant</TableHead>
                      <TableHead className="text-center">Rated</TableHead>
                      <TableHead className="text-center">
                        Time control
                      </TableHead>
                      <TableHead className="text-center">Board size</TableHead>
                      <TableHead className="text-center">Player</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAndSortedGames.map((game) => (
                      <TableRow
                        key={game.gameId}
                        onClick={() => handleJoinGame(game.gameId)}
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                      >
                        <TableCell className="capitalize text-center">
                          <span
                            className={`inline-block px-2 py-1 ${
                              !game.matchStatus.variant
                                ? "bg-red-100 dark:bg-red-900/50 rounded-md"
                                : ""
                            }`}
                          >
                            {game.variant}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <span
                            className={`inline-block px-2 py-1 ${
                              !game.matchStatus.rated
                                ? "bg-red-100 dark:bg-red-900/50 rounded-md"
                                : ""
                            }`}
                          >
                            {game.rated ? "Yes" : "No"}
                          </span>
                        </TableCell>
                        <TableCell className="capitalize text-center">
                          <span
                            className={`inline-flex items-center gap-2 px-2 py-1 ${
                              !game.matchStatus.timeControl
                                ? "bg-red-100 dark:bg-red-900/50 rounded-md"
                                : ""
                            }`}
                          >
                            {getTimeControlIcon(game.timeControl) && (
                              <img
                                src={getTimeControlIcon(game.timeControl)}
                                alt={game.timeControl}
                                className="w-5 h-5"
                              />
                            )}
                            {formatTimeControl(game.timeControl)}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <span
                            className={`inline-block px-2 py-1 ${
                              !game.matchStatus.boardSize
                                ? "bg-red-100 dark:bg-red-900/50 rounded-md"
                                : ""
                            }`}
                          >
                            {formatBoardSize(game.boardWidth, game.boardHeight)}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          {formatPlayers(game.players)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
