/**
 * The follower count of the Wall Game account on each platform, for Wall
 * Game Growth's dashboard (Nil, 2026-10-28, via Growth and Wall Game PM).
 * READ-ONLY: nothing here posts. A count is a number or null with a short
 * reason; a reason names a step, an HTTP status or a code, never a token, a
 * URL with a token or a reply body.
 *
 * Read 2026-10-28 (Worker 1's research notes, with quotes):
 * - X: GET https://api.x.com/2/users/me?user.fields=public_metrics ->
 *   data.public_metrics.followers_count ("Number of Users who follow this
 *   User"); OAuth 1.0a User Context is accepted (v2 authentication mapping).
 *   "User: Read | $0.010 per resource" on pay-per-use, so an X count is
 *   read at most once in 24 hours (Growth via Wall Game PM, 2026-10-28).
 *   The developer account can run out of credits (2026-10-27: HTTP 402
 *   "credits depleted" at media finalize); a 402 shows as X_CREDITS_DEPLETED.
 * - Facebook: Page node, followers_count ("Number of page followers"),
 *   pages_read_engagement; read with the Page token.
 * - Instagram: IG User node, followers_count ("Total number of Instagram
 *   users following the user"), instagram_basic and pages_read_engagement.
 *   The page names a User token, not a Page token, so it is read with the
 *   system-user token, as meta.mjs reads the username.
 * - Threads: GET https://graph.threads.com/v1.0/<user-id>/threads_insights
 *   ?metric=followers_count -> data[].total_value.value; threads_manage_insights
 *   is "Required for making GET calls to insights endpoints".
 * - Bluesky: app.bsky.actor.getProfile "Does not require auth"; the public
 *   AppView https://public.api.bsky.app -> followersCount.
 * - YouTube: channels.list part=statistics mine=true (updated 2026-10-15):
 *   statistics.subscriberCount, "rounded down to three significant
 *   figures", and hiddenSubscriberCount; 1 quota unit. The discovery
 *   document lists youtube.readonly for channels.list, not youtube.upload.
 * - TikTok: GET https://open.tiktokapis.com/v2/user/info/?fields=follower_count
 *   (updated 2026-10-23), "Authorized scope: user.info.stats".
 *
 * A token connected before its platform's read scope was asked for still
 * posts; its count is null with NEEDS_RECONNECT (connect.mjs).
 */
import { PostFailed, ok } from "./transport.mjs";
import { X_API, X_SECRETS, oauth1Header, xCreds } from "./post-x.mjs";
import { FB_GRAPH } from "./post-facebook.mjs";
import { META_SECRETS, MetaRefused, discoverMeta } from "./meta.mjs";
import { THREADS_GRAPH } from "./post-threads.mjs";
import { YOUTUBE_SECRETS, youtubeAccessToken } from "./post-youtube.mjs";
import { TIKTOK_SECRETS, tiktokAccessToken } from "./post-tiktok.mjs";
import {
  THREADS_INSIGHTS_SCOPE,
  TIKTOK_STATS_SCOPE,
  YOUTUBE_READ_SCOPE,
} from "./connect.mjs";

export const FOLLOWER_PLATFORMS = [
  "x",
  "facebook",
  "instagram",
  "threads",
  "bluesky",
  "youtube",
  "tiktok",
];

/** A count is read at most once in this time. */
export const FOLLOWERS_MAX_AGE_MS = 60 * 60 * 1000;
/** An X count is read at most once in this time: X reads are paid. */
export const X_FOLLOWERS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const X_CREDITS_DEPLETED = "X credits depleted";

export const NEEDS_RECONNECT = "needs reconnect";

export const BLUESKY_PROFILE_URL =
  "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile";
export const YOUTUBE_CHANNELS_STATS_URL =
  "https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true";
export const TIKTOK_FOLLOWERS_URL =
  "https://open.tiktokapis.com/v2/user/info/?fields=follower_count";

