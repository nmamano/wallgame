import manifest from "virtual:pawn-manifest";
import { sortPawnNames } from "./pawn-sort";

/**
 * The pawn art a player can choose from, by filename, in reading order.
 *
 * The names come from `vite-plugin-pawn-manifest.ts`, which reads
 * `frontend/public/pawns/<type>/` at build time. Adding art needs no code change;
 * see that file for why the app does not import the SVGs.
 */
export const CAT_PAWNS = sortPawnNames(manifest.cat);
export const MOUSE_PAWNS = sortPawnNames(manifest.mouse);
export const HOME_PAWNS = sortPawnNames(manifest.home);
