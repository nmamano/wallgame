/**
 * A stable id for this browser, so "did the same person come back" is a
 * question the database can answer.
 *
 * Today it cannot: `game_players.user_id` is NULL for every guest and there is
 * no session, cookie or anonymous column anywhere, so the roughly 99% of
 * players who never sign in are invisible between visits.
 *
 * See shared/domain/anonymous-id.ts for what this id is and, more importantly,
 * what it is not.
 */

import { isAnonymousId } from "../../../shared/domain/anonymous-id";

/** Matches the existing `wall-game-theme` / `wall-game-sound-enabled` keys. */
const STORAGE_KEY = "wall-game-anonymous-id";

/** The slice of `localStorage` this needs, so tests can supply their own. */
export interface IdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Reading `window.localStorage` can itself throw - some privacy modes make the
 * property access fail, not just the read - so even obtaining it is guarded.
 */
function browserStorage(): IdStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * This browser's id, or undefined when it cannot be stored durably.
 *
 * The undefined case is deliberate and load-bearing. Returning a freshly minted
 * id that failed to persist would look like helping, and would instead invent a
 * brand-new visitor on every single page load - turning a browser that cannot
 * store anything into a stream of people who each played once and never
 * returned. That is the exact conclusion this whole exercise exists to measure
 * honestly, so an id that will not survive the page is worth strictly less than
 * no id at all.
 */
export function getAnonymousId(
  storage: IdStorage | undefined = browserStorage(),
): string | undefined {
  if (!storage) return undefined;

  try {
    const existing = storage.getItem(STORAGE_KEY);
    // Already good: return it and write nothing. An id that is present and
    // valid is the common path and must not churn storage on every call.
    if (isAnonymousId(existing)) return existing;

    // Missing, or corrupted by something that is not us. Replace it.
    const minted = crypto.randomUUID();
    storage.setItem(STORAGE_KEY, minted);

    // Read back rather than trusting the write. Some storages accept a write
    // and silently drop it, and that is indistinguishable from success until
    // the next page load - by which time it has already become a false visitor.
    const persisted = storage.getItem(STORAGE_KEY);
    return persisted === minted && isAnonymousId(persisted)
      ? persisted
      : undefined;
  } catch {
    return undefined;
  }
}
