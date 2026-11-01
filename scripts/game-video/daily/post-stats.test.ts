/**
 * The per-post stats (post-stats.mjs): each platform's read from fixture
 * replies (no live call), the four numbers and "-" for one a platform does
 * not give, "needs reconnect" with a fallback where a permission is
 * missing, safe reasons, which posts are due (at 1 h, 24 h, 7 d, then
 * weekly to 4 weeks; a free platform also every 6 h for 14 days; a Story
 * for 1 day), and one paid X request for all posts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINTS,
  graphReason,
  keepNumbers,
  mergeReads,
  refreshDue,
  META_INSIGHTS,
  META_INSIGHTS_SECRET,
  metaTokenCheck,
  STATS_PLATFORMS,
  TIKTOK_NO_STATS,
  postsDue,
  readPostStats,
} from "./post-stats.mjs";
import { META_ACCOUNTS_URL } from "./meta.mjs";
import { openTokenStore } from "./token-store.mjs";
import { THREADS_SCOPES } from "./connect.mjs";
import { GOOGLE_TOKEN_URL } from "./post-youtube.mjs";

interface Req {
  method: string;
  url: string;
  headers?: Record<string, string>;
}
interface Reply {
  status: number;
  json?: unknown;
}

const NOW = Date.parse("2026-10-31T18:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (h: number) => new Date(NOW - h * HOUR).toISOString();
/** The posts of each platform, as postsDue gives them. */
const dueOf = (
  posts: { platform: string; postId: string; utc: string }[],
  platforms: string[],
) =>
  Object.fromEntries(
    platforms.map((pl) => [pl, posts.filter((p) => p.platform === pl)]),
  );

const ENV = {
  X_API_KEY: "x-key",
  X_API_SECRET: "SECRET-X-KEY",
  META_SYSTEM_USER_TOKEN: "SECRET-SU",
  YOUTUBE_CLIENT_ID: "yt-client",
  YOUTUBE_CLIENT_SECRET: "SECRET-YT-CLIENT",
};
const CONNECTED = { connectedAt: ago(100), connectedBy: "Nil" };
const RECORDS = {
  x: {
    ...CONNECTED,
    scopes: [],
    account: { id: "1", name: "@wallgameio" },
    accessToken: "1-SECRET-XAT",
    accessTokenSecret: "SECRET-XATS",
  },
  threads: {
    ...CONNECTED,
    scopes: THREADS_SCOPES,
    account: { id: "TH1", name: "wallgame.io" },
    accessToken: "SECRET-THREADS",
  },
  youtube: {
    ...CONNECTED,
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
    account: { id: null, name: null },
    refreshToken: "SECRET-YT-RT",
  },
};
const SECRETS = [
  "SECRET-X-KEY",
  "SECRET-SU",
  "SECRET-INSIGHTS",
  "SECRET-STORED",
  "SECRET-PAGE",
  "SECRET-YT-CLIENT",
  "1-SECRET-XAT",
  "SECRET-XATS",
  "SECRET-THREADS",
  "SECRET-YT-RT",
  "SECRET-YT-AT",
];

const BSKY = "at://did:plc:wg/app.bsky.feed.post/3abc";
/** The live post log's rows, as logRow writes them. */
const POSTS = [
  { platform: "x", postId: "X1", utc: ago(2) },
  { platform: "x", postId: "X2", utc: ago(30) },
  { platform: "bluesky", postId: BSKY, utc: ago(2) },
  { platform: "youtube", postId: "YT1", utc: ago(2) },
  { platform: "threads", postId: "TH-P1", utc: ago(2) },
  { platform: "instagram", postId: "IG-R1", utc: ago(2) },
  { platform: "instagram-story", postId: "IG-S1", utc: ago(2) },
  { platform: "facebook", postId: "FB-V1", utc: ago(2) },
  { platform: "tiktok", postId: "v_inbox_file~v2.1", utc: ago(2) },
];

const insights = (values: Record<string, unknown>) => ({
  data: Object.entries(values).map(([name, value]) => ({
    name,
    period: "lifetime",
    values: [{ value }],
  })),
});

