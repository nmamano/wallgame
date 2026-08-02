/**
 * Where each kind of puzzle lives, as a link you can send someone.
 *
 * The three kinds have separate id namespaces (see shared/contracts/puzzles.ts)
 * and, until now, separate link stories: a scripted puzzle and a campaign level
 * each played at their own address, so they were already shareable even though
 * nothing advertised it, while a generated puzzle had no address at all. It was
 * launched straight into a fresh bot game, and its identity travelled in
 * client-side handshake state — so the only link a player could produce pointed
 * at one playthrough of it, which a friend could watch but not play.
 *
 * `/puzzles/generated/$id` is that missing address. It is a launcher, not a
 * board: opening it starts that puzzle for whoever opened it.
 *
 * Centralised here because three surfaces now build these links (the card on
 * the listing page, the two in-page puzzle headers) and a fourth reads one back
 * out of the address bar. A share link that disagrees with the route that
 * serves it is a broken link, so there is one definition of both.
 */

export type PuzzleKind = "scripted" | "campaign" | "generated";

/** The in-app path for a puzzle of the given kind. */
export function puzzlePath(kind: PuzzleKind, id: string): string {
  switch (kind) {
    case "scripted":
      return `/puzzles/${id}`;
    case "campaign":
      return `/solo-campaign/${id}`;
    case "generated":
      return `/puzzles/generated/${id}`;
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
