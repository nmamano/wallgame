import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSettings } from "@/hooks/use-settings";
import {
  fetchBots,
  fetchSavedPuzzles,
  playVsBot,
  userQueryOptions,
} from "@/lib/api";
import { saveGameHandshake } from "@/lib/game-session";
import type { SavedPuzzle } from "../../../shared/contracts/puzzles";

export const Route = createFileRoute("/generated-candidates")({
  component: GeneratedCandidatesPage,
});

function GeneratedCandidatesPage() {
  const navigate = Route.useNavigate();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const settings = useSettings(!!userData?.user, userPending);
  // Saved puzzles are persisted entities served by the API; the response is
  // contract-parsed in fetchSavedPuzzles, so a corrupted payload fails this
  // query rather than reaching a launch.
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
  // Bots register the exact variant they serve, so the only official bot listed for
  // custom-setup-standard is PuzzleBot - the deep-search oracle. If it is down, the
  // page says so rather than quietly substituting a shallower opponent.
  const officialBots =
    botsQuery.data?.bots.filter((bot) => bot.isOfficial) ?? [];
  const officialBot = officialBots[0];

  const launch = async (puzzle: SavedPuzzle) => {
    if (!officialBot || launchingId !== null) return;
    setLaunchingId(puzzle.id);
    setError(null);

    try {
      const humanIsPlayer1 = puzzle.config.variantConfig.turn.playerId === 1;
      const response = await playVsBot({
        botId: officialBot.id,
        config: puzzle.config,
        hostDisplayName: settings.displayName,
        hostAppearance: {
          pawnColor: settings.pawnColor,
          catSkin: settings.catPawn,
          mouseSkin: settings.mousePawn,
          homeSkin: settings.homePawn,
        },
        hostIsPlayer1: humanIsPlayer1,
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

  const puzzles = puzzlesQuery.data?.puzzles ?? [];

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-3xl font-bold">Generated puzzles</h1>
        <p className="mt-2 text-muted-foreground">
          Generated 6×6 positions with 18 neutral walls and short races.
          Positions whose best first move is simply walking at the target are
          filtered out; nothing else is vetted.
        </p>
      </div>

      {puzzlesQuery.isPending && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading puzzles…
        </p>
      )}
      {puzzlesQuery.isError && (
        <Card className="border-destructive p-4 text-destructive">
          Could not load the puzzles. Try again later.
        </Card>
      )}

      {botsQuery.isPending && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Looking for the official bot…
        </p>
      )}
      {!botsQuery.isPending && !officialBot && (
        <Card className="border-destructive p-4 text-destructive">
          The official bot is offline. Puzzles can be inspected, but games
          cannot start until it reconnects.
        </Card>
      )}
      {error && (
        <Card className="border-destructive p-4 text-destructive">{error}</Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {puzzles.map((puzzle) => (
          <Card className="space-y-3 p-4" key={puzzle.id}>
            <div>
              <h2 className="font-semibold">{puzzle.displayName}</h2>
            </div>
            <Button
              className="w-full"
              disabled={!officialBot || launchingId !== null}
              onClick={() => void launch(puzzle)}
            >
              {launchingId === puzzle.id ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                "Try"
              )}
            </Button>
          </Card>
        ))}
      </div>
    </main>
  );
}
