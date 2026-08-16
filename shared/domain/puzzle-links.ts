/**
 * Where each kind of puzzle lives, as a link you can send someone.
 *
 * Every puzzle plays at `/puzzles/$id`, and a campaign level at
 * `/solo-campaign/$id`. Generated puzzles briefly had a third address,
 * `/puzzles/generated/$id`, from when they were numbered separately from the
 * handcrafted ones; the numbering runs once across both now, so the extra
 * segment distinguished nothing. It is gone rather than redirected — the links
 * were never out in the world (Nil, 2026-08-04: "we can get rid of the old
 * generated/ links, they were not used yet").
 *
 * Centralised here because three surfaces build these links (the card on the
 * listing page, the two in-page puzzle headers) and a fourth reads one back out
 * of the address bar. A share link that disagrees with the route that serves it
 * is a broken link, so there is one definition of both.
 *
 * PUZZLE LINKS USE THE PUZZLE'S NUMBER, and that number is not permanent.
 * Retiring a puzzle renumbers the survivors to keep the listing contiguous
 * (`scripts/retire-puzzles.ts`), so a link shared before a retirement can
 * afterwards resolve to a DIFFERENT puzzle rather than to nothing. Nil was
 * shown that trade and chose it (2026-08-02) over a stable id, because a
 * shareable link that reads `/puzzles/7` is worth more to him than one that
 * survives renumbering. The stable alternative is the row id, which is still
 * accepted here so links minted before numbers existed keep working.
 */

/**
 * Two kinds, not three. "scripted" and "generated" used to be separate
 * catalogs with separate addresses; they are one table now, so one kind
 * ("saved") covers every puzzle and the campaign keeps its own.
 */
export type PuzzleKind = "saved" | "campaign";

/** Anything with the two fields a puzzle link is built from or matched against. */
export interface SavedPuzzleRef {
  id: string;
  displayName: string;
}

/**
 * The number shown to a player, read off the display name ("Puzzle 7" -> 7).
 *
 * Read from the NAME rather than from array position because the listing can
 * be re-sorted (by likes), so position there is not the puzzle's number. Falls
 * back to null on a name that does not end in a number, which keeps a renamed
 * or historical row out of the numeric namespace instead of guessing.
 */
export function savedPuzzleNumber(displayName: string): number | null {
  const match = /(\d+)\s*$/.exec(displayName);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** What a puzzle link should carry: the number when it has one, else the id. */
export function savedPuzzleSlug(puzzle: SavedPuzzleRef): string {
  const number = savedPuzzleNumber(puzzle.displayName);
  return number === null ? puzzle.id : String(number);
}

/**
 * Resolve the `$id` segment of a puzzle link back to a puzzle.
 *
 * Accepts both forms on purpose: an all-digits segment is a puzzle number,
 * anything else is a row id (the shape links used before numbers existed).
 * The two namespaces cannot collide because row ids are nanoids.
 */
export function resolveSavedPuzzle<T extends SavedPuzzleRef>(
  puzzles: readonly T[],
  param: string,
): T | undefined {
  if (/^\d+$/.test(param)) {
    const wanted = Number(param);
    return puzzles.find(
      (puzzle) => savedPuzzleNumber(puzzle.displayName) === wanted,
    );
  }
  return puzzles.find((puzzle) => puzzle.id === param);
}

/** The in-app path for a puzzle of the given kind. */
export function puzzlePath(kind: PuzzleKind, id: string): string {
  switch (kind) {
    case "saved":
      return `/puzzles/${id}`;
    case "campaign":
      return `/solo-campaign/${id}`;
  }
}

/**
 * The absolute link to hand to someone else.
 *
 * `origin` is passed in rather than read from `window` so this stays pure and
 * testable, and so a caller on the server side could not accidentally bake in
 * the wrong host.
 */
export function puzzleShareUrl(
  kind: PuzzleKind,
  id: string,
  origin: string,
): string {
  // A trailing slash on the origin would double up against the leading slash
  // on the path and produce a link that still resolves but looks broken when
  // pasted into a chat.
  return `${origin.replace(/\/+$/, "")}${puzzlePath(kind, id)}`;
}
