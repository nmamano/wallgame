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
  isPending,
  isVisible,
  player1Color,
  player2Color,
}: EvaluationBarProps) {
  // Convert evaluation (-1 to +1) to percentage (0 to 100)
  // +1 = P1 winning = 100% P1 color
  // -1 = P2 winning = 0% P1 color (100% P2 color)
  // 0 = even = 50/50 split
  const displayEval = evaluation ?? 0; // Default to 50/50 when no eval yet
  const p1Percentage = ((displayEval + 1) / 2) * 100;

  return (
    // Container always renders with fixed height for space allocation
    <div className="w-full flex items-center gap-2 py-2">
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
              style={{ width: `${p1Percentage}%` }}
            />
            {/* P2 side (right) */}
            <div
              className={cn("h-full flex-1", bgColorClassMap[player2Color])}
            />
            {/* Pending overlay */}
            {isPending && (
              <div className="absolute inset-0 bg-black/30 animate-pulse rounded" />
            )}
          </>
        )}
      </div>

      {/* Eval number display - next to the bar */}
      <div
        className={cn(
          "text-[11px] font-mono font-semibold tabular-nums min-w-[4.5ch] text-right",
          isVisible ? "text-muted-foreground" : "text-transparent",
        )}
      >
        {evaluation !== null ? formatEval(evaluation) : "—"}
      </div>
    </div>
  );
}
