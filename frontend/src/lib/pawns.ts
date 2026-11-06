import { PAWN_FILES as manifest } from "../../../shared/domain/pawn-files.generated";
import { sortPawnNames } from "./pawn-sort";
import { isRetiredPawnStyle } from "./pawn-style";

/**
 * The pawn art a player can choose from, by filename, in reading order.
 *
 * The names come from `shared/domain/pawn-files.generated.ts`, the same list
 * the server accepts skins from. Run `bun run pawns:files` after you add art.
 * The app does not import the SVGs: an import of each one put a hashed copy of
 * all of them (~9.4 MB) in every build, on top of the copies in `dist/pawns/`;
 * the art is fetched by URL (`lib/pawn-style.ts`, `components/pawn-selector.tsx`).
 */
export const CAT_PAWNS = sortPawnNames(
  manifest.cat.filter((name) => !isRetiredPawnStyle(name, "cat")),
);
export const MOUSE_PAWNS = sortPawnNames(
  manifest.mouse.filter((name) => !isRetiredPawnStyle(name, "mouse")),
);
export const HOME_PAWNS = sortPawnNames(manifest.home);

const dogPackOrder = (name: string): number =>
  name.startsWith("dog-one-line-") ? 0 : name.startsWith("dog-puppy-") ? 1 : 2;

/** Dog art stays grouped by purchased pack, then numeric within each pack. */
export const DOG_PAWNS = [...manifest.dog].sort(
  (left, right) =>
    dogPackOrder(left) - dogPackOrder(right) ||
    left.localeCompare(right, undefined, { numeric: true }),
);
export const ELEPHANT_PAWNS = sortPawnNames(manifest.elephant);
