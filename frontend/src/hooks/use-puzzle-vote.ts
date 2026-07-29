import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SAVED_PUZZLES_QUERY_KEY,
  fetchPuzzleVote,
  puzzleVoteQueryKey,
  submitPuzzleVote,
} from "@/lib/api";
import type { PuzzleVoteState } from "../../../shared/contracts/puzzles";

const NO_VOTES: PuzzleVoteState = { likes: 0, dislikes: 0, myVote: null };

/**
 * Voting from the puzzle LIST, where the counts already arrive with the
 * listing, so there is nothing extra to read — only a write, and the
 * invalidation that refreshes the counts and the "Most liked" order.
 *
 * One mutation serves every card; the per-card flags below compare against
 * the puzzle it was called with, so a failure marks the card that failed
 * rather than all of them.
 */
export function usePuzzleCardVotes() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (args: { puzzleId: string; value: 1 | -1 | null }) =>
      submitPuzzleVote(args),
    onSuccess: (state, args) => {
      queryClient.setQueryData(puzzleVoteQueryKey(args.puzzleId), state);
      void queryClient.invalidateQueries({ queryKey: SAVED_PUZZLES_QUERY_KEY });
    },
  });

  const { mutate, isPending, isError, variables } = mutation;

  const voteFor = useCallback(
    (puzzleId: string) => (value: 1 | -1 | null) => mutate({ puzzleId, value }),
    [mutate],
  );

  return {
    voteFor,
    isVotePending: useCallback(
      (puzzleId: string) => isPending && variables?.puzzleId === puzzleId,
      [isPending, variables],
    ),
    isVoteFailed: useCallback(
      (puzzleId: string) => isError && variables?.puzzleId === puzzleId,
      [isError, variables],
    ),
  };
}

/**
 * One puzzle's vote state, for a surface that shows a single puzzle (S-G4) —
 * the finished-game panel.
 *
 * It reads the dedicated per-puzzle endpoint rather than picking the puzzle
 * out of the listing, so a vote is still shown after a refresh or a direct
 * link, when no listing has been fetched. `enabled` is the caller's
 * eligibility decision (logged in, decisive win, own seat); this hook does
 * not second-guess it, and asks the server nothing when it is false.
 */
export function usePuzzleVote(args: {
  puzzleId: string | null;
  enabled: boolean;
}) {
  const { puzzleId, enabled } = args;
  const queryClient = useQueryClient();
  const active = enabled && puzzleId !== null;

  const voteQuery = useQuery({
    queryKey: puzzleVoteQueryKey(puzzleId ?? ""),
    queryFn: () => fetchPuzzleVote(puzzleId!),
    enabled: active,
    staleTime: 0,
  });

  const mutation = useMutation({
    mutationFn: (value: 1 | -1 | null) =>
      submitPuzzleVote({ puzzleId: puzzleId!, value }),
    onSuccess: (state) => {
      // The write returns the authoritative new state, so the single-puzzle
      // cache is set rather than refetched; the listing is invalidated
      // because its counts and sort order have just changed.
      if (puzzleId) {
        queryClient.setQueryData(puzzleVoteQueryKey(puzzleId), state);
      }
      void queryClient.invalidateQueries({ queryKey: SAVED_PUZZLES_QUERY_KEY });
    },
  });

  const { mutate } = mutation;
  const vote = useCallback(
    (value: 1 | -1 | null) => {
      mutate(value);
    },
    [mutate],
  );

  return {
    /** Safe to render before the read lands: zero counts and no vote. */
    state: voteQuery.data ?? NO_VOTES,
    canVote: active,
    vote,
    pending: mutation.isPending,
    /**
     * A failed write leaves the buttons live, so trying again is the same
     * click that failed — there is no separate retry to forget about, and
     * the pressed state still reflects the server rather than the attempt.
     */
    failed: mutation.isError,
  };
}
