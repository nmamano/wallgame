import { Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronRight, List, RotateCcw } from "lucide-react";

interface SoloCampaignEndPopupProps {
  won: boolean;
  nextLevelId: string | null;
  onTryAgain: () => void;
  /**
   * Non-null only when saving this win failed and no retry is in flight;
   * calling it sends the completion again. Omitted where saving progress is
   * not this popup's concern.
   */
  onRetrySavingProgress?: (() => void) | null;
}

/**
 * The end-of-level panel, shaped like the puzzle solved panel
 * (`routes/puzzles.$id.tsx`): explicit buttons rather than links inside a
 * sentence.
 *
 * It used to offer the same three destinations as prose ("continue to the
 * next level, try again, or go back to the main menu"), and Nil reported
 * there was no way back to the level list — the route was there, but an
 * underlined phrase does not read as an action, and "main menu" does not
 * name the screen he wanted. So the list is its own button, present even
 * when a next level exists; the puzzle panel can fold that case into "Done"
 * only because it has nowhere else to go.
 *
 * Exactly one button is primary, and it comes last: the next level while
 * there is one, otherwise the way out.
 */
export function SoloCampaignEndPopup({
  won,
  nextLevelId,
  onTryAgain,
  onRetrySavingProgress,
}: SoloCampaignEndPopupProps) {
  // Wraps rather than overflows: the card is width-capped and a longer
  // translation of any label would otherwise push a button off it.
  const buttonRow = "mt-4 flex flex-wrap items-center justify-center gap-2";
  const levelListButton = (variant: "outline" | "default") => (
    <Button variant={variant} size="sm" asChild>
      <Link to="/solo-campaign">
        <List className="h-4 w-4 mr-1" />
        Level list
      </Link>
    </Button>
  );

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg z-10">
      <Card className="p-6 max-w-sm text-center bg-card border-border shadow-lg">
        {won ? (
          <>
            <h3 className="text-xl font-bold text-green-600 dark:text-green-500">
              You won!
            </h3>
            {!nextLevelId && (
              <p className="mt-2 text-sm text-muted-foreground">
                That was the last level for now.
              </p>
            )}
            <div className={buttonRow}>
              <Button variant="outline" size="sm" onClick={onTryAgain}>
                <RotateCcw className="h-4 w-4 mr-1" />
                Replay
              </Button>
              {levelListButton(nextLevelId ? "outline" : "default")}
              {/* Moving to a sibling level remounts the page: the route keys
                  its content on the level id, so the finished game state
                  behind this popup is discarded. */}
              {nextLevelId && (
                <Button size="sm" asChild>
                  <Link to="/solo-campaign/$id" params={{ id: nextLevelId }}>
                    Next level
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Link>
                </Button>
              )}
            </div>
            {onRetrySavingProgress && (
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-sm text-destructive">
                <span>We could not save this progress.</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetrySavingProgress}
                >
                  Try again
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <h3 className="text-xl font-bold text-red-600 dark:text-red-500">
              You lost
            </h3>
            <div className={buttonRow}>
              {levelListButton("outline")}
              <Button size="sm" onClick={onTryAgain}>
                <RotateCcw className="h-4 w-4 mr-1" />
                Try again
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
