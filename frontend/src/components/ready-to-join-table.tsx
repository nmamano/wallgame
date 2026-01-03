import { useMemo, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw } from "lucide-react";
import type {
  GameConfiguration,
  TimeControlPreset,
  TimeControlConfig,
  Variant,
} from "../../../shared/domain/game-types";
import type {
  ListedBot,
  RecommendedBotEntry,
} from "../../../shared/contracts/custom-bot-protocol";
import { useBotsQuery, useRecommendedBotsQuery } from "@/hooks/use-bots";
import { formatTimeControl as formatTimeControlUtil } from "../../../shared/domain/game-utils";

type TabKey = "humans" | "bots-recommended" | "bots-filtered";

// Type for tracking which fields don't match
interface GameMatchStatus {
  variant: boolean;
  rated: boolean;
  timeControl: boolean;
  boardSize: boolean;
  allMatch: boolean;
}

// Extended type with match status
interface GameWithMatchStatus {
  id: string;
  config: GameConfiguration;
  createdAt: number;
  players: {
    playerId: number;
    displayName: string;
    ready: boolean;
    role?: string;
  }[];
  matchStatus: GameMatchStatus;
}

interface ReadyToJoinTableProps {
  config: GameConfiguration;
  mode: string | undefined;
  matchmakingGames: GameWithMatchStatus[];
  isLoadingGames: boolean;
  isJoiningGame: string | null;
  onJoinGame: (gameId: string) => void;
  onPlayBot: (args: { botId: string; config: GameConfiguration }) => void;
  onRecommendedSelect?: (boardWidth: number, boardHeight: number) => void;
  isPlaying?: boolean;
  errorMessage?: string | null;
}

const formatVariantLabel = (variant: Variant): string =>
  variant.charAt(0).toUpperCase() + variant.slice(1);

const formatTimeControlLabel = (preset: TimeControlPreset): string => {
  const labels: Record<TimeControlPreset, string> = {
    bullet: "Bullet",
    blitz: "Blitz",
    rapid: "Rapid",
    classical: "Classical",
  };
  return labels[preset];
};

const formatBoardSizeShort = (width: number, height: number): string =>
  `${width}x${height}`;

const formatBoardSizeFull = (width: number, height: number): string => {
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
};

const usesBoardSize = (variant: Variant): boolean =>
  variant === "standard" || variant === "classic";

function formatTimeControl(timeControl: TimeControlConfig): string {
  if (timeControl.preset) {
    const formats: Record<TimeControlPreset, string> = {
      bullet: "bullet (1+0)",
      blitz: "blitz (3+2)",
      rapid: "rapid (10+2)",
      classical: "classical (30+0)",
    };
    return formats[timeControl.preset];
  }
  return formatTimeControlUtil(timeControl);
}

function getTimeControlIcon(timeControl: TimeControlConfig): string {
  if (!timeControl.preset) return "";
  const iconMap: Record<TimeControlPreset, string> = {
    bullet: "/time_control_icons/activity.lichess-bullet.webp",
    blitz: "/time_control_icons/activity.lichess-blitz.webp",
    rapid: "/time_control_icons/activity.lichess-rapid.webp",
    classical: "/time_control_icons/activity.lichess-classical.webp",
  };
  return iconMap[timeControl.preset] || "";
}

