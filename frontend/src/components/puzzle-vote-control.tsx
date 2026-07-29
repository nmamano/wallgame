import { AlertCircle, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PuzzleVoteState } from "../../../shared/contracts/puzzles";

/**
 * What a surface needs to offer an EARNED vote: the counts, this player's
 * vote, the action, and the mutation's state. Exported so panels can accept
 * it as one typed prop instead of restating four fields.
 */
export interface PuzzleVoteProps extends PuzzleVoteState {
  onVote: (value: 1 | -1 | null) => void;
  /** Set while a vote is in flight; both controls go inert. */
  pending?: boolean;
  /** Set when the last attempt failed; clicking again retries. */
  failed?: boolean;
}

interface PuzzleVoteControlProps extends PuzzleVoteState {
  /**
   * Omitted where the counts are shown but voting is not offered — an
   * anonymous visitor, or a puzzle this player has not beaten. A vote is
   * earned, so read-only is the normal case, not an error state.
   */
  onVote?: (value: 1 | -1 | null) => void;
  pending?: boolean;
  failed?: boolean;
}

/**
 * Likes and dislikes on one puzzle (S-G4), presentation only: it renders the
 * counts, says which way this player voted, and reports clicks. Every
 * decision about whether voting is allowed, and every query and mutation,
 * belongs to the caller.
 *
 * Clicking the active choice withdraws the vote (`null`) — a misclick needs a
 * way back — and clicking the other flips it.
 */
export function PuzzleVoteControl({
  likes,
  dislikes,
  myVote,
  onVote,
  pending = false,
  failed = false,
}: PuzzleVoteControlProps) {
  const readOnly = !onVote;
  // One size everywhere: all three surfaces (the finished-game panel, the
  // mobile strip, the puzzle card) are tight rows beside other controls.
  const buttonSize = "h-7 px-2 text-xs";
  const iconSize = "h-3.5 w-3.5";

  const choice = (value: 1 | -1) => {
    const active = myVote === value;
    const label =
      value === 1
        ? active
          ? "Remove your like"
          : "Like this puzzle"
        : active
          ? "Remove your dislike"
          : "Dislike this puzzle";
    const Icon = value === 1 ? ThumbsUp : ThumbsDown;
    const countValue = value === 1 ? likes : dislikes;

    if (readOnly) {
      return (
        <span
          className="flex items-center gap-1 text-muted-foreground"
          aria-label={`${countValue} ${value === 1 ? "likes" : "dislikes"}`}
        >
          <Icon className={iconSize} aria-hidden="true" />
          <span className="tabular-nums">{countValue}</span>
        </span>
      );
    }

    return (
      <Button
        type="button"
        size="sm"
        variant={active ? "default" : "outline"}
        className={`gap-1 ${buttonSize}`}
        // The pressed state is what a screen reader reads back as "this is
        // your vote"; the fill alone would not say it.
        aria-pressed={active}
        aria-label={label}
        title={label}
        disabled={pending}
        onClick={() => onVote(active ? null : value)}
      >
        <Icon className={iconSize} aria-hidden="true" />
        <span className="tabular-nums">{countValue}</span>
      </Button>
    );
  };

  return (
    <div className="flex items-center gap-1.5">
      {choice(1)}
      {choice(-1)}
      {failed && (
        // Every surface here is a tight row — a fixed-height panel block, a
        // 390px strip, a grid card — where a sentence would collide with
        // what sits beside it. A bounded icon carries the message; the words
        // still reach a screen reader, and the retry is the same button that
        // failed, which stays live.
        <span
          role="status"
          className="flex shrink-0 items-center text-destructive"
          title="Not saved — tap again"
        >
          <AlertCircle className={iconSize} aria-hidden="true" />
          <span className="sr-only">Not saved — tap again</span>
        </span>
      )}
    </div>
  );
}
