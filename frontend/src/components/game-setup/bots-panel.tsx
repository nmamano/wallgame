import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type {
  GameConfiguration,
  Variant,
} from "../../../../shared/domain/game-types";
import { BOT_GAME_TIME_CONTROL } from "../../../../shared/domain/game-utils";
import type {
  ListedBot,
  RecommendedBotEntry,
} from "../../../../shared/contracts/custom-bot-protocol";
import { useBotsQuery, useRecommendedBotsQuery } from "@/hooks/use-bots";

type BotTabKey = "recommended" | "filtered";

const formatVariantLabel = (variant: Variant): string =>
  variant.charAt(0).toUpperCase() + variant.slice(1);

const formatBoardSizeShort = (width: number, height: number): string =>
  `${width}x${height}`;

const usesBoardSize = (variant: Variant): boolean =>
  variant === "standard" || variant === "classic" || variant === "survival";

interface BotsPanelProps {
  config: GameConfiguration;
  onPlayBot: (args: { botId: string; config: GameConfiguration }) => void;
  onRecommendedSelect?: (boardWidth: number, boardHeight: number) => void;
  isPlaying?: boolean;
  errorMessage?: string | null;
}

export function BotsPanel({
  config,
  onPlayBot,
  onRecommendedSelect,
  isPlaying = false,
  errorMessage,
}: BotsPanelProps) {
  const includeBoardSize = usesBoardSize(config.variant);

  const { data: recommendedData, isLoading: recommendedLoading } =
    useRecommendedBotsQuery(config.variant);
  const { data: matchingData, isLoading: matchingLoading } = useBotsQuery({
    variant: config.variant,
    boardWidth: includeBoardSize ? config.boardWidth : undefined,
    boardHeight: includeBoardSize ? config.boardHeight : undefined,
  });

  const recommendedRows = useMemo<RecommendedBotEntry[]>(
    () => recommendedData?.bots ?? [],
    [recommendedData?.bots],
  );
  const matchingRows = useMemo<ListedBot[]>(
    () => matchingData?.bots ?? [],
    [matchingData?.bots],
  );

  const [activeTab, setActiveTab] = useState<BotTabKey>("recommended");

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
            timeControl: BOT_GAME_TIME_CONTROL,
          },
        });
      }}
    >
      Play
    </Button>
  );

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

  const getTabClasses = (tab: BotTabKey): string =>
    activeTab === tab
      ? "border-b-2 border-primary text-primary"
      : "text-muted-foreground hover:text-foreground";

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-tabs */}
      <div className="flex border-b">
        <button
          className={`flex-1 py-2 text-sm font-medium transition-colors cursor-pointer ${getTabClasses("recommended")}`}
          onClick={() => setActiveTab("recommended")}
        >
          Recommended
          {recommendedRows.length > 0 ? ` (${recommendedRows.length})` : ""}
        </button>
        <button
          className={`flex-1 py-2 text-sm font-medium transition-colors cursor-pointer ${getTabClasses("filtered")}`}
          onClick={() => setActiveTab("filtered")}
        >
          Filtered
          {matchingRows.length > 0 ? ` (${matchingRows.length})` : ""}
        </button>
      </div>

      {errorMessage && (
        <p className="text-sm text-destructive">{errorMessage}</p>
      )}

      {activeTab === "recommended" && (
        <div className="overflow-x-auto">
          <p className="text-xs text-muted-foreground mb-2">
            Showing recommended bots for: {formatVariantLabel(config.variant)}
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

      {activeTab === "filtered" && (
        <div className="overflow-x-auto">
          <p className="text-xs text-muted-foreground mb-2">
            Showing bots matching: {formatVariantLabel(config.variant)}
            {includeBoardSize &&
              ` | ${formatBoardSizeShort(config.boardWidth, config.boardHeight)}`}
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
                  ? renderEmptyState("No bots match your current settings.", 4)
                  : matchingRows.map((bot) => (
                      <TableRow
                        key={bot.id}
                        className="hover:bg-muted/40 transition-colors"
                      >
                        <TableCell>{bot.name}</TableCell>
                        <TableCell>{renderTypeBadge(bot.isOfficial)}</TableCell>
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
  );
}
