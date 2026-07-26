import { useState } from "react";
import { cn } from "@/lib/utils";
import type { PlayerColor } from "@/lib/player-colors";

interface EvaluationBarProps {
  evaluation: number | null; // -1 to +1
  isPending: boolean;
  isVisible: boolean; // Toggle is ON
  player1Color: PlayerColor;
  player2Color: PlayerColor;
}

// Background color classes for player colors
const bgColorClassMap: Record<PlayerColor, string> = {
  red: "bg-red-600",
  blue: "bg-blue-600",
  green: "bg-green-600",
  purple: "bg-purple-600",
  pink: "bg-pink-500",
  cyan: "bg-cyan-500",
  brown: "bg-amber-700",
  gray: "bg-gray-500",
};

// Format evaluation for display
const formatEval = (evaluation: number): string => {
  // Show as percentage: +1 = +100%, 0 = 0%, -1 = -100%
  const pct = Math.round(evaluation * 100);
  if (pct > 0) {
    return `+${pct}%`;
  }
  return `${pct}%`;
};

export function EvaluationBar({
  evaluation,
  isVisible,
  player1Color,
  player2Color,
}: EvaluationBarProps) {
  // Track last authoritative evaluation to avoid jumping to 50% between moves.
  // When a new move is made, evaluation becomes null until the engine responds.
  // Instead of snapping to 50%, we keep the bar at its last position but dimmed.
  const [lastKnownEval, setLastKnownEval] = useState<number | null>(null);
  if (evaluation !== null && evaluation !== lastKnownEval) {
    setLastKnownEval(evaluation);
  }

  const displayEval = evaluation ?? lastKnownEval ?? 0;
  const isStale = evaluation === null && lastKnownEval !== null;
  const p1Percentage = ((displayEval + 1) / 2) * 100;

  return (
    // Container always renders with fixed height for space allocation
    <div className="w-full flex items-center py-2 px-2">
      {/* The bar itself - always rendered for consistent spacing */}
      <div
        className={cn(
          "relative flex-1 h-3 flex rounded overflow-hidden",
          isVisible ? "shadow-sm" : "bg-muted/30",
        )}
      >
        {isVisible && (
          <>
            {/* P1 side (left) */}
            <div
              className={cn(
                "h-full transition-all duration-300 ease-out",
                bgColorClassMap[player1Color],
              )}
              style={{
                width: `${p1Percentage}%`,
                opacity: isStale ? 0.4 : 1,
                transition: "width 300ms ease-out, opacity 200ms ease-out",
              }}
            />
            {/* P2 side (right) */}
            <div
              className={cn("h-full flex-1", bgColorClassMap[player2Color])}
              style={{
                opacity: isStale ? 0.4 : 1,
                transition: "opacity 200ms ease-out",
              }}
            />
          </>
        )}
      </div>

      {/* Eval number display - always rendered for consistent height, collapses width when hidden */}
      <div
        className={cn(
          "text-[11px] font-mono font-semibold tabular-nums text-right overflow-hidden",
          isVisible ? "min-w-[3.5ch] text-muted-foreground" : "w-0 min-w-0",
        )}
      >
        {evaluation !== null ? formatEval(evaluation) : "—"}
      </div>
    </div>
  );
}
