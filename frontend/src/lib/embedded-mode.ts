/**
 * Whether this session is running inside a game portal's frame.
 *
 * A portal such as CrazyGames embeds `https://wallgame.io/?embedded=1` in an
 * iframe on its own page. Two of their rules matter to us: external logins must
 * be disabled, and the game must not send the player off-site. Neither is a
 * cosmetic preference - our login is genuinely BROKEN there, because Kinde's
 * cookies are `sameSite: "Lax"` and a third-party frame never sends them. So the
 * entry points are made absent rather than left dead.
 *
 * The flag is LATCHED. A query param survives the initial load only; the first
 * client-side navigation rewrites the URL and it is gone. Latching to
 * `sessionStorage` keeps the whole tab session embedded - including, deliberately,
 * a tab where the player later types the plain URL. Closing the tab clears it.
 *
 * Default off. With no param and no latch this is `false`, and every caller
 * renders exactly what wallgame.io renders today.
 */

// The same two-method slice of Storage that anonymous-id.ts needs; not worth a
// second interface.
import type { IdStorage } from "@/lib/anonymous-id";

/**
 * Matches the existing `wall-game-*` storage keys.
 *
 * Exported because `index.html` has to make the same decision in plain JS,
 * before any module runs, to keep the analytics tag from being appended in a
 * portal frame. `tests/embedded-analytics.test.ts` fails if the two drift.
 */
export const EMBEDDED_STORAGE_KEY = "wall-game-embedded";
export const EMBEDDED_QUERY_PARAM = "embedded";

/**
 * The flag for a given URL query and storage, without touching globals, so a
 * test can drive both halves.
 */
export const readEmbeddedFlag = (
  search: string,
  storage: IdStorage | undefined,
): boolean => {
  if (new URLSearchParams(search).get(EMBEDDED_QUERY_PARAM) === "1") {
    // A failure to persist is not a reason to refuse the caller's request; it
    // only means the latch will not outlive this page load.
    try {
      storage?.setItem(EMBEDDED_STORAGE_KEY, "1");
    } catch {
      /* storage full or blocked - the query param still stands */
    }
    return true;
  }

  try {
    return storage?.getItem(EMBEDDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * Reading `window.sessionStorage` can itself throw - some privacy modes make the
 * property access fail, not just the read - so even obtaining it is guarded.
 */
const browserStorage = (): IdStorage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

let latched: boolean | undefined;

/** Whether to render the portal-safe page. Constant for the life of the tab. */
export const isEmbedded = (): boolean => {
  latched ??= readEmbeddedFlag(window.location.search, browserStorage());
  return latched;
};
