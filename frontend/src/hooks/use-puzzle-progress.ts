import { useCallback, useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  PUZZLE_PROGRESS_QUERY_KEY,
  fetchPuzzleProgress,
  reportScriptedPuzzleCompletion,
  userQueryOptions,
} from "@/lib/api";
import { createCompletionRetry } from "@/lib/completion-retry";

/**
 * Freshness is part of the contract, so it lives here where a test can pin
 * it.
 *
 * The server persists a finished game BEFORE broadcasting that it finished
 * (`server/games/finish-sequence.ts`), so by the time the client knows it
 * won, the row that completion is derived from already exists. That is what
 * makes a plain invalidation on the win sufficient — there is no write still
 * in flight to wait for.
 *
 * Re-reading on mount then covers the navigation itself: the progress query
 * is inactive while a game is being played, so the invalidation marks it
 * stale and returning to the puzzle list is what actually fetches.
 */
export const puzzleProgressQueryOptions = {
  queryKey: PUZZLE_PROGRESS_QUERY_KEY,
  queryFn: fetchPuzzleProgress,
  staleTime: 0,
  refetchOnMount: "always",
} as const;

/**
 * Puzzle completion, server-side (S-G3). Progress follows the account rather
 * than the browser, which is why this replaced a localStorage hook outright:
 * anonymous visitors are shown no completion state at all, so a local
 * fallback would only produce markers that vanish on another device.
 *
 * The three sets do not share a trust model. A GENERATED puzzle counts as
 * solved only when the server can see a decisive win in a game it launched as
 * that puzzle — the client cannot assert one, and deliberately does not mark
 * one optimistically, because that would undermine the whole point. A
 * SCRIPTED puzzle and a CAMPAIGN LEVEL are played entirely in the browser with
 * no game to verify, so finishing one is reported and taken at face value.
 *
 * Campaign levels read from here since S-FOLD, when the campaign moved onto
 * the /puzzles page. This is the page's ONLY progress query: three sections,
 * one loader-prefetched read, one invalidation. Campaign WRITES live in
 * `useCampaignCompletion`, which the level route owns.
 */
export function usePuzzleProgress() {
  const queryClient = useQueryClient();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;

  const progressQuery = useQuery({
    ...puzzleProgressQueryOptions,
    // The endpoint answers 401 when logged out; only ask once we know.
    enabled: !userPending && isLoggedIn,
  });

  // Memoised because the `?? []` fallback would otherwise be a fresh array
  // each render, and these feed the callbacks below.
  const verifiedSolvedSavedPuzzleIds = useMemo(
    () => progressQuery.data?.verifiedSolvedSavedPuzzleIds ?? [],
    [progressQuery.data],
  );
  const assertedCompletedSavedPuzzleIds = useMemo(
    () => progressQuery.data?.assertedCompletedSavedPuzzleIds ?? [],
    [progressQuery.data],
  );

  /**
   * What a CARD needs: finished by either kind of evidence. The two sources
   * stay separate on the wire because they mean different things (see the
   * contract), and this is the single place the union is taken — so nothing
   * downstream has to remember that a client assertion is not a win.
   */
  const completedSavedPuzzleIds = useMemo(
    () =>
      new Set([
        ...verifiedSolvedSavedPuzzleIds,
        ...assertedCompletedSavedPuzzleIds,
      ]),
    [verifiedSolvedSavedPuzzleIds, assertedCompletedSavedPuzzleIds],
  );
  const completedCampaignLevelIds = useMemo(
    () => progressQuery.data?.completedCampaignLevelIds ?? [],
    [progressQuery.data],
  );

  const scriptedCompletion = useMutation({
    mutationFn: reportScriptedPuzzleCompletion,
    onSuccess: () => {
      // Only after the write is acknowledged — an optimistic flip would show
      // progress that does not exist if the request failed.
      void queryClient.invalidateQueries({
        queryKey: PUZZLE_PROGRESS_QUERY_KEY,
      });
    },
  });

  // The mutation remembers what it was called with, so a failed report knows
  // which puzzle to send again.
  const failedScriptedPuzzleId = scriptedCompletion.isError
    ? (scriptedCompletion.variables ?? null)
    : null;
  const { mutate: sendScriptedCompletion, isPending: scriptedPending } =
    scriptedCompletion;
  const retryScriptedCompletion = useMemo(
    () =>
      createCompletionRetry({
        failedId: failedScriptedPuzzleId,
        pending: scriptedPending,
        resend: sendScriptedCompletion,
      }),
    [failedScriptedPuzzleId, scriptedPending, sendScriptedCompletion],
  );

  const markScriptedCompleted = useCallback(
    (puzzleId: string) => {
      scriptedCompletion.mutate(puzzleId);
    },
    [scriptedCompletion],
  );

  /** For a card's tick: finished at all, however it was finished. */
  const isPuzzleCompleted = useCallback(
    (puzzleId: string) => completedSavedPuzzleIds.has(puzzleId),
    [completedSavedPuzzleIds],
  );

  /**
   * Strictly "the server watched me win this". Voting is authorised on the
   * SERVER from the same rule; this only decides whether to offer the control,
   * so a stale client can never do more than show a control the API refuses.
   */
  const isVerifiedSolve = useCallback(
    (puzzleId: string) => verifiedSolvedSavedPuzzleIds.includes(puzzleId),
    [verifiedSolvedSavedPuzzleIds],
  );

  const isCampaignLevelCompleted = useCallback(
    (levelId: string) => completedCampaignLevelIds.includes(levelId),
    [completedCampaignLevelIds],
  );

  return {
    isLoggedIn,
    /** True while we cannot yet know whether anything is solved. */
    isLoading: userPending || (isLoggedIn && progressQuery.isPending),
    verifiedSolvedSavedPuzzleIds,
    assertedCompletedSavedPuzzleIds,
    completedCampaignLevelIds,
    isPuzzleCompleted,
    isVerifiedSolve,
    isCampaignLevelCompleted,
    markScriptedCompleted,
    /**
     * Non-null only when a completion report failed: calling it sends the
     * SAME puzzle again. The solve effect fires once per puzzle, so without
     * this a lost report would stay lost until the puzzle was solved afresh.
     */
    retryScriptedCompletion,
    scriptedCompletionPending: scriptedCompletion.isPending,
  };
}

/**
 * Ask for a fresh progress read after a decisive puzzle win.
 *
 * The game page calls this instead of marking anything itself: a solve is
 * whatever the server can verify from the stored game, so the client's only
 * job is to stop trusting what it cached. Safe to call the moment the win
 * arrives, because the game is already persisted by then — see the ordering
 * note on the query options above.
 */
export function invalidatePuzzleProgress(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: PUZZLE_PROGRESS_QUERY_KEY });
}
