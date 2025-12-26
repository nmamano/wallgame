import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Clock,
  Volume2,
  VolumeX,
  Music,
  Music2,
  Swords,
  AlertCircle,
} from "lucide-react";
import type { GameConfiguration } from "../../../shared/domain/game-types";
import type { PlayerType } from "@/lib/gameViewModel";

interface GameInfoPanelProps {
  config: GameConfiguration | null;
  defaultVariant: string;
  defaultTimeControlPreset: string | null | undefined;
  sfxEnabled: boolean;
  onSfxToggle: () => void;
  musicEnabled: boolean;
  onMusicToggle: () => void;
  interactionLocked: boolean;
  isMultiplayerMatch: boolean;
  unsupportedPlayers: PlayerType[];
  placeholderCopy: Partial<Record<PlayerType, string>>;
}

export function GameInfoPanel({
  config,
  defaultVariant,
  defaultTimeControlPreset,
  sfxEnabled,
  onSfxToggle,
  musicEnabled,
  onMusicToggle,
  interactionLocked,
  isMultiplayerMatch,
  unsupportedPlayers,
  placeholderCopy,
}: GameInfoPanelProps) {
  return (
    <>
      <Card className="p-2 lg:p-4 space-y-2 lg:space-y-3 bg-card/50 backdrop-blur">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 lg:gap-2">
            <Swords className="w-3.5 h-3.5 lg:w-4 lg:h-4 text-muted-foreground" />
            <span className="font-medium capitalize text-sm lg:text-base">
              {config?.variant ?? defaultVariant}
            </span>
          </div>
          <Badge
            variant={config?.rated ? "default" : "secondary"}
            className="text-[10px] lg:text-xs px-1.5 lg:px-2.5 h-5 lg:h-auto"
          >
            {config?.rated ? "Rated" : "Casual"}
          </Badge>
        </div>
        <div className="flex items-center justify-between text-xs lg:text-sm text-muted-foreground">
          <div className="flex items-center gap-1.5 lg:gap-2">
            <Clock className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
            <span className="capitalize">
              {config?.timeControl.preset ??
                defaultTimeControlPreset ??
                "blitz"}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 lg:h-6 lg:w-6"
              onClick={onSfxToggle}
              title={sfxEnabled ? "Mute sound effects" : "Unmute sound effects"}
            >
              {sfxEnabled ? (
                <Volume2 className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
              ) : (
                <VolumeX className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 lg:h-6 lg:w-6"
              onClick={onMusicToggle}
              title={musicEnabled ? "Mute music" : "Unmute music"}
            >
              {musicEnabled ? (
                <Music className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
              ) : (
                <Music2 className="w-3.5 h-3.5 lg:w-4 lg:h-4 opacity-50" />
              )}
            </Button>
          </div>
        </div>
      </Card>

      {interactionLocked && !isMultiplayerMatch && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="space-y-1">
            {unsupportedPlayers
              .map((type) => placeholderCopy[type])
              .filter(Boolean)
              .map((text, idx) => (
                <div key={`${text}-${idx}`}>{text}</div>
              ))}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
