import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CAMPAIGN_PROGRESS_QUERY_KEY,
  fetchCampaignProgress,
  reportCampaignCompletion,
  userQueryOptions,
} from "@/lib/api";
import { createCompletionRetry } from "@/lib/completion-retry";

/**
 * Freshness is part of the contract, so it lives here where a test can pin
 * it.
 *
 * A completed level is written from the level page and read on the level
 * list, which is a different route: the query is inactive while a level is
 * being played, so invalidating on the write marks it stale and returning to
 * the list is what actually fetches. Without this the list served a cached
 * answer (it used to cache for five minutes), and a level completed seconds
 * ago showed as unfinished.
 */
export const campaignProgressQueryOptions = {
  queryKey: CAMPAIGN_PROGRESS_QUERY_KEY,
  queryFn: fetchCampaignProgress,
  staleTime: 0,
  refetchOnMount: "always",
} as const;

/**
 * Solo-campaign completion, server-side (S-CAMP).
 *
 * Deliberately shaped like `usePuzzleProgress`, because the campaign has the
 * same trust model as the scripted puzzles: the game runs entirely in the
 * browser, so a finish is CLIENT-ASSERTED and taken at face value. Progress
 * follows the account, so anonymous visitors are shown no completion state at
 * all — their completions are still reported, as usage data, but a local
 * fallback would only produce markers that vanish on another device.
 */
export function useCampaignProgress() {
  const queryClient = useQueryClient();
  const { data: userData, isPending: userPending } = useQuery(userQueryOptions);
  const isLoggedIn = !!userData?.user;

  const progressQuery = useQuery({
    ...campaignProgressQueryOptions,
    // The endpoint answers 401 when logged out; only ask once we know.
    enabled: !userPending && isLoggedIn,
  });

  // Memoised because the `?? []` fallback would otherwise be a fresh array
  // each render, and it feeds the callback below.
  const completedLevelIds = useMemo(
    () => progressQuery.data?.completedLevels ?? [],
    [progressQuery.data],
  );

  const completion = useMutation({
    mutationFn: reportCampaignCompletion,
    onSuccess: () => {
      // Only after the write is acknowledged — an optimistic flip would show
      // progress that does not exist if the request failed.
      void queryClient.invalidateQueries({
        queryKey: CAMPAIGN_PROGRESS_QUERY_KEY,
      });
    },
  });

  // The mutation remembers what it was called with, so a failed report knows
  // which level to send again.
  const failedLevelId = completion.isError
    ? (completion.variables ?? null)
    : null;
  const { mutate: sendCompletion, isPending: completionPending } = completion;
  const retryCompletion = useMemo(
    () =>
      createCompletionRetry({
        failedId: failedLevelId,
        pending: completionPending,
        resend: sendCompletion,
      }),
    [failedLevelId, completionPending, sendCompletion],
  );

  const markCompleted = useCallback(
    (levelId: string) => {
      sendCompletion(levelId);
    },
    [sendCompletion],
  );

  const isLevelCompleted = useCallback(
    (levelId: string) => completedLevelIds.includes(levelId),
    [completedLevelIds],
  );

  return {
    isLoggedIn,
    /** True while we cannot yet know whether anything is completed. */
    isLoading: userPending || (isLoggedIn && progressQuery.isPending),
    completedLevelIds,
    isLevelCompleted,
    markCompleted,
    /**
     * Non-null only when a completion report failed and none is in flight:
     * calling it sends the SAME level again. The win effect fires once per
     * mounted level, so without this a lost report would stay lost until the
     * level was beaten afresh.
     */
    retryCompletion,
  };
}
