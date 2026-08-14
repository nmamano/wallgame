import { useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { GameConfiguration } from "../../../../shared/domain/game-types";
import { variantDisplayName } from "../../../../shared/domain/game-types";
import { BOT_GAME_TIME_CONTROL } from "../../../../shared/domain/game-utils";
import type {
  ListedBot,
  RecommendedBotEntry,
} from "../../../../shared/contracts/custom-bot-protocol";
import { useBotsQuery, useRecommendedBotsQuery } from "@/hooks/use-bots";

type BotTabKey = "recommended" | "filtered";

/**
 * Shown whenever the listing for the player's current settings contains no
 * OFFICIAL bot.
 *
 * The condition is the official subset rather than the row count, because a
 * listed third-party bot must not hide the fact that every official bot is
 * away. It is deliberately general: it says nothing about which bot is missing,
 * only that none is here, so it stays true whatever the reason.
 */
const NO_OFFICIAL_BOT_MESSAGE =
  "No official bot is available right now. Try again later.";

const formatBoardSizeShort = (width: number, height: number): string =>
  `${width}x${height}`;

interface BotsPanelProps {
  config: GameConfiguration;
  onPlayBot: (args: { botId: string; config: GameConfiguration }) => void;
  isPlaying?: boolean;
  errorMessage?: string | null;
}

export function BotsPanel({
  config,
  onPlayBot,
  isPlaying = false,
  errorMessage,
}: BotsPanelProps) {
  const { data: recommendedData, isLoading: recommendedLoading } =
    useRecommendedBotsQuery(config.variant, config.randomStart);
  const { data: matchingData, isLoading: matchingLoading } = useBotsQuery({
    variant: config.variant,
    randomStart: config.randomStart,
    boardWidth: config.boardWidth,
    boardHeight: config.boardHeight,
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

  // Each tab asks its own question of its own query, so each answers it
  // separately: the recommended listing is variant-wide, the filtered one is
  // narrowed to the exact board size.
  const noOfficialRecommended =
    !recommendedLoading && !recommendedRows.some((e) => e.bot.isOfficial);
  const noOfficialMatching =
    !matchingLoading && !matchingRows.some((b) => b.isOfficial);

  /**
   * The availability notice, placed where the player is already looking.
   *
   * With no rows at all it belongs in the empty table, replacing wording that
   * used to blame the player's settings for a server-side outage. With custom
   * rows present it goes above them instead, so the bot that IS there stays
   * listed and playable.
   */
  const renderUnavailableCaption = () => (
    <p className="text-xs text-muted-foreground mb-2">
      {NO_OFFICIAL_BOT_MESSAGE}
    </p>
  );

  const handlePlayBot = (
    botId: string,
    boardWidth: number,
    boardHeight: number,
  ) => {
    if (isPlaying) return;
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
  };

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
          {noOfficialRecommended && recommendedRows.length > 0 ? (
            renderUnavailableCaption()
          ) : (
            <p className="text-xs text-muted-foreground mb-2">
              Showing recommended bots for:{" "}
              {variantDisplayName(config.variant, config.randomStart)}
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">Name</TableHead>
                <TableHead className="text-left">Type</TableHead>
                <TableHead className="text-left">Board size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recommendedLoading &&
                renderEmptyState("Loading recommended bots...", 3)}
              {!recommendedLoading &&
                (recommendedRows.length === 0
                  ? renderEmptyState(NO_OFFICIAL_BOT_MESSAGE, 3)
                  : recommendedRows.map((entry) => (
                      <TableRow
                        key={`${entry.bot.id}-${entry.boardWidth}x${entry.boardHeight}`}
                        className="hover:bg-muted/40 transition-colors cursor-pointer"
                        onClick={() =>
                          handlePlayBot(
                            entry.bot.id,
                            entry.boardWidth,
                            entry.boardHeight,
                          )
                        }
                      >
                        <TableCell>{entry.bot.name}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              entry.bot.isOfficial ? "default" : "outline"
                            }
                          >
                            {entry.bot.isOfficial ? "official" : "custom"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {formatBoardSizeShort(
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
          {noOfficialMatching && matchingRows.length > 0 ? (
            renderUnavailableCaption()
          ) : (
            <p className="text-xs text-muted-foreground mb-2">
              Showing bots matching:{" "}
              {variantDisplayName(config.variant, config.randomStart)}
              {` | ${formatBoardSizeShort(config.boardWidth, config.boardHeight)}`}
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">Name</TableHead>
                <TableHead className="text-left">Type</TableHead>
                <TableHead className="text-left">Board size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {matchingLoading &&
                renderEmptyState("Loading matching bots...", 3)}
              {!matchingLoading &&
                (matchingRows.length === 0
                  ? renderEmptyState(NO_OFFICIAL_BOT_MESSAGE, 3)
                  : matchingRows.map((bot) => (
                      <TableRow
                        key={bot.id}
                        className="hover:bg-muted/40 transition-colors cursor-pointer"
                        onClick={() =>
                          handlePlayBot(
                            bot.id,
                            config.boardWidth,
                            config.boardHeight,
                          )
                        }
                      >
                        <TableCell>{bot.name}</TableCell>
                        <TableCell>
                          <Badge
                            variant={bot.isOfficial ? "default" : "outline"}
                          >
                            {bot.isOfficial ? "official" : "custom"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {formatBoardSizeShort(
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
