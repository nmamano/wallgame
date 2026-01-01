import { useMemo, useState } from "react";
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
import type {
  GameConfiguration,
  TimeControlPreset,
  Variant,
} from "../../../shared/domain/game-types";
import type {
  ListedBot,
  RecommendedBotEntry,
} from "../../../shared/contracts/custom-bot-protocol";
import { useBotsQuery, useRecommendedBotsQuery } from "@/hooks/use-bots";

type BotsTabKey = "recommended" | "matching";

interface BotsTableProps {
  config: GameConfiguration;
  onPlayBot: (args: { botId: string; config: GameConfiguration }) => void;
  onRecommendedSelect?: (boardWidth: number, boardHeight: number) => void;
  isPlaying?: boolean;
  errorMessage?: string | null;
}

const tabLabels: Record<BotsTabKey, string> = {
  recommended: "Recommended",
  matching: "Matching settings",
};

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

const formatBoardSize = (width: number, height: number): string =>
  `${width}x${height}`;

const usesBoardSize = (variant: Variant): boolean =>
  variant === "standard" || variant === "classic";

export function BotsTable({
  config,
  onPlayBot,
  onRecommendedSelect,
  isPlaying = false,
  errorMessage,
}: BotsTableProps) {
  const [activeTab, setActiveTab] = useState<BotsTabKey>("recommended");
  const timeControlPreset = config.timeControl.preset ?? "rapid";
  const includeBoardSize = usesBoardSize(config.variant);

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

  const renderTypeBadge = (isOfficial: boolean) => (
    <Badge variant={isOfficial ? "default" : "outline"}>
      {isOfficial ? "official" : "custom"}
    </Badge>
  );

  const renderEmptyState = (label: string) => (
    <TableRow>
      <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
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
      onClick={() =>
        onPlayBot({
          botId,
          config: {
            ...config,
            boardWidth,
            boardHeight,
            rated: false,
          },
        })
      }
    >
      Play
    </Button>
  );

  const headerLabel = `Bots (${formatVariantLabel(
    config.variant,
  )} / ${formatTimeControlLabel(timeControlPreset)} / Unrated)`;

  return (
    <Card className="p-5 border-border/50 bg-card/50 backdrop-blur">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-semibold">{headerLabel}</h2>
          <div className="inline-flex items-center gap-2">
            {(["recommended", "matching"] as BotsTabKey[]).map((tab) => (
              <Button
                key={tab}
                variant={activeTab === tab ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveTab(tab)}
                aria-pressed={activeTab === tab}
              >
                {tabLabels[tab]}
              </Button>
            ))}
          </div>
        </div>

        {errorMessage && (
          <p className="text-sm text-destructive">{errorMessage}</p>
        )}

        <div className="overflow-x-auto">
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
              {activeTab === "recommended" &&
                recommendedLoading &&
                renderEmptyState("Loading recommended bots...")}
              {activeTab === "matching" &&
                matchingLoading &&
                renderEmptyState("Loading matching bots...")}

              {activeTab === "recommended" &&
                !recommendedLoading &&
                (recommendedRows.length === 0
                  ? renderEmptyState("No recommended bots for these settings.")
                  : recommendedRows.map((entry) => (
                      <TableRow
                        key={`${entry.bot.id}-${entry.boardWidth}x${entry.boardHeight}`}
                        className="hover:bg-muted/40 transition-colors"
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
                          {formatBoardSize(entry.boardWidth, entry.boardHeight)}
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

              {activeTab === "matching" &&
                !matchingLoading &&
                (matchingRows.length === 0
                  ? renderEmptyState("No bots match your current settings.")
                  : matchingRows.map((bot) => (
                      <TableRow key={bot.id} className="hover:bg-muted/40">
                        <TableCell>{bot.name}</TableCell>
                        <TableCell>{renderTypeBadge(bot.isOfficial)}</TableCell>
                        <TableCell>
                          {includeBoardSize
                            ? formatBoardSize(
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
      </div>
    </Card>
  );
}
