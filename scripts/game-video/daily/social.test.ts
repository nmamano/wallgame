/**
 * The Social tab (social.mjs): the follower history keeps one row per
 * platform per UTC day and never rewrites a row; the view shows the app's
 * live mode over the file's status, the dry-run reasons, secret names, and
 * links only to https addresses. The per-post stats: one history row per
 * post per day, each video with its platforms and totals (most recent
 * first), and each platform's totals with their change over 1 and 7 days.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFollowerHistory,
  createPostCheckpoints,
  createPostStatsHistory,
  postStatsView,
  ptMinute,
  socialView,
  videoName,
} from "./social.mjs";

const DAY = Date.parse("2026-10-30T09:00:00Z");

describe("the follower history", () => {
  test("one row per platform per UTC day; the moved rows stay as they were", () => {
    const path = join(mkdtempSync(join(tmpdir(), "social-")), "f.jsonl");
    // As moved from wallgame-social: rows with their own key order.
    const moved =
      '{"day":"2026-10-28","platform":"bluesky","followers":0,"at":"2026-10-28T04:31:25.097Z"}\n';
    writeFileSync(path, moved);
    const h = createFollowerHistory(path);
    const at = "2026-10-30T08:59:00.000Z";
    h.record(
      {
        bluesky: { followers: 3, at, error: null },
        x: { followers: null, at, error: "no key" },
      },
      DAY,
    );
    // Later the same day: no second row, even with a new count.
    h.record({ bluesky: { followers: 4, at, error: null } }, DAY + 3600e3);
    // No counts (a post ran): nothing.
    h.record(null, DAY);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith(moved)).toBe(true);
    expect(h.read()).toEqual([
      {
        day: "2026-10-28",
        platform: "bluesky",
        followers: 0,
        at: "2026-10-28T04:31:25.097Z",
      },
      { day: "2026-10-30", platform: "bluesky", followers: 3, at },
    ]);
    // The next UTC day: a count cached from the day before writes no row
    // (X is cached 24 h); a count read that day writes its own row.
    h.record({ bluesky: { followers: 4, at, error: null } }, DAY + 864e5);
    expect(h.read()).toHaveLength(2);
    const next = "2026-10-31T09:00:00.000Z";
    h.record({ bluesky: { followers: 5, at: next, error: null } }, DAY + 864e5);
    expect(h.read().map((r) => [r.day, r.followers])).toEqual([
      ["2026-10-28", 0],
      ["2026-10-30", 3],
      ["2026-10-31", 5],
    ]);
  });
});

const DATA = {
  updated: "2026-10-30",
  updatedBy: "Wall Game Growth",
  flow: "the flow",
  root: { name: "root", why: "why.", credentials: "Nil", twoFactor: "app" },
  roles: [{ role: "Posts", who: "the game-video app" }],
  later: ["Pinterest"],
  log: [{ at: "2026-10-30", what: "a change" }],
  platforms: [
    {
      id: "bluesky",
      name: "Bluesky",
      status: "ready",
      handle: "@wallgame.io",
      url: "https://bsky.app/profile/wallgame.io",
      keys: ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"],
      owners: { setup: "Growth" },
      next: [{ who: "Nil", what: "add the key", nil: true }],
      asks: ["a1"],
      profile: { bio: "ok", banner: "to do" },
    },
    {
      id: "x",
      name: "X",
      status: "setup",
      handle: "@wallgame",
      url: "javascript:alert(1)",
      keys: [],
    },
    { id: "mastodon", name: "Mastodon", status: "skipped" },
  ],
};

describe("socialView", () => {
  test("the app's mode over the file's status, reasons, secret names, https links only", () => {
    const v = socialView({
      data: DATA,
      modes: { bluesky: "live", x: "dry-run" },
      reasons: { x: ["X_API_KEY is not set"] },
      live: [
        {
          platform: "bluesky",
          utc: "2026-10-30T03:14:00.000Z",
          url: "https://bsky.app/post/1",
        },
      ],
      dry: [],
      followers: {
        bluesky: { followers: 7, at: "", error: null },
        x: { followers: null, at: "", error: "no key" },
      },
      history: [
        { day: "2026-10-23", platform: "bluesky", followers: 1 },
        { day: "2026-10-29", platform: "bluesky", followers: 5 },
      ],
      nowMs: DAY,
    });
    // Skipped platforms do not count.
    expect(v.stats[0]).toEqual({
      value: "1 / 2",
      label: "platforms posting live",
    });
    const [bluesky, x] = v.cards;
    expect(bluesky.status.label).toBe("Live");
    expect(x.status.label).toBe("Setup in progress");
    const row = (c: typeof bluesky, k: string) =>
      c.rows.find((r) => r.k === k)!;
    expect(row(x, "Poster mode now").v).toBe(
      "dry-run (nothing is posted: X_API_KEY is not set)",
    );
    expect(row(bluesky, "Keys (secret names on the game-video app)")).toEqual({
      k: "Keys (secret names on the game-video app)",
      v: "",
      codes: ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"],
    });
    expect(row(bluesky, "Account").href).toBe(
      "https://bsky.app/profile/wallgame.io",
    );
    expect(row(x, "Account").href).toBeNull();
    expect(row(bluesky, "Last post")).toMatchObject({
      v: "Oct 29, 8:14 PM PT",
      href: "https://bsky.app/post/1",
    });
    expect(bluesky.profile).toEqual([
      { k: "bio", v: "ok", tone: "ok" },
      { k: "banner", v: "to do", tone: "todo" },
    ]);
    expect(v.nilSteps).toEqual([
      { platform: "Bluesky", what: "add the key", asks: ["a1"] },
    ]);
    // 7 now; 5 a day ago; 1 a week ago.
    expect(v.followers!.rows[0]).toEqual({
      platform: "Bluesky",
      now: 7,
      day: "+2",
      week: "+6",
      note: "",
    });
    expect(v.followers!.rows[1]).toMatchObject({ now: "-", note: "no key" });
    // All accounts: X has no count, so only Bluesky adds (7, and +6 since
    // 2026-10-23).
    expect(v.followers!.total).toEqual({ now: 7, week: 6 });
    expect(v.followers!.note).toStartWith("Counts cached 1 h (X: 24 h). ");
    expect(v.followers!.note).toContain("since 2026-10-23");
  });
});

describe("the per-post stats", () => {
  const NOW = Date.parse("2026-10-31T18:00:00Z");
  const at = (day: string) => `${day}T10:00:00.000Z`;
  /** The numbers Growth asked for later, none given here. */
  const MORE = { saves: null, reach: null, quotes: null };
  const n = (
    day: string,
    views: number | null,
    likes: number | null,
    extra: object = {},
  ) => ({
    views,
    likes,
    comments: null,
    shares: null,
    ...MORE,
    at: at(day),
    ...extra,
  });

  test("the history keeps the first numbers of each post each UTC day", () => {
    const path = join(mkdtempSync(join(tmpdir(), "post-stats-")), "h.jsonl");
    const h = createPostStatsHistory(path);
    h.record({ "x X1": n("2026-10-30", 10, 1) }, Date.parse(at("2026-10-30")));
    h.record({ "x X1": n("2026-10-30", 20, 2) }, Date.parse(at("2026-10-30")));
    // Numbers read on an earlier day write no row today.
    h.record({ "x X1": n("2026-10-30", 20, 2) }, Date.parse(at("2026-10-31")));
    h.record({ "x X1": n("2026-10-31", 30, 3) }, Date.parse(at("2026-10-31")));
    expect(h.read().map((r) => [r.day, r.key, r.views, r.likes])).toEqual([
      ["2026-10-30", "x X1", 10, 1],
      ["2026-10-31", "x X1", 30, 3],
    ]);
  });

  test("videos most recent first, a row per platform with its link, totals and changes", () => {
    const posts = [
      {
        itemId: "v-1",
        day: "2026-10-24",
        utc: at("2026-10-24"),
        platform: "x",
        postId: "X1",
        url: "https://x.com/i/web/status/X1",
      },
      {
        itemId: "v-2",
        day: "2026-10-31",
        utc: at("2026-10-31"),
        platform: "x",
        postId: "X2",
        url: "https://x.com/i/web/status/X2",
      },
      {
        itemId: "v-2",
        day: "2026-10-31",
        utc: at("2026-10-31"),
        platform: "bluesky",
        postId: "at://b",
        url: "javascript:alert(1)",
      },
      {
        itemId: "v-2",
        day: "2026-10-31",
        utc: at("2026-10-31"),
        platform: "tiktok",
        postId: "v_inbox_file~1",
        url: null,
      },
    ];
    const v = postStatsView({
      posts,
      numbers: {
        "x X1": n("2026-10-31", 100, 5, { saves: 2, quotes: 1 }),
        "x X2": n("2026-10-31", 40, 2, { saves: 1 }),
        "bluesky at://b": n("2026-10-31", null, 3),
      },
      reads: {
        x: { at: at("2026-10-31"), error: null, posts: 2 },
        tiktok: { at: at("2026-10-31"), error: "needs reconnect", posts: 0 },
      },
      // X2's views at 1 h; Bluesky gives likes only.
      checkpoints: [
        ["x X2", 10, 1],
        ["bluesky at://b", null, 1],
      ].map(([key, views, likes]) => ({
        key: String(key),
        checkpoint: "1 h",
        views: views as number | null,
        likes: likes as number,
        comments: null,
        shares: null,
        ...MORE,
        at: at("2026-10-31"),
      })),
      history: [
        // X1 had 60 views a week ago and 90 yesterday.
        {
          day: "2026-10-24",
          key: "x X1",
          views: 60,
          likes: 4,
          comments: null,
          shares: null,
          ...MORE,
          at: at("2026-10-24"),
        },
        {
          day: "2026-10-30",
          key: "x X1",
          views: 90,
          likes: 5,
          comments: null,
          shares: null,
          ...MORE,
          at: at("2026-10-30"),
        },
      ],
      names: { x: "X", bluesky: "Bluesky", tiktok: "TikTok" },
      nowMs: NOW,
      platforms: ["x", "bluesky", "tiktok"],
      note: "Read every 6 h.",
    });
    expect(v.videos.map((x) => x.itemId)).toEqual(["v-2", "v-1"]);
    // No caption in these rows: the name is the id.
    expect(v.videos.map((x) => x.name)).toEqual(["v-2", "v-1"]);
    expect(v.videos.map((x) => x.posted)).toEqual([
      "Oct 31, 3:00 AM PT",
      "Oct 24, 3:00 AM PT",
    ]);
    // The headline: the 7-day change of views and likes over all
    // platforms, and the videos posted in 7 days (v-1 is 7.3 days old).
    expect(v.headline).toEqual({ views: 80, likes: 6, videos: 1 });
    expect(v.readAt).toBe("Oct 31, 3:00 AM PT");
    // Posts from before item ids: one video per video file, named by game.
    const early = postStatsView({
      posts: ["x", "bluesky"].map((platform) => ({
        day: "2026-10-28",
        utc: at("2026-10-28"),
        platform,
        postId: platform,
        url: null,
        gameId: "VoSWbMDd",
        videoSha256: "1f8d",
      })),
      numbers: {},
      reads: {},
      history: [],
      checkpoints: [],
      names: {},
      nowMs: NOW,
      platforms: ["x", "bluesky"],
      note: "",
    });
    expect(early.videos.map((x) => [x.itemId, x.rows.length])).toEqual([
      ["game VoSWbMDd", 2],
    ]);
    const [latest] = v.videos;
    expect(latest.rows).toEqual([
      {
        platform: "X",
        href: "https://x.com/i/web/status/X2",
        views: 40,
        likes: 2,
        comments: null,
        shares: null,
        ...MORE,
        saves: 1,
        at: at("2026-10-31"),
        ages: "10 / - / -",
        note: "",
      },
      // No link but https. Bluesky gives no views: "-", no note.
      {
        platform: "Bluesky",
        href: null,
        views: null,
        likes: 3,
        comments: null,
        shares: null,
        ...MORE,
        at: at("2026-10-31"),
        ages: "1 / - / - likes",
        note: "",
      },
      // No numbers: the platform's read error is in its platform row.
      {
        platform: "TikTok",
        href: null,
        views: null,
        likes: null,
        comments: null,
        shares: null,
        ...MORE,
        at: null,
        ages: "- / - / -",
        note: "no numbers: see Posts by platform",
      },
    ]);
    expect(latest.total).toEqual({
      views: 40,
      likes: 5,
      comments: null,
      shares: null,
      ...MORE,
      saves: 1,
    });
    const x = v.platforms[0];
    // X2 was posted today: all of it is growth. X1: 100 - 90 a day, 100 -
    // 60 a week.
    expect(x).toMatchObject({ platform: "X", posts: 2, views: 140, likes: 7 });
    // Saves, reach and quotes add up as the others; none given: null.
    expect([x.saves, x.reach, x.quotes]).toEqual([3, null, 1]);
    expect(x.day).toBe("+50 views, +2 likes");
    expect(x.week).toBe("+80 views, +3 likes");
    expect(x.note).toBe("read Oct 31, 3:00 AM PT");
    // Bluesky has no history row and was posted today: all growth.
    expect(v.platforms[1]).toMatchObject({
      day: "+3 likes",
      note: "not read yet",
    });
    expect(v.platforms[2]).toMatchObject({
      posts: 1,
      views: null,
      day: "-",
      note: "needs reconnect",
    });
    expect(v.total).toEqual({
      views: 140,
      likes: 10,
      comments: null,
      shares: null,
      ...MORE,
      saves: 3,
      quotes: 1,
    });
    expect(v.note).toBe(
      'Read every 6 h. History: one row a day (UTC) per post since 2026-10-24. "-": the platform gives no such number.',
    );
  });
});

