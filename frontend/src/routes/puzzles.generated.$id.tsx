import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2 } from "lucide-react";
import {
  playPuzzle,
  puzzleBotsQueryOptions,
  savedPuzzlesQueryOptions,
  userQueryOptions,
} from "@/lib/api";
import { saveGameHandshake } from "@/lib/game-session";
import { useSettings } from "@/hooks/use-settings";

/**
 * A generated puzzle's own address, so one can be sent to someone.
 *
 * This is a launcher rather than a board: generated puzzles are played against
 * the bot on the game page, so opening this link starts that puzzle for
 * whoever opened it and hands them off to their own game. Two people opening
 * the same link get their own game each, which is the point — the alternative,
 * sharing the game link, only ever let a friend watch.
 *
 * The launch itself is the same server-authoritative call the listing page
 * makes; nothing about the position travels in the URL, only the puzzle's id.
 */
export const Route = createFileRoute("/puzzles/generated/$id")({
  loader: async ({ context: { queryClient } }) => {
    // Warm both before paint: which puzzle this is, and whether the bot that
    // plays it is around. Prefetch rather than ensure, so a failed request
    // lands on this component's own message instead of the router's error page.
    await Promise.all([
      queryClient.prefetchQuery(savedPuzzlesQueryOptions),
      queryClient.prefetchQuery(puzzleBotsQueryOptions),
    ]);
  },
  component: GeneratedPuzzleLauncher,
});

function GeneratedPuzzleLauncher() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const settings = useSettings(!!userData?.user, userPending);
  const puzzlesQuery = useQuery(savedPuzzlesQueryOptions);
  const botsQuery = useQuery(puzzleBotsQueryOptions);
  const [error, setError] = useState<string | null>(null);

  const puzzle = puzzlesQuery.data?.puzzles.find((p) => p.id === id);
  const officialBot = botsQuery.data?.bots.find((bot) => bot.isOfficial);

  // One launch per visit. Settings and query data can each land in more than
  // one render, and without this the second pass would start a second game and
  // strand the first — the listing page guards the same way with launchingId.
  const hasLaunched = useRef(false);

  useEffect(() => {
    if (hasLaunched.current) return;
    if (!puzzle || !officialBot) return;
    hasLaunched.current = true;

    void (async () => {
      try {
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
        void navigate({ to: `/game/${response.gameId}`, replace: true });
      } catch (cause) {
        // Let them try again rather than leaving the ref latched.
        hasLaunched.current = false;
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to start this puzzle.",
        );
      }
    })();
  }, [puzzle, officialBot, settings, navigate]);

  const backLink = (
    <Link
      to="/puzzles"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to Puzzles
    </Link>
  );

  const shell = (children: ReactNode) => (
    <div className="container mx-auto py-12 px-4 max-w-lg">
      <div className="mb-4">{backLink}</div>
      {children}
    </div>
  );

  // A list we could not read is NOT a retired puzzle, and saying so would
  // blame a good link for a bad connection. Offer the retry instead.
  if (puzzlesQuery.isError) {
    return shell(
      <Card className="border-destructive p-6 text-destructive">
        <p>We could not load this puzzle. Check your connection and retry.</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => void puzzlesQuery.refetch()}
        >
          Try again
        </Button>
      </Card>,
    );
  }

  // A link that no longer resolves. Puzzles are retired from the listing over
  // time, so an old link outliving its puzzle is expected rather than an error
  // — say so plainly and point back at the ones that do exist.
  if (!puzzlesQuery.isPending && !puzzle) {
    return shell(
      <Card className="p-6">
        <h1 className="font-serif text-xl font-semibold text-foreground">
          This puzzle is no longer available
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The link may be out of date. There are plenty of others to try.
        </p>
        <Button
          className="mt-4"
          onClick={() => void navigate({ to: "/puzzles" })}
        >
          Browse puzzles
        </Button>
      </Card>,
    );
  }

  if (error) {
    return shell(
      <Card className="border-destructive p-6 text-destructive">
        <p>{error}</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => {
            setError(null);
            void botsQuery.refetch();
          }}
        >
          Try again
        </Button>
      </Card>,
    );
  }

  if (!botsQuery.isPending && !officialBot) {
    return shell(
      <Card className="border-destructive p-6 text-destructive">
        <p>
          The opponent for this puzzle is offline right now. Try again in a
          little while.
        </p>
      </Card>,
    );
  }

  return shell(
    <Card className="flex items-center gap-3 p-6">
      <Loader2 className="h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
      <p className="text-muted-foreground">
        {puzzle ? `Starting ${puzzle.displayName}…` : "Loading puzzle…"}
      </p>
    </Card>,
  );
}
