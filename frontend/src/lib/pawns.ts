import manifest from "virtual:pawn-manifest";
import { sortPawnNames } from "./pawn-sort";
import { isRetiredPawnStyle } from "./pawn-style";

/**
 * The pawn art a player can choose from, by filename, in reading order.
 *
 * The names come from `vite-plugin-pawn-manifest.ts`, which reads
 * `frontend/public/pawns/<type>/` at build time. Adding art needs no code change;
 * see that file for why the app does not import the SVGs.
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
