import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createScriptedRetry,
  invalidatePuzzleProgress,
  puzzleProgressQueryOptions,
} from "./use-puzzle-progress";
import { PUZZLE_PROGRESS_QUERY_KEY } from "@/lib/api";

/**
 * Freshness of the solved markers (S-G3).
 *
 * A generated puzzle's completion is derived server-side from the persisted
 * game, and the server persists that game AFTER broadcasting the finished
 * state. So the client may not mark a solve itself, and may not assume an
 * immediate refetch would see it. What it does instead is drop the cached
 * answer on a win and re-read when the page that shows it mounts. Both halves
 * are load-bearing; these pin them.
 */

describe("puzzle progress freshness", () => {
  it("re-reads on mount rather than trusting the cache", () => {
    expect(puzzleProgressQueryOptions.staleTime).toBe(0);
    expect(puzzleProgressQueryOptions.refetchOnMount).toBe("always");
  });

  it("invalidates the cached progress a win may have changed", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(PUZZLE_PROGRESS_QUERY_KEY, {
      solvedGeneratedIds: [],
      solvedScriptedIds: [],
    });
    expect(
      queryClient.getQueryState(PUZZLE_PROGRESS_QUERY_KEY)?.isInvalidated,
    ).toBe(false);

    invalidatePuzzleProgress(queryClient);

    expect(
      queryClient.getQueryState(PUZZLE_PROGRESS_QUERY_KEY)?.isInvalidated,
    ).toBe(true);
  });

  it("uses the same key the API module exposes for invalidation", () => {
    expect(puzzleProgressQueryOptions.queryKey).toBe(PUZZLE_PROGRESS_QUERY_KEY);
  });
});

/**
 * A scripted solve is reported once, by an effect that fires a single time
 * per puzzle. So if that report fails, the only thing standing between the
 * player and a lost solve is a retry that actually SENDS AGAIN — clearing an
 * error flag would look like a fix and lose the completion.
 */
describe("retrying a failed scripted completion", () => {
  it("sends the failed puzzle again", () => {
    const sent: string[] = [];
    const retry = createScriptedRetry({
      failedPuzzleId: "7",
      resend: (puzzleId) => sent.push(puzzleId),
    });

    expect(retry).not.toBeNull();
    retry?.();
    expect(sent).toEqual(["7"]);

    // And it stays usable if the network is still unhappy.
    retry?.();
    expect(sent).toEqual(["7", "7"]);
  });

  it("offers nothing to retry when no report failed", () => {
    expect(
      createScriptedRetry({
        failedPuzzleId: null,
        resend: () => {
          throw new Error("must not send");
        },
      }),
    ).toBeNull();
  });
});
