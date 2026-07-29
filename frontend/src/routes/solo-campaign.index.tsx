import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2, Play, Info, Clock } from "lucide-react";
import {
  SOLO_CAMPAIGN_LEVELS,
  getLevelIds,
} from "../../../shared/domain/solo-campaign-levels";
import { useCampaignProgress } from "@/hooks/use-campaign-progress";

export const Route = createFileRoute("/solo-campaign/")({
  component: SoloCampaign,
});

function SoloCampaign() {
  const navigate = useNavigate();
  const { isLoggedIn, isLevelCompleted } = useCampaignProgress();

  const levelIds = getLevelIds();

  const handlePlayPuzzle = (levelId: string) => {
    void navigate({ to: `/solo-campaign/${levelId}` });
  };

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-4 text-balance">
          Solo Campaign
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Learn the fundamentals of Wall Game through a structured series of
          challenges. Start here if you&apos;re new to the game!
        </p>
      </div>

      {!isLoggedIn && (
        <Alert className="mb-6 bg-card/50 border-border/50">
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm text-muted-foreground">
            Log in to keep track of the levels you have completed.
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        {levelIds.map((levelId) => {
          const level = SOLO_CAMPAIGN_LEVELS[levelId];
          const isCompleted = isLevelCompleted(levelId);

          return (
            <Card
              key={levelId}
              className="p-6 hover:shadow-lg transition-shadow border-border/50 bg-card/50 backdrop-blur"
            >
              <div className="flex items-center justify-between">
                {/* A checkmark when completed and nothing at all otherwise:
                    an empty circle beside a "Completed" chip beside a
                    checkmark said the same thing three times (Nil, S-UI2).
                    The slot keeps its width either way, so level names stay
                    aligned down the list instead of stepping right wherever
                    a checkmark appears. */}
                <div className="flex items-center gap-4 flex-1">
                  <div className="w-6 shrink-0">
                    {isCompleted && (
                      <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-500" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="text-xl font-serif font-semibold text-foreground">
                      {levelId}. {level.name}
                    </h3>
                  </div>
                </div>

                <Button
                  size="sm"
                  onClick={() => handlePlayPuzzle(levelId)}
                  className="gap-1.5 shrink-0"
                >
                  <Play className="w-3.5 h-3.5" />
                  {isCompleted ? "Replay" : "Play"}
                </Button>
              </div>
            </Card>
          );
        })}

        {/* Coming soon placeholder */}
        <Card className="p-6 border-dashed border-2 border-border/50 bg-card/30">
          <div className="flex items-center gap-4">
            <div className="text-muted-foreground">
              <Clock className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-xl font-serif font-semibold text-muted-foreground">
                More coming soon...
              </h3>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Additional levels are in development
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