describe("a video's name", () => {
  test("the post text's first line, without the sounds credit or hashtags", () => {
    expect(
      videoName(
        "the race flipped in one move... #wallgame #gaming #Shorts\n\nmore",
      ),
    ).toBe("the race flipped in one move...");
    expect(
      videoName(
        "bro trapped himself with his own walls 😭💔 #wallgame · sounds: JDSherbert",
      ),
    ).toBe("bro trapped himself with his own walls 😭💔");
    expect(videoName("#wallgame")).toBeNull();
    expect(videoName(null)).toBeNull();
    expect(videoName("x".repeat(100))).toHaveLength(80);
    // An emoji at the cut stays whole.
    expect(videoName("x".repeat(78) + "😭😭😭")).toBe("x".repeat(78) + "😭…");
  });
});

describe("a post read without the insights permission", () => {
  test("its row says no views, its platform shows why, and views totals leave it out", () => {
    const at = "2026-10-31T10:00:00.000Z";
    const note = "views, shares: needs reconnect (read_insights)";
    const v = postStatsView({
      posts: ["F1", "F2"].map((postId) => ({
        itemId: postId,
        day: "2026-10-31",
        utc: at,
        platform: "facebook",
        postId,
        url: null,
      })),
      numbers: {
        "facebook F1": { views: 500, likes: 9, comments: 1, shares: 2, at },
        "facebook F2": {
          views: null,
          likes: 11,
          comments: 3,
          shares: null,
          note,
          at,
        },
      },
      reads: { facebook: { at, error: null, posts: 2 } },
      history: [],
      checkpoints: [],
      names: { facebook: "Facebook Page" },
      nowMs: Date.parse("2026-10-31T18:00:00.000Z"),
      platforms: ["facebook"],
      note: "",
    });
    const f2 = v.videos.find((x) => x.itemId === "F2")!;
    expect(f2.rows[0].platform).toBe("Facebook Page (no views)");
    expect(f2.total.views).toBeNull();
    expect(v.platforms[0]).toMatchObject({ views: 500, likes: 20, note });
    expect(v.headline.views).toBe(500);
  });
});

