import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { colorFilterMap } from "@/lib/player-colors";

interface PawnSelectorProps {
  value: string;
  onChange: (value: string) => void;
  pawns: readonly string[];
  basePath: string;
  label: string;
  defaultLabel?: string;
  color?: string; // Player color to apply to pawns
}

export function PawnSelector({
  value,
  onChange,
  pawns,
  basePath,
  label,
  defaultLabel = "Default",
  color,
}: PawnSelectorProps) {
  const [open, setOpen] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Ensure basePath ends with a slash
  const normalizedBasePath = basePath.endsWith("/") ? basePath : `${basePath}/`;

  // Extract the pawn type from the label (e.g., "Cat Pawn" -> "Cat")
  const pawnType = label.split(" ")[0];

  // Helper function to get display name from filename
  const getDisplayName = (filename: string) => {
    // Extract number from filename (e.g., "cat1.svg" -> "1", "mouse42.svg" -> "42")
    const match = filename.match(/\d+/);
    if (match) {
      return `${pawnType} ${match[0]}`;
    }
    return filename;
  };

  // Get display name for the selected value
  const displayValue = value === "default" ? defaultLabel : getDisplayName(value);

  // Get the CSS filter for the selected color
  const colorFilter = color && colorFilterMap[color] ? colorFilterMap[color] : undefined;

  // Scroll to selected item when dialog opens
  useEffect(() => {
    if (open) {
      const timeoutId = setTimeout(() => {
        // Find the selected button by its data attribute
        const selectedButton = document.querySelector(`[data-pawn-value="${value}"]`) as HTMLElement;
        if (selectedButton && scrollAreaRef.current) {
          // Get the viewport element from Radix ScrollArea
          const viewport = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
          if (viewport) {
            // Calculate the position to scroll to (center the selected item)
            const buttonTop = selectedButton.offsetTop;
            const buttonHeight = selectedButton.offsetHeight;
            const viewportHeight = viewport.clientHeight;
            const scrollTo = buttonTop - (viewportHeight / 2) + (buttonHeight / 2);
            
            viewport.scrollTo({
              top: Math.max(0, scrollTo),
              behavior: 'auto'
            });
          }
        }
      }, 250);
      
      return () => clearTimeout(timeoutId);
    }
  }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full justify-between h-12">
          <span className="truncate">
            {displayValue}
          </span>
          {/* Preview of selected pawn */}
          {value !== "default" && (
            <div className="h-8 w-8 ml-2 shrink-0">
              <img
                src={`${normalizedBasePath}${value}`}
                alt="Selected"
                className="h-full w-full object-contain"
                style={colorFilter ? { filter: colorFilter } : undefined}
              />
            </div>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Select {label}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 mt-4">
          <ScrollArea className="h-full pr-4" ref={scrollAreaRef}>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3 pb-4">
              <Button
                variant="ghost"
                className={cn(
                  "w-full p-3 border-2 flex flex-col gap-2 h-auto aspect-square",
                  value === "default" ? "border-primary" : "border-transparent"
                )}
                onClick={() => {
                  onChange("default");
                  setOpen(false);
                }}
                data-pawn-value="default"
              >
                <span className="text-sm font-medium">Default</span>
              </Button>
              {pawns.map((pawn) => (
                <Button
                  key={pawn}
                  variant="ghost"
                  className={cn(
                    "p-1 border-2 h-auto aspect-square",
                    value === pawn ? "border-primary" : "border-transparent"
                  )}
                  onClick={() => {
                    onChange(pawn);
                    setOpen(false);
                  }}
                  data-pawn-value={pawn}
                >
                  <img
                    src={`${normalizedBasePath}${pawn}`}
                    alt={pawn}
                    className="h-full w-full object-contain"
                    loading="lazy"
                    style={colorFilter ? { filter: colorFilter } : undefined}
                  />
                </Button>
              ))}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
