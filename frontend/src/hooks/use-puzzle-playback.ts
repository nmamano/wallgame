import { useCallback, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";

import { puzzleBotsQueryOptionsFor } from "@/lib/api";
import { botSupportsPosition } from "../../../shared/domain/bot-capability";
import type { SavedPuzzle } from "../../../shared/contracts/puzzles";
import type { ListedBot } from "../../../shared/contracts/custom-bot-protocol";

/**
 * How a given puzzle can actually be played right now.
 *
 * Puzzles used to be split by ORIGIN — generated ones were played against
 * PuzzleBot, handcrafted ones followed an authored line — and the page was
 * built around that split. It is the wrong axis: origin is a fact about who
 * made a puzzle, and what a player can do with it depends only on whether an
 * opponent exists for that exact position.
 *
 * So the decision is made per puzzle:
 *
 *   pending     — we do not know yet. NOT a synonym for "no bot": answering
 *                 "scripted" here would send a player down the authored line
 *                 for a puzzle a bot was about to be found for, and then yank
 *                 them into a bot game the moment discovery resolved.
 *   bot         — an official bot declares this position AND the row can be
 *                 handed to one. The real thing: a wrong move gets answered
 *                 instead of refused.
 *   scripted    — no bot for it, but it has an authored line to walk.
 *   unavailable — neither. A generated puzzle with PuzzleBot offline.
 */
export type PuzzlePlayback =
  | { kind: "pending" }
  | { kind: "bot"; bot: ListedBot }
  | { kind: "scripted"; scriptedId: string }
  | { kind: "unavailable" };

const shapeKey = (puzzle: SavedPuzzle) =>
  `${puzzle.config.variant}:${puzzle.config.boardWidth}x${puzzle.config.boardHeight}`;

/**
 * What one puzzle can be played as, given what discovery has said so far about
 * its shape. Pure, and separate from the hook, because the ORDER of these
 * three checks is the whole correctness argument:
 *
 * `discovered` is "pending" until that shape's query settles, and answering
 * anything else first is the bug this shape exists to prevent — a handcrafted
 * puzzle would open its authored line on a cold cache, and then the bot would
 * be found and the player yanked into a game mid-move.
 */
export const choosePlayback = (
  puzzle: SavedPuzzle,
  discovered: ListedBot | undefined | "pending",
): PuzzlePlayback => {
  // A row the server could not hand to a bot anyway (human-as-P2 with no
  // stored opening move) never waits on discovery: no bot changes that.
  if (puzzle.botLaunchReady && discovered === "pending") {
    return { kind: "pending" };
  }
  if (discovered && discovered !== "pending" && puzzle.botLaunchReady) {
    return { kind: "bot", bot: discovered };
  }
  if (puzzle.legacyScriptedId !== null) {
    return { kind: "scripted", scriptedId: puzzle.legacyScriptedId };
  }
  return { kind: "unavailable" };
};

/**
 * What one shape's bot query currently says.
 *
 * Separated out because the subtle case is not "no data" but "data we have
 * been told is wrong". TanStack keeps the previous result during a refetch and
 * `isPending` stays false, so reading the query alone would keep handing back
 * the bot that just refused a launch. `isRefetching` here is OUR flag, set for
 * the duration of a deliberate re-ask, and it outranks the cache.
 */
export const resolveShapeBot = (
  query: { isPending: boolean; bots: ListedBot[] } | undefined,
  isRefetching: boolean,
  config: SavedPuzzle["config"],
): ListedBot | undefined | "pending" => {
  if (!query || query.isPending || isRefetching) return "pending";
  // Only an ANALYSIS bot plays a puzzle. Two conditions used to be one: a
  // puzzle must never be silently handed to somebody's own bot (trust), and it
  // must be played by an engine strong enough to hold the solution line
  // (strength). `isOfficial` covered both until we started shipping official
  // bots that are weak on purpose. The endpoint already narrowed to this
  // shape; re-asking each bot's own declaration keeps the client's idea of
  // "can play it" identical to the server's, which re-checks the same way at
  // launch.
  return query.bots.find(
    (bot) =>
      bot.isAnalysisBot &&
      bot.placement === "puzzle" &&
      botSupportsPosition(
        bot.variants,
        config.variant,
        config.boardWidth,
        config.boardHeight,
      ),
  );
};

/**
 * Whether this puzzle should skip bot discovery and go straight to its
 * authored line.
 *
 * Keyed by PUZZLE, never a bare flag. "Next puzzle" changes only the route
 * param, so the component can be reused, and a boolean would hand the decision
 * to a puzzle nobody made it for.
 */
export const isForcedToAuthoredLine = (
  puzzle: SavedPuzzle,
  playIntent: "authored" | undefined,
  forcedAuthoredId: string | null,
): boolean => playIntent === "authored" || forcedAuthoredId === puzzle.id;

export function usePuzzlePlayback(puzzles: SavedPuzzle[]) {
  /**
   * One query per distinct SHAPE, not per puzzle: the whole generated set is
   * one 6x6 standard question, and the handcrafted set adds a handful. Sorted
   * so the query list is stable across renders even if the listing re-sorts.
   */
  const shapes = useMemo(() => {
    const seen = new Map<string, SavedPuzzle["config"]>();
    for (const puzzle of puzzles) seen.set(shapeKey(puzzle), puzzle.config);
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [puzzles]);

  const botQueries = useQueries({
    queries: shapes.map(([, config]) =>
      puzzleBotsQueryOptionsFor({
        variant: config.variant,
        boardWidth: config.boardWidth,
        boardHeight: config.boardHeight,
      }),
    ),
  });

  /**
   * Shapes we are deliberately re-asking about after a launch was refused.
   *
   * This cannot be read off the query: TanStack keeps the previous data during
   * a refetch, so `isPending` stays FALSE and the map would keep handing out
   * the very bot that just refused the launch — long enough for the launch
   * effect to try it again. Tracked explicitly so "we are asking again" is a
   * state of its own rather than something inferred from a flag that does not
   * mean it.
   */
  const [refetchingShapes, setRefetchingShapes] = useState<ReadonlySet<string>>(
    new Set(),
  );

  /**
   * Per shape: the official bot that can play it, or `undefined` while that
   * shape's own query is still in flight. Tracked PER SHAPE rather than as one
   * page-wide flag because the shapes resolve independently — a puzzle whose
   * opponent is already known should not wait on an unrelated one.
   */
  const botsByShape = useMemo(() => {
    const map = new Map<string, ListedBot | undefined | "pending">();
    shapes.forEach(([key, config], index) => {
      const query = botQueries[index];
      map.set(
        key,
        resolveShapeBot(
          query && {
            isPending: query.isPending,
            bots: query.data?.bots ?? [],
          },
          refetchingShapes.has(key),
          config,
        ),
      );
    });
    return map;
  }, [shapes, botQueries, refetchingShapes]);

  const playbackFor = useMemo(
    () =>
      (puzzle: SavedPuzzle): PuzzlePlayback =>
        choosePlayback(puzzle, botsByShape.get(shapeKey(puzzle))),
    [botsByShape],
  );

  /**
   * Ask again who can play ONE puzzle, after its launch was refused: by then
   * the cached answer is known to be wrong.
   *
   * Only that puzzle's shape, not every shape on the page — the others were
   * never contradicted. The shape is marked pending for the whole round trip,
   * which is what stops a retry from re-picking the bot that just refused.
   * Awaitable so a caller can sequence anything that must happen afterwards.
   */
  const refetchFor = useCallback(
    async (puzzle: SavedPuzzle): Promise<void> => {
      const key = shapeKey(puzzle);
      const index = shapes.findIndex(([shape]) => shape === key);
      const query = botQueries[index];
      if (!query) return;
      setRefetchingShapes((current) => new Set(current).add(key));
      try {
        await query.refetch();
      } finally {
        setRefetchingShapes((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [shapes, botQueries],
  );

  return { playbackFor, refetchFor };
}
