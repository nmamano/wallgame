import { Switch } from "@/components/ui/switch";
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
  onEvalToggle: () => void;
  onBestMoveToggle: () => void;
}

export function EvalToggle({
  state,
  displayMode,
  isDisabled,
  disabledReason,
  onEvalToggle,
  onBestMoveToggle,
}: EvalToggleProps) {
  const isEvalOn = displayMode !== "off";
  const isLoading = state === "loading";
  const showBestMoveToggle = isEvalOn && !isLoading;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        isDisabled && "opacity-50 cursor-not-allowed",
      )}
      title={isDisabled ? disabledReason : undefined}
    >
      <Switch
        checked={isEvalOn}
        disabled={isDisabled || isLoading}
        onCheckedChange={onEvalToggle}
        className={cn(isLoading && "opacity-70")}
      />
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {isLoading ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Evaluating...</span>
          </>
        ) : (
          <span>Eval</span>
        )}
      </div>
      {showBestMoveToggle && (
        <>
          <Switch
            checked={displayMode === "eval-and-best-move"}
            onCheckedChange={onBestMoveToggle}
            className="ml-1"
          />
          <span className="text-xs text-muted-foreground">Best</span>
        </>
      )}
    </div>
  );
}
