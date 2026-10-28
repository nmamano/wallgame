/**
 * The values the posters and Connect need that are NOT secret. Nil's rule
 * (2026-10-27): no env var or secret for a value that is not secret; it is a
 * constant here. createDaily puts these over its env (withPublicIds), so an
 * env var of the same name has no effect.
 *
 * null = not given yet: that platform stays dry-run, and /daily/connect
 * says why ("YouTube client id not set in code").
 */
/**
 * @typedef {{
 *   BLUESKY_IDENTIFIER: string | null,
 *   YOUTUBE_CLIENT_ID: string | null,
 *   TIKTOK_CLIENT_KEY: string | null,
 *   THREADS_APP_ID: string | null,
 *   R2_ACCOUNT_ID: string | null,
 * }} PublicIds
 */

/** @type {Readonly<PublicIds>} */
export const PUBLIC_IDS = Object.freeze({
  // The account's DID, not its handle: it stays the same when the handle
  // changes (to wallgame.io). createSession takes either.
  BLUESKY_IDENTIFIER: "did:plc:7hk4ouyq7rfod3qatg2pbjln",
  // The OAuth client "Wall Game Poster" (Web application) of the Google
  // project wall-game-poster, owned by thewallgameio@gmail.com. The app is
  // "In production" but unverified: Connect shows Google's unverified-app
  // screen (Personal Assistant, 2026-10-28).
  YOUTUBE_CLIENT_ID:
    "487593560695-qdu8rjjistmaq4iouds76ffsiameggu0.apps.googleusercontent.com",
  // The SANDBOX key of the TikTok app "Wall Game Poster" (sandbox "Wall Game
  // sandbox"). The production key replaces it when the app is approved.
  TIKTOK_CLIENT_KEY: "sbawgnt7vpik5zdozp",
  // The Threads app id of the Meta app "Wall Game Threads", not the Meta
  // app id (Wall Game Growth, 2026-10-27).
  THREADS_APP_ID: "2049959042384724",
  // The Cloudflare account of the R2 bucket that Threads fetches from.
  R2_ACCOUNT_ID: "1f1a89fa2a45aeb655275b923202a800",
});

/** The public ids that each platform needs. */
export const PLATFORM_IDS = {
  youtube: ["YOUTUBE_CLIENT_ID"],
  tiktok: ["TIKTOK_CLIENT_KEY"],
  // Threads and Instagram fetch the video from R2 (public-url-r2.mjs).
  threads: ["THREADS_APP_ID", "R2_ACCOUNT_ID"],
  instagram: ["R2_ACCOUNT_ID"],
  bluesky: ["BLUESKY_IDENTIFIER"],
};

const LABELS = {
  BLUESKY_IDENTIFIER: "Bluesky identifier",
  YOUTUBE_CLIENT_ID: "YouTube client id",
  TIKTOK_CLIENT_KEY: "TikTok client key",
  THREADS_APP_ID: "Threads app id",
  R2_ACCOUNT_ID: "R2 account id",
};

/**
 * `env` with the public ids from code over it.
 * @param {Record<string, string | undefined>} env
 * @param {PublicIds} [ids]
 */
export const withPublicIds = (env, ids = PUBLIC_IDS) => ({ ...env, ...ids });

/** Why `platform` cannot post: its public ids that are not set in code. */
export const idsNotSet = (platform, env) =>
  (PLATFORM_IDS[platform] ?? [])
    .filter((name) => !env[name])
    .map((name) => `${LABELS[name]} not set in code`);
