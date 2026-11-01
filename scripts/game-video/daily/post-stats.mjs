/**
 * The numbers of each posted video on each platform, for the stats tracker
 * on the app's "/" (Nil, 2026-10-31: "this app can be restructured into
 * social media stats tracker"; Wall Game PM's task). READ-ONLY: nothing
 * here posts or reconnects. Each post gets up to seven numbers, null where
 * the platform does not give one: views, likes, comments, shares, saves,
 * reach, quotes (Wall Game Growth asked for the last three). A reason
 * names a step, an HTTP status or a code, never a token or a reply body
 * (followers.mjs rule).
 *
 * Read 2026-10-31 (the platform docs, and one public Bluesky read):
 * - X: GET /2/tweets?ids=<up to 100>&tweet.fields=public_metrics ->
 *   impression_count, like_count, reply_count, retweet_count, quote_count,
 *   bookmark_count.
 *   "Posts: Read | $0.005 per resource", charged per resource returned, so
 *   X posts are read only at their checkpoints, one request for the due posts.
 * - Bluesky: app.bsky.feed.getPosts on the public AppView, no auth, up to
 *   25 uris -> likeCount, replyCount, repostCount, quoteCount,
 *   bookmarkCount (no views).
 * - YouTube: videos.list part=statistics, up to 50 ids, youtube.readonly ->
 *   viewCount, likeCount, commentCount (no shares).
 * - Threads: GET /<media-id>/insights?metric=views,likes,replies,reposts,
 *   quotes,shares, threads_manage_insights -> data[].values[0].value.
 * - Instagram Reel: GET /<media-id>/insights?metric=views,likes,comments,
 *   shares, then metric=saved,reach in a second request (a refused metric
 *   fails its whole request), instagram_manage_insights ->
 *   data[].values[0].value. Without
 *   that permission, like_count and comments_count of the media node
 *   (instagram_basic), and views show "needs reconnect".
 * - Instagram Story: the same edge, metric=views,replies,shares, then
 *   metric=reach apart; a Story's
 *   numbers can be read only while it is up (24 h), so it is read for a
 *   day and keeps its last numbers.
 * - Facebook Reel: GET /<video-id>/video_insights?metric=
 *   blue_reels_play_count,post_video_likes_by_reaction_type,
 *   post_video_social_actions with the Page token (read_insights). Without
 *   that permission, the likes and comments summaries of the video node,
 *   and views show "needs reconnect". No saves or reach: no Reel metric for
 *   them could be checked without read_insights.
 * - TikTok: a post is an inbox draft (post-tiktok.mjs), so the app has no
 *   video id, and video.query needs the video.list scope, which the
 *   connection lacks: no numbers, "needs reconnect".
 *
 * Shares are the platform's re-shares, quotes not included: X retweets,
 * Bluesky reposts, Threads reposts and shares. Saves are X and Bluesky
 * bookmarks and Instagram saves.
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

/**
 * The ages at which each post is read (Wall Game Growth, 2026-10-31): 1 h,
 * 24 h, 7 days, then weekly to 4 weeks. Posts compare at the same ages,
 * and X, paid per post read, reads each post 6 times.
 */
export const CHECKPOINTS = [
  { label: "1 h", ms: HOUR_MS },
  { label: "24 h", ms: DAY_MS },
  { label: "7 d", ms: 7 * DAY_MS },
  { label: "14 d", ms: 14 * DAY_MS },
  { label: "21 d", ms: 21 * DAY_MS },
  { label: "28 d", ms: 28 * DAY_MS },
];
/**
 * A free platform (all but X) is also read every 6 h while its post is
 * younger than 14 days, so the page stays fresh. A failed X read waits
 * this time before the next (X is paid).
 */
export const STATS_MAX_AGE_MS = 6 * HOUR_MS;
/** A failed read of a free platform waits only this (Growth, 2026-11-01). */
export const FREE_RETRY_MS = HOUR_MS;
export const FRESH_WINDOW_MS = 14 * DAY_MS;
/**
 * A checkpoint read missed by more than a day (the app was down) is not
 * made up: the post keeps its last numbers.
 */
