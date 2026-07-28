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
 * The two sets do not share a trust model. A GENERATED puzzle counts as
 * solved only when the server can see a decisive win in a game it launched as
 * that puzzle — the client cannot assert one, and deliberately does not mark
 * one optimistically, because that would undermine the whole point. A
 * SCRIPTED puzzle is a client-side walkthrough with no game to verify, so
 * finishing it is reported and taken at face value.
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
  const solvedGeneratedIds = useMemo(
    () => progressQuery.data?.solvedGeneratedIds ?? [],
    [progressQuery.data],
  );
  const solvedScriptedIds = useMemo(
    () => progressQuery.data?.solvedScriptedIds ?? [],
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
  const { mutate: sendScriptedCompletion } = scriptedCompletion;
  const retryScriptedCompletion = useMemo(
    () =>
      createScriptedRetry({
        failedPuzzleId: failedScriptedPuzzleId,
        resend: sendScriptedCompletion,
      }),
    [failedScriptedPuzzleId, sendScriptedCompletion],
  );

  const markScriptedCompleted = useCallback(
    (puzzleId: string) => {
      scriptedCompletion.mutate(puzzleId);
    },
    [scriptedCompletion],
  );

  const isScriptedCompleted = useCallback(
    (puzzleId: string) => solvedScriptedIds.includes(puzzleId),
    [solvedScriptedIds],
  );

  const isGeneratedCompleted = useCallback(
    (puzzleId: string) => solvedGeneratedIds.includes(puzzleId),
    [solvedGeneratedIds],
  );

  return {
    isLoggedIn,
    /** True while we cannot yet know whether anything is solved. */
    isLoading: userPending || (isLoggedIn && progressQuery.isPending),
    solvedGeneratedIds,
    solvedScriptedIds,
    isScriptedCompleted,
    isGeneratedCompleted,
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
 * Builds the retry action for a failed scripted-completion report, or null
 * when there is nothing to retry. Separated from the hook so the behaviour
 * that matters — retrying issues another request for the failed puzzle,
 * rather than merely clearing an error flag — is directly testable in a repo
 * with no React renderer.
 */
export const createScriptedRetry = (args: {
  failedPuzzleId: string | null;
  resend: (puzzleId: string) => void;
}): (() => void) | null => {
  const { failedPuzzleId, resend } = args;
  if (!failedPuzzleId) return null;
  return () => resend(failedPuzzleId);
};

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
