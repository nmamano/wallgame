import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Play, Loader2, Clock } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";
import {
  SOLO_CAMPAIGN_LEVELS,
  getLevelIds,
} from "../../../shared/domain/solo-campaign-levels";
import { usePuzzleProgress } from "@/hooks/use-puzzle-progress";
import { useSettings } from "@/hooks/use-settings";
import {
  playPuzzle,
  savedPuzzlesQueryOptions,
  userQueryOptions,
} from "@/lib/api";
import { usePuzzlePlayback } from "@/hooks/use-puzzle-playback";
import { puzzleProgressQueryOptions } from "@/hooks/use-puzzle-progress";
import { saveGameHandshake } from "@/lib/game-session";
import { usePuzzleCardVotes } from "@/hooks/use-puzzle-vote";
import { PuzzleVoteControl } from "@/components/puzzle-vote-control";
import { SharePuzzleButton } from "@/components/share-puzzle-button";
import { savedPuzzleSlug } from "@/lib/puzzle-links";
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
import {
  SYNTHETIC_AUTHOR,
  type PuzzleVoteState,
  type SavedPuzzle,
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
   * correct once we know. The puzzle list does not depend on it, so it runs
   * alongside.
   *
   * Bots are NOT warmed here any more. Which bot questions to ask depends on
   * the SHAPES of the puzzles in the list (variant and board size), so they
   * cannot be known before the list arrives; `usePuzzlePlayback` asks them
   * once the list is in hand.
   */
  loader: async ({ context: { queryClient } }) => {
    const user = queryClient
      .ensureQueryData(userQueryOptions)
      // An unreachable /api/me must not block the page; the component
      // treats "unknown" as logged out, which is the safe default.
      .catch(() => null);
    await Promise.all([
      queryClient.prefetchQuery(savedPuzzlesQueryOptions),
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
   * Vote state for a generated puzzle. Campaign levels and handcrafted
   * puzzles omit it entirely — votes cover the generated set only.
   */
  votes?: PuzzleVoteState;
  /**
   * Given only when this player earned a vote here (logged in and solved);
   * without it the counts still render, read-only.
   */
  onVote?: (value: 1 | -1 | null) => void;
  votePending?: boolean;
  voteFailed?: boolean;
  /**
   * The share control for this card, already built by the section that owns it.
   * Required: every section has a shareable address, and passing the rendered
   * node rather than a kind keeps the promise below — no kind branch in here.
   */
  share: ReactNode;
}

/**
 * One card, all THREE sections. Campaign levels, handcrafted puzzles and
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
  share,
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

      <div className="flex shrink-0 items-center gap-1">
        {share}
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
  const { isLoggedIn, isLoading } = usePuzzleProgress();

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

      <PuzzlesSection />
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
              share={
                <SharePuzzleButton
                  kind="campaign"
                  id={levelId}
                  puzzleName={`${levelId}. ${level.name}`}
                />
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
 * The two puzzle sections: handcrafted first, then generated.
 *
 * They are ONE component rather than two because the split is presentational
 * and nothing else about them differs. Everything a launch needs — which card
 * is starting, which one was refused, what each position can be played as —
 * is page-wide state, and forking it into two components would mean two copies
 * of it drifting apart. `author` is the discriminator, and it decides exactly
 * three things per card: the byline, the difficulty badge, and whether votes
 * are offered.
 *
 * What a card DOES when clicked is not decided here and is not tied to the
 * section it sits in: `usePuzzlePlayback` asks, per position, whether an
 * official bot serves it. Seven of the ten handcrafted puzzles play PuzzleBot;
 * the three that are only three rows tall are below any bot's minimum board
 * size, so they walk their authored line instead. Same section, different
 * answers, because origin and playability are genuinely different questions.
 *
 * Loading and error states are scoped to these two sections; the campaign
 * above renders regardless.
 */
function PuzzlesSection() {
  const navigate = useNavigate();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;
  const settings = useSettings(isLoggedIn, userPending);
  const { isPuzzleCompleted, isVerifiedSolve } = usePuzzleProgress();
  const [sortMode, setSortMode] = useState<PuzzleSortMode>("number");
  const { voteFor, isVotePending, isVoteFailed } = usePuzzleCardVotes();
  // Same options object the route loader warms, so this reads the primed
  // cache entry rather than issuing the request a second time.
  const puzzlesQuery = useQuery(savedPuzzlesQueryOptions);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const puzzles = puzzlesQuery.data?.puzzles ?? [];
  const { playbackFor, refetchFor } = usePuzzlePlayback(puzzles);
  /**
   * The puzzle whose launch was refused, if any. Kept so the banner can offer
   * its authored line — no game was created, so falling back is honest here.
   */
  const [failedPuzzle, setFailedPuzzle] = useState<SavedPuzzle | null>(null);

  /**
   * Walking an authored line needs no opponent and no server round trip, so
   * it is a plain navigation. Playing a bot mints a game first.
   */
  const play = async (puzzle: SavedPuzzle) => {
    if (launchingId !== null) return;
    const playback = playbackFor(puzzle);
    // "pending" means discovery has not answered for this puzzle's shape yet.
    // Doing anything here would guess, and guessing "authored line" for a
    // puzzle a bot is about to be found for is the wrong guess.
    if (playback.kind === "pending" || playback.kind === "unavailable") return;
    if (playback.kind === "scripted") {
      void navigate({ to: `/puzzles/${savedPuzzleSlug(puzzle)}` });
      return;
    }

    setLaunchingId(puzzle.id);
    setError(null);

    try {
      // S-P1: server-authoritative launch — the server derives config, seat,
      // and the bot's lead-in move from the puzzle row.
      const response = await playPuzzle({
        botId: playback.bot.id,
        puzzleId: puzzle.id,
        hostDisplayName: settings.displayName,
        hostAppearance: {
          pawnColor: settings.pawnColor,
          dogSkin: settings.dogPawn,
          catSkin: settings.catPawn,
          mouseSkin: settings.mousePawn,
          elephantSkin: settings.elephantPawn,
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
      setFailedPuzzle(puzzle);
      // The bot we chose is by now known to be stale — gone, or no longer
      // serving this position. Re-asking marks this puzzle's shape pending for
      // the round trip, so the card cannot be clicked back into the same bot
      // while the answer is in flight.
      void refetchFor(puzzle);
      setLaunchingId(null);
    }
  };

  /**
   * Which section a puzzle belongs to. `author` is the only thing that
   * decides it — a person wrote it, or the generation pipeline did.
   */
  const handcrafted = puzzles.filter(
    (puzzle) => puzzle.author !== SYNTHETIC_AUTHOR,
  );
  const generated = puzzles.filter(
    (puzzle) => puzzle.author === SYNTHETIC_AUTHOR,
  );

  /**
   * One card, either section. The three things that differ between them are
   * all read off `author` here rather than passed in by the caller, so the two
   * call sites below cannot disagree about which puzzle gets a byline, a
   * difficulty, or votes.
   */
  const renderCard = (puzzle: SavedPuzzle) => {
    const authored = puzzle.author !== SYNTHETIC_AUTHOR;
    const completed = isPuzzleCompleted(puzzle.id);
    const playback = playbackFor(puzzle);
    return (
      <PuzzleCard
        key={puzzle.id}
        title={puzzle.displayName}
        // "by synthetic" on every generated card is noise; a byline is worth
        // showing only when a person is behind it.
        subtitle={authored ? `by ${puzzle.author}` : undefined}
        // Generated puzzles show NO difficulty (Nil, 2026-08-04). The
        // pipeline does not produce one, so today the column is null for all
        // of them — the author test is here so a stray value could never
        // surface a number nobody stands behind.
        badge={
          authored && puzzle.difficulty !== null
            ? `Difficulty: ${puzzle.difficulty}/5`
            : undefined
        }
        completed={completed}
        actionLabel={puzzleActionLabel(completed)}
        // Also pending while we do not yet know who can play this puzzle: a
        // card that looks ready before discovery answers invites a click we
        // would have to guess at.
        pending={launchingId === puzzle.id || playback.kind === "pending"}
        disabled={
          playback.kind === "unavailable" ||
          playback.kind === "pending" ||
          launchingId !== null
        }
        onAction={() => void play(puzzle)}
        // Votes cover the generated set only (Nil, 2026-08-04). Handcrafted
        // puzzles are a curated set with a person's name on them; asking
        // players to rate them is a different thing from rating the output of
        // a pipeline, so the controls and the counts are both absent.
        votes={
          authored
            ? undefined
            : {
                likes: puzzle.likes,
                dislikes: puzzle.dislikes,
                myVote: puzzle.myVote,
              }
        }
        // Earned: a vote needs a win the SERVER watched, so a card finished by
        // walking its authored line shows the counts without the controls —
        // the API would refuse the write anyway.
        onVote={
          !authored && isLoggedIn && isVerifiedSolve(puzzle.id)
            ? voteFor(puzzle.id)
            : undefined
        }
        votePending={isVotePending(puzzle.id)}
        voteFailed={isVoteFailed(puzzle.id)}
        share={
          <SharePuzzleButton
            kind="saved"
            // The number, not the row id: a link reading /puzzles/7 is the
            // point. See puzzle-links.ts for what that costs when a puzzle is
            // retired.
            id={savedPuzzleSlug(puzzle)}
            puzzleName={puzzle.displayName}
          />
        }
      />
    );
  };

  return (
    <>
      {/* Both of the states below speak for BOTH sections — one list backs
          them — so they sit above the pair rather than inside either one. */}
      {puzzlesQuery.isPending && (
        <p className="mb-8 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading puzzles…
        </p>
      )}
      {puzzlesQuery.isError && (
        <Card className="mb-8 border-destructive p-4 text-destructive">
          Could not load the puzzles. Try again later.
        </Card>
      )}

      {/* Availability is PER PUZZLE, so a page-wide "the bot is offline"
          banner would be wrong: with PuzzleBot down the authored puzzles are
          still fully playable. Each card says what IT can do, and the only
          page-wide message left is a launch that was actually refused. */}
      {error && (
        <Card className="mb-8 border-destructive p-4 text-destructive">
          <p>{error}</p>
          {failedPuzzle?.legacyScriptedId != null && (
            <Button
              className="mt-3"
              onClick={() => {
                const target = failedPuzzle;
                setError(null);
                setFailedPuzzle(null);
                // `play=authored` so the destination walks the line instead of
                // hunting for the same bot again. No game exists yet, which is
                // what makes this fallback honest.
                void navigate({
                  to: "/puzzles/$id",
                  params: { id: savedPuzzleSlug(target) },
                  search: { play: "authored" },
                });
              }}
            >
              Play the authored line
            </Button>
          )}
        </Card>
      )}

      <section className="mb-12">
        <h2 className="mb-4 text-2xl font-serif font-semibold text-foreground">
          Handcrafted Puzzles
        </h2>

        {/* No sort control: ten puzzles arranged by their author in rising
            difficulty are already in the order that matters, and there is
            nothing to sort them BY — they carry no votes. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {handcrafted.map(renderCard)}
        </div>
      </section>

      <section>
        {/* Heading and sort control share a row: with the old subtitle gone
            (Nil, 2026-07-29) a control-only row under the heading would be a
            band of empty space, and the margin matches the headings above so
            all three sections line up. */}
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

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* A copy, always: this is cached query data. */}
          {sortPuzzles(generated, sortMode).map(renderCard)}
        </div>
      </section>
    </>
  );
}
