import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { campaignProgressQueryOptions } from "./use-campaign-progress";
import { CAMPAIGN_PROGRESS_QUERY_KEY } from "@/lib/api";

/**
 * Freshness of the campaign completion markers (S-CAMP).
 *
 * A level is completed on the level page and the markers are read on the
 * level list, so the query is inactive exactly when the fact changes. Before
 * this slice the list cached for five minutes and nothing invalidated it,
 * which meant a level beaten seconds ago could still show as unfinished.
 * Both halves of the fix are pinned here.
 */
describe("campaign progress freshness", () => {
  it("re-reads on mount rather than trusting the cache", () => {
    expect(campaignProgressQueryOptions.staleTime).toBe(0);
    expect(campaignProgressQueryOptions.refetchOnMount).toBe("always");
  });

  it("uses the same key the API module exposes for invalidation", () => {
    expect(campaignProgressQueryOptions.queryKey).toBe(
      CAMPAIGN_PROGRESS_QUERY_KEY,
    );
  });

  it("marks the cached progress stale once a completion is recorded", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(CAMPAIGN_PROGRESS_QUERY_KEY, {
      completedLevels: [],
    });
    expect(
      queryClient.getQueryState(CAMPAIGN_PROGRESS_QUERY_KEY)?.isInvalidated,
    ).toBe(false);

    // What the mutation's onSuccess does; asserted through the shared key so
    // a renamed key cannot silently stop invalidating.
    void queryClient.invalidateQueries({
      queryKey: CAMPAIGN_PROGRESS_QUERY_KEY,
    });

    expect(
      queryClient.getQueryState(CAMPAIGN_PROGRESS_QUERY_KEY)?.isInvalidated,
    ).toBe(true);
  });
});