/** A reason that is safe to show as it is. */
export class NoCount extends Error {}

export const bearer = (token) => ({ authorization: `Bearer ${token}` });

/**
 * The reply's JSON, or NoCount with the step and the status only, or with
 * the reason that `reasons` gives for the status.
 */
export const read = async (transport, step, req, reasons = {}) => {
  const reply = await transport.request({ method: "GET", ...req });
  if (!ok(reply)) {
    throw new NoCount(reasons[reply.status] ?? `${step}: HTTP ${reply.status}`);
  }
  return reply.json;
};

/** A count, or NoCount: a platform could answer a string or nothing. */
export const asCount = (value, step) => {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new NoCount(`${step}: no count in the reply`);
  }
  return n;
};

export const needSecrets = (env, names) => {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) {
    throw new NoCount(`secrets missing: ${missing.join(", ")}`);
  }
};

/** The stored Connect record, with `scope` granted when it is named. */
export const needConnected = (tokens, platform, scope) => {
  if (!tokens.connected(platform)) {
    throw new NoCount("not connected (/daily/connect)");
  }
  const record = tokens.read(platform);
  if (scope && !record.scopes?.includes(scope)) {
    throw new NoCount(NEEDS_RECONNECT);
  }
  return record;
};

/**
 * One reader for each platform. `ctx` is {transport, env, tokens,
 * keepRefreshToken}; `env` has the public ids over it, and
 * keepRefreshToken(platform, token, expiresInSeconds) stores a rotated
 * refresh token as the posters do.
 */
const READERS = {
  async x({ transport, env, tokens }) {
    needSecrets(env, X_SECRETS);
    const record = needConnected(tokens, "x");
    const url = `${X_API}/2/users/me?user.fields=public_metrics`;
    const json = await read(
      transport,
      "x users/me",
      {
        url,
        headers: {
          authorization: oauth1Header(
            { method: "GET", url },
            xCreds(env, record),
          ),
        },
      },
      { 402: X_CREDITS_DEPLETED },
    );
    return asCount(json?.data?.public_metrics?.followers_count, "x");
  },

  async facebook({ transport, env }) {
    needSecrets(env, META_SECRETS);
    const meta = await discoverMeta({
      transport,
      token: env.META_SYSTEM_USER_TOKEN,
    });
    const json = await read(transport, "facebook Page read", {
      url: `${FB_GRAPH}/${meta.pageId}?fields=followers_count`,
      headers: bearer(meta.pageToken),
    });
    return asCount(json?.followers_count, "facebook");
  },

  async instagram({ transport, env }) {
    needSecrets(env, META_SECRETS);
    const meta = await discoverMeta({
      transport,
      token: env.META_SYSTEM_USER_TOKEN,
      instagram: "id",
    });
    const json = await read(transport, "instagram account read", {
      url: `${FB_GRAPH}/${meta.igUserId}?fields=followers_count`,
      headers: bearer(env.META_SYSTEM_USER_TOKEN),
    });
    return asCount(json?.followers_count, "instagram");
  },

  async threads({ transport, tokens }) {
    const record = needConnected(tokens, "threads", THREADS_INSIGHTS_SCOPE);
    const json = await read(transport, "threads insights", {
      url: `${THREADS_GRAPH}/${record.account.id}/threads_insights?metric=followers_count`,
      headers: bearer(record.accessToken),
    });
    const metric = (Array.isArray(json?.data) ? json.data : []).find(
      (m) => m?.name === "followers_count",
    );
    return asCount(metric?.total_value?.value, "threads");
  },

  async bluesky({ transport, env }) {
    if (!env.BLUESKY_IDENTIFIER) {
      throw new NoCount("Bluesky identifier not set in code");
    }
    const json = await read(transport, "bluesky profile", {
      url: `${BLUESKY_PROFILE_URL}?actor=${encodeURIComponent(env.BLUESKY_IDENTIFIER)}`,
    });
    return asCount(json?.followersCount, "bluesky");
  },

  async youtube({ transport, env, tokens, keepRefreshToken }) {
    needSecrets(env, YOUTUBE_SECRETS);
    if (!env.YOUTUBE_CLIENT_ID) {
      throw new NoCount("YouTube client id not set in code");
    }
    const record = needConnected(tokens, "youtube", YOUTUBE_READ_SCOPE);
    const access = await youtubeAccessToken({
      transport,
      creds: {
        YOUTUBE_CLIENT_ID: env.YOUTUBE_CLIENT_ID,
        YOUTUBE_CLIENT_SECRET: env.YOUTUBE_CLIENT_SECRET,
        refreshToken: record.refreshToken,
      },
      onRefreshToken: (token) => keepRefreshToken("youtube", token),
    });
    const json = await read(transport, "youtube channels", {
      url: YOUTUBE_CHANNELS_STATS_URL,
      headers: bearer(access),
    });
    const stats = json?.items?.[0]?.statistics;
    if (stats?.hiddenSubscriberCount === true) {
      throw new NoCount("the channel hides its subscriber count");
    }
    return asCount(stats?.subscriberCount, "youtube");
  },

  async tiktok({ transport, env, tokens, keepRefreshToken }) {
    needSecrets(env, TIKTOK_SECRETS);
    const record = needConnected(tokens, "tiktok", TIKTOK_STATS_SCOPE);
    const access = await tiktokAccessToken({
      transport,
      creds: {
        TIKTOK_CLIENT_KEY: env.TIKTOK_CLIENT_KEY,
        TIKTOK_CLIENT_SECRET: env.TIKTOK_CLIENT_SECRET,
        refreshToken: record.refreshToken,
      },
      onRefreshToken: (token, expiresIn) =>
        keepRefreshToken("tiktok", token, expiresIn),
    });
    const json = await read(transport, "tiktok user info", {
      url: TIKTOK_FOLLOWERS_URL,
      headers: bearer(access),
    });
    return asCount(json?.data?.user?.follower_count, "tiktok");
  },
};

