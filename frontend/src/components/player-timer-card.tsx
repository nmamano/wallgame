import { Badge } from "@/components/ui/badge";
import { Bot, User } from "lucide-react";
import { colorFilterMap, colorHexMap } from "@/lib/player-colors";
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
  isThinking?: boolean;
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
  isThinking = false,
  score = null,
  gameStatus = "playing",
}: PlayerTimerCardProps) {
  // Determine if we should show cat SVG for this player
  const shouldShowCatSvg =
    player.catSkin && player.catSkin !== "default" && player.catSkin.length > 0;
  const catSvgPath = shouldShowCatSvg ? `/pawns/cat/${player.catSkin}` : null;
  const colorFilter = colorFilterMap[player.color]
    ? { filter: colorFilterMap[player.color] }
    : undefined;

  // Suppress active highlighting when game is finished (nobody's turn)
  const shouldShowActiveState = gameStatus !== "finished" && isActive;

  return (
    <div
      className={`flex items-center justify-between gap-2 lg:gap-3 p-2 lg:p-3 rounded-lg transition-colors shadow-sm ${
        shouldShowActiveState
          ? "bg-accent/50 border border-accent"
          : "bg-card/50 backdrop-blur border border-border"
      }`}
    >
      {/* Left side: Profile pic, Name/Rating/Online, Score card */}
      <div className="flex items-center gap-2 lg:gap-3 min-w-0 flex-1">
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
              {player.name}
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

        {/* Match score card */}
        {typeof score === "number" && (
          <Badge
            variant="outline"
            className="text-[10px] lg:text-xs px-1.5 lg:px-2 py-0 lg:py-0.5 flex-shrink-0 bg-card/50 border-border h-5 lg:h-auto"
          >
            Score {score}
          </Badge>
        )}
      </div>

      {/* Right side: "Bot is thinking" message, Timer */}
      <div className="flex items-center gap-2 lg:gap-3 flex-shrink-0">
        {/* "Bot is thinking" info message */}
        {isThinking && (
          <div className="flex items-center gap-1 lg:gap-1.5 text-[10px] lg:text-xs text-muted-foreground">
            <Bot className="w-3 h-3" />
            <span>{`Thinking...`}</span>
          </div>
        )}

        {/* Timer */}
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
