import { useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import type { MoveHistoryRow } from "@/components/move-list-panel";
import type { HistoryNav } from "@/types/history";

interface MobileMoveBarProps {
  formattedHistory: MoveHistoryRow[];
  historyNav: HistoryNav;
}

/**
 * Compact horizontal move bar for mobile game page.
 * Moves scroll horizontally in a carousel; nav buttons on the edges.
 * The active move auto-scrolls into view.
 */
export function MobileMoveBar({
  formattedHistory,
  historyNav,
}: MobileMoveBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Auto-scroll to keep the active move visible.
  // If no move is active (e.g. jumped to initial position before first move),
  // scroll the container to the start.
  useEffect(() => {
    if (activeRef.current && scrollRef.current) {
      activeRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    } else if (scrollRef.current) {
      scrollRef.current.scrollTo({ left: 0, behavior: "smooth" });
    }
  }, [historyNav.cursor]);

  // Flatten rows into a list of individual moves for the horizontal strip
  const moves: { notation: string; plyIndex: number }[] = [];
  for (const row of formattedHistory) {
    if (row.white)
      moves.push({
        notation: `${row.num}. ${row.white.notation}`,
        plyIndex: row.white.plyIndex,
      });
    if (row.black)
      moves.push({
        notation: `${row.num}… ${row.black.notation}`,
        plyIndex: row.black.plyIndex,
      });
  }

  // Determine which ply is active (cursor, or latest if live)
  const activePly = historyNav.cursor ?? historyNav.latestPlyIndex;

  return (
    <div
      className="flex items-center w-full px-1 shrink-0 gap-0.5"
      style={{ height: "32px" }}
    >
      {/* Jump to start */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={historyNav.jumpStart}
        disabled={!historyNav.canStepBack}
      >
        <ChevronsLeft className="w-3.5 h-3.5" />
      </Button>

      {/* Step back */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={historyNav.stepBack}
        disabled={!historyNav.canStepBack}
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </Button>

      {/* Scrollable move list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-x-auto overflow-y-hidden flex items-center gap-0.5 min-w-0 scrollbar-none"
      >
        {moves.length === 0 ? (
          <span className="text-[10px] text-muted-foreground px-1 whitespace-nowrap">
            No moves
          </span>
        ) : (
          moves.map((move) => {
            const isActive = move.plyIndex === activePly;
            return (
              <button
                key={move.plyIndex}
                ref={isActive ? activeRef : undefined}
                className={`px-1.5 py-0.5 text-[10px] rounded whitespace-nowrap cursor-pointer transition-colors ${
                  isActive
                    ? "bg-primary text-primary-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
                onClick={() => historyNav.goTo(move.plyIndex)}
              >
                {move.notation}
              </button>
            );
          })
        )}
      </div>

      {/* Step forward */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={historyNav.stepForward}
        disabled={!historyNav.canStepForward}
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </Button>

      {/* Jump to end */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={historyNav.jumpEnd}
        disabled={!historyNav.canStepForward}
      >
        <ChevronsRight className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}
