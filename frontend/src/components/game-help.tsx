import { CircleHelp } from "lucide-react";
import type { PlayerId, Variant } from "../../../shared/domain/game-types";
import { helpVariantFor } from "../../../shared/domain/variant-rules";
import { RuleGuide } from "@/components/rule-guide";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { PlayerColor } from "@/lib/player-colors";

interface GameHelpProps {
  variant: Variant;
  playerColors: Record<PlayerId, PlayerColor>;
  primaryLocalPlayerId: PlayerId | null;
  placement: "desktop" | "phone";
}

export function GameHelp({
  variant,
  playerColors,
  primaryLocalPlayerId,
  placement,
}: GameHelpProps) {
  const helpVariant = helpVariantFor(variant);
  if (!helpVariant) return null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        {placement === "phone" ? (
          <button
            type="button"
            aria-label="Game help"
            className="flex h-6 cursor-pointer items-center gap-1 rounded-md px-[7px] text-[10px] font-semibold tracking-[0.025em] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <CircleHelp className="size-3.5" />
            HELP
          </button>
        ) : (
          <Button
            type="button"
            aria-label="Game help"
            variant="outline"
            className="h-6 px-[7px] text-[11px] font-semibold tracking-[0.02em] text-muted-foreground shadow-none"
          >
            HELP
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="game-help-motion max-h-[calc(100dvh-1.25rem)] max-w-[calc(100%-1.25rem)] gap-0 overflow-y-auto p-3.5 sm:max-h-[calc(100dvh-2rem)] sm:max-w-[780px] sm:p-[22px]"
        overlayClassName="game-help-motion"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Game help</DialogTitle>
        <RuleGuide
          variant={helpVariant}
          playerColors={playerColors}
          diagramPlayerId={primaryLocalPlayerId ?? 1}
        />
      </DialogContent>
    </Dialog>
  );
}