describe("ptMinute", () => {
  test("a time shows in PT, daylight saving time or not; a date stays", () => {
    expect(ptMinute("2026-10-31T16:00:00.000Z")).toBe("Oct 31, 9:00 AM PT");
    expect(ptMinute("2026-11-02T17:05:00Z")).toBe("Nov 2, 9:05 AM PT");
    expect(ptMinute("2026-10-30")).toBe("2026-10-30");
  });
});

describe("the checkpoint numbers", () => {
  test("one row per post per checkpoint: the first read after it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "checkpoints-")), "c.jsonl");
    const cp = createPostCheckpoints(path);
    const posts = [
      { platform: "x", postId: "X1", utc: "2026-10-30T09:00:00.000Z" },
    ];
    const read = (at: string, views: number) => ({
      "x X1": { views, likes: 1, comments: 0, shares: 0, at },
      // A post not in the log has no age: no row.
      "x gone": { views: 5, likes: 0, comments: 0, shares: 0, at },
    });
    // At 0.5 h: no checkpoint yet.
    cp.record(read("2026-10-30T09:30:00.000Z", 3), posts);
    // At 1.5 h, then 3 h: only the first counts as "1 h".
    cp.record(read("2026-10-30T10:30:00.000Z", 12), posts);
    cp.record(read("2026-10-30T12:00:00.000Z", 20), posts);
    // At 24.5 h: "24 h".
    cp.record(read("2026-10-31T09:30:00.000Z", 140), posts);
    expect(
      cp.read().map((r) => [r.key, r.checkpoint, r.views, r.at.slice(0, 13)]),
    ).toEqual([
      ["x X1", "1 h", 12, "2026-10-30T10"],
      ["x X1", "24 h", 140, "2026-10-31T09"],
    ]);
  });
});
