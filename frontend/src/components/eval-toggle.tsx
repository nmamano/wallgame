import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EvalToggleState } from "@/hooks/use-eval-bar";

interface EvalToggleProps {
  state: EvalToggleState;
  isDisabled: boolean;
  disabledReason?: string;
  onToggle: () => void;
}

export function EvalToggle({
  state,
  isDisabled,
  disabledReason,
  onToggle,
}: EvalToggleProps) {
  const isChecked = state === "on" || state === "loading";
  const isLoading = state === "loading";

  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        isDisabled && "opacity-50 cursor-not-allowed",
      )}
      title={isDisabled ? disabledReason : undefined}
    >
      <Switch
        checked={isChecked}
        disabled={isDisabled || isLoading}
        onCheckedChange={() => {
          if (isChecked) {
            // Already on or loading, turn off
            onToggle();
          } else {
            // Off, turn on
            onToggle();
          }
        }}
        className={cn(isLoading && "opacity-70")}
      />
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {isLoading ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Connecting...</span>
          </>
        ) : (
          <span>Eval</span>
        )}
      </div>
    </div>
  );
}
