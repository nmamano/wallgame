/**
 * Labels for the action button on a puzzle card, and the label its width is
 * sized against.
 *
 * The two puzzle sections sit in the same grid, so their buttons must be the
 * same width (Nil, 2026-07-28). "Solve" is intrinsically narrower than
 * "Replay", so the button reserves the WIDEST steady-state label rather than
 * a guessed pixel value — see the hidden sizing span in `puzzles.index.tsx`.
 *
 * Factored out here so that relationship is testable: if a label is ever
 * reworded, the sizing label has to keep being the widest, or buttons start
 * varying in width again.
 */

/** Labels a card shows while simply sitting there, waiting to be clicked. */
export const PUZZLE_ACTION_LABELS = {
  solve: "Solve",
  play: "Play",
  replay: "Replay",
} as const;

export const puzzleActionLabel = (completed: boolean): string =>
  completed ? PUZZLE_ACTION_LABELS.replay : PUZZLE_ACTION_LABELS.solve;

/**
 * Campaign levels say "Play", not "Solve": a level is a guided game against a
 * local AI, not a position with an answer. They share the grid with the puzzle
 * cards since S-FOLD, so they must share the sizing label — which "Replay"
 * still is.
 */
export const campaignActionLabel = (completed: boolean): string =>
  completed ? PUZZLE_ACTION_LABELS.replay : PUZZLE_ACTION_LABELS.play;

/**
 * The label every button reserves room for. A transient "Starting…" may be
 * wider and is allowed to expand the button rather than be clipped.
 */
export const PUZZLE_ACTION_SIZING_LABEL = PUZZLE_ACTION_LABELS.replay;
