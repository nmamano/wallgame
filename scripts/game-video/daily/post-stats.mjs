/**
 * The numbers of each posted video on each platform, for the stats tracker
 * on the app's "/" (Nil, 2026-10-31: "this app can be restructured into
 * social media stats tracker"; Wall Game PM's task). READ-ONLY: nothing
 * here posts or reconnects. Each post gets up to four numbers, null where
 * the platform does not give one: views, likes, comments, shares. A reason
 * names a step, an HTTP status or a code, never a token or a reply body
 * (followers.mjs rule).
 *
 * Read 2026-10-31 (the platform docs, and one public Bluesky read):
 * - X: GET /2/tweets?ids=<up to 100>&tweet.fields=public_metrics ->
 *   impression_count, like_count, reply_count, retweet_count, quote_count.
 *   "Posts: Read | $0.005 per resource", charged per resource returned, so
 *   X is read at most once in 24 h, one request for all posts.
 * - Bluesky: app.bsky.feed.getPosts on the public AppView, no auth, up to
 *   25 uris -> likeCount, replyCount, repostCount, quoteCount (no views).
 * - YouTube: videos.list part=statistics, up to 50 ids, youtube.readonly ->
 *   viewCount, likeCount, commentCount (no shares).
 * - Threads: GET /<media-id>/insights?metric=views,likes,replies,reposts,
 *   quotes,shares, threads_manage_insights -> data[].values[0].value.
 * - Instagram Reel: GET /<media-id>/insights?metric=views,likes,comments,
 *   shares, instagram_manage_insights -> data[].values[0].value. Without
 *   that permission, like_count and comments_count of the media node
 *   (instagram_basic), and views show "needs reconnect".
 * - Instagram Story: the same edge, metric=views,replies,shares; a Story's
 *   numbers can be read only while it is up (24 h), so it is read for a
 *   day and keeps its last numbers.
 * - Facebook Reel: GET /<video-id>/video_insights?metric=
 *   blue_reels_play_count,post_video_likes_by_reaction_type,
 *   post_video_social_actions with the Page token (read_insights). Without
 *   that permission, the likes and comments summaries of the video node,
 *   and views show "needs reconnect".
 * - TikTok: a post is an inbox draft (post-tiktok.mjs), so the app has no
 *   video id, and video.query needs the video.list scope, which the
 *   connection lacks: no numbers, "needs reconnect".
 *
 * Shares are the platform's re-shares: X retweets and quotes, Bluesky
 * reposts and quotes, Threads reposts, quotes and shares.
 */
import { X_API, X_SECRETS, oauth1Header, xCreds } from "./post-x.mjs";
import { FB_GRAPH } from "./post-facebook.mjs";
import { META_SECRETS, discoverMeta } from "./meta.mjs";
import { THREADS_GRAPH } from "./post-threads.mjs";
import { YOUTUBE_SECRETS, youtubeAccessToken } from "./post-youtube.mjs";
import { THREADS_INSIGHTS_SCOPE, YOUTUBE_READ_SCOPE } from "./connect.mjs";
import {
  NEEDS_RECONNECT,
  NoCount,
  X_CREDITS_DEPLETED,
  asCount,
  bearer,
  needConnected,
  needSecrets,
  read,
  reasonOf,
} from "./followers.mjs";
import { ok } from "./transport.mjs";

export const STATS_PLATFORMS = [
  "x",
  "bluesky",
  "youtube",
  "facebook",
  "instagram",
  "instagram-story",
  "threads",
  "tiktok",
];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A platform's posts are read at most once in this time. */
export const STATS_MAX_AGE_MS = 6 * HOUR_MS;
/** X posts at most once in 24 h: X reads are paid per post. */
export const X_STATS_MAX_AGE_MS = DAY_MS;
/**
 * A post is read until it is this old; then it keeps its last numbers. It
 * bounds the paid X read and the Meta calls (one per post).
 */
export const STATS_WINDOW_MS = 14 * DAY_MS;
/** A Story's numbers can be read only while it is up. */
const STORY_WINDOW_MS = DAY_MS;

