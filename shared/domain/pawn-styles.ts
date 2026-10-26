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