const LATE_MS = DAY_MS;
/** A Story's numbers can be read only while it is up. */
const STORY_WINDOW_MS = DAY_MS;

export const BLUESKY_POSTS_URL =
  "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";
export const YOUTUBE_VIDEOS_STATS_URL =
  "https://www.googleapis.com/youtube/v3/videos?part=statistics";

export const TIKTOK_NO_STATS = `${NEEDS_RECONNECT}: a TikTok post is an inbox draft with no video id, and video stats need the video.list scope`;

/**
 * @typedef {{ views: number | null, likes: number | null,
 *   comments: number | null, shares: number | null, saves: number | null,
 *   reach: number | null, quotes: number | null }} Numbers
 */

/**
 * A post's numbers: the ones given, null for the rest.
 * @param {Partial<Numbers>} given
 * @returns {Numbers}
 */
const numbers = (given) => ({
  views: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  reach: null,
  quotes: null,
  ...given,
});
/** @typedef {{ platform: string, postId: string, utc: string }} Post */

/**
 * The Meta token of the stats read (Instagram, its Story, Facebook), a
 * read-only token with the insights permissions (Wall Game PM,
 * 2026-10-31), first found of: the one saved on
 * /daily/connect/meta-insights (token store, "meta-insights"), the app
 * secret META_INSIGHTS_TOKEN, the posting token as before. Only this read
 * uses it: posting never does.
 */
export const META_INSIGHTS = "meta-insights";
export const META_INSIGHTS_SECRET = "META_INSIGHTS_TOKEN";
const metaStatsToken = (env, tokens) => {
  let saved;
  try {
    saved = tokens?.read(META_INSIGHTS)?.accessToken;
  } catch (err) {
    // Its message names the file, never the token.
    throw new NoCount(String(err?.message ?? err));
  }
  if (typeof saved === "string" && saved) return saved;
  if (env[META_INSIGHTS_SECRET]) return env[META_INSIGHTS_SECRET];
  needSecrets(env, META_SECRETS);
  return env.META_SYSTEM_USER_TOKEN;
};

/**
 * The test read of a saved Meta insights token: Graph /me. The result is
 * a safe text (a status and a code), never the token or the reply body.
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export const metaTokenCheck = async (transport, token) => {
  try {
    const reply = await transport.request({
      method: "GET",
      url: `${FB_GRAPH}/me?fields=id`,
      headers: bearer(token),
    });
    if (ok(reply))
      return { ok: true, text: "Saved. Test read (Graph /me): works." };
    const code = reply.json?.error?.code;
    return {
      ok: false,
      text: `Saved, but the test read (Graph /me) failed: HTTP ${reply.status}${typeof code === "number" ? ` code ${code}` : ""}.`,
    };
  } catch (err) {
    return {
      ok: false,
      text: `Saved, but the test read (Graph /me) did not finish (${err?.name ?? "error"}).`,
    };
  }
};

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
 * A Graph read: the reply's JSON, or a throw. A reply Graph refused with an
 * error code (HTTP 4xx) is GraphRefused, so a reader can fall back to the
 * numbers it may read; its reason keeps the HTTP status, code and subcode
 * (Wall Game PM, 2026-11-01), never Graph's message, which can echo values.
 * Only a real permission error says "needs reconnect": codes 200-299, or
 * code 10 whose message names a permission. Code 10 also means other things,
 * e.g. "Not enough viewers for the media to show insights".
 */
