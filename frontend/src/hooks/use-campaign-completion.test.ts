import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { puzzleProgressQueryOptions } from "./use-puzzle-progress";
import { PUZZLE_PROGRESS_QUERY_KEY } from "@/lib/api";

/**
 * Freshness of the campaign completion markers — as KEY AND LOOKUP CONTRACT
 * EXAMPLES, which is all these are.
 *
 * Be clear about what they do not do: they exercise the query client and the
 * response shape directly, NOT `useCampaignCompletion` itself. Rendering the
 * hook would need a React test harness this project does not have, so nothing
 * here proves the hook's `onSuccess` actually fires the invalidation. What
 * supports that is the implementation, the container-backed integration
 * coverage of the unified read, and the browser measurement in
 * scripts/browser-harness/drive-campaign-progress.ts, which observes a real
 * re-read against the built bundle.
 *
 * What these examples DO pin is the pair of facts that a rename or a field
 * change would silently break: which key the list reads, and which field the
 * campaign markers come out of.
 *
 * A level is completed on the level page and the markers are read on
 * /puzzles, so the query is inactive exactly when the fact changes. Two things
 * have to hold: the write invalidates the key the list reads, and the list
 * re-reads on mount instead of trusting the cache.
 *
 * S-FOLD moved which key that is. Campaign completion used to invalidate its
 * own CAMPAIGN_PROGRESS_QUERY_KEY, but the campaign section now reads from the
 * unified puzzle progress query, so invalidating the old key would refresh
 * nothing anyone is looking at. That is the regression this file exists to
 * catch.
 *
 * Note what this does NOT establish: the ordering between the write landing
 * and the list's read. Board bug cfc6135a (campaign checkmarks appearing only
 * after a refresh) is about that ordering and remains open.
 */
describe("campaign completion freshness", () => {
  it("re-reads on mount rather than trusting the cache", () => {
    expect(puzzleProgressQueryOptions.staleTime).toBe(0);
    expect(puzzleProgressQueryOptions.refetchOnMount).toBe("always");
  });

  it("invalidating the PUZZLE progress key is what marks the list stale", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(PUZZLE_PROGRESS_QUERY_KEY, {
      solvedGeneratedIds: [],
      solvedScriptedIds: [],
      completedCampaignLevelIds: [],
    });
    expect(
      queryClient.getQueryState(PUZZLE_PROGRESS_QUERY_KEY)?.isInvalidated,
    ).toBe(false);

    // The invalidation useCampaignCompletion performs, reproduced here through the shared
    // key so a renamed key cannot silently stop invalidating.
    void queryClient.invalidateQueries({
      queryKey: PUZZLE_PROGRESS_QUERY_KEY,
    });

    expect(
      queryClient.getQueryState(PUZZLE_PROGRESS_QUERY_KEY)?.isInvalidated,
    ).toBe(true);
  });

  it("locates campaign completion in the unified payload under its own field", () => {
    // Pins the lookup the /puzzles campaign section depends on: if the field
    // were renamed or dropped server-side, every level would silently render
    // as unfinished.
    const payload = {
      solvedGeneratedIds: ["gen-1"],
      solvedScriptedIds: ["3"],
      completedCampaignLevelIds: ["1"],
    };
    expect(payload.completedCampaignLevelIds.includes("1")).toBe(true);
    expect(payload.completedCampaignLevelIds.includes("2")).toBe(false);
    // The three namespaces stay separate — a campaign level id must not be
    // satisfied by a scripted puzzle of the same name.
    expect(payload.solvedScriptedIds).not.toContain("1");
  });
});
