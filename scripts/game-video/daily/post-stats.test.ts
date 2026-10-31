/**
 * The per-post stats (post-stats.mjs): each platform's read from fixture
 * replies (no live call), the four numbers and "-" for one a platform does
 * not give, "needs reconnect" with a fallback where a permission is
 * missing, safe reasons, which posts are read (14 days; a Story 1 day) and
 * when (X 24 h, others 6 h), and one paid X request for all posts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STATS_MAX_AGE_MS,
  STATS_PLATFORMS,
  TIKTOK_NO_STATS,
  X_STATS_MAX_AGE_MS,
  postsToRead,
  readPostStats,
  statsDue,
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
            quoteCount: 0,
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
  if (u.includes("/IG-R1/insights")) {
    return {
      status: 200,
      json: insights({ views: 800, likes: 40, comments: 5, shares: 6 }),
    };
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
      json: { error: { code: 10, message: "SECRET-SU is not allowed" } },
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
) => {
  const sent: Req[] = [];
  const tokens = openTokenStore(
    join(mkdtempSync(join(tmpdir(), "post-stats-test-")), "tokens"),
  );
  for (const [p, r] of Object.entries(RECORDS)) {
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
      env: ENV,
      tokens,
      keepRefreshToken: () => undefined,
      now: () => new Date(NOW),
    },
    posts,
    platforms,
  );
  return { ...out, sent };
};

describe("readPostStats", () => {
  test("each platform's numbers; '-' (null) where a platform gives none", async () => {
    const { numbers, reads } = await run();
    const at = new Date(NOW).toISOString();
    expect(numbers).toEqual({
      "x X1": { views: 500, likes: 7, comments: 2, shares: 4, at },
      "x X2": { views: 90, likes: 1, comments: null, shares: null, at },
      [`bluesky ${BSKY}`]: {
        views: null,
        likes: 4,
        comments: 1,
        shares: 2,
        at,
      },
      "youtube YT1": {
        views: 1200,
        likes: 30,
        comments: 4,
        shares: null,
        at,
      },
      "threads TH-P1": { views: 300, likes: 9, comments: 2, shares: 5, at },
      "instagram IG-R1": { views: 800, likes: 40, comments: 5, shares: 6, at },
      "instagram-story IG-S1": {
        views: 120,
        likes: null,
        comments: 1,
        shares: 2,
        at,
      },
      "facebook FB-V1": { views: 650, likes: 12, comments: 3, shares: 4, at },
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
    expect(numbers["instagram IG-R1"]).toEqual({
      views: null,
      likes: 41,
      comments: 6,
      shares: null,
      note: "views, shares: needs reconnect (instagram_manage_insights)",
      at,
    });
    expect(numbers["facebook FB-V1"]).toEqual({
      views: null,
      likes: 11,
      comments: 3,
      shares: null,
      note: "views, shares: needs reconnect (read_insights)",
      at,
    });
    // A Story has no other source.
    expect(reads["instagram-story"].error).toBe(
      "needs reconnect (instagram_manage_insights)",
    );
    // No reply body and no token reaches a reason or a note.
    const shown = JSON.stringify({ numbers, reads });
    for (const s of SECRETS) expect(shown).not.toContain(s);
    expect(shown).not.toContain("not allowed");
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
      POSTS,
      ["threads"],
    );
    expect(reads.threads.error).toBe("needs reconnect");
    expect(sent).toEqual([]);
  });
});

describe("which posts and when", () => {
  test("a post is read for 14 days, a Story for 1 day", () => {
    const posts = [
      { platform: "x", postId: "new", utc: ago(13 * 24) },
      { platform: "x", postId: "old", utc: ago(14 * 24) },
      { platform: "instagram-story", postId: "s-new", utc: ago(23) },
      { platform: "instagram-story", postId: "s-old", utc: ago(25) },
      { platform: "x", postId: "", utc: ago(1) },
    ];
    expect(postsToRead(posts, "x", NOW).map((p) => p.postId)).toEqual(["new"]);
    expect(
      postsToRead(posts, "instagram-story", NOW).map((p) => p.postId),
    ).toEqual(["s-new"]);
  });

  test("X is due after 24 h (after a failed read, 6 h); any other after 6 h", () => {
    const read = (h: number, error: string | null = null) => ({
      at: ago(h),
      error,
      posts: 1,
    });
    expect(statsDue(null, NOW)).toEqual(STATS_PLATFORMS);
    expect(X_STATS_MAX_AGE_MS).toBe(24 * HOUR);
    expect(STATS_MAX_AGE_MS).toBe(6 * HOUR);
    const reads = Object.fromEntries(
      STATS_PLATFORMS.map((p) => [p, read(5.9)]),
    );
    expect(statsDue(reads, NOW)).toEqual([]);
    expect(statsDue({ ...reads, x: read(23) }, NOW)).toEqual([]);
    expect(statsDue({ ...reads, x: read(24) }, NOW)).toEqual(["x"]);
    expect(
      statsDue({ ...reads, x: read(6, "x tweets: HTTP 503") }, NOW),
    ).toEqual(["x"]);
    expect(statsDue({ ...reads, youtube: read(6) }, NOW)).toEqual(["youtube"]);
  });
});
