import type { IdStorage } from "./anonymous-id";

/**
 * Reading `window.localStorage` can itself throw - some privacy modes make the
 * property access fail, not just the read - so even obtaining it is guarded.
 * It lives apart from the rules modules (account-nudge.ts, game-first-move.ts)
 * so they never touch `window` and run anywhere.
 */
export function browserStorage(
  kind: "local" | "session",
): IdStorage | undefined {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}
