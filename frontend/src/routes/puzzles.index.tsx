import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Play, Loader2, Clock } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";
import { PUZZLES, getPuzzleIds } from "../../../shared/domain/puzzles";
import {
  SOLO_CAMPAIGN_LEVELS,
  getLevelIds,
} from "../../../shared/domain/solo-campaign-levels";
import { usePuzzleProgress } from "@/hooks/use-puzzle-progress";
import { useSettings } from "@/hooks/use-settings";
import {
  playPuzzle,
  puzzleBotsQueryOptions,
  savedPuzzlesQueryOptions,
  userQueryOptions,
} from "@/lib/api";
import { puzzleProgressQueryOptions } from "@/hooks/use-puzzle-progress";
import { saveGameHandshake } from "@/lib/game-session";
import { usePuzzleCardVotes } from "@/hooks/use-puzzle-vote";
import { PuzzleVoteControl } from "@/components/puzzle-vote-control";
import {
  PUZZLE_ACTION_SIZING_LABEL,
  puzzleActionLabel,
  campaignActionLabel,
} from "@/lib/puzzle-action-label";
import {
  PUZZLE_SORT_OPTIONS,
  sortPuzzles,
  type PuzzleSortMode,
} from "@/lib/puzzle-sort";
import type {
  PuzzleVoteState,
  SavedPuzzle,
} from "../../../shared/contracts/puzzles";

export const Route = createFileRoute("/puzzles/")({
  /**
   * Warm everything the page renders from BEFORE it paints, so cards and
   * markers arrive together instead of in waves a second apart.
   *
   * `prefetchQuery`, never `ensureQueryData`: prefetch resolves even when a
   * request fails, leaving the failure to the component, which already
   * renders an inline "could not load" card. `ensureQueryData` rejects, and
   * a rejecting loader replaces the whole route with the router's error
   * boundary — a worse page for a recoverable failure.
   *
   * The user query is AWAITED first because two things depend on the
   * answer: progress is only worth fetching for a logged-in visitor (the
   * endpoint answers 401 otherwise), and the log-in invitation is only
   * correct once we know. Puzzles and bots do not depend on it, so they run
   * alongside.
   */
  loader: async ({ context: { queryClient } }) => {
    const user = queryClient
      .ensureQueryData(userQueryOptions)
      // An unreachable /api/me must not block the page; the component
      // treats "unknown" as logged out, which is the safe default.
      .catch(() => null);
    await Promise.all([
      queryClient.prefetchQuery(savedPuzzlesQueryOptions),
      queryClient.prefetchQuery(puzzleBotsQueryOptions),
      user.then((data) =>
        data?.user
          ? queryClient.prefetchQuery(puzzleProgressQueryOptions)
          : undefined,
      ),
    ]);
  },
  component: Puzzles,
});

/**
 * Surface treatment for a puzzle card. All THREE sections render the same
 * `PuzzleCard` in the same grid, so this no longer holds a density
 * distinction — padding and internal layout live in that component, and only
 * the shell's look (border, background, hover) is kept separate here.
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

interface PuzzleCardProps {
  title: string;
  completed: boolean;
  onAction: () => void;
  /**
   * The verb this card's button shows at rest. REQUIRED, and supplied by the
   * caller rather than derived here: a campaign level says Play where a puzzle
   * says Solve, and a default would let a future call site quietly inherit the
   * wrong verb. The card stays ignorant of which section it is in.
   */
  actionLabel: string;
  /** Omitted where a card has nothing to say beyond its name. */
  subtitle?: string;
  badge?: string;
  /** Set only while this card's action is in flight. */
  pending?: boolean;
  disabled?: boolean;
  /**
   * Vote state for a generated puzzle. Scripted cards omit it entirely —
   * votes cover the generated set only.
   */
  votes?: PuzzleVoteState;
  /**
   * Given only when this player earned a vote here (logged in and solved);
   * without it the counts still render, read-only.
   */
  onVote?: (value: 1 | -1 | null) => void;
  votePending?: boolean;
  voteFailed?: boolean;
}

