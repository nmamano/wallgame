import { PAWN_FILES } from "./pawn-files.generated";

/**
 * The pawn art a seat gets when its player chose none.
 *
 * Shared, not frontend-only, because tools outside the app draw the site's
 * pawns too (the daily video storyboard, scripts/game-video/storyboard.ts),
 * and they must draw the same default. The file names are under
 * frontend/public/pawns/<type>/.
 */
export type PawnStyleType = "dog" | "cat" | "mouse" | "elephant" | "home";

export const DEFAULT_PAWN_STYLES: Record<PawnStyleType, string> = {
  dog: "dog-puppy-03.svg",
  cat: "cat3.svg",
  mouse: "mouse20.svg",
  elephant: "elephant-14.svg",
  home: "home2.svg",
};

const PAWN_FOLDERS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(PAWN_FILES).map(([folder, files]) => [folder, new Set(files)]),
);

const PAWN_PATH = /^\/?pawns\/([a-z-]+)\/([^/]+)$/;

/**
 * The site path of the pawn file a skin names, or null if the skin names no
 * file the site ships.
 *
 * A skin is a filename in its type's folder ("cat3.svg", or "cat3" for
 * "cat3.svg") or a path to any pawn file ("/pawns/animal-cycle/cat.svg").
 * Any other value is not a skin: a player or a bot chooses it, every viewer's
 * browser loads it, and a URL or an /api path would make them all send a
 * request the player wants (board task 6a245eee).
 */
export const builtInPawnPath = (
  skin: string,
  type: PawnStyleType,
): string | null => {
  const path = PAWN_PATH.exec(skin);
  const [folder, file] = path
    ? [path[1], path[2]]
    : [type, skin.includes(".") ? skin : `${skin}.svg`];
  return PAWN_FOLDERS.get(folder)?.has(file)
    ? `/pawns/${folder}/${file}`
    : null;
};

/** Whether a skin is "default" or names a pawn file the site ships. */
export const isBuiltInPawnStyle = (
  skin: string,
  type: PawnStyleType,
): boolean => skin === "default" || builtInPawnPath(skin, type) !== null;
