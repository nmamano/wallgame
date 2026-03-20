import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  EvalToggleState,
  EvalDisplayMode,
} from "@/hooks/use-eval-bar";

interface EvalToggleProps {
  state: EvalToggleState;
  displayMode: EvalDisplayMode;
  isDisabled: boolean;
  disabledReason?: string;
  onCycle: () => void;
}

export function EvalToggle({
  state,
  displayMode,
  isDisabled,
  disabledReason,
  onCycle,
}: EvalToggleProps) {
  const isLoading = state === "loading";
  const isActive = displayMode !== "off";

  const label =
    isLoading
      ? "Evaluating..."
      : displayMode === "eval-and-best-move"
        ? "Eval + Best"
        : "Eval";

  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors cursor-pointer",
        isDisabled && "opacity-50 cursor-not-allowed",
        isActive && !isLoading
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
      )}
      title={isDisabled ? disabledReason : undefined}
      disabled={isDisabled || isLoading}
      onClick={onCycle}
    >
      {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
      <span>{label}</span>
    </button>
  );
}
