/**
 * Builds the retry action for a failed client-asserted completion report, or
 * null when there is nothing to retry.
 *
 * Shared by the scripted puzzles (S-G3) and the solo campaign (S-CAMP)
 * because the hazard is identical: the solve effect fires ONCE per mounted
 * puzzle or level, so a report that fails has no second chance. What matters
 * is that retrying issues another request for the SAME id — clearing an error
 * flag would look like a fix and lose the completion.
 *
 * Separated from the hooks so that behaviour is directly testable in a repo
 * with no React renderer.
 *
 * `pending` suppresses the action while a report is in flight, so repeated
 * clicks cannot stack concurrent requests. A mutation also stops reporting an
 * error the moment it retries, which hides the action too — this makes the
 * guarantee explicit rather than a side effect of that.
 */
export const createCompletionRetry = (args: {
  failedId: string | null;
  pending: boolean;
  resend: (id: string) => void;
}): (() => void) | null => {
  const { failedId, pending, resend } = args;
  if (!failedId || pending) return null;
  return () => resend(failedId);
};