export const BLUESKY_POSTS_URL =
  "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";
export const YOUTUBE_VIDEOS_STATS_URL =
  "https://www.googleapis.com/youtube/v3/videos?part=statistics";

export const TIKTOK_NO_STATS = `${NEEDS_RECONNECT}: a TikTok post is an inbox draft with no video id, and video stats need the video.list scope`;

/** @typedef {{ views: number | null, likes: number | null, comments: number | null, shares: number | null }} Numbers */
/** @typedef {{ platform: string, postId: string, utc: string }} Post */

/** A number the platform gave, or null when it gave none. */
const num = (value, step) =>
  value === undefined || value === null ? null : asCount(value, step);

/** The sum of the numbers that are there, or null when none is. */
const sum = (...xs) => {
  const have = xs.filter((x) => typeof x === "number");
  return have.length ? have.reduce((a, b) => a + b, 0) : null;
};

const chunks = (xs, n) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) =>
    xs.slice(i * n, i * n + n),
  );

/**
 * A Graph read: the reply's JSON, or NoCount. A permission error (code 10,
 * or 200-299) says "needs reconnect" with the permission it lacks, so the
 * caller can fall back to the numbers it may read.
 */
class NeedsPermission extends NoCount {}
const graph = async (transport, step, url, token, permission) => {
  const reply = await transport.request({
    method: "GET",
    url,
    headers: bearer(token),
  });
  if (ok(reply)) return reply.json;
  const code = reply.json?.error?.code;
  if (code === 10 || (code >= 200 && code < 300)) {
    throw new NeedsPermission(`${NEEDS_RECONNECT} (${permission})`);
  }
  throw new NoCount(
    `${step}: HTTP ${reply.status}${typeof code === "number" ? ` code ${code}` : ""}`,
  );
};

/** {name: value} of an insights reply: data[].values[0].value. */
const insightValues = (json) =>
  Object.fromEntries(
    (Array.isArray(json?.data) ? json.data : []).map((m) => [
      m?.name,
      m?.values?.[0]?.value ?? m?.total_value?.value,
    ]),
  );

/** A number, or the sum of an object's numbers (likes by reaction type). */
const total = (value, step) =>
  value && typeof value === "object"
    ? sum(...Object.values(value).map((v) => num(v, step)))
    : num(value, step);

/** The value of the first key that contains `part` (comment, share). */
const keyed = (value, part, step) => {
  if (!value || typeof value !== "object") return null;
  const key = Object.keys(value).find((k) => k.toLowerCase().includes(part));
  return key ? num(value[key], step) : null;
};

/**
 * One reader per platform: (ctx, posts) -> {postId: Numbers & {note?}}, or
 * a throw for the whole platform. A post the platform does not return is
 * left out (it shows no numbers yet).
 */
