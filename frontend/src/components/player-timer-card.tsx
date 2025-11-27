import { Badge } from "@/components/ui/badge";
import { Bot, User } from "lucide-react";
import { colorFilterMap } from "@/lib/player-colors";
import type { PlayerId } from "../../../shared/game-types";
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
}: PlayerTimerCardProps) {
  // Determine if we should show cat SVG for this player
  const shouldShowCatSvg =
    player.catSkin && player.catSkin !== "default" && player.catSkin.length > 0;
  const catSvgPath = shouldShowCatSvg ? `/pawns/cat/${player.catSkin}` : null;
  const colorFilter = colorFilterMap[player.color]
    ? { filter: colorFilterMap[player.color] }
    : undefined;

  return (
    <div
      className={`flex items-center justify-between gap-3 p-3 rounded-lg transition-colors shadow-sm ${
        isActive
          ? "bg-accent/50 border border-accent"
          : "bg-card/50 backdrop-blur border border-border"
      }`}
    >
      {/* Left side: Profile pic, Name/Rating/Online, Score card */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* Profile pic */}
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
            player.color === "red"
              ? "bg-red-100 text-red-700"
              : "bg-blue-100 text-blue-700"
          }`}
        >
          {catSvgPath ? (
            <img
              src={catSvgPath}
              alt="player avatar"
              className="w-full h-full object-contain rounded-full"
              style={colorFilter}
            />
          ) : player.type.includes("bot") ? (
            <Bot size={20} />
          ) : (
            <User size={20} />
          )}
        </div>

        {/* Name with rating and online indicator */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate">{player.name}</span>
            <Badge variant="outline" className="text-xs flex-shrink-0">
              {player.rating}
            </Badge>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span
              className={`w-2 h-2 rounded-full ${
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
            className="text-[12px] px-2 py-0.5 flex-shrink-0 bg-card/50 border-border"
          >
            Score {score}
          </Badge>
        )}
      </div>

      {/* Right side: "Bot is thinking" message, Timer */}
      <div className="flex items-center gap-3 flex-shrink-0">
        {/* "Bot is thinking" info message */}
        {isThinking && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Bot className="w-3 h-3" />
            <span>{`Thinking...`}</span>
          </div>
        )}

        {/* Timer */}
        <div
          className={`text-2xl font-mono font-bold whitespace-nowrap ${
            isActive ? "text-foreground" : "text-muted-foreground/50"
          } ${timeLeft < 30 ? "text-red-500 animate-pulse" : ""}`}
        >
          {formatTime(Math.max(0, Math.round(timeLeft)))}
        </div>
      </div>
    </div>
  );
}
