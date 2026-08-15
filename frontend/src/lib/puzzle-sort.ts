import type { SavedPuzzle } from "../../../shared/contracts/puzzles";

/**
 * Ordering of the generated puzzle list (S-G4).
 *
 * Numeric order is the server's own: the listing arrives ordered by
 * `sortIndex`, so that option returns the list as given rather than
 * re-deriving an order from display names.
 *
 * "Most liked" ranks by likes minus dislikes, with the puzzle's number as the
 * tiebreak — every puzzle starts at zero, so without a deterministic tiebreak
 * an unvoted list would be at the mercy of sort stability.
 */
export type PuzzleSortMode = "number" | "most-liked";

export const DEFAULT_PUZZLE_SORT_MODE: PuzzleSortMode = "most-liked";

export const PUZZLE_SORT_OPTIONS: { value: PuzzleSortMode; label: string }[] = [
  { value: "number", label: "Puzzle number" },
  { value: "most-liked", label: "Most liked" },
];

/** Likes minus dislikes: what "most liked" actually means here. */
export const voteScore = (puzzle: Pick<SavedPuzzle, "likes" | "dislikes">) =>
  puzzle.likes - puzzle.dislikes;

/**
 * Returns a NEW array; the input is cached query data and must not be
 * mutated in place.
 */
export const sortPuzzles = <
  T extends Pick<SavedPuzzle, "likes" | "dislikes"> & { sortIndex: number },
>(
  puzzles: readonly T[],
  mode: PuzzleSortMode,
): T[] => {
  if (mode === "number") return [...puzzles];
  return [...puzzles].sort(
    (a, b) => voteScore(b) - voteScore(a) || a.sortIndex - b.sortIndex,
  );
};
