/**
 * Retiring a stored game preference once, for GUESTS.
 *
 * A default only reaches a browser that has nothing stored. Change the default
 * and every returning player keeps the old one forever, which is exactly the
 * situation this exists for: until 2026-08-07 the site recommended 12x10
 * alongside 8x8, so anyone who picked the big board is still starting there -
 * on a phone, where it does not fit - and would never see the 8x8 Standard Random Start
 * default again.
 *
 * WHO THIS DOES NOT REACH, stated plainly because the reach is not obvious
 * from the code: a SIGNED-IN player's setup comes from the database, not from
 * here. `use-settings.ts` selects `isLoggedIn ? gameConfigFromDb :
 * localGameConfig`, and `gameConfigFromDb` is rebuilt from `user_settings` and
 * `user_variant_settings`, neither of which this touches. Clearing localStorage
 * for such a player changes nothing they will ever see.
 *
 * That is a deliberate scope, not an oversight (Project Reviewer 1 caught the
 * claim before it shipped, 2026-08-07). Roughly 99% of players never sign in,
 * and measured against production on the day this landed exactly ONE account
 * that has ever played a game carried a board larger than 8x8. Retiring an
 * account's stored setup is a database migration and a write to real user data;
 * it needs its own decision rather than riding along with this.
 *
 * A GENERATION rather than a flag. A flag answers "have we reset yet", which
 * is only ever true once and makes a second retirement need a second flag.
 * A generation answers "which set of defaults has this browser seen", so the
 * next time a default changes the only edit is the number below.
 *
 * Deliberately narrow. It clears the two keys that hold the game setup and
 * nothing else: the theme, the display name and the pawn choices are the
 * player's own and have no defaults worth retiring. It is also a one-time
 * clear, not an override - the very next choice the player makes is stored and
 * kept.
 */

import type { IdStorage } from "./anonymous-id";

/**
 * `IdStorage` plus the one method this needs. Extended rather than widened at
 * the source: nothing that only stores an id has any business removing keys,
 * and adding `removeItem` there would hand that reach to every caller.
 */
export interface ResettableStorage extends IdStorage {
  removeItem(key: string): void;
}

/**
 * Bump to retire the current stored game setup for every browser exactly once.
 *
 * 1 - 2026-08-07, when 12x10 stopped being recommended (Nil: too small for
 *     mobile, 8x8 Standard Random Start is the better first game).
 */
export const PREFERENCE_GENERATION = 1;

/** Matches the existing `wall-game-*` naming. */
const GENERATION_KEY = "wall-game-preference-generation";

export type PreferenceResetOutcome =
  /** This browser had an older generation, or none; the keys were cleared. */
  | "reset"
  /** Already on this generation - the ordinary case after the first load. */
  | "current"
  /** Storage could not be read or written, so nothing was decided. */
  | "unavailable";

/**
 * Clears `keys` if this browser has not seen `generation` yet, then records it.
 *
 * Recording happens even when there was nothing to clear, which is what keeps
 * this to a single read on every load after the first. A browser that has
 * never stored anything is therefore "reset" once and never again - the same
 * path, and one that costs it nothing.
 *
 * THE STAMP IS WRITTEN AND CONFIRMED BEFORE ANYTHING IS CLEARED, and the order
 * is the whole safety property. A storage that accepts a write and silently
 * drops it - some privacy modes do exactly this - would otherwise clear the
 * player's setup on every single load, turning a one-time reset into a setting
 * that never sticks. Clearing after the stamp is confirmed means the worst
 * case is that we never reset at all, which is merely the old behaviour.
 */
export function resetStalePreferences(
  storage: ResettableStorage | undefined,
  keys: readonly string[],
  generation: number = PREFERENCE_GENERATION,
): PreferenceResetOutcome {
  if (!storage) return "unavailable";

  try {
    const stamp = String(generation);
    if (storage.getItem(GENERATION_KEY) === stamp) return "current";

    storage.setItem(GENERATION_KEY, stamp);
    if (storage.getItem(GENERATION_KEY) !== stamp) return "unavailable";

    for (const key of keys) storage.removeItem(key);
    return "reset";
  } catch {
    return "unavailable";
  }
}