export function ReadyToJoinTable({
  config,
  mode,
  matchmakingGames,
  isLoadingGames,
  isJoiningGame,
  onJoinGame,
  onPlayBot,
  onRecommendedSelect,
  isPlaying = false,
  errorMessage,
}: ReadyToJoinTableProps) {
  const timeControlPreset = config.timeControl.preset ?? "rapid";
  const includeBoardSize = usesBoardSize(config.variant);

  // Bot queries
  const { data: matchingData, isLoading: matchingLoading } = useBotsQuery({
    variant: config.variant,
    timeControl: timeControlPreset,
    boardWidth: includeBoardSize ? config.boardWidth : undefined,
    boardHeight: includeBoardSize ? config.boardHeight : undefined,
  });

  const { data: recommendedData, isLoading: recommendedLoading } =
    useRecommendedBotsQuery(config.variant, timeControlPreset);

  const recommendedRows = useMemo<RecommendedBotEntry[]>(() => {
    return recommendedData?.bots ?? [];
  }, [recommendedData?.bots]);

  const matchingRows = useMemo<ListedBot[]>(() => {
    return matchingData?.bots ?? [];
  }, [matchingData?.bots]);

  // Counts for tabs
  const humansCount = matchmakingGames.length;
  const botsRecommendedCount = recommendedRows.length;
  const botsFilteredCount = matchingRows.length;

  // Default tab logic:
  // 1. If there are humans waiting AND user did NOT come from "Play vs AI", open Humans tab
  // 2. Otherwise, open Bots (Recommended) tab
  const getDefaultTab = (): TabKey => {
    const hasHumans = humansCount > 0;
    const cameFromVsAI = mode === "vs-ai";

    if (hasHumans && !cameFromVsAI) {
      return "humans";
    }
    return "bots-recommended";
  };

  const [activeTab, setActiveTab] = useState<TabKey>(getDefaultTab);

  // Update default tab when conditions change (humans available or mode changes)
  useEffect(() => {
    setActiveTab(getDefaultTab());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [humansCount > 0, mode]);

  const formatPlayers = (players: GameWithMatchStatus["players"]): string => {
    return players
      .filter((p) => p.ready || p.role === "host")
      .map((p) => p.displayName)
      .join(" & ");
  };

  const renderTypeBadge = (isOfficial: boolean) => (
    <Badge variant={isOfficial ? "default" : "outline"}>
      {isOfficial ? "official" : "custom"}
    </Badge>
  );

  const renderEmptyState = (label: string, colSpan: number) => (
    <TableRow>
      <TableCell
        colSpan={colSpan}
        className="py-6 text-center text-muted-foreground"
      >
        {label}
      </TableCell>
    </TableRow>
  );

  const renderPlayButton = (
    botId: string,
    boardWidth: number,
    boardHeight: number,
  ) => (
    <Button
      size="sm"
      disabled={isPlaying}
      onClick={(e) => {
        e.stopPropagation();
        onPlayBot({
          botId,
          config: {
            ...config,
            boardWidth,
            boardHeight,
            rated: false,
          },
        });
      }}
    >
      Play
    </Button>
  );

  const getTabClasses = (tab: TabKey): string => {
    if (activeTab === tab) {
      return "border-b-2 border-primary text-primary";
    }
    return "text-muted-foreground hover:text-foreground";
  };

  const getTabLabel = (tab: TabKey): string => {
    switch (tab) {
      case "humans":
        return humansCount > 0 ? `Humans (${humansCount})` : "Humans";
      case "bots-recommended":
        return botsRecommendedCount > 0
          ? `Bots (Recommended) (${botsRecommendedCount})`
          : "Bots (Recommended)";
      case "bots-filtered":
        return botsFilteredCount > 0
          ? `Bots (Filtered) (${botsFilteredCount})`
          : "Bots (Filtered)";
    }
  };

  return (
    <Card className="p-5 border-border/50 bg-card/50 backdrop-blur">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-semibold">Ready to Join</h2>
          {isLoadingGames && (
            <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b">
          {(["humans", "bots-recommended", "bots-filtered"] as TabKey[]).map(
            (tab) => (
              <button
                key={tab}
                className={`flex-1 py-2 text-sm font-medium transition-colors cursor-pointer ${getTabClasses(tab)}`}
                onClick={() => setActiveTab(tab)}
              >
                {getTabLabel(tab)}
              </button>
            ),
          )}
        </div>

        {errorMessage && (
          <p className="text-sm text-destructive">{errorMessage}</p>
        )}

        {/* Humans Tab Content */}
        {activeTab === "humans" && (
          <div className="overflow-x-auto">
            {matchmakingGames.length === 0 ? (
              <p className="text-muted-foreground py-4">
                {isLoadingGames
                  ? "Loading available games..."
                  : "No human players waiting. Create a game or try playing against a bot."}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-center">Variant</TableHead>
                    <TableHead className="text-center">Rated</TableHead>
                    <TableHead className="text-center">Time control</TableHead>
                    <TableHead className="text-center">Board size</TableHead>
                    <TableHead className="text-center">Player</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matchmakingGames.map((game) => (
                    <TableRow
                      key={game.id}
                      onClick={() => onJoinGame(game.id)}
                      className={`cursor-pointer hover:bg-muted/50 transition-colors ${
                        isJoiningGame === game.id ? "opacity-50" : ""
                      }`}
                    >
                      <TableCell className="capitalize text-center">
                        <span
                          className={`inline-block px-2 py-1 ${
                            !game.matchStatus.variant
                              ? "bg-red-100 dark:bg-red-900/50 rounded-md"
                              : ""
                          }`}
                        >
                          {game.config.variant}
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
                          {game.config.rated ? "Yes" : "No"}
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
                          {getTimeControlIcon(game.config.timeControl) && (
                            <img
                              src={getTimeControlIcon(game.config.timeControl)}
                              alt={
                                game.config.timeControl.preset ??
                                formatTimeControl(game.config.timeControl)
                              }
                              className="w-5 h-5"
                            />
                          )}
                          {formatTimeControl(game.config.timeControl)}
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
                          {formatBoardSizeFull(
                            game.config.boardWidth,
                            game.config.boardHeight,
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        {formatPlayers(game.players)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {/* Bots (Recommended) Tab Content */}
        {activeTab === "bots-recommended" && (
          <div className="overflow-x-auto">
            <p className="text-xs text-muted-foreground mb-2">
              Showing recommended bots for: {formatVariantLabel(config.variant)}{" "}
              / {formatTimeControlLabel(timeControlPreset)}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-left">Name</TableHead>
                  <TableHead className="text-left">Type</TableHead>
                  <TableHead className="text-left">Board size</TableHead>
                  <TableHead className="text-right">Play</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recommendedLoading &&
                  renderEmptyState("Loading recommended bots...", 4)}
                {!recommendedLoading &&
                  (recommendedRows.length === 0
                    ? renderEmptyState(
                        "No recommended bots for these settings.",
                        4,
                      )
                    : recommendedRows.map((entry) => (
                        <TableRow
                          key={`${entry.bot.id}-${entry.boardWidth}x${entry.boardHeight}`}
                          className="hover:bg-muted/40 transition-colors cursor-pointer"
                          onClick={() =>
                            onRecommendedSelect?.(
                              entry.boardWidth,
                              entry.boardHeight,
                            )
                          }
                        >
                          <TableCell>{entry.bot.name}</TableCell>
                          <TableCell>
                            {renderTypeBadge(entry.bot.isOfficial)}
                          </TableCell>
                          <TableCell>
                            {formatBoardSizeShort(
                              entry.boardWidth,
                              entry.boardHeight,
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {renderPlayButton(
                              entry.bot.id,
                              entry.boardWidth,
                              entry.boardHeight,
                            )}
                          </TableCell>
                        </TableRow>
                      )))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Bots (Filtered) Tab Content */}
        {activeTab === "bots-filtered" && (
          <div className="overflow-x-auto">
            <p className="text-xs text-muted-foreground mb-2">
              Showing bots matching: {formatVariantLabel(config.variant)} /{" "}
              {formatTimeControlLabel(timeControlPreset)}
              {includeBoardSize &&
                ` / ${formatBoardSizeShort(config.boardWidth, config.boardHeight)}`}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-left">Name</TableHead>
                  <TableHead className="text-left">Type</TableHead>
                  <TableHead className="text-left">Board size</TableHead>
                  <TableHead className="text-right">Play</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matchingLoading &&
                  renderEmptyState("Loading matching bots...", 4)}
                {!matchingLoading &&
                  (matchingRows.length === 0
                    ? renderEmptyState(
                        "No bots match your current settings.",
                        4,
                      )
                    : matchingRows.map((bot) => (
                        <TableRow
                          key={bot.id}
                          className="hover:bg-muted/40 transition-colors"
                        >
                          <TableCell>{bot.name}</TableCell>
                          <TableCell>
                            {renderTypeBadge(bot.isOfficial)}
                          </TableCell>
                          <TableCell>
                            {includeBoardSize
                              ? formatBoardSizeShort(
                                  config.boardWidth,
                                  config.boardHeight,
                                )
                              : "n/a"}
                          </TableCell>
                          <TableCell className="text-right">
                            {renderPlayButton(
                              bot.id,
                              config.boardWidth,
                              config.boardHeight,
                            )}
                          </TableCell>
                        </TableRow>
                      )))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Card>
  );
}