/** What a failed read may show: never a reply body or a request. */
export const reasonOf = (err) => {
  if (err instanceof NoCount || err instanceof MetaRefused) return err.message;
  if (err instanceof PostFailed) return `${err.step}: HTTP ${err.status}`;
  return `the read did not finish (${err?.name ?? "error"})`;
};

/**
 * The platforms whose last result in `counts` is too old: an X count after
 * 24 hours, any other result after an hour. A failed X read has no count
 * to keep (and X bills per resource it returns), so it is tried again after
 * an hour, not 24.
 * @param {Record<string, { followers: number | null, at: string }> | null} counts
 * @param {number} nowMs
 */
export const followersDue = (counts, nowMs) =>
  FOLLOWER_PLATFORMS.filter((platform) => {
    const last = counts?.[platform];
    const at = Date.parse(last?.at ?? "");
    if (!Number.isFinite(at)) return true;
    const maxAge =
      platform === "x" && last.followers !== null
        ? X_FOLLOWERS_MAX_AGE_MS
        : FOLLOWERS_MAX_AGE_MS;
    return nowMs - at >= maxAge;
  });

/**
 * The count of each platform in `platforms` (all of them by default), read
 * now, one platform after the other.
 * @returns {Promise<Record<string, { followers: number | null, at: string, error: string | null }>>}
 */
export const readFollowers = async (ctx, platforms = FOLLOWER_PLATFORMS) => {
  const now = ctx.now ?? (() => new Date());
  /** @type {Record<string, { followers: number | null, at: string, error: string | null }>} */
  const out = {};
  for (const platform of platforms) {
    try {
      const followers = await READERS[platform](ctx);
      out[platform] = { followers, at: now().toISOString(), error: null };
    } catch (err) {
      out[platform] = {
        followers: null,
        at: now().toISOString(),
        error: reasonOf(err),
      };
    }
  }
  return out;
};