class GraphRefused extends NoCount {}
export const graphReason = (step, permission, reply) => {
  const e = reply.json?.error;
  const code = typeof e?.code === "number" ? e.code : null;
  const sub = typeof e?.error_subcode === "number" ? e.error_subcode : null;
  const where = `HTTP ${reply.status}${code === null ? "" : ` code ${code}`}${sub === null ? "" : ` subcode ${sub}`}`;
  const permissionError =
    (code !== null && code >= 200 && code < 300) ||
    (code === 10 && /permission/i.test(String(e?.message ?? "")));
  return permissionError
    ? `${NEEDS_RECONNECT} (${permission}; ${where})`
    : `${step}: ${where}`;
};
const graph = async (transport, step, url, token, permission) => {
  const reply = await transport.request({
    method: "GET",
    url,
    headers: bearer(token),
  });
  if (ok(reply)) return reply.json;
  const reason = graphReason(step, permission, reply);
  if (reply.status >= 400 && reply.status < 500 && reply.json?.error) {
    throw new GraphRefused(reason);
  }
  throw new NoCount(reason);
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
 * Insights a post may not give (saved, reach), asked in their own request:
 * Graph fails a whole request on one metric it refuses, so a refused one
 * costs only its own columns, never the views (VR1 and Wall Game PM,
 * review 122). A refusal is kept as `partial`, a safe reason.
 */
const optionalInsights = async (transport, step, url, token, names) => {
  try {
    const m = insightValues(
      await graph(transport, step, url, token, "instagram_manage_insights"),
    );
    return { m, partial: null };
  } catch (err) {
    return { m: {}, partial: `${names}: ${reasonOf(err)}` };
  }
};

/**
 * One reader per platform: (ctx, posts) -> {postId: Numbers & {note?, partial?}}, or
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
        out[t.id] = numbers({
          views: num(m.impression_count, "x"),
          likes: num(m.like_count, "x"),
          comments: num(m.reply_count, "x"),
          shares: num(m.retweet_count, "x"),
          saves: num(m.bookmark_count, "x"),
          quotes: num(m.quote_count, "x"),
        });
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
        out[p.uri] = numbers({
          likes: num(p.likeCount, "bluesky"),
          comments: num(p.replyCount, "bluesky"),
          shares: num(p.repostCount, "bluesky"),
          saves: num(p.bookmarkCount, "bluesky"),
          quotes: num(p.quoteCount, "bluesky"),
        });
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
        out[v.id] = numbers({
          views: num(st.viewCount, "youtube"),
          likes: num(st.likeCount, "youtube"),
          comments: num(st.commentCount, "youtube"),
        });
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
      out[p.postId] = numbers({
        views: num(m.views, "threads"),
        likes: num(m.likes, "threads"),
        comments: num(m.replies, "threads"),
        shares: sum(num(m.reposts, "threads"), num(m.shares, "threads")),
        quotes: num(m.quotes, "threads"),
      });
    }
    return out;
  },

  async instagram({ transport, env, tokens }, posts) {
    const token = metaStatsToken(env, tokens);
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
        const more = await optionalInsights(
          transport,
          "instagram saves and reach",
          `${FB_GRAPH}/${p.postId}/insights?metric=saved,reach`,
          token,
          "saves, reach",
        );
        out[p.postId] = {
          ...numbers({
            views: num(m.views, "instagram"),
            likes: num(m.likes, "instagram"),
            comments: num(m.comments, "instagram"),
            shares: num(m.shares, "instagram"),
            saves: num(more.m.saved, "instagram"),
            reach: num(more.m.reach, "instagram"),
          }),
          ...(more.partial && { partial: more.partial }),
        };
      } catch (err) {
        if (!(err instanceof GraphRefused)) throw err;
        // The media node's counts need only instagram_basic.
        const json = await read(transport, "instagram media", {
          url: `${FB_GRAPH}/${p.postId}?fields=like_count,comments_count`,
          headers: bearer(token),
        });
        out[p.postId] = {
          ...numbers({
            likes: num(json?.like_count, "instagram"),
            comments: num(json?.comments_count, "instagram"),
          }),
          note: `views, shares, saves, reach: ${err.message}`,
        };
      }
    }
    return out;
  },

  async "instagram-story"({ transport, env, tokens }, posts) {
    const token = metaStatsToken(env, tokens);
    const out = {};
    for (const p of posts) {
      let m;
      try {
        m = insightValues(
          await graph(
            transport,
            "instagram story insights",
            `${FB_GRAPH}/${p.postId}/insights?metric=views,replies,shares`,
            token,
            "instagram_manage_insights",
          ),
        );
      } catch (err) {
        if (!(err instanceof GraphRefused)) throw err;
        // A Story has no other source: the post shows the reason.
        out[p.postId] = { ...numbers({}), note: err.message };
        continue;
      }
      const more = await optionalInsights(
        transport,
        "instagram story reach",
        `${FB_GRAPH}/${p.postId}/insights?metric=reach`,
        token,
        "reach",
      );
      out[p.postId] = {
        ...numbers({
          views: num(m.views, "instagram story"),
          comments: num(m.replies, "instagram story"),
          shares: num(m.shares, "instagram story"),
          reach: num(more.m.reach, "instagram story"),
        }),
        ...(more.partial && { partial: more.partial }),
      };
    }
    return out;
  },

  async facebook({ transport, env, tokens }, posts) {
    // The Page token comes from the stats token, so it has its permissions.
    const meta = await discoverMeta({
      transport,
      token: metaStatsToken(env, tokens),
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
        // The reply came, so a reaction or action it does not list is none
        // yet (a new reel): 0, not "-" (Wall Game Growth, 2026-11-01).
        out[p.postId] = numbers({
          views: num(m.blue_reels_play_count, "facebook"),
          likes: total(m.post_video_likes_by_reaction_type, "facebook") ?? 0,
          comments: keyed(social, "comment", "facebook") ?? 0,
          shares: keyed(social, "share", "facebook") ?? 0,
        });
      } catch (err) {
        if (!(err instanceof GraphRefused)) throw err;
        // The video node's likes and comments: pages_read_engagement.
        const json = await read(transport, "facebook video", {
          url: `${FB_GRAPH}/${p.postId}?fields=likes.summary(true).limit(0),comments.summary(true).limit(0)`,
          headers: bearer(meta.pageToken),
        });
        out[p.postId] = {
          ...numbers({
            likes: num(json?.likes?.summary?.total_count, "facebook"),
            comments: num(json?.comments?.summary?.total_count, "facebook"),
          }),
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
 * The last checkpoint a post of this age has passed, or null.
 * @param {number} ageMs
 */
export const checkpointAt = (ageMs) =>
  CHECKPOINTS.filter((c) => c.ms <= ageMs).at(-1) ?? null;

/**
 * @typedef {{ at: string, error: string | null, posts?: number,
 *   refreshedAt?: string }} PlatformRead
 * `at`: the last read of the platform (of any post); `refreshedAt`: the last
 * successful 6 h refresh of all its young posts. A checkpoint read of one
 * post moves `at` only, so it does not delay the others' refresh.
 */

/**
 * The free platforms whose 6 h refresh is due: no successful refresh in
 * 6 h, and no failed read in the last hour (FREE_RETRY_MS).
 * @param {Record<string, PlatformRead> | undefined} reads
 */
export const refreshDue = (reads, nowMs) =>
  STATS_PLATFORMS.filter((platform) => {
    if (platform === "x") return false;
    const last = reads?.[platform];
    if (last?.error && nowMs - Date.parse(last.at) < FREE_RETRY_MS) {
      return false;
    }
    const refreshed = Date.parse(last?.refreshedAt ?? "");
    return !Number.isFinite(refreshed) || nowMs - refreshed >= STATS_MAX_AGE_MS;
  });

/**
 * The posts to read now, by platform, from the cached reads and numbers:
 * - a post that passed a checkpoint (by less than a day) and was not read
 *   since;
 * - on a free platform whose refresh is due (refreshDue), each post younger
 *   than 14 days (and TikTok's status, which has no post to read).
 * A platform whose last read failed waits: X 6 h, a free platform 1 h. A
 * Story is read only while it is up. A post with no post id is never read.
 * @param {Post[]} posts the live post log's rows
 * @param {{ reads?: Record<string, PlatformRead>,
 *   numbers?: Record<string, { at: string }> }} cache
 * @returns {Record<string, Post[]>}
 */
export const postsDue = (posts, cache, nowMs) => {
  /** @type {Record<string, Post[]>} */
  const out = {};
  const refresh = refreshDue(cache.reads, nowMs);
  for (const platform of STATS_PLATFORMS) {
    const last = cache.reads?.[platform];
    const wait = platform === "x" ? STATS_MAX_AGE_MS : FREE_RETRY_MS;
    if (last?.error && nowMs - Date.parse(last.at) < wait) continue;
    const fresh = refresh.includes(platform);
    const list = posts.filter((p) => {
      if (p.platform !== platform || typeof p.postId !== "string") return false;
      if (!p.postId) return false;
      const age = nowMs - Date.parse(p.utc);
      if (!(age >= 0)) return false;
      if (platform === "instagram-story" && age >= STORY_WINDOW_MS) {
        return false;
      }
      if (fresh && age < FRESH_WINDOW_MS) return true;
      const c = checkpointAt(age);
      if (!c || age - c.ms >= LATE_MS) return false;
      const readMs = Date.parse(
        cache.numbers?.[`${platform} ${p.postId}`]?.at ?? "",
      );
      return !(readMs >= Date.parse(p.utc) + c.ms);
    });
    if (list.length || fresh) out[platform] = list;
  }
  return out;
};

/**
 * The reads to keep after a run: the fresh ones over the cached ones; a
 * platform whose refresh was due and read without error gets `refreshedAt`,
 * any other keeps its cached one.
 * @param {Record<string, PlatformRead>} cached
 * @param {Record<string, PlatformRead>} fresh
 * @param {string[]} refreshed the platforms refreshDue gave for this run
 * @returns {Record<string, PlatformRead>}
 */
export const mergeReads = (cached, fresh, refreshed) =>
  Object.fromEntries(
    Object.entries({ ...cached, ...fresh }).map(([platform, r]) => {
      const kept = cached[platform]?.refreshedAt;
      const refreshedAt =
        platform in fresh && refreshed.includes(platform) && !r.error
          ? r.at
          : kept;
      return [platform, refreshedAt ? { ...r, refreshedAt } : r];
    }),
  );

/** The numbers fields of a post, in one list. */
const METRIC_KEYS = [
  "views",
  "likes",
  "comments",
  "shares",
  "saves",
  "reach",
  "quotes",
];

/**
 * The numbers to keep after a run, and the ones to record in the history.
 * A post refused this time (a note and no number at all, e.g. a refused
 * Story) keeps its last numbers, with the refusal as `partial` and
 * `refusedAt`, so a refused last read of a Story does not lose its final
 * numbers (Wall Game Reviewer 1, M1). Only a fresh entry with a number goes
 * to the history and the checkpoints.
 * @param {Record<string, any>} cached
 * @param {Record<string, any>} fresh
 */
export const keepNumbers = (cached, fresh) => {
  const kept = { ...cached };
  /** @type {Record<string, any>} */
  const recorded = {};
  for (const [key, n] of Object.entries(fresh)) {
    const none = METRIC_KEYS.every((m) => n[m] === null || n[m] === undefined);
    const before = cached[key];
    const hadAny =
      before && METRIC_KEYS.some((m) => typeof before[m] === "number");
    if (none && n.note && hadAny) {
      // An old fallback row keeps its own `note` (views missing), which
      // the page shows before the partial.
      kept[key] = {
        ...before,
        partial: `last read refused: ${n.note}`,
        refusedAt: n.at,
      };
      continue;
    }
    kept[key] = n;
    if (!none) recorded[key] = n;
  }
  return { kept, recorded };
};

/**
 * Read the due posts (postsDue), one platform after the other. A platform
 * with no post to read is not asked (no X bill), but TikTok is: its read
 * gives the reason it has no numbers.
 * @param {object} ctx {transport, env, tokens, keepRefreshToken, now?}
 * @param {Record<string, Post[]>} due
 * @returns {Promise<{ reads: Record<string, { at: string, error: string | null, posts: number }>,
 *   numbers: Record<string, Numbers & { at: string, note?: string, partial?: string }> }>}
 *   numbers is keyed "<platform> <postId>"
 */
export const readPostStats = async (ctx, due) => {
  const now = ctx.now ?? (() => new Date());
  const reads = {};
  const numbers = {};
  for (const [platform, list] of Object.entries(due)) {
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