/** Every platform answers with its numbers. */
const answers = (req: Req): Reply => {
  const u = req.url;
  if (u === META_ACCOUNTS_URL) {
    return {
      status: 200,
      json: {
        data: [{ id: "P1", name: "Wall Game", access_token: "SECRET-PAGE" }],
      },
    };
  }
  if (u.startsWith("https://api.x.com/2/tweets?ids=")) {
    return {
      status: 200,
      json: {
        data: [
          {
            id: "X1",
            public_metrics: {
              impression_count: 500,
              like_count: 7,
              reply_count: 2,
              retweet_count: 3,
              quote_count: 1,
              bookmark_count: 5,
            },
          },
          {
            id: "X2",
            public_metrics: { impression_count: 90, like_count: 1 },
          },
        ],
      },
    };
  }
  if (u.startsWith("https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts")) {
    return {
      status: 200,
      json: {
        posts: [
          {
            uri: BSKY,
            likeCount: 4,
            replyCount: 1,
            repostCount: 2,
            quoteCount: 1,
            bookmarkCount: 3,
          },
        ],
      },
    };
  }
  if (u === GOOGLE_TOKEN_URL) {
    return { status: 200, json: { access_token: "SECRET-YT-AT" } };
  }
  if (u.startsWith("https://www.googleapis.com/youtube/v3/videos")) {
    return {
      status: 200,
      json: {
        items: [
          {
            id: "YT1",
            statistics: {
              viewCount: "1200",
              likeCount: "30",
              commentCount: "4",
            },
          },
        ],
      },
    };
  }
  if (u.includes("/TH-P1/insights")) {
    return {
      status: 200,
      json: insights({
        views: 300,
        likes: 9,
        replies: 2,
        reposts: 1,
        quotes: 1,
        shares: 3,
      }),
    };
  }
  // Saves and reach come in their own request.
  if (u.includes("/IG-R1/insights?metric=saved,reach")) {
    return { status: 200, json: insights({ saved: 7, reach: 650 }) };
  }
  if (u.includes("/IG-R1/insights")) {
    return {
      status: 200,
      json: insights({ views: 800, likes: 40, comments: 5, shares: 6 }),
    };
  }
  if (u.includes("/IG-S1/insights?metric=reach")) {
    return { status: 200, json: insights({ reach: 100 }) };
  }
  if (u.includes("/IG-S1/insights")) {
    return {
      status: 200,
      json: insights({ views: 120, replies: 1, shares: 2 }),
    };
  }
  if (u.includes("/FB-V1/video_insights")) {
    return {
      status: 200,
      json: insights({
        blue_reels_play_count: 650,
        post_video_likes_by_reaction_type: {
          REACTION_LIKE: 10,
          REACTION_LOVE: 2,
        },
        post_video_social_actions: { COMMENT: 3, SHARE: 4 },
      }),
    };
  }
  return { status: 404, json: null };
};

/** Meta answers a permission error (code 10) to every insights read. */
const noInsights = (req: Req): Reply => {
  if (req.url.includes("insights")) {
    return {
      status: 400,
      json: {
        error: {
          code: 10,
          message:
            "(#10) Application does not have permission for this action SECRET-SU",
        },
      },
    };
  }
  if (req.url.endsWith("/IG-R1?fields=like_count,comments_count")) {
    return { status: 200, json: { like_count: 41, comments_count: 6 } };
  }
  if (req.url.includes("/FB-V1?fields=likes.summary")) {
    return {
      status: 200,
      json: {
        likes: { summary: { total_count: 11 } },
        comments: { summary: { total_count: 3 } },
      },
    };
  }
  return answers(req);
};

const run = async (
  answer: (req: Req) => Reply = answers,
  platforms: string[] = STATS_PLATFORMS,
  posts = POSTS,
  env: Record<string, string> = ENV,
  records: Record<string, unknown> = RECORDS,
) => {
  const sent: Req[] = [];
  const tokens = openTokenStore(
    join(mkdtempSync(join(tmpdir(), "post-stats-test-")), "tokens"),
  );
  for (const [p, r] of Object.entries(records)) {
    tokens.write(p, r as Parameters<typeof tokens.write>[1]);
  }
  const out = await readPostStats(
    {
      transport: {
        mode: "live",
        request: (req: Req) => {
          sent.push(req);
          return Promise.resolve(answer(req));
        },
      },
      env,
      tokens,
      keepRefreshToken: () => undefined,
      now: () => new Date(NOW),
    },
    dueOf(posts, platforms),
  );
  return { ...out, sent };
};

