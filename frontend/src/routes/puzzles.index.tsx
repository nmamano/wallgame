import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle, Play, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";
import { PUZZLES, getPuzzleIds } from "../../../shared/domain/puzzles";
import { usePuzzleProgress } from "@/hooks/use-puzzle-progress";
import { useSettings } from "@/hooks/use-settings";
import {
  fetchBots,
  fetchSavedPuzzles,
  playPuzzle,
  userQueryOptions,
} from "@/lib/api";
import { saveGameHandshake } from "@/lib/game-session";
import type { SavedPuzzle } from "../../../shared/contracts/puzzles";

export const Route = createFileRoute("/puzzles/")({
  component: Puzzles,
});

/**
 * Card shell shared by both puzzle sections so their visual treatment cannot
 * drift; padding and internal layout stay density-specific (roomy scripted
 * rows vs the compact generated grid).
 */
const puzzleCardShell =
  "hover:shadow-lg transition-shadow border-border/50 bg-card/50 backdrop-blur";

/**
 * Convert difficulty rating (1350-1850) to a 1-5 scale for display.
 */
function ratingToDifficulty(rating: number): number {
  // Map ~1300-1900 range to 1-5
  // 1300-1400 = 1, 1400-1500 = 2, 1500-1600 = 3, 1600-1750 = 4, 1750+ = 5
  if (rating < 1400) return 1;
  if (rating < 1500) return 2;
  if (rating < 1600) return 3;
  if (rating < 1750) return 4;
  return 5;
}

function Puzzles() {
  const navigate = useNavigate();
  const { isCompleted } = usePuzzleProgress();

  const handlePlayPuzzle = (puzzleId: string) => {
    void navigate({ to: `/puzzles/${puzzleId}` });
  };

  const puzzleIds = getPuzzleIds();
  const puzzles = puzzleIds.map((id) => {
    const puzzle = PUZZLES[id];
    return {
      id: puzzle.id,
      title: puzzle.title,
      author: puzzle.author,
      difficulty: ratingToDifficulty(puzzle.difficulty),
      completed: isCompleted(puzzle.id),
    };
  });

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-4 text-balance">
          Puzzles
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Sharpen your tactical skills.
        </p>
      </div>

      <section className="mb-12">
        <h2 className="text-2xl font-serif font-semibold text-foreground mb-4">
          Scripted Puzzles
        </h2>

        <Alert className="mb-6 bg-card/50 border-border/50">
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm text-muted-foreground">
            Your scripted-puzzle progress is saved locally in this browser.
          </AlertDescription>
        </Alert>

        <div className="space-y-4">
          {puzzles.map((puzzle) => (
            <Card key={puzzle.id} className={`p-6 ${puzzleCardShell}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 flex-1">
                  <div className="text-foreground">
                    {puzzle.completed ? (
                      <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-500" />
                    ) : (
                      <Circle className="w-6 h-6" />
                    )}
                  </div>

                  <div className="flex-1">
                    <h3 className="text-xl font-serif font-semibold text-foreground mb-1">
                      {puzzle.title}
                    </h3>
                    <p className="text-sm text-muted-foreground mb-2">
                      by {puzzle.author}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="text-xs">
                        Difficulty: {puzzle.difficulty}/5
                      </Badge>
                      {puzzle.completed && (
                        <Badge className="text-xs bg-green-600 dark:bg-green-700">
                          Completed
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                <Button
                  onClick={() => handlePlayPuzzle(puzzle.id)}
                  className="gap-2"
                >
                  <Play className="w-4 h-4" />
                  {puzzle.completed ? "Replay" : "Solve"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <GeneratedPuzzlesSection />
    </div>
  );
}

/**
 * The persisted generated set (S-G1/S-G2): race positions against PuzzleBot,
 * filtered only by the best-move distance rule — no winnability
 * certification, no other vetting. Loading, error, and bot-offline states
 * are scoped to this section; the scripted list above renders regardless.
 */
function GeneratedPuzzlesSection() {
  const navigate = useNavigate();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const settings = useSettings(!!userData?.user, userPending);
  const puzzlesQuery = useQuery({
    queryKey: ["saved-puzzles"],
    queryFn: fetchSavedPuzzles,
  });
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const botsQuery = useQuery({
    queryKey: ["bots", "custom-setup-standard", 6, 6],
    queryFn: () =>
      fetchBots({
        variant: "custom-setup-standard",
        boardWidth: 6,
        boardHeight: 6,
      }),
  });
  // Bots register the exact variant they serve, so the only official bot
  // listed for custom-setup-standard is PuzzleBot - the deep-search oracle.
  // If it is down, the section says so rather than substituting a shallower
  // opponent.
  const officialBots =
    botsQuery.data?.bots.filter((bot) => bot.isOfficial) ?? [];
  const officialBot = officialBots[0];

  const launch = async (puzzle: SavedPuzzle) => {
    if (!officialBot || launchingId !== null) return;
    setLaunchingId(puzzle.id);
    setError(null);

    try {
      // S-P1: server-authoritative launch — the server derives config, seat,
      // and the bot's lead-in move from the puzzle row.
      const response = await playPuzzle({
        botId: officialBot.id,
        puzzleId: puzzle.id,
        hostDisplayName: settings.displayName,
        hostAppearance: {
          pawnColor: settings.pawnColor,
          catSkin: settings.catPawn,
          mouseSkin: settings.mousePawn,
          homeSkin: settings.homePawn,
        },
      });
      saveGameHandshake({
        gameId: response.gameId,
        token: response.token,
        socketToken: response.socketToken,
        role: response.role,
        playerId: response.playerId,
        shareUrl: response.shareUrl,
        puzzleId: puzzle.id,
        puzzleName: puzzle.displayName,
      });
      void navigate({ to: `/game/${response.gameId}` });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to launch puzzle.",
      );
      setLaunchingId(null);
    }
  };

  const generated = puzzlesQuery.data?.puzzles ?? [];

  return (
    <section>
      <h2 className="text-2xl font-serif font-semibold text-foreground mb-2">
        Generated Puzzles
      </h2>
      <p className="text-sm text-muted-foreground mb-6">
        Fresh 6×6 positions to play against PuzzleBot.
      </p>

      {puzzlesQuery.isPending && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading puzzles…
        </p>
      )}
      {puzzlesQuery.isError && (
        <Card className="border-destructive p-4 text-destructive">
          Could not load the generated puzzles. Try again later.
        </Card>
      )}

      {botsQuery.isPending && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Looking for the official bot…
        </p>
      )}
      {!botsQuery.isPending && !officialBot && (
        <Card className="border-destructive p-4 text-destructive mb-4">
          The official bot is offline. Puzzles can be inspected, but games
          cannot start until it reconnects.
        </Card>
      )}
      {error && (
        <Card className="border-destructive p-4 text-destructive mb-4">
          {error}
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {generated.map((puzzle) => (
          <Card className={`space-y-3 p-4 ${puzzleCardShell}`} key={puzzle.id}>
            <div>
              <h3 className="font-serif font-semibold text-foreground">
                {puzzle.displayName}
              </h3>
            </div>
            <Button
              className="w-full gap-2"
              disabled={!officialBot || launchingId !== null}
              onClick={() => void launch(puzzle)}
            >
              {launchingId === puzzle.id ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Solve
                </>
              )}
            </Button>
          </Card>
        ))}
      </div>
    </section>
  );
}
