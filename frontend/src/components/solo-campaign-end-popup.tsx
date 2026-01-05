import { Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";

interface SoloCampaignEndPopupProps {
  won: boolean;
  nextLevelId: string | null;
  onTryAgain: () => void;
}

export function SoloCampaignEndPopup({
  won,
  nextLevelId,
  onTryAgain,
}: SoloCampaignEndPopupProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg z-10">
      <Card className="p-6 max-w-sm text-center bg-card border-border shadow-lg">
        {won ? (
          <>
            <h3 className="text-xl font-bold text-green-600 dark:text-green-500 mb-3">
              You won!
            </h3>
            <p className="text-muted-foreground mb-4">
              You can continue to the{" "}
              {nextLevelId ? (
                <Link
                  to="/solo-campaign/$id"
                  params={{ id: nextLevelId }}
                  className="text-primary hover:underline font-medium"
                >
                  next level
                </Link>
              ) : (
                <span className="text-muted-foreground">
                  (no more levels yet)
                </span>
              )}
              ,{" "}
              <button
                onClick={onTryAgain}
                className="text-primary hover:underline font-medium"
              >
                try again
              </button>
              , or go back to the{" "}
              <Link
                to="/solo-campaign"
                className="text-primary hover:underline font-medium"
              >
                main menu
              </Link>
              .
            </p>
          </>
        ) : (
          <>
            <h3 className="text-xl font-bold text-red-600 dark:text-red-500 mb-3">
              You lost
            </h3>
            <p className="text-muted-foreground mb-4">
              You can{" "}
              <button
                onClick={onTryAgain}
                className="text-primary hover:underline font-medium"
              >
                try again
              </button>
              , or go back to the{" "}
              <Link
                to="/solo-campaign"
                className="text-primary hover:underline font-medium"
              >
                main menu
              </Link>
              .
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
