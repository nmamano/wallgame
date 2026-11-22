import { Button } from "@/components/ui/button";

/**
 * The end of a daily video's puzzle (task a03b8f5c): solved, or the bot held
 * on, and one clear next step. A solver goes on to a full game; a solver who
 * lost tries the same position again first.
 */
export interface VideoPuzzleNextStep {
  outcome: "solved" | "failed";
  handlePlayFullGame: () => void;
}

interface VideoPuzzleNextStepButtonsProps extends VideoPuzzleNextStep {
  handleRetryPuzzle: () => void;
  isRetryingPuzzle: boolean;
  /** The button size of the surrounding bar. */
  className: string;
}

/** "Play a full game" and "Try again", the outcome's next step first. */
export function VideoPuzzleNextStepButtons({
  outcome,
  handlePlayFullGame,
  handleRetryPuzzle,
  isRetryingPuzzle,
  className,
}: VideoPuzzleNextStepButtonsProps) {
  const playFullGame = (
    <Button
      key="full-game"
      size="sm"
      variant={outcome === "solved" ? "default" : "outline"}
      className={className}
      onClick={handlePlayFullGame}
    >
      Play a full game
    </Button>
  );
  const tryAgain = (
    <Button
      key="try-again"
      size="sm"
      variant={outcome === "failed" ? "default" : "outline"}
      className={className}
      onClick={handleRetryPuzzle}
      disabled={isRetryingPuzzle}
    >
      {isRetryingPuzzle ? "Starting…" : "Try again"}
    </Button>
  );
  return (
    <>
      {outcome === "solved"
        ? [playFullGame, tryAgain]
        : [tryAgain, playFullGame]}
    </>
  );
}
