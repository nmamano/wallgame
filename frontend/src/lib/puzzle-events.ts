/**
 * The puzzle analytics events (task 7db1b18a, Wall Game Growth 2026-11-26),
 * sent with `browserSendEvent`:
 * - `puzzle_start`: the server accepted a puzzle launch (Solve it on a puzzle
 *   page, a puzzle on the listing, Retry). One launch is one puzzle game, so
 *   one event per puzzle game. Sent by `launchPuzzle` (lib/api.ts), the one
 *   function every launch goes through.
 * - `puzzle_solved`: this browser's seated player won a puzzle game that this
 *   page saw in play. Once per game.
 *
 * Both describe the puzzle the same way (`puzzleParams`): its kind, and the
 * daily video that brought the visitor when the tab landed through
 * wallgame.io/go/<n>. No user or game id, as the other events.
 *
 * Pure functions over injected storage, as `game-events.ts`: the project has
 * no React test harness, so the rules are checked by running them.
 */

import type { GameState } from "../../../shared/domain/game-state";
import type { PlayerId, PuzzleRef } from "../../../shared/domain/game-types";
import { VIDEO_CTA_TAGS } from "../../../shared/domain/video-puzzles";
import type { IdStorage } from "./anonymous-id";

/** GA4 event names are snake_case and capped at 40 characters. */
export const PUZZLE_START_EVENT = "puzzle_start";
export const PUZZLE_SOLVED_EVENT = "puzzle_solved";

const VIDEO_ITEM_KEY = "wall-game-video-item";
const SOLVED_KEY_PREFIX = "wall-game-puzzle-solved:";
const SENT_VALUE = "1";

/**
 * "video": a position from a stored game (/puzzle/game/<id>/<ply>, where the
 * daily videos' /go/<n> links lead). "saved": a numbered puzzle (/puzzles/<n>).
 */
export type PuzzleEventKind = "video" | "saved";

/** Flat scalars only (GA4 stores no nested values); no user or game id. */
export type PuzzleParams = Record<string, string> & {
  puzzle_kind: PuzzleEventKind;
};

export function puzzleEventKind(ref: PuzzleRef): PuzzleEventKind {
  return ref.kind === "game" ? "video" : "saved";
}

/** The tags /go/<n> puts on its target (shared/domain/video-puzzles.ts). */
const GO_TAGS = [...new URLSearchParams(VIDEO_CTA_TAGS)];

/**
 * The video item of a /go/<n> visit: the `utm_content` of a query that
 * carries every tag /go adds. Null for any other query, so an ad or a
 * hand-made link that happens to have a `utm_content` is not counted as a
 * video visit.
 */
export function videoItemOf(search: string): string | null {
  const query = new URLSearchParams(search);
  if (GO_TAGS.some(([name, value]) => query.get(name) !== value)) return null;
  const item = query.get("utm_content");
  // An empty utm_content names no video.
  return item === null || item === "" ? null : item;
}

/**
 * At page load: keep the video item of a /go/<n> landing for this tab. The
 * landing URL is gone after Solve it (the game page replaces it), and a
 * Retry or a reload comes later still, so the item is read back from here.
 * A load with no item keeps the one stored, and a new /go/<n> landing in the
 * same tab replaces it.
 */
export function rememberVideoItem(
  search: string,
  session: IdStorage | undefined,
): void {
  const item = videoItemOf(search);
  if (item === null) return;
  try {
    session?.setItem(VIDEO_ITEM_KEY, item);
  } catch {
    // Storage refused (a privacy mode): the events go out without the item.
  }
}

/** The puzzle, as both events describe it. */
export function puzzleParams(
  ref: PuzzleRef,
  session: IdStorage | undefined,
): PuzzleParams {
  let item: string | null = null;
  try {
    item = session?.getItem(VIDEO_ITEM_KEY) ?? null;
  } catch {
    // Storage refused: send the event without the item.
  }
  const puzzle_kind = puzzleEventKind(ref);
  return item ? { puzzle_kind, video_item: item } : { puzzle_kind };
}

/** The live puzzle game, as this browser sees it. */
export interface PuzzleSolvedView {
  gameId: string;
  /** Null when this game is not a puzzle (or before its state loads). */
  puzzle: PuzzleRef | null;
  /** The live state (not a history snapshot), or null before it loads. */
  state: Pick<GameState, "status" | "result"> | null;
  /** This browser's seat (`primaryLocalPlayerId`), or null. */
  playerId: PlayerId | null;
  /** Spectating or watching a replay. */
  isReadOnly: boolean;
}

/**
 * Where this view stands for the event: "none" (not a puzzle game of this
 * browser's own: no puzzle, no state, no seat, a spectator, a replay),
 * "playing", "won" (finished, and this player is the winner) or "over"
 * (finished any other way: a loss, a draw).
 */
export function puzzleSolvedPhase(
  view: PuzzleSolvedView,
): "none" | "playing" | "won" | "over" {
  if (!view.puzzle || !view.state || view.playerId === null) return "none";
  if (view.isReadOnly) return "none";
  if (view.state.status !== "finished") return "playing";
  return view.state.result?.winner === view.playerId ? "won" : "over";
}

/**
 * The event's params when it is due now, or null; marks the game as sent in
 * `session` when it is.
 *
 * Due only when this page saw the game in play (`sawPlaying`) and now sees it
 * won, so opening a game that is already won - a reload, a second tab -
 * sends nothing. The session mark is the second guard: the same game is
 * never counted twice in this tab.
 */
export function takePuzzleSolvedEvent({
  view,
  sawPlaying,
  session,
}: {
  view: PuzzleSolvedView;
  sawPlaying: boolean;
  session: IdStorage | undefined;
}): PuzzleParams | null {
  if (!sawPlaying || !view.puzzle || puzzleSolvedPhase(view) !== "won") {
    return null;
  }
  const key = SOLVED_KEY_PREFIX + view.gameId;
  try {
    if (session?.getItem(key) === SENT_VALUE) return null;
    session?.setItem(key, SENT_VALUE);
  } catch {
    // Storage refused: the page's own once-only guard (`sawPlaying`, which
    // the caller clears) still holds.
  }
  return puzzleParams(view.puzzle, session);
}
