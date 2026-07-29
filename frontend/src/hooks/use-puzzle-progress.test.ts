import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
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