/**
 * One card, all THREE sections. Campaign levels, scripted puzzles and
 * generated puzzles differ in what they know about themselves (an author and a
 * difficulty, or votes, or just a name) and in what their button says, but they
 * are the same object to a player, so they render through one component rather
 * than parallel trees that have to be kept looking alike — which is how they
 * drifted apart before.
 *
 * Everything section-specific arrives as a prop; there is deliberately no
 * "kind" branch inside. Kept local to this route: every call site is here, and
 * its props encode this page's presentation rather than a general card
 * contract.
 */
function PuzzleCard({
  title,
  completed,
  onAction,
  actionLabel,
  subtitle,
  badge,
  pending = false,
  disabled = false,
  votes,
  onVote,
  votePending = false,
  voteFailed = false,
}: PuzzleCardProps) {
  return (
    // Text and action sit side by side: a stacked card left the button as a
    // small pill against a wide empty strip, wasting the space a three-column
    // grid is meant to save.
    // `flex-row` is explicit because Card's own classes include flex-col, and
    // the class merge only drops a base utility when a conflicting one is
    // passed — omitting the direction leaves the column in place.
    <Card
      className={`flex h-full flex-row items-center justify-between gap-3 p-4 ${puzzleCardShell}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          {completed && (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-500" />
          )}
          <h3 className="font-serif font-semibold leading-tight text-foreground">
            {title}
          </h3>
        </div>
        {subtitle && (
          <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
        )}
        {badge && (
          <Badge variant="outline" className="mt-2 text-xs">
            {badge}
          </Badge>
        )}
        {votes && (
          // Counts show on every generated card, including for visitors who
          // cannot vote — otherwise a "Most liked" sort would rank by
          // something nobody can see.
          <div className="mt-2">
            <PuzzleVoteControl
              {...votes}
              onVote={onVote}
              pending={votePending}
              failed={voteFailed}
            />
          </div>
        )}
      </div>

      <div className="shrink-0">
        <Button
          className="gap-2"
          // A card whose action is in flight is never clickable, whatever the
          // caller says about `disabled` — the two reasons are independent.
          disabled={disabled || pending}
          onClick={onAction}
        >
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Starting…
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              {/* Every label occupies the same cell, with the widest one
                  invisible, so every resting button is Replay-wide instead of
                  a hardcoded size that would rot if the copy changed. */}
              <span className="grid">
                <span
                  aria-hidden="true"
                  className="col-start-1 row-start-1 invisible"
                >
                  {PUZZLE_ACTION_SIZING_LABEL}
                </span>
                <span className="col-start-1 row-start-1">{actionLabel}</span>
              </span>
            </>
          )}
        </Button>
      </div>
    </Card>
  );
}

function Puzzles() {
  const navigate = useNavigate();
  const { isScriptedCompleted, isLoggedIn, isLoading } = usePuzzleProgress();

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
      completed: isScriptedCompleted(puzzle.id),
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

      {/* ONE invitation for the whole page, not one per section: all three
          sections show completion markers, and three copies of the same
          sentence would be noise. It also has to speak for all of them, so it
          says "your progress" rather than naming puzzles.

          Waiting on `isLoading` as well as the answer: logged-out is the
          resting state of this hook, so testing it alone flashed the
          invitation at logged-in visitors for as long as /api/me took. */}
      {!isLoading && !isLoggedIn && (
        <Alert className="mb-8 bg-card/50 border-border/50">
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm text-muted-foreground">
            Log in to keep track of your progress.
          </AlertDescription>
        </Alert>
      )}

      <CampaignSection />

      <section className="mb-12">
        <h2 className="text-2xl font-serif font-semibold text-foreground mb-4">
          Handcrafted Puzzles
        </h2>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {puzzles.map((puzzle) => (
            <PuzzleCard
              key={puzzle.id}
              title={puzzle.title}
              subtitle={`by ${puzzle.author}`}
              badge={`Difficulty: ${puzzle.difficulty}/5`}
              completed={puzzle.completed}
              actionLabel={puzzleActionLabel(puzzle.completed)}
              onAction={() => handlePlayPuzzle(puzzle.id)}
            />
          ))}
        </div>
      </section>

      <GeneratedPuzzlesSection />
    </div>
  );
}

/**
 * The solo campaign, first section since S-FOLD (Nil: "fold solo campaign
 * levels under the Puzzles tab, as the first of now 3 subsections").
 *
 * Levels still PLAY at /solo-campaign/$id; only the list moved here, and
 * /solo-campaign now redirects to this page. Completion is read from the same
 * unified progress query as the other two sections, so all three arrive in the
 * paint the route loader warms.
 */
function CampaignSection() {
  const navigate = useNavigate();
  const { isCampaignLevelCompleted } = usePuzzleProgress();
  const levelIds = getLevelIds();

  return (
    <section className="mb-12">
      <h2 className="text-2xl font-serif font-semibold text-foreground mb-4">
        Campaign
      </h2>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {levelIds.map((levelId) => {
          const level = SOLO_CAMPAIGN_LEVELS[levelId];
          const completed = isCampaignLevelCompleted(levelId);
          return (
            <PuzzleCard
              key={levelId}
              title={`${levelId}. ${level.name}`}
              completed={completed}
              actionLabel={campaignActionLabel(completed)}
              onAction={() =>
                void navigate({ to: `/solo-campaign/${levelId}` })
              }
            />
          );
        })}

        {/* Last cell of the SAME grid, so two levels plus this placeholder
            fill one desktop row and stack at 390px. Kept out of PuzzleCard:
            it is not a card you can do anything with. Nil asked for it to
            stay (2026-07-29), knowing the section is sparse. */}
        <Card className="flex h-full flex-row items-center gap-3 border-2 border-dashed border-border/50 bg-card/30 p-4">
          <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h3 className="font-serif font-semibold leading-tight text-muted-foreground">
              More coming soon…
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground/70">
              Additional levels are in development
            </p>
          </div>
        </Card>
      </div>
    </section>
  );
}

/**
 * The persisted generated set (S-G1/S-G2): race positions against PuzzleBot,
 * filtered by TWO engine rules — the best-move distance rule, and since
 * S-EVAL the requirement that the mover be decisively winning, because solving
 * a puzzle means winning it. Beyond those, no vetting: Nil is the filter.
 *
 * Loading, error, and bot-offline states are scoped to this section; the two
 * sections above render regardless.
 */
function GeneratedPuzzlesSection() {
  const navigate = useNavigate();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;
  const settings = useSettings(isLoggedIn, userPending);
  const { isGeneratedCompleted } = usePuzzleProgress();
  const [sortMode, setSortMode] = useState<PuzzleSortMode>("number");
  const { voteFor, isVotePending, isVoteFailed } = usePuzzleCardVotes();
  // Same options object the route loader warms, so this reads the primed
  // cache entry rather than issuing the request a second time.
  const puzzlesQuery = useQuery(savedPuzzlesQueryOptions);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const botsQuery = useQuery(puzzleBotsQueryOptions);
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
  // A copy, always: this is cached query data.
  const ordered = sortPuzzles(generated, sortMode);

  return (
    <section>
      {/* Heading and sort control share a row: with the old subtitle gone
          (Nil, 2026-07-29) a control-only row under the heading would be a
          band of empty space, and the margin here matches the handcrafted
          section's heading so the two sections still line up. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl font-serif font-semibold text-foreground">
          Generated Puzzles
        </h2>
        <div className="flex items-center gap-1">
          {PUZZLE_SORT_OPTIONS.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={sortMode === option.value ? "default" : "outline"}
              aria-pressed={sortMode === option.value}
              onClick={() => setSortMode(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

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
        {ordered.map((puzzle) => {
          const solved = isGeneratedCompleted(puzzle.id);
          return (
            <PuzzleCard
              key={puzzle.id}
              title={puzzle.displayName}
              completed={solved}
              actionLabel={puzzleActionLabel(solved)}
              pending={launchingId === puzzle.id}
              disabled={!officialBot || launchingId !== null}
              onAction={() => void launch(puzzle)}
              votes={{
                likes: puzzle.likes,
                dislikes: puzzle.dislikes,
                myVote: puzzle.myVote,
              }}
              // Earned: only a logged-in player who has beaten this puzzle
              // gets controls. Everyone else sees the counts.
              onVote={isLoggedIn && solved ? voteFor(puzzle.id) : undefined}
              votePending={isVotePending(puzzle.id)}
              voteFailed={isVoteFailed(puzzle.id)}
            />
          );
        })}
      </div>
    </section>
  );
}
