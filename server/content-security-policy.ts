/**
 * The Content-Security-Policy of every HTML page (task 3c8fd31c, 2026-11-17).
 *
 * If a bad script ever runs on wallgame.io (a hijacked tag, a compromised
 * dependency in the bundle), this policy keeps it from loading more code or
 * sending data to any host the site does not use. It lists what the site
 * really loads, read from the code and the built shell on 2026-11-17:
 *
 * - Scripts: the bundle ('self'), the shell's one inline script (by its hash,
 *   computed from the shell the server serves, so it cannot drift), and
 *   Google Analytics' gtag.js. No eval.
 * - Connections: the API and the game sockets on this host, and Google
 *   Analytics' collection endpoints (Google's own CSP list for GA4).
 * - Styles: 'unsafe-inline', because the shell has an inline <style> and the
 *   app sets style attributes. A style cannot run code.
 * - Fonts, sounds, music, images and the manifest are self-hosted. The build
 *   inlines the smallest font files as data: URLs.
 * - No eval: the app turns off Zod's eval probe (frontend/src/main.tsx).
 * - Forms: the profile page posts to /api/logout, which redirects to Kinde,
 *   and Chrome checks form-action on that redirect too.
 * - Frames: a game portal frames https://wallgame.io/?embedded=1 (CrazyGames,
 *   task 8fe7c08e). A new portal needs its host here before it can frame the
 *   site.
 */

/**
 * Report-only while the policy is new: a browser reports a violation in its
 * console and still loads the resource. Phase 2 enforces the same policy.
 */
export const CSP_HEADER = "Content-Security-Policy-Report-Only";

/** The host that serves the Kinde sign-in and sign-out pages. */
const KINDE_ORIGIN = "https://wallgame.kinde.com";

/** The game portals that may frame the site. */
const FRAME_ANCESTORS = ["https://crazygames.com", "https://*.crazygames.com"];

/**
 * The policy, given the sha256 sources ('sha256-...') of the shell's inline
 * scripts.
 */
export const contentSecurityPolicy = (inlineScriptHashes: string[]): string =>
  [
    "default-src 'self'",
    [
      "script-src 'self'",
      ...inlineScriptHashes,
      "https://*.googletagmanager.com",
    ].join(" "),
    [
      "connect-src 'self' wss://wallgame.io",
      "https://*.google-analytics.com",
      "https://*.analytics.google.com",
      "https://*.googletagmanager.com",
    ].join(" "),
    [
      "img-src 'self' data:",
      "https://*.google-analytics.com",
      "https://*.googletagmanager.com",
    ].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${KINDE_ORIGIN}`,
    `frame-ancestors 'self' ${FRAME_ANCESTORS.join(" ")}`,
  ].join("; ");
