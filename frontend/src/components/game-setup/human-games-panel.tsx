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
  GameSnapshot,
  TimeControlConfig,
  TimeControlPreset,
} from "../../../../shared/domain/game-types";
import { formatTimeControl as formatTimeControlUtil } from "../../../../shared/domain/game-utils";
import { assetUrl } from "@/lib/asset-url";

interface GameMatchStatus {
  variant: boolean;
  rated: boolean;
  timeControl: boolean;
  boardSize: boolean;
  allMatch: boolean;
}

export interface GameWithMatchStatus extends GameSnapshot {
  matchStatus: GameMatchStatus;
}

function formatTimeControl(timeControl: TimeControlConfig): string {
  if (timeControl.preset) {
    const formats: Record<TimeControlPreset, string> = {
      bullet: "bullet (1+0)",
      blitz: "blitz (3+2)",
      rapid: "rapid (10+2)",
      classical: "classical (30+0)",
      unlimited: "unlimited",
    };
    return formats[timeControl.preset];
  }
  return formatTimeControlUtil(timeControl);
}

function getTimeControlIcon(timeControl: TimeControlConfig): string {
  if (!timeControl.preset) return "";
  const iconMap: Record<TimeControlPreset, string> = {
    bullet: assetUrl("/time_control_icons/activity.lichess-bullet.webp"),
    blitz: assetUrl("/time_control_icons/activity.lichess-blitz.webp"),
    rapid: assetUrl("/time_control_icons/activity.lichess-rapid.webp"),
    classical: assetUrl("/time_control_icons/activity.lichess-classical.webp"),
    unlimited: "",
  };
  return iconMap[timeControl.preset] || "";
}

const formatBoardSizeFull = (width: number, height: number): string => {
  const totalCells = width * height;
  let sizeName = "custom";
  if (totalCells <= 36) sizeName = "small";
  else if (totalCells <= 81) sizeName = "medium";
  else if (totalCells <= 144) sizeName = "large";
  return `${sizeName} (${width}x${height})`;
};

interface HumanGamesPanelProps {
  matchmakingGames: GameWithMatchStatus[];
  isLoadingGames: boolean;
  isJoiningGame: string | null;
  onJoinGame: (gameId: string) => void;
}

export function HumanGamesPanel({
  matchmakingGames,
  isLoadingGames,
  isJoiningGame,
  onJoinGame,
}: HumanGamesPanelProps) {
  const formatPlayers = (players: GameWithMatchStatus["players"]): string =>
    players
      .filter((p) => p.ready || p.role === "host")
      .map((p) => p.displayName)
      .join(" & ");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">Games waiting for players</h3>
        {isLoadingGames && (
          <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-center">Player</TableHead>
              <TableHead className="text-center">Variant</TableHead>
              <TableHead className="text-center">Rated</TableHead>
              <TableHead className="text-center">Time control</TableHead>
              <TableHead className="text-center">Board size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {matchmakingGames.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-6 text-center text-muted-foreground"
                >
                  {isLoadingGames
                    ? "Loading available games..."
                    : "No players waiting. Create a game above and wait for an opponent."}
                </TableCell>
              </TableRow>
            ) : (
              matchmakingGames.map((game) => (
                <TableRow
                  key={game.id}
                  onClick={() => onJoinGame(game.id)}
                  className={`cursor-pointer hover:bg-muted/50 transition-colors ${
                    isJoiningGame === game.id ? "opacity-50" : ""
                  }`}
                >
                  <TableCell className="text-center">
                    {formatPlayers(game.players)}
                  </TableCell>
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
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