describe("readPostStats", () => {
  test("each platform's numbers; '-' (null) where a platform gives none", async () => {
    const { numbers, reads } = await run();
    const at = new Date(NOW).toISOString();
    // Each post's seven numbers; null where the platform gives none.
    const n = (
      views: number | null,
      likes: number | null,
      comments: number | null,
      shares: number | null,
      saves: number | null = null,
      reach: number | null = null,
      quotes: number | null = null,
    ) => ({ views, likes, comments, shares, saves, reach, quotes, at });
    expect(numbers).toEqual({
      // Shares leave quotes out: X 3 retweets, 1 quote, 5 bookmarks.
      "x X1": n(500, 7, 2, 3, 5, null, 1),
      "x X2": n(90, 1, null, null),
      [`bluesky ${BSKY}`]: n(null, 4, 1, 2, 3, null, 1),
      "youtube YT1": n(1200, 30, 4, null),
      // Threads: 1 repost + 3 shares; 1 quote.
      "threads TH-P1": n(300, 9, 2, 4, null, null, 1),
      "instagram IG-R1": n(800, 40, 5, 6, 7, 650),
      "instagram-story IG-S1": n(120, null, 1, 2, null, 100),
      "facebook FB-V1": n(650, 12, 3, 4),
    });
    expect(reads.x).toEqual({ at, error: null, posts: 2 });
    expect(reads.tiktok).toEqual({ at, error: TIKTOK_NO_STATS, posts: 0 });
    expect(TIKTOK_NO_STATS).toStartWith("needs reconnect");
  });

  test("X: one paid request for all its posts, signed, never a token in a reason", async () => {
    const { sent, reads } = await run(answers, ["x"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(
      "https://api.x.com/2/tweets?ids=X1,X2&tweet.fields=public_metrics",
    );
    expect(sent[0].headers?.authorization).toStartWith("OAuth ");
    expect(reads.x.error).toBeNull();
    const depleted = await run(() => ({ status: 402, json: null }), ["x"]);
    expect(depleted.reads.x.error).toBe("X credits depleted");
    expect(depleted.numbers).toEqual({});
  });

  test("Meta: the stats read uses META_INSIGHTS_TOKEN when it is set, else the posting token", async () => {
    const meta = ["instagram", "instagram-story", "facebook"];
    const bearerOf = (r: Req) => r.headers?.authorization;
    // Set: every token-bearing Meta request is the insights token's, or
    // the Page token found with it; never the posting token.
    const withIt = await run(answers, meta, POSTS, {
      ...ENV,
      [META_INSIGHTS_SECRET]: "SECRET-INSIGHTS",
    });
    const got: unknown[][] = withIt.sent.map((r) => [
      r.url.split("?")[0],
      bearerOf(r),
    ]);
    expect(got).toEqual([
      [expect.stringContaining("/IG-R1/insights"), "Bearer SECRET-INSIGHTS"],
      [expect.stringContaining("/IG-R1/insights"), "Bearer SECRET-INSIGHTS"],
      [expect.stringContaining("/IG-S1/insights"), "Bearer SECRET-INSIGHTS"],
      [expect.stringContaining("/IG-S1/insights"), "Bearer SECRET-INSIGHTS"],
      [META_ACCOUNTS_URL.split("?")[0], "Bearer SECRET-INSIGHTS"],
      [expect.stringContaining("/FB-V1/video_insights"), "Bearer SECRET-PAGE"],
    ]);
    expect(withIt.numbers["instagram IG-R1"].views).toBe(800);
    // Not set: the posting token, as before.
    const without = await run(answers, meta);
    expect(without.sent.map(bearerOf)).toEqual([
      "Bearer SECRET-SU",
      "Bearer SECRET-SU",
      "Bearer SECRET-SU",
      "Bearer SECRET-SU",
      "Bearer SECRET-SU",
      "Bearer SECRET-PAGE",
    ]);
    // A token saved on /daily/connect/meta-insights comes first.
    const stored = await run(
      answers,
      ["instagram"],
      POSTS,
      { ...ENV, [META_INSIGHTS_SECRET]: "SECRET-INSIGHTS" },
      {
        ...RECORDS,
        [META_INSIGHTS]: {
          connectedAt: ago(1),
          connectedBy: "browser",
          scopes: [],
          account: { id: null, name: null },
          accessToken: "SECRET-STORED",
        },
      },
    );
    expect(stored.sent.map(bearerOf)).toEqual([
      "Bearer SECRET-STORED",
      "Bearer SECRET-STORED",
    ]);
    // Only the insights token: the read needs no posting token.
    const only = await run(answers, ["instagram"], POSTS, {
      [META_INSIGHTS_SECRET]: "SECRET-INSIGHTS",
    });
    expect(only.reads.instagram.error).toBeNull();
  });

  test("Instagram: a refused saves or reach costs only its own columns, never the views", async () => {
    // Graph refuses one metric (code 100): only the second request fails.
    const refused = (req: Req): Reply =>
      /insights\?metric=(saved,reach|reach)$/.test(req.url)
        ? {
            status: 400,
            json: { error: { code: 100, message: "SECRET-SU bad metric" } },
          }
        : answers(req);
    const { numbers, reads } = await run(refused, [
      "instagram",
      "instagram-story",
    ]);
    expect(numbers["instagram IG-R1"]).toMatchObject({
      views: 800,
      likes: 40,
      saves: null,
      reach: null,
      partial: "saves, reach: instagram saves and reach: HTTP 400 code 100",
    });
    expect(numbers["instagram IG-R1"].note).toBeUndefined();
    expect(numbers["instagram-story IG-S1"]).toMatchObject({
      views: 120,
      reach: null,
      partial: "reach: instagram story reach: HTTP 400 code 100",
    });
    expect(reads.instagram.error).toBeNull();
    // A full read has no partial.
    const full = await run(answers, ["instagram"]);
    expect(full.numbers["instagram IG-R1"].partial).toBeUndefined();
  });

  test("a Graph refusal keeps HTTP status, code and subcode; 'needs reconnect' only for a permission error", async () => {
    const reply = (code: number, message: string, sub?: number) => ({
      status: 400,
      json: {
        error: { code, message: `${message} SECRET-SU`, error_subcode: sub },
      },
    });
    const step = "instagram story insights";
    const perm = "instagram_manage_insights";
    expect(
      graphReason(
        step,
        perm,
        reply(
          10,
          "(#10) Not enough viewers for the media to show insights",
          2108006,
        ),
      ),
    ).toBe("instagram story insights: HTTP 400 code 10 subcode 2108006");
    expect(
      graphReason(
        step,
        perm,
        reply(10, "(#10) Application does not have permission for this action"),
      ),
    ).toBe("needs reconnect (instagram_manage_insights; HTTP 400 code 10)");
    expect(graphReason(step, perm, reply(200, "(#200) Requires x"))).toBe(
      "needs reconnect (instagram_manage_insights; HTTP 400 code 200)",
    );
    expect(graphReason(step, perm, { status: 500, json: null })).toBe(
      "instagram story insights: HTTP 500",
    );
    // A Story with too few viewers: its own row says why, the read goes on,
    // and Instagram posts fall back to the node's counts with the reason.
    const fewViewers = (req: Req): Reply =>
      req.url.includes("/insights")
        ? reply(
            10,
            "(#10) Not enough viewers for the media to show insights",
            2108006,
          )
        : req.url.endsWith("/IG-R1?fields=like_count,comments_count")
          ? { status: 200, json: { like_count: 3, comments_count: 1 } }
          : answers(req);
    const { numbers, reads } = await run(fewViewers, [
      "instagram",
      "instagram-story",
    ]);
    expect(reads["instagram-story"].error).toBeNull();
    expect(numbers["instagram-story IG-S1"].note).toBe(
      "instagram story insights: HTTP 400 code 10 subcode 2108006",
    );
    expect(numbers["instagram IG-R1"]).toMatchObject({
      likes: 3,
      note: "views, shares, saves, reach: instagram insights: HTTP 400 code 10 subcode 2108006",
    });
    expect(JSON.stringify(numbers)).not.toContain("SECRET-SU");
    expect(JSON.stringify(numbers)).not.toContain("viewers");
  });

  test("Facebook: a new reel with no reactions or actions yet shows 0, not '-'", async () => {
    const empty = (req: Req): Reply =>
      req.url.includes("/FB-V1/video_insights")
        ? {
            status: 200,
            json: {
              data: [
                { name: "blue_reels_play_count", values: [{ value: 4 }] },
                {
                  name: "post_video_likes_by_reaction_type",
                  values: [{ value: {} }],
                },
              ],
            },
          }
        : answers(req);
    const { numbers } = await run(empty, ["facebook"]);
    expect(numbers["facebook FB-V1"]).toMatchObject({
      views: 4,
      likes: 0,
      comments: 0,
      shares: 0,
    });
  });

  test("a platform with no post to read is not asked (no X bill)", async () => {
    const { sent, reads } = await run(answers, ["x", "bluesky"], []);
    expect(sent).toEqual([]);
    expect(reads.x.posts).toBe(0);
    expect(reads.bluesky.error).toBeNull();
  });

  test("Meta without the insights permission: likes and comments from the node, views 'needs reconnect'", async () => {
    const { numbers, reads, sent } = await run(noInsights, [
      "instagram",
      "instagram-story",
      "facebook",
    ]);
    const at = new Date(NOW).toISOString();
    const none = { views: null, shares: null, saves: null, reach: null };
    expect(numbers["instagram IG-R1"]).toEqual({
      ...none,
      likes: 41,
      comments: 6,
      quotes: null,
      note: "views, shares, saves, reach: needs reconnect (instagram_manage_insights; HTTP 400 code 10)",
      at,
    });
    expect(numbers["facebook FB-V1"]).toEqual({
      ...none,
      likes: 11,
      comments: 3,
      quotes: null,
      note: "views, shares: needs reconnect (read_insights; HTTP 400 code 10)",
      at,
    });
    // A Story has no other source: the post shows the reason.
    expect(numbers["instagram-story IG-S1"]).toMatchObject({
      views: null,
      note: "needs reconnect (instagram_manage_insights; HTTP 400 code 10)",
    });
    expect(reads["instagram-story"].error).toBeNull();
    // No reply body and no token reaches a reason or a note.
    const shown = JSON.stringify({ numbers, reads });
    for (const s of SECRETS) expect(shown).not.toContain(s);
    expect(shown).not.toContain("does not have permission");
    // The tokens went only in headers.
    for (const r of sent) {
      for (const s of SECRETS) expect(r.url).not.toContain(s);
    }
  });

  test("a failure names the step and the status only", async () => {
    const { reads } = await run(
      (req) =>
        req.url.includes("insights")
          ? { status: 500, json: { error: { code: 1, message: "SECRET-SU" } } }
          : answers(req),
      ["threads", "instagram"],
    );
    expect(reads.threads.error).toBe("threads insights: HTTP 500 code 1");
    expect(reads.instagram.error).toBe("instagram insights: HTTP 500 code 1");
  });

  test("Threads without its insights scope: needs reconnect, nothing asked", async () => {
    const tokens = openTokenStore(
      join(mkdtempSync(join(tmpdir(), "post-stats-test-")), "tokens"),
    );
    tokens.write("threads", {
      ...RECORDS.threads,
      scopes: ["threads_basic", "threads_content_publish"],
    } as Parameters<typeof tokens.write>[1]);
    const sent: Req[] = [];
    const { reads } = await readPostStats(
      {
        transport: {
          mode: "live",
          request: (req: Req) => (
            sent.push(req),
            Promise.resolve(answers(req))
          ),
        },
        env: ENV,
        tokens,
        keepRefreshToken: () => undefined,
        now: () => new Date(NOW),
      },
      dueOf(POSTS, ["threads"]),
    );
    expect(reads.threads.error).toBe("needs reconnect");
    expect(sent).toEqual([]);
  });
});

describe("which posts and when", () => {
  interface P {
    platform: string;
    postId: string;
    utc: string;
  }
  const due = (posts: P[], cache: Parameters<typeof postsDue>[1]) =>
    Object.fromEntries(
      Object.entries(postsDue(posts, cache, NOW)).map(([pl, ps]) => [
        pl,
        ps.map((p) => p.postId),
      ]),
    );
  /** Every platform read `h` hours ago, with no error. */
  const readAll = (h: number) =>
    Object.fromEntries(
      STATS_PLATFORMS.map((p) => [
        p,
        { at: ago(h), error: null, refreshedAt: ago(h) },
      ]),
    );

  test("the checkpoints: 1 h, 24 h, 7 d, then weekly to 4 weeks", () => {
    expect(CHECKPOINTS.map((c) => c.label)).toEqual([
      "1 h",
      "24 h",
      "7 d",
      "14 d",
      "21 d",
      "28 d",
    ]);
  });

  test("an X post is read once per checkpoint, never between", () => {
    const x = (postId: string, h: number) => ({
      platform: "x",
      postId,
      utc: ago(h),
    });
    const posts = [
      x("young", 0.5),
      x("1h", 1.5),
      x("1h-read", 3),
      x("24h", 25),
      x("7d", 7 * 24 + 2),
      x("28d", 28 * 24 + 2),
      x("late", 8 * 24 + 2),
      x("old", 30 * 24),
    ];
    const numbers = {
      // Read at 1.2 h: the 1 h checkpoint is done.
      "x 1h-read": { at: ago(3 - 1.2) },
      // Read at 6 d: the 7 d checkpoint is not.
      "x 7d": { at: ago(26) },
      // Read at 7 d: nothing new until 14 d.
      "x late": { at: ago(26) },
    };
    expect(due(posts, { reads: readAll(0.5), numbers })).toEqual({
      x: ["1h", "24h", "7d", "28d"],
    });
  });

  test("a free platform also every 6 h for 14 days; TikTok for its reason", () => {
    const posts = [
      { platform: "bluesky", postId: "new", utc: ago(3) },
      { platform: "bluesky", postId: "13d", utc: ago(13 * 24) },
      { platform: "bluesky", postId: "20d", utc: ago(20 * 24) },
      { platform: "x", postId: "X", utc: ago(3) },
      { platform: "tiktok", postId: "", utc: ago(3) },
    ];
    const numbers = {
      "bluesky new": { at: ago(1) },
      "x X": { at: ago(1) },
    };
    expect(due(posts, { reads: readAll(5.9), numbers })).toEqual({});
    const stale = { ...readAll(5.9), bluesky: { at: ago(6), error: null } };
    expect(due(posts, { reads: stale, numbers })).toEqual({
      bluesky: ["new", "13d"],
    });
    const tiktok = { ...readAll(5.9), tiktok: { at: ago(6), error: null } };
    expect(due(posts, { reads: tiktok, numbers })).toEqual({ tiktok: [] });
  });

  test("a failed read waits: X 6 h, a free platform 1 h; a Story is read for 1 day only", () => {
    const posts = [
      { platform: "x", postId: "X", utc: ago(2) },
      { platform: "instagram-story", postId: "s-new", utc: ago(23) },
      { platform: "instagram-story", postId: "s-old", utc: ago(25) },
    ];
    const reads = {
      ...readAll(0.5),
      x: { at: ago(5.9), error: "x tweets: HTTP 503" },
      "instagram-story": { at: ago(6), error: null },
    };
    expect(due(posts, { reads, numbers: {} })).toEqual({
      "instagram-story": ["s-new"],
    });
    reads.x = { at: ago(6), error: "x tweets: HTTP 503" };
    expect(due(posts, { reads, numbers: {} }).x).toEqual(["X"]);
    // A free platform: 1 h after its failed read (its refresh is old).
    const b = [{ platform: "bluesky", postId: "B", utc: ago(30) }];
    const failed = (h: number) => ({
      ...readAll(0.5),
      bluesky: {
        at: ago(h),
        error: "the read did not finish (TypeError)",
        refreshedAt: ago(12),
      },
    });
    expect(due(b, { reads: failed(0.9), numbers: {} })).toEqual({});
    expect(due(b, { reads: failed(1), numbers: {} })).toEqual({
      bluesky: ["B"],
    });
  });

  test("a checkpoint read of one post does not delay the refresh of the others", () => {
    const posts = [
      { platform: "facebook", postId: "new", utc: ago(1.5) },
      { platform: "facebook", postId: "old", utc: ago(30) },
    ];
    // The checkpoint read of "new" was 0.5 h ago; the refresh 6 h ago.
    const reads = {
      ...readAll(0.5),
      facebook: { at: ago(0.5), error: null, refreshedAt: ago(6) },
    };
    const numbers = { "facebook new": { at: ago(0.5) } };
    expect(refreshDue(reads, NOW)).toEqual(["facebook"]);
    expect(due(posts, { reads, numbers })).toEqual({
      facebook: ["new", "old"],
    });
    // After the run: a refresh moves refreshedAt; a checkpoint-only read,
    // or a failed refresh, keeps the old one.
    const at = ago(0);
    const fresh = {
      facebook: { at, error: null, posts: 2 },
      x: { at, error: null, posts: 1 },
      bluesky: { at, error: "bluesky posts: HTTP 502", posts: 0 },
    };
    const cached = {
      x: { at: ago(30), error: null },
      bluesky: { at: ago(7), error: null, refreshedAt: ago(7) },
      facebook: reads.facebook,
    };
    const merged = mergeReads(cached, fresh, ["facebook", "bluesky"]);
    expect(merged.facebook.refreshedAt).toBe(at);
    expect(merged.x.refreshedAt).toBeUndefined();
    expect(merged.bluesky).toMatchObject({
      error: "bluesky posts: HTTP 502",
      refreshedAt: ago(7),
    });
  });
});

describe("metaTokenCheck", () => {
  test("Graph /me with the token: 'works', or a status and code, never the token", async () => {
    const sent: Req[] = [];
    const transport = (reply: Reply) => ({
      request: (req: Req) => (sent.push(req), Promise.resolve(reply)),
    });
    const good = await metaTokenCheck(
      transport({ status: 200, json: { id: "1" } }),
      "SECRET-STORED",
    );
    expect(good).toEqual({
      ok: true,
      text: "Saved. Test read (Graph /me): works.",
    });
    expect(sent[0].url).toEndWith("/me?fields=id");
    expect(sent[0].headers?.authorization).toBe("Bearer SECRET-STORED");
    const bad = await metaTokenCheck(
      transport({
        status: 400,
        json: { error: { code: 190, message: "SECRET-STORED is invalid" } },
      }),
      "SECRET-STORED",
    );
    expect(bad).toEqual({
      ok: false,
      text: "Saved, but the test read (Graph /me) failed: HTTP 400 code 190.",
    });
    const down = await metaTokenCheck(
      { request: () => Promise.reject(new TypeError("fetch failed")) },
      "SECRET-STORED",
    );
    expect(down.text).toBe(
      "Saved, but the test read (Graph /me) did not finish (TypeError).",
    );
  });
});

describe("keepNumbers (Wall Game Reviewer 1, M1)", () => {
  test("a refused read keeps a post's last numbers and shows the refusal; nothing goes to the history", () => {
    const good = {
      views: 40,
      likes: null,
      comments: 1,
      shares: 0,
      saves: null,
      reach: 30,
      quotes: null,
      at: ago(5),
    };
    const refused = {
      views: null,
      likes: null,
      comments: null,
      shares: null,
      saves: null,
      reach: null,
      quotes: null,
      note: "instagram story insights: HTTP 400 code 4",
      at: ago(0),
    };
    const fresh = {
      "instagram-story S": refused,
      "x X": { ...good, at: ago(0) },
    };
    const { kept, recorded } = keepNumbers(
      { "instagram-story S": good, "instagram-story T": good },
      fresh,
    );
    expect(kept["instagram-story S"]).toEqual({
      ...good,
      partial: "last read refused: instagram story insights: HTTP 400 code 4",
      refusedAt: ago(0),
    });
    expect(kept["instagram-story T"]).toEqual(good);
    expect(kept["x X"]).toMatchObject({ views: 40 });
    expect(Object.keys(recorded)).toEqual(["x X"]);
    // With no earlier numbers, the refused row is kept as it is (its note).
    const first = keepNumbers({}, { "instagram-story S": refused });
    expect(first.kept["instagram-story S"]).toEqual(refused);
    expect(first.recorded).toEqual({});
  });
});
