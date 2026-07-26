import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const GRID_SIZE = 12;
const MIN_SIZE = 4;

interface BoardSizePickerProps {
  width: number;
  height: number;
  onChange: (width: number, height: number) => void;
  disabled?: boolean;
}

export function BoardSizePicker({
  width,
  height,
  onChange,
  disabled = false,
}: BoardSizePickerProps) {
  const [open, setOpen] = useState(false);
  const [hoverCell, setHoverCell] = useState<{
    col: number;
    row: number;
  } | null>(null);

  const displayRows = hoverCell ? hoverCell.row : height;
  const displayCols = hoverCell ? hoverCell.col : width;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`px-3 py-1.5 rounded-md border text-sm font-medium tabular-nums transition-colors ${
            disabled
              ? "border-border bg-muted text-muted-foreground cursor-not-allowed"
              : "border-border bg-background hover:bg-accent hover:text-accent-foreground cursor-pointer"
          }`}
        >
          {height}×{width}
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-auto p-3"
        onMouseLeave={() => setHoverCell(null)}
      >
        <p className="text-center text-sm font-medium tabular-nums mb-2">
          {displayRows} × {displayCols}
        </p>

        <div
          className="grid bg-border rounded-sm overflow-hidden"
          style={{
            gridTemplateColumns: `repeat(${GRID_SIZE}, 28px)`,
            gridAutoRows: "28px",
            gap: "1px",
          }}
        >
          {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => {
            const col = (i % GRID_SIZE) + 1;
            const row = Math.floor(i / GRID_SIZE) + 1;
            const belowMin = col < MIN_SIZE || row < MIN_SIZE;
            const isInHoverRegion =
              hoverCell != null && col <= hoverCell.col && row <= hoverCell.row;
            const isSelected =
              hoverCell == null && col <= width && row <= height;

            let bgClass: string;
            if (isInHoverRegion) {
              bgClass = "bg-primary/40";
            } else if (isSelected) {
              bgClass = "bg-primary/20";
            } else {
              bgClass = "bg-background";
            }

            return (
              <button
                key={i}
                type="button"
                className={`${bgClass} transition-colors duration-75`}
                onMouseEnter={() => {
                  setHoverCell(belowMin ? null : { col, row });
                }}
                onClick={() => {
                  if (belowMin) return;
                  onChange(col, row);
                  setOpen(false);
                }}
                disabled={belowMin}
                aria-label={`${col}×${row}`}
              />
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