const READERS = {
  async x({ transport, env, tokens }, posts) {
    needSecrets(env, X_SECRETS);
    const record = needConnected(tokens, "x");
    const out = {};
    for (const part of chunks(posts, 100)) {
      const url = `${X_API}/2/tweets?ids=${part.map((p) => p.postId).join(",")}&tweet.fields=public_metrics`;
      const json = await read(
        transport,
        "x tweets",
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
      for (const t of Array.isArray(json?.data) ? json.data : []) {
        const m = t?.public_metrics ?? {};
        out[t.id] = {
          views: num(m.impression_count, "x"),
          likes: num(m.like_count, "x"),
          comments: num(m.reply_count, "x"),
          shares: sum(num(m.retweet_count, "x"), num(m.quote_count, "x")),
        };
      }
    }
    return out;
  },

  async bluesky({ transport }, posts) {
    const out = {};
    for (const part of chunks(posts, 25)) {
      const query = part
        .map((p) => `uris=${encodeURIComponent(p.postId)}`)
        .join("&");
      const json = await read(transport, "bluesky posts", {
        url: `${BLUESKY_POSTS_URL}?${query}`,
      });
      for (const p of Array.isArray(json?.posts) ? json.posts : []) {
        out[p.uri] = {
          views: null,
          likes: num(p.likeCount, "bluesky"),
          comments: num(p.replyCount, "bluesky"),
          shares: sum(
            num(p.repostCount, "bluesky"),
            num(p.quoteCount, "bluesky"),
          ),
        };
      }
    }
    return out;
  },

  async youtube({ transport, env, tokens, keepRefreshToken }, posts) {
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
    const out = {};
    for (const part of chunks(posts, 50)) {
      const json = await read(transport, "youtube videos", {
        url: `${YOUTUBE_VIDEOS_STATS_URL}&id=${part.map((p) => p.postId).join(",")}`,
        headers: bearer(access),
      });
      for (const v of Array.isArray(json?.items) ? json.items : []) {
        const st = v?.statistics ?? {};
        out[v.id] = {
          views: num(st.viewCount, "youtube"),
          likes: num(st.likeCount, "youtube"),
          comments: num(st.commentCount, "youtube"),
          shares: null,
        };
      }
    }
    return out;
  },

  async threads({ transport, tokens }, posts) {
    const record = needConnected(tokens, "threads", THREADS_INSIGHTS_SCOPE);
    const out = {};
    for (const p of posts) {
      const m = insightValues(
        await graph(
          transport,
          "threads insights",
          `${THREADS_GRAPH}/${p.postId}/insights?metric=views,likes,replies,reposts,quotes,shares`,
          record.accessToken,
          THREADS_INSIGHTS_SCOPE,
        ),
      );
      out[p.postId] = {
        views: num(m.views, "threads"),
        likes: num(m.likes, "threads"),
        comments: num(m.replies, "threads"),
        shares: sum(
          num(m.reposts, "threads"),
          num(m.quotes, "threads"),
          num(m.shares, "threads"),
        ),
      };
    }
    return out;
  },

  async instagram({ transport, env }, posts) {
    needSecrets(env, META_SECRETS);
    const token = env.META_SYSTEM_USER_TOKEN;
    const out = {};
    for (const p of posts) {
      try {
        const m = insightValues(
          await graph(
            transport,
            "instagram insights",
            `${FB_GRAPH}/${p.postId}/insights?metric=views,likes,comments,shares`,
            token,
            "instagram_manage_insights",
          ),
        );
        out[p.postId] = {
          views: num(m.views, "instagram"),
          likes: num(m.likes, "instagram"),
          comments: num(m.comments, "instagram"),
          shares: num(m.shares, "instagram"),
        };
      } catch (err) {
        if (!(err instanceof NeedsPermission)) throw err;
        // The media node's counts need only instagram_basic.
        const json = await read(transport, "instagram media", {
          url: `${FB_GRAPH}/${p.postId}?fields=like_count,comments_count`,
          headers: bearer(token),
        });
        out[p.postId] = {
          views: null,
          likes: num(json?.like_count, "instagram"),
          comments: num(json?.comments_count, "instagram"),
          shares: null,
          note: `views, shares: ${err.message}`,
        };
      }
    }
    return out;
  },

  async "instagram-story"({ transport, env }, posts) {
    needSecrets(env, META_SECRETS);
    const out = {};
    for (const p of posts) {
      const m = insightValues(
        await graph(
          transport,
          "instagram story insights",
          `${FB_GRAPH}/${p.postId}/insights?metric=views,replies,shares`,
          env.META_SYSTEM_USER_TOKEN,
          "instagram_manage_insights",
        ),
      );
      out[p.postId] = {
        views: num(m.views, "instagram story"),
        likes: null,
        comments: num(m.replies, "instagram story"),
        shares: num(m.shares, "instagram story"),
      };
    }
    return out;
  },

  async facebook({ transport, env }, posts) {
    needSecrets(env, META_SECRETS);
    const meta = await discoverMeta({
      transport,
      token: env.META_SYSTEM_USER_TOKEN,
    });
    const out = {};
    for (const p of posts) {
      try {
        const m = insightValues(
          await graph(
            transport,
            "facebook reel insights",
            `${FB_GRAPH}/${p.postId}/video_insights?metric=blue_reels_play_count,post_video_likes_by_reaction_type,post_video_social_actions`,
            meta.pageToken,
            "read_insights",
          ),
        );
        const social = m.post_video_social_actions;
        out[p.postId] = {
          views: num(m.blue_reels_play_count, "facebook"),
          likes: total(m.post_video_likes_by_reaction_type, "facebook"),
          comments: keyed(social, "comment", "facebook"),
          shares: keyed(social, "share", "facebook"),
        };
      } catch (err) {
        if (!(err instanceof NeedsPermission)) throw err;
        // The video node's likes and comments: pages_read_engagement.
        const json = await read(transport, "facebook video", {
          url: `${FB_GRAPH}/${p.postId}?fields=likes.summary(true).limit(0),comments.summary(true).limit(0)`,
          headers: bearer(meta.pageToken),
        });
        out[p.postId] = {
          views: null,
          likes: num(json?.likes?.summary?.total_count, "facebook"),
          comments: num(json?.comments?.summary?.total_count, "facebook"),
          shares: null,
          note: `views, shares: ${err.message}`,
        };
      }
    }
    return out;
  },

  async tiktok() {
    throw new NoCount(TIKTOK_NO_STATS);
  },
};

/**
 * The posts of `platform` that are still read: posted less than
 * STATS_WINDOW_MS ago (a Story: a day), with a post id.
 * @param {Post[]} posts
 */
export const postsToRead = (posts, platform, nowMs) => {
  const window =
    platform === "instagram-story" ? STORY_WINDOW_MS : STATS_WINDOW_MS;
  return posts.filter(
    (p) =>
      p.platform === platform &&
      typeof p.postId === "string" &&
      p.postId &&
      nowMs - Date.parse(p.utc) < window,
  );
};

/**
 * The platforms whose last read in `reads` is too old: X after 24 h (after
 * a failed X read, 6 h: it returned no post, so nothing was billed), any
 * other after 6 h.
 * @param {Record<string, { at: string, error: string | null }> | null | undefined} reads
 */
export const statsDue = (reads, nowMs) =>
  STATS_PLATFORMS.filter((platform) => {
    const last = reads?.[platform];
    const at = Date.parse(last?.at ?? "");
    if (!Number.isFinite(at)) return true;
    const maxAge =
      platform === "x" && !last.error ? X_STATS_MAX_AGE_MS : STATS_MAX_AGE_MS;
    return nowMs - at >= maxAge;
  });

/**
 * Read the posts of each platform in `platforms`, one platform after the
 * other. A platform with no post to read is not asked (no X bill).
 * @param {object} ctx {transport, env, tokens, keepRefreshToken, now?}
 * @param {Post[]} posts the live post log's rows
 * @param {string[]} platforms
 * @returns {Promise<{ reads: Record<string, { at: string, error: string | null, posts: number }>,
 *   numbers: Record<string, Numbers & { at: string, note?: string }> }>}
 *   numbers is keyed "<platform> <postId>"
 */
export const readPostStats = async (ctx, posts, platforms) => {
  const now = ctx.now ?? (() => new Date());
  const reads = {};
  const numbers = {};
  for (const platform of platforms) {
    const list = postsToRead(posts, platform, now().getTime());
    const at = now().toISOString();
    if (!list.length && platform !== "tiktok") {
      reads[platform] = { at, error: null, posts: 0 };
      continue;
    }
    try {
      const got = await READERS[platform](ctx, list);
      for (const [postId, n] of Object.entries(got)) {
        numbers[`${platform} ${postId}`] = { ...n, at };
      }
      reads[platform] = { at, error: null, posts: Object.keys(got).length };
    } catch (err) {
      reads[platform] = { at, error: reasonOf(err), posts: 0 };
    }
  }
  return { reads, numbers };
};
