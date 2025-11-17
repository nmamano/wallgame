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
import {
  GameConfigurationPanel,
  GameConfiguration,
} from "@/components/game-configuration-panel";
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
  players: Array<{ name: string; rating: number }>;
  createdAt: Date; // When the game entered matching stage
  creatorRating?: number; // Rating of the game creator
}

function GameSetup() {
  // Get mode from sessionStorage (set when navigating from landing page)
  // This avoids showing it in the URL
  const [mode] = useState<string | undefined>(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("game-setup-mode") || undefined;
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
  }, [settings.isLoadingSettings, settings.gameConfig, hasInitialized]);

  // Player configurations state
  const [playerConfigs, setPlayerConfigs] = useState<PlayerType[]>([]);

  // Initialize player configs based on variant and mode
  useEffect(() => {
    const playerCount = getPlayerCountForVariant(gameConfig.variant);
    const defaultOtherPlayerType = getDefaultOtherPlayerType(mode);
    const newConfigs: PlayerType[] = Array(playerCount).fill(
      defaultOtherPlayerType
    );
    newConfigs[0] = "you"; // Player 1 defaults to "You"
    setPlayerConfigs(newConfigs);
  }, [gameConfig.variant, mode]);

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

  // Update rated status when player configs change
  useEffect(() => {
    if (!canRatedGame && gameConfig.rated) {
      setGameConfig((prev) => ({ ...prev, rated: false }));
    }
  }, [canRatedGame, gameConfig.rated]);

  // Update player configs when variant changes
  const handleGameConfigChange = (newConfig: GameConfiguration) => {
    // Prevent setting rated to true if not allowed
    const finalRated = canRatedGame ? newConfig.rated : false;
    setGameConfig({ ...newConfig, rated: finalRated });

    // If variant changed, reset player configs (preserving mode-based defaults)
    if (newConfig.variant !== gameConfig.variant) {
      const playerCount = getPlayerCountForVariant(newConfig.variant);
      const defaultOtherPlayerType = getDefaultOtherPlayerType(mode);
      const newConfigs: PlayerType[] = Array(playerCount).fill(
        defaultOtherPlayerType
      );
      newConfigs[0] = "you";
      setPlayerConfigs(newConfigs);
    }
  };

  const handleCreateGame = () => {
    // TODO: Implement backend call to create game
    console.log("Creating game with config:", gameConfig);
    console.log("Player configs:", playerConfigs);
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

  // Filter and sort matching games
  const filteredAndSortedGames = useMemo(() => {
    let games = [...mockMatchingGames];

    // Filter by variant if set
    if (gameConfig.variant) {
      games = games.filter((g) => g.variant === gameConfig.variant);
    }

    // Filter by rated status if set
    if (gameConfig.rated !== undefined) {
      games = games.filter((g) => g.rated === gameConfig.rated);
    }

    // Filter by time control if set
    if (gameConfig.timeControl) {
      games = games.filter((g) => g.timeControl === gameConfig.timeControl);
    }

    // Filter by board size if set
    if (gameConfig.boardWidth && gameConfig.boardHeight) {
      games = games.filter(
        (g) =>
          g.boardWidth === gameConfig.boardWidth &&
          g.boardHeight === gameConfig.boardHeight
      );
    }

    // Sort: prioritize by ELO difference, then by time in matching stage
    games.sort((a, b) => {
      // Calculate ELO difference
      const eloDiffA = Math.abs((a.creatorRating || 1200) - userRating);
      const eloDiffB = Math.abs((b.creatorRating || 1200) - userRating);

      // Prioritize games with closer ELO
      if (eloDiffA !== eloDiffB) {
        return eloDiffA - eloDiffB;
      }

      // If ELO difference is the same, prioritize older games (longer in matching stage)
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return games;
  }, [mockMatchingGames, gameConfig, userRating]);

  const formatPlayers = (
    players: Array<{ name: string; rating: number }>
  ): string => {
    return players.map((p) => `${p.name} (${p.rating})`).join(" & ");
  };

  const handleJoinGame = (gameId: number) => {
    // TODO: Implement backend call to join game
    console.log("Joining game:", gameId);
  };

  return (
    <div className="container mx-auto py-12 px-4 max-w-6xl">
      <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-8 text-balance">
        Game Setup
      </h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Create Game Section */}
        <Card className="p-6 border-border/50 bg-card/50 backdrop-blur">
          <h2 className="text-2xl font-semibold mb-6">Create game</h2>
          <div className="space-y-6">
            {/* Player Configurations */}
            <div className="space-y-4">
              {playerConfigs.map((config, index) => (
                <PlayerConfiguration
                  key={index}
                  label={`Player ${index + 1}`}
                  value={config}
                  onChange={(value) => {
                    const newConfigs = [...playerConfigs];
                    newConfigs[index] = value;
                    setPlayerConfigs(newConfigs);
                  }}
                />
              ))}
            </div>

            {/* Game Configuration Panel */}
            <div>
              <GameConfigurationPanel
                config={gameConfig}
                onChange={handleGameConfigChange}
                isLoggedIn={isLoggedIn}
                showRatedInfo={true}
                ratedDisabled={!canRatedGame}
                showRatedDisabledMessage={true}
              />
            </div>

            {/* Create Game Button */}
            <Button
              onClick={handleCreateGame}
              className="w-full"
              size="lg"
              disabled={!canCreateGame}
            >
              Create game
            </Button>

            {/* Error message about invalid player configuration */}
            {!canCreateGame && (
              <p className="text-sm text-destructive">
                Friend and Matched User can only be selected when "You" is also
                selected as a player.
              </p>
            )}
          </div>
        </Card>

        {/* Join Game Section */}
        <Card className="p-6 border-border/50 bg-card/50 backdrop-blur">
          <h2 className="text-2xl font-semibold mb-6">Join game</h2>
          {filteredAndSortedGames.length === 0 ? (
            <p className="text-muted-foreground">
              No games available to join matching your preferences.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Join</TableHead>
                    <TableHead>Variant</TableHead>
                    <TableHead>Rated</TableHead>
                    <TableHead>Time control</TableHead>
                    <TableHead>Board size</TableHead>
                    <TableHead>Player</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAndSortedGames.map((game) => (
                    <TableRow key={game.gameId}>
                      <TableCell>
                        <Button
                          onClick={() => handleJoinGame(game.gameId)}
                          size="sm"
                          variant="outline"
                        >
                          Join
                        </Button>
                      </TableCell>
                      <TableCell className="capitalize">
                        {game.variant}
                      </TableCell>
                      <TableCell>{game.rated ? "Yes" : "No"}</TableCell>
                      <TableCell className="capitalize">
                        {formatTimeControl(game.timeControl)}
                      </TableCell>
                      <TableCell>
                        {formatBoardSize(game.boardWidth, game.boardHeight)}
                      </TableCell>
                      <TableCell>{formatPlayers(game.players)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
