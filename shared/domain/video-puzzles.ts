/**
 * The puzzles of the daily videos (task a03b8f5c). A video that ends on a
 * puzzle shows "solve it: wallgame.io/go/<n>"; /go/<n> opens the position of
 * entry <n> as a puzzle against the puzzle bot.
 *
 * Add one entry per puzzle video, and deploy it BEFORE the video posts: the
 * poster checks that wallgame.io/go/<n> reaches the puzzle. An <n> that is
 * not here goes to the tagged home page, as /go does, so a link in a posted
 * video never breaks.
 *
 * Never change or reuse an entry: posted videos keep their number.
 */

/** One puzzle video. */
export interface VideoPuzzle {
  /** The number in the video's link, wallgame.io/go/<n>. */
  n: number;
  /** The video app's item id; the link tags the visit with it. */
  itemId: string;
  gameId: string;
  /** The plies played before the puzzle position (the missed move's index). */
  ply: number;
}

export const VIDEO_PUZZLES: readonly VideoPuzzle[] = [];

/** The tags of a visit from a daily video's call to action. */
export const VIDEO_CTA_TAGS =
  "utm_source=video&utm_medium=cta&utm_campaign=video-cta";

/** Where wallgame.io/go sends a viewer of a daily video: home, tagged. */
export const VIDEO_CTA_TARGET = `/?${VIDEO_CTA_TAGS}`;

/** The page of one game position as a puzzle. */
export const gamePositionPuzzlePath = (gameId: string, ply: number): string =>
  `/puzzle/game/${encodeURIComponent(gameId)}/${ply}`;

/**
 * Where wallgame.io/go/<n> sends a viewer: the puzzle of entry <n>, tagged
 * with its item, or the tagged home page when there is no such entry.
 */
export const videoPuzzleTarget = (
  n: number,
  puzzles: readonly VideoPuzzle[] = VIDEO_PUZZLES,
): string => {
  const puzzle = puzzles.find((entry) => entry.n === n);
  if (!puzzle) return VIDEO_CTA_TARGET;
  const content = encodeURIComponent(puzzle.itemId);
  return `${gamePositionPuzzlePath(puzzle.gameId, puzzle.ply)}?${VIDEO_CTA_TAGS}&utm_content=${content}`;
};
