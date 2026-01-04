import { Badge } from "@/components/ui/badge";
import { Bot, User } from "lucide-react";
import { colorFilterMap, colorHexMap } from "@/lib/player-colors";
import { resolvePawnStyleSrc } from "@/lib/pawn-style";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";
import type { PlayerType } from "@/lib/gameViewModel";

export interface GamePlayer {
  id: string;
  playerId: PlayerId;
  name: string;
  rating: number;
  color: PlayerColor;
  type: PlayerType;
  isOnline: boolean;
  catSkin?: string;
  mouseSkin?: string;
}

interface PlayerTimerCardProps {
  player: GamePlayer;
  isActive: boolean;
  timeLeft: number;
  goalDistance: number | null;
  minWidthRem: number;
  score?: number | null;
  gameStatus?: "playing" | "finished" | "aborted";
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function PlayerTimerCard({
  player,
  isActive,
  timeLeft,
  goalDistance,
  minWidthRem,
  score = null,
  gameStatus = "playing",
}: PlayerTimerCardProps) {
  const nameSuffixRegex = /\s*\((?:also\s+you|you)\)\s*$/i;
  const nameSuffixMatch = nameSuffixRegex.exec(player.name);
  const nameSuffixLabel = nameSuffixMatch ? nameSuffixMatch[0].trim() : null;
  const baseName = player.name.replace(nameSuffixRegex, "").trim();
  const trimmedBaseName =
    baseName.length > 10 ? `${baseName.slice(0, 8)}..` : baseName;
  // Determine if we should show cat SVG for this player
  const shouldShowCatSvg =
    player.catSkin && player.catSkin !== "default" && player.catSkin.length > 0;
  const catSvgPath = shouldShowCatSvg
    ? resolvePawnStyleSrc(player.catSkin, "cat")
    : null;
  const colorFilter = colorFilterMap[player.color]
    ? { filter: colorFilterMap[player.color] }
    : undefined;

  // Suppress active highlighting when game is finished (nobody's turn)
  const shouldShowActiveState = gameStatus !== "finished" && isActive;
  const goalDistanceLabel =
    goalDistance == null
      ? "--"
      : goalDistance < 0
        ? "No path"
        : `${goalDistance}`;
  const scoreLabel = typeof score === "number" ? `${score}` : "--";
  const middleBadgeClass = shouldShowActiveState
    ? "border-accent/60 bg-accent/20 text-foreground/80"
    : "border-border/60 bg-muted/40 text-muted-foreground";

  return (
    <div
      className={`flex items-center justify-between gap-2 lg:gap-3 p-2 lg:p-3 rounded-lg transition-colors shadow-sm ${
        shouldShowActiveState
          ? "bg-accent/50 border border-accent"
          : "bg-card/50 backdrop-blur border border-border"
      }`}
      style={{ minWidth: `${minWidthRem}rem` }}
    >
      {/* Left side: Profile pic, Name/Rating/Online */}
      <div className="flex items-center gap-2 lg:gap-3 min-w-0">
        {/* Profile pic */}
        <div
          className="w-8 h-8 lg:w-10 lg:h-10 rounded-full flex items-center justify-center flex-shrink-0"
          style={{
            backgroundColor: `${colorHexMap[player.color]}20`,
            color: colorHexMap[player.color],
          }}
        >
          {catSvgPath ? (
            <img
              src={catSvgPath}
              alt="player avatar"
              className="w-full h-full object-contain rounded-full"
              style={colorFilter}
            />
          ) : player.type.includes("bot") ? (
            <Bot size={16} className="lg:w-5 lg:h-5" />
          ) : (
            <User size={16} className="lg:w-5 lg:h-5" />
          )}
        </div>

        {/* Name with rating and online indicator */}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 lg:gap-2">
            <span className="font-semibold truncate text-sm lg:text-base">
              {trimmedBaseName || player.name}
              {nameSuffixLabel && (
                <span className="hidden lg:inline"> {nameSuffixLabel}</span>
              )}
            </span>
            <Badge
              variant="outline"
              className="text-[10px] lg:text-xs px-1 lg:px-2 py-0 lg:py-0.5 flex-shrink-0 h-4 lg:h-auto"
            >
              {player.rating}
            </Badge>
          </div>
          <div className="flex items-center gap-1 text-[10px] lg:text-xs text-muted-foreground">
            <span
              className={`w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full ${
                player.isOnline ? "bg-green-500" : "bg-gray-300"
              }`}
            />
            {player.isOnline ? "Online" : "Offline"}
          </div>
        </div>
      </div>

      {/* Middle: Match score and distance */}
      <div className="flex-1 min-w-0 px-1 lg:px-2">
        <div className="grid grid-cols-2 gap-2 lg:gap-3">
          <div className="flex items-center justify-center">
            <Badge
              variant="outline"
              className={`text-[10px] lg:text-xs px-1.5 lg:px-2 py-0 lg:py-0.5 h-5 lg:h-auto whitespace-nowrap ${middleBadgeClass}`}
            >
              Match<span className="hidden lg:inline"> Score</span>:{" "}
              {scoreLabel}
            </Badge>
          </div>
          <div className="flex items-center justify-center">
            <Badge
              variant="outline"
              className={`text-[10px] lg:text-xs px-1.5 lg:px-2 py-0 lg:py-0.5 h-5 lg:h-auto whitespace-nowrap ${middleBadgeClass}`}
              title="Distance to goal"
            >
              Distance {goalDistanceLabel}
            </Badge>
          </div>
        </div>
      </div>

      {/* Right side: Timer */}
      <div className="flex items-center gap-2 lg:gap-3 flex-shrink-0">
        <div
          className={`text-md lg:text-xl font-mono font-bold whitespace-nowrap ${
            shouldShowActiveState
              ? "text-foreground"
              : "text-muted-foreground/50"
          } ${timeLeft < 30 ? "text-red-500 animate-pulse" : ""}`}
        >
          {formatTime(Math.max(0, Math.round(timeLeft)))}
        </div>
      </div>
    </div>
  );
}
