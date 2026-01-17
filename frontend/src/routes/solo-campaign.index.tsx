import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2, Circle, Play, Info, Clock } from "lucide-react";
import {
  SOLO_CAMPAIGN_LEVELS,
  getLevelIds,
} from "../../../shared/domain/solo-campaign-levels";
import { userQueryOptions, campaignProgressQueryOptions } from "@/lib/api";

export const Route = createFileRoute("/solo-campaign/")({
  component: SoloCampaign,
});

function SoloCampaign() {
  const navigate = useNavigate();

  // Check if user is logged in
  const { data: userData } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;

  // Fetch campaign progress (only if logged in)
  const { data: progressData } = useQuery({
    ...campaignProgressQueryOptions,
    enabled: isLoggedIn,
  });

  const completedLevels = new Set(progressData?.completedLevels ?? []);
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
            Create an account to save your progress.
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        {levelIds.map((levelId) => {
          const level = SOLO_CAMPAIGN_LEVELS[levelId];
          const isCompleted = completedLevels.has(levelId);

          return (
            <Card
              key={levelId}
              className="p-6 hover:shadow-lg transition-shadow border-border/50 bg-card/50 backdrop-blur"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 flex-1">
                  <div className="text-foreground">
                    {isCompleted ? (
                      <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-500" />
                    ) : (
                      <Circle className="w-6 h-6" />
                    )}
                  </div>

                  <div className="flex-1">
                    <h3 className="text-xl font-serif font-semibold text-foreground mb-2">
                      {levelId}. {level.name}
                    </h3>
                    <div className="flex gap-2">
                      <Badge variant="secondary" className="text-xs">
                        {level.boardWidth}x{level.boardHeight}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        {level.turnsToSurvive} turns
                      </Badge>
                      {isCompleted && (
                        <Badge className="text-xs bg-green-600 dark:bg-green-700">
                          Completed
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                <Button
                  onClick={() => handlePlayPuzzle(levelId)}
                  className="gap-2"
                >
                  <Play className="w-4 h-4" />
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
