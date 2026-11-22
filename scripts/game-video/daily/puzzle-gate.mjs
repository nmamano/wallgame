/**
 * The post gate of a puzzle video (edl.mjs puzzle; task a03b8f5c): its call
 * to action names wallgame.io/go/<n>, so the video may post only once that
 * link opens its own position. The site answers /go/<n> with a 302 to
 * /puzzle/game/<gameId>/<ply>, tagged with the item's id, from the entry
 * <n> of shared/domain/video-puzzles.ts; an <n> that is not deployed yet
 * goes to the tagged home page. The poster reads the live link with one
 * HEAD request and refuses the item until it is right (Wall Game PM,
 * 2026-11-22): the entry must be deployed before the video posts.
 */
import { gamePositionPuzzlePath } from "../../../shared/domain/video-puzzles.ts";

/** The site whose /go/<n> links the videos show. */
export const PUZZLE_SITE = "https://wallgame.io";
/** How long the gate waits for the site's answer. */
const GATE_TIMEOUT_MS = 10_000;

/**
 * Why the video of `item` may not post yet, or null: null when it has no
 * puzzle, or when wallgame.io/go/<n> answers 302 to its game's position
 * with its own id as utm_content. Never throws: a site it cannot read is a
 * reason too.
 * @param {{ id: string, edl?: { doc?: { gameId: string,
 *   puzzle?: { ply: number, n: number } } } }} item
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<string | null>}
 */
export const puzzleLinkProblem = async (item, { fetchImpl = fetch } = {}) => {
  const doc = item.edl?.doc;
  const puzzle = doc?.puzzle;
  if (!puzzle) return null;
  const link = `${PUZZLE_SITE}/go/${puzzle.n}`;
  const want = gamePositionPuzzlePath(doc.gameId, puzzle.ply);
  const fix = `deploy the entry { n: ${puzzle.n}, itemId: "${item.id}", gameId: "${doc.gameId}", ply: ${puzzle.ply} } of shared/domain/video-puzzles.ts first`;
  let res;
  try {
    res = await fetchImpl(link, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    });
  } catch (err) {
    return `the puzzle link ${link} cannot be read: ${String(err?.message ?? err)}`;
  }
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) {
    return `the puzzle link ${link} answers ${res.status}${location ? "" : " with no Location"}, not a 302 to ${want}: ${fix}`;
  }
  let to;
  try {
    to = new URL(location, PUZZLE_SITE);
  } catch {
    return `the puzzle link ${link} sends to ${location}, which is not a link`;
  }
  if (to.origin !== PUZZLE_SITE || to.pathname !== want) {
    return `the puzzle link ${link} sends to ${to.origin === PUZZLE_SITE ? to.pathname : to.href}, not to ${want}: ${fix}`;
  }
  const tagged = to.searchParams.get("utm_content");
  if (tagged !== item.id) {
    return `the puzzle link ${link} opens this position for the item ${tagged ?? "(none)"}, not ${item.id}: its entry in shared/domain/video-puzzles.ts names another item`;
  }
  return null;
};
