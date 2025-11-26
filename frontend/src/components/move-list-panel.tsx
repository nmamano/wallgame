import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

interface MoveListPanelProps {
  formattedHistory: {
    num: number;
    white?: string;
    black?: string;
  }[];
}

export function MoveListPanel({ formattedHistory }: MoveListPanelProps) {
  return (
    <>
      <ScrollArea className="flex-1 p-0">
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
              <button className="p-2 hover:bg-accent text-center transition-colors border-r font-mono">
                {row.white}
              </button>
              <button className="p-2 hover:bg-accent text-center transition-colors font-mono">
                {row.black}
              </button>
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="p-2 border-t grid grid-cols-4 gap-1 bg-muted/30 flex-shrink-0">
        <Button variant="ghost" size="icon" className="h-8">
          <ChevronsLeft className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8">
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8">
          <ChevronRight className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8">
          <ChevronsRight className="w-4 h-4" />
        </Button>
      </div>
    </>
  );
}
