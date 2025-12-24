import { useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import type { HistoryNav } from "@/types/history";

export interface MoveHistoryCell {
  notation: string;
  plyIndex: number;
}

export interface MoveHistoryRow {
  num: number;
  white?: MoveHistoryCell;
  black?: MoveHistoryCell;
}

interface MoveListPanelProps {
  formattedHistory: MoveHistoryRow[];
  historyNav: HistoryNav;
  hasNewMovesWhileRewound: boolean;
}

export function MoveListPanel({
  formattedHistory,
  historyNav,
  hasNewMovesWhileRewound,
}: MoveListPanelProps) {
  const hasHistory = formattedHistory.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Track scroll position during user scrolling
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 10;
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  // Auto-scroll to bottom when new moves come in (only if was at bottom)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [formattedHistory.length]);
  const renderMoveButton = (
    cell: MoveHistoryCell | undefined,
    showRightBorder: boolean,
  ) => {
    if (!cell) {
      return (
        <button
          className={`p-2 text-center text-muted-foreground font-mono cursor-default ${
            showRightBorder ? "border-r" : ""
          }`}
          disabled
        >
          —
        </button>
      );
    }
    const isLiveView = historyNav.cursor === null;
    const isSelected =
      historyNav.cursor === cell.plyIndex ||
      (isLiveView && historyNav.latestPlyIndex === cell.plyIndex);
    const baseClasses = "p-2 text-center transition-colors font-mono";
    const hoverClasses = isSelected
      ? "bg-primary/15 text-primary font-semibold"
      : "hover:bg-accent";
    return (
      <button
        className={`${baseClasses} ${hoverClasses} ${
          showRightBorder ? "border-r" : ""
        }`}
        onClick={() => historyNav.goTo(cell.plyIndex)}
        aria-pressed={isSelected}
      >
        {cell.notation}
      </button>
    );
  };

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-none"
      >
        <div className="grid grid-cols-[3rem_1fr_1fr] text-sm">
          {formattedHistory.map((row, index) => (
            <div
              key={index}
              className={`contents group ${
                index % 2 === 1 ? "bg-muted/30" : ""
              }`}
            >
              <div className="p-2 text-muted-foreground text-center border-r">
                {row.num}.
              </div>
              {renderMoveButton(row.white, true)}
              {renderMoveButton(row.black, false)}
            </div>
          ))}
        </div>
      </div>
      <div className="px-2 py-1 border-t grid grid-cols-4 gap-1 bg-muted/30 flex-shrink-0 justify-items-center">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 cursor-pointer"
          onClick={historyNav.jumpStart}
          disabled={!hasHistory || historyNav.cursor === -1}
          aria-label="Jump to beginning"
        >
          <ChevronsLeft className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 cursor-pointer"
          onClick={historyNav.stepBack}
          disabled={!historyNav.canStepBack}
          aria-label="Step back"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 cursor-pointer"
          onClick={historyNav.stepForward}
          disabled={!historyNav.canStepForward}
          aria-label="Step forward"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
        <Button
          variant={hasNewMovesWhileRewound ? "secondary" : "ghost"}
          size="icon"
          className={`h-7 cursor-pointer ${
            hasNewMovesWhileRewound ? "animate-pulse text-primary" : ""
          }`}
          onClick={historyNav.jumpEnd}
          disabled={historyNav.cursor === null}
          aria-label="Go live"
        >
          <ChevronsRight className="w-4 h-4" />
        </Button>
      </div>
    </>
  );
}
