import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PUZZLE_PROGRESS_QUERY_KEY, reportCampaignCompletion } from "@/lib/api";
import { createCompletionRetry } from "@/lib/completion-retry";

/**
 * Reporting a solo-campaign level as completed. WRITE ONLY.
 *
 * This was `useCampaignProgress` and it also read progress. Since S-FOLD the
 * campaign level list lives on /puzzles and its completion state comes from
 * the unified `usePuzzleProgress` read, so the read half moved out and the
 * hook was renamed to stop promising something it no longer does. The level
 * route (`/solo-campaign/$id`) is its only consumer.
 *
 * Campaign completion stays CLIENT-ASSERTED: a level is played entirely in the
 * browser against a local AI, so there is no server-side game to verify it
 * against. That is settled, not a gap.
 *
 * On acknowledged success it invalidates the PUZZLE progress key, because that
 * is now where campaign completion is read from. Only after the server has
 * confirmed the write — an optimistic flip would show progress that does not
 * exist if the request failed.
 */
export function useCampaignCompletion() {
  const queryClient = useQueryClient();

  const completion = useMutation({
    mutationFn: reportCampaignCompletion,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: PUZZLE_PROGRESS_QUERY_KEY,
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

  return {
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
