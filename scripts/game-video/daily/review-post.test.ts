/**
 * post(itemId) (review-post.mjs) with a fake item store: the platforms live
 * at the slot are fixed on the item, the approval's two hashes gate the
 * post, a retry touches only the slot's failed platforms and never an
 * uncertain one without a check, and a stop mid-post leaves post-failed.
 */
import { describe, expect, test } from "bun:test";
import { PLATFORMS, StepRefused } from "./store.mjs";
import { copySha256 } from "./copy.mjs";
import { sha256 } from "./transport.mjs";
import { createItemPoster } from "./review-post.mjs";

const VIDEO = Buffer.from("the approved mp4");
const COPY = {
  x: "x line",
  youtubeTitle: "title",
  youtubeDescription: "description",
  tiktok: "tiktok line",
  instagram: "instagram line",
  facebook: "facebook line",
  bluesky: "bluesky line",
  threads: "threads line",
  version: "growth-copy-1",
};

interface Post {
  ok: boolean | null;
  pending?: boolean;
  uncertain?: boolean;
  mode?: string;
  at?: string;
  error?: string;
  url?: string;
}

interface Item {
  id: string;
  state: string;
  render: {
    video: { path: string; durationSeconds: number };
    music?: { track: string }[];
  };
  copy: { block: typeof COPY; sha256: string };
  approval: {
    videoSha256: string;
    copySha256: string;
    by: string;
    at: string;
  } | null;
  posts: Record<string, Post>;
  posting?: {
    slotAt: string;
    at: string;
    platforms: string[];
    notApplicable?: Record<string, string>;
  };
  events: string[];
}

/** One upload of youtubeRecentUploads, with the fields the retry reads. */
interface Upload {
  id: string;
  title: string | null;
  uploadStatus: string | null;
  processingStatus: string | null;
}

/** What postNext and retry return. */
interface Outcome {
  kind: string;
  itemId?: string;
  platforms: string[];
  notApplicable?: Record<string, string>;
  posts: Record<string, Post>;
  refused?: { itemId: string; error: string }[];
}

/** The message a promise is refused with, or null when it is not. */
const refusal = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};

const world = (live: string[]) => {
  const items = new Map<string, Item>();
  items.set("v-2026-10-28-1", {
    id: "v-2026-10-28-1",
    state: "approved",
    render: { video: { path: "/videos/1.mp4", durationSeconds: 30 } },
    copy: { block: { ...COPY }, sha256: copySha256(COPY) },
    approval: {
      videoSha256: sha256(VIDEO),
      copySha256: copySha256(COPY),
      by: "Nil",
      at: "2026-10-28T08:00:00Z",
    },
    posts: {},
    events: [],
  });
  let video: Buffer = VIDEO;
  // Why each platform is not live (routes.mjs modeReasons): every platform
  // not in `live` is "not connected" unless setReasons says more.
  const reasonsOf = (live: string[]) =>
    Object.fromEntries(
      PLATFORMS.map((p) => [p, live.includes(p) ? [] : ["not connected"]]),
    );
  let reasons: Record<string, string[]> = reasonsOf(live);
  const replies: Record<
    string,
    (beforeCommit: () => void) => Post | Promise<Post>
  > = {};
  let staleQueue: Item[] | null = null;
  const logged: string[] = [];
  const confirmedSeen: [string, boolean][] = [];
  // tiktok-drafts.mjs waiting: why no TikTok draft goes out now, or null;
  // an Error is a read that throws (a damaged file).
  let tiktokWhy: string | Error | null = null;
  let tiktokReads = 0;
  // post-youtube.mjs youtubeRecentUploads: the channel's last uploads; an
  // Error is a read that fails.
  let youtubeUploads: Upload[] | Error = [];
  let youtubeReads = 0;
  const store = {
    item: (id: string) => structuredClone(items.get(id)) ?? null,
    items: ({ states }: { states?: string[] } = {}) =>
      [...items.values()].filter((i) => !states || states.includes(i.state)),
    // As read before the post guard: an item may be withdrawn since.
    approvedQueue: () =>
      staleQueue ?? [...items.values()].filter((i) => i.state === "approved"),
    updateItem: (
      id: string,
      expect: string[],
      mutate: (i: Item) => void,
      what: string,
    ) => {
      const item = structuredClone(items.get(id)!);
      if (!expect.includes(item.state)) {
        throw new StepRefused(`${id} is ${item.state}`);
      }
      mutate(item);
      item.events.push(what);
      items.set(id, item);
      return structuredClone(item);
    },
  };
  const poster = createItemPoster({
    store,
    modeReasons: () => reasons,
    readVideo: () => video,
    postPlatform: (
      platform: string,
      ctx: { beforeCommit: () => void; confirmedNotPosted: boolean },
    ) => {
      confirmedSeen.push([platform, ctx.confirmedNotPosted]);
      const reply =
        replies[platform] ??
        ((commit: () => void): Post => {
          commit();
          return {
            ok: true,
            mode: "live",
            at: "t",
            url: `https://${platform}/1`,
          };
        });
      try {
        return Promise.resolve(reply(ctx.beforeCommit));
      } catch (err) {
        return Promise.reject(err as Error);
      }
    },
    logPost: (_item, platform) => logged.push(platform),
    tiktokWaiting: () => {
      tiktokReads++;
      return tiktokWhy instanceof Error
        ? Promise.reject(tiktokWhy)
        : Promise.resolve(tiktokWhy);
    },
    youtubeRecent: () => {
      youtubeReads++;
      return youtubeUploads instanceof Error
        ? Promise.reject(youtubeUploads)
        : Promise.resolve(youtubeUploads);
    },
  });
  const post = async (slot: { slotAt: string; firedBy?: string }) =>
    (await poster.postNext(slot)) as Outcome;
  const retry = async (id: string, opts?: { confirmNotPosted: string[] }) =>
    (await poster.retry(id, opts)) as Outcome;
  return {
    post,
    retry,
    recover: () => poster.recover() as unknown,
    get: (id = "v-2026-10-28-1") => items.get(id)!,
    add: (item: Item) => items.set(item.id, item),
    freezeQueue: () => (staleQueue = structuredClone([...items.values()])),
    replies,
    logged,
    confirmedSeen,
    setVideo: (b: Buffer) => (video = b),
    setTiktok: (why: string | Error | null) => (tiktokWhy = why),
    tiktokReads: () => tiktokReads,
    setYoutube: (v: Upload[] | Error) => (youtubeUploads = v),
    youtubeReads: () => youtubeReads,
    setLive: (p: string[]) => (reasons = reasonsOf(p)),
    setReasons: (r: Record<string, string[]>) =>
      (reasons = { ...reasons, ...r }),
  };
};

const SLOT = { slotAt: "2026-10-29T16:00:00.000Z" };

describe("post(itemId)", () => {
  test("posts to the platforms live at the slot and fixes that set", async () => {
    const w = world(["x", "bluesky"]);
    const r = await w.post(SLOT);
    expect(r).toMatchObject({
      kind: "posted",
      itemId: "v-2026-10-28-1",
      platforms: ["x", "bluesky"],
    });
    expect(w.get()).toMatchObject({
      state: "posted",
      posting: { slotAt: SLOT.slotAt, platforms: ["x", "bluesky"] },
    });
    expect(w.logged).toEqual(["x", "bluesky"]);
    // A timed slot names nobody.
    expect(w.get().posting).not.toHaveProperty("firedBy");
  });

  test("a slot by hand records who fired it on the item (the post log's firedBy)", async () => {
    const w = world(["x"]);
    await w.post({ ...SLOT, firedBy: "Wall Game Growth" });
    expect(w.get()).toMatchObject({
      state: "posted",
      posting: { slotAt: SLOT.slotAt, firedBy: "Wall Game Growth" },
    });
  });

  test("an item withdrawn since the queue was read is passed over", async () => {
    const w = world(["x"]);
    w.add({ ...structuredClone(w.get()), id: "v-2026-10-28-2" });
    w.freezeQueue();
    // Nil withdraws item 1 while the post waits for a follower read.
    Object.assign(w.get(), { state: "finished", approval: null });
    const r = await w.post(SLOT);
    expect(r).toMatchObject({ kind: "posted", itemId: "v-2026-10-28-2" });
    expect(w.get().state).toBe("finished");
  });

  test("no live platform: the item is not touched", async () => {
    const w = world([]);
    expect((await w.post(SLOT)) as unknown).toEqual({ kind: "no-live" });
    expect(w.get().state).toBe("approved");
  });

  test("a changed video or block is refused and leaves post-failed", async () => {
    const w = world(["x"]);
    w.setVideo(Buffer.from("a new render"));
    const r = await w.post(SLOT);
    expect(r as unknown).toEqual({
      kind: "refused",
      refused: [
        {
          itemId: "v-2026-10-28-1",
          error: `content changed since approval: the video sha256 is ${sha256(Buffer.from("a new render")).slice(0, 12)}, Nil approved ${sha256(VIDEO).slice(0, 12)}`,
        },
      ],
    });
    expect(w.get().state).toBe("post-failed");
    expect(w.logged).toEqual([]);

    const w2 = world(["x"]);
    w2.get().copy.block.x = "an edited line";
    expect((await w2.post(SLOT)).refused?.[0]?.error).toBe(
      `content changed since approval: the copy block sha256 is ${copySha256({ ...COPY, x: "an edited line" }).slice(0, 12)}, Nil approved ${copySha256(COPY).slice(0, 12)}`,
    );
  });

  test("an item that fails its checks is passed over: the next one posts", async () => {
    const w = world(["x"]);
    w.add({ ...structuredClone(w.get()), id: "v-2026-10-28-2" });
    w.get().copy.block.x = "an edited line";
    const r = await w.post(SLOT);
    expect(r).toMatchObject({
      kind: "posted",
      itemId: "v-2026-10-28-2",
      refused: [{ itemId: "v-2026-10-28-1" }],
    });
    expect(w.get().state).toBe("post-failed");
  });

  test("music whose license is blocked since approval: passed over like a changed video", async () => {
    const w = world(["x"]);
    w.add({ ...structuredClone(w.get()), id: "v-2026-10-28-2" });
    // A slug that music-tracks.mjs does not clear (unknown = blocked).
    w.get().render.music = [{ track: "no-such-track" }];
    const r = await w.post(SLOT);
    expect(r).toMatchObject({
      kind: "posted",
      itemId: "v-2026-10-28-2",
      refused: [
        {
          itemId: "v-2026-10-28-1",
          error:
            "music license blocked since approval: no-such-track has the license unknown",
        },
      ],
    });
    expect(w.get().state).toBe("post-failed");
    expect(w.confirmedSeen.map(([p]) => p)).toEqual(["x"]);
  });

  test("a platform that left live since the slot: no dry run counts as posted", async () => {
    // Retry: refused before any request.
    const w = world(["x", "bluesky"]);
    w.replies.x = () => ({
      ok: false,
      uncertain: false,
      mode: "live",
      at: "t",
      error: "x: HTTP 401",
    });
    await w.post(SLOT);
    w.setLive(["bluesky"]);
    delete w.replies.x;
    expect(await refusal(w.retry("v-2026-10-28-1"))).toContain(
      "x (not connected) is not live now: retry when it is live (/daily/connect)",
    );
    // A pause is named as a pause, not as a missing Connect (VR1 on
    // 27eac3cc).
    w.setReasons({ x: ["paused until 2099-01-01T00:00:00Z: a test"] });
    expect(await refusal(w.retry("v-2026-10-28-1"))).toContain(
      "x (paused until 2099-01-01T00:00:00Z: a test) is not live now: retry when it is live (/daily/connect)",
    );
    expect(w.get().state).toBe("post-failed");
    // A mode change between livePlatforms() and postPlatform: a dry-run
    // result is a clear failure, not a post.
    const w2 = world(["x"]);
    w2.replies.x = () => ({ ok: true, mode: "dry-run", at: "t" });
    const r = await w2.post(SLOT);
    expect(r.kind).toBe("post-failed");
    expect(r.posts.x).toMatchObject({
      ok: false,
      uncertain: false,
      error: "posted as a dry run: the platform is not live",
    });
    expect(w2.logged).toEqual([]);
  });

  test("a retry posts only the slot's failed platforms, never a newer live one", async () => {
    const w = world(["x", "bluesky"]);
    w.replies.x = () => ({
      ok: false,
      uncertain: false,
      mode: "live",
      at: "t",
      error: "x: HTTP 402",
    });
    expect((await w.post(SLOT)).kind).toBe("post-failed");
    w.setLive(["x", "bluesky", "threads"]);
    delete w.replies.x;
    const r = await w.retry("v-2026-10-28-1");
    expect(r.kind).toBe("posted");
    expect(r.platforms).toEqual(["x", "bluesky"]);
    // bluesky posted once (at the slot), x once (at the retry); no threads.
    expect(w.logged).toEqual(["bluesky", "x"]);
  });

  test("the Instagram Story is its own result: its failure never fails the Reel, and it is tried when the Reel fails", async () => {
    const failed = (error: string) => () => ({
      ok: false,
      uncertain: false,
      mode: "live",
      at: "t",
      error,
    });
    const w = world(["instagram", "instagram-story"]);
    w.replies["instagram-story"] = failed(
      "instagram story container: HTTP 400",
    );
    expect((await w.post(SLOT)).kind).toBe("post-failed");
    expect(w.get().posts.instagram.ok).toBe(true);
    expect(w.get().posts["instagram-story"].ok).toBe(false);
    delete w.replies["instagram-story"];
    const r = await w.retry("v-2026-10-28-1");
    expect(r.kind).toBe("posted");
    expect(w.logged).toEqual(["instagram", "instagram-story"]);

    // A failed Reel does not hold back the Story (Wall Game PM, 2026-10-29).
    const w2 = world(["instagram", "instagram-story"]);
    w2.replies.instagram = failed("instagram container: HTTP 400");
    expect((await w2.post(SLOT)).kind).toBe("post-failed");
    expect(w2.logged).toEqual(["instagram-story"]);
  });

  test("TikTok posts at any slot when no draft waits; while one waits it is not applicable, never retried", async () => {
    const why = "a draft is waiting";
    for (const slot of [
      SLOT, // 09:00 PDT
      { slotAt: "2026-10-29T22:00:00.000Z" }, // 15:00 PDT
      { ...SLOT, firedBy: "Nil" }, // slot --now
    ]) {
      const w = world(["x", "tiktok"]);
      expect(await w.post(slot)).toMatchObject({
        kind: "posted",
        platforms: ["x", "tiktok"],
      });
      expect(w.logged).toEqual(["x", "tiktok"]);
      // One read of the latest draft per slot.
      expect(w.tiktokReads()).toBe(1);
    }

    for (const slot of [SLOT, { slotAt: "2026-10-29T22:00:00.000Z" }]) {
      const w2 = world(["x", "tiktok"]);
      w2.setTiktok(why);
      w2.replies.x = () => ({
        ok: false,
        uncertain: false,
        mode: "live",
        at: "t",
        error: "x: HTTP 503",
      });
      expect(await w2.post(slot)).toMatchObject({
        kind: "post-failed",
        platforms: ["x"],
        notApplicable: { tiktok: why },
      });
      expect(w2.get().posts).not.toHaveProperty("tiktok");
      // A retry of another failure never tries TikTok, even when no draft
      // waits any more.
      w2.setTiktok(null);
      delete w2.replies.x;
      expect((await w2.retry("v-2026-10-28-1")).kind).toBe("posted");
      expect(w2.logged).toEqual(["x"]);
    }
  });

  test("a TikTok retry is gated as a slot: a draft that waits now, or an unknown status, holds TikTok; the other platforms go on", async () => {
    const failed = (error: string) => () => ({
      ok: false,
      uncertain: false,
      mode: "live",
      at: "t",
      error,
    });
    for (const why of [
      "a draft is waiting",
      "draft status unknown: tiktok status: HTTP 503",
    ]) {
      // Slot A: TikTok and X fail. Since then, slot B sent another draft.
      const w = world(["x", "tiktok"]);
      w.replies.x = failed("x: HTTP 503");
      w.replies.tiktok = failed("tiktok init: HTTP 500");
      expect((await w.post(SLOT)).kind).toBe("post-failed");
      delete w.replies.x;
      delete w.replies.tiktok;
      w.setTiktok(why);
      const r = (await w.retry("v-2026-10-28-1")) as Outcome & {
        held?: Record<string, string>;
      };
      expect(r.kind).toBe("post-failed");
      expect(r.held).toEqual({ tiktok: why });
      expect(w.logged).toEqual(["x"]);
      expect(w.get().posts.tiktok.ok).toBe(false);
      // TikTok alone: the retry is refused, and nothing changes.
      expect(await refusal(w.retry("v-2026-10-28-1"))).toBe(
        `tiktok: ${why}; retry when Nil has posted it or it is marked lost (crew.mjs tiktok)`,
      );
      expect(w.get().state).toBe("post-failed");
      // Nil posts the waiting draft: the retry sends TikTok's.
      w.setTiktok(null);
      expect((await w.retry("v-2026-10-28-1")).kind).toBe("posted");
      expect(w.logged).toEqual(["x", "tiktok"]);
    }
  });

  test("a TikTok read that throws (a damaged file) holds TikTok alone at a slot (a retry reads through the same guard)", async () => {
    const w = world(["x", "tiktok"]);
    w.setTiktok(new Error("tiktok-drafts.json cannot be read"));
    expect(await w.post(SLOT)).toMatchObject({
      kind: "posted",
      platforms: ["x"],
      notApplicable: {
        tiktok: "draft status unknown: tiktok-drafts.json cannot be read",
      },
    });
    expect(w.logged).toEqual(["x"]);
  });

  test("TikTok is not read when it is not live, or when no item is approved", async () => {
    const w = world(["x"]);
    await w.post(SLOT);
    expect(w.tiktokReads()).toBe(0);
    const w2 = world(["x", "tiktok"]);
    await w2.post(SLOT);
    expect(await w2.post(SLOT)).toMatchObject({ kind: "empty" });
    expect(w2.tiktokReads()).toBe(1);
  });

  test("a slot at which no live platform applies never takes the item: it stays approved and posts at a later slot", async () => {
    const w = world(["tiktok"]);
    w.setTiktok("a draft is waiting");
    const r = await w.post({ slotAt: "2026-10-29T22:00:00.000Z" }); // 15:00 PDT
    expect(r).toMatchObject({
      kind: "none-applies",
      passed: [
        {
          itemId: "v-2026-10-28-1",
          notApplicable: { tiktok: "a draft is waiting" },
        },
      ],
    });
    expect(w.get().state).toBe("approved");
    expect(w.get()).not.toHaveProperty("posting");
    expect(w.logged).toEqual([]);
    // Nil posts the draft: the next slot takes it.
    w.setTiktok(null);
    expect(await w.post(SLOT)).toMatchObject({
      kind: "posted",
      platforms: ["tiktok"],
    });
    expect(w.logged).toEqual(["tiktok"]);
  });

  test("a video outside the Story limits posts no Story: not applicable, not a failure, never retried", async () => {
    const w = world(["instagram", "instagram-story"]);
    w.get().render.video.durationSeconds = 72;
    const r = await w.post(SLOT);
    const why = "instagram story: the video is 72 s; a Story takes 3-60 s";
    expect(r).toMatchObject({
      kind: "posted",
      platforms: ["instagram"],
      notApplicable: { "instagram-story": why },
    });
    expect(w.get().posting).toMatchObject({
      platforms: ["instagram"],
      notApplicable: { "instagram-story": why },
    });
    expect(w.get().posts).not.toHaveProperty("instagram-story");
    expect(w.logged).toEqual(["instagram"]);
    // A later retry of another failure never tries the Story.
    const w2 = world(["instagram", "instagram-story"]);
    w2.get().render.video.durationSeconds = 72;
    w2.replies.instagram = () => ({
      ok: false,
      uncertain: false,
      mode: "live",
      at: "t",
      error: "instagram container: HTTP 400",
    });
    expect((await w2.post(SLOT)).kind).toBe("post-failed");
    delete w2.replies.instagram;
    const again = await w2.retry("v-2026-10-28-1");
    expect(again).toMatchObject({ kind: "posted", platforms: ["instagram"] });
    expect(w2.confirmedSeen.map(([p]) => p)).toEqual([
      "instagram",
      "instagram",
    ]);
  });

  test("an uncertain platform needs confirmNotPosted before a retry", async () => {
    const w = world(["x"]);
    w.replies.x = (commit) => {
      commit();
      return {
        ok: false,
        uncertain: true,
        mode: "live",
        at: "t",
        error: "x: HTTP 503",
      };
    };
    await w.post(SLOT);
    expect(await refusal(w.retry("v-2026-10-28-1"))).toContain(
      "x may already have this post (no clear answer to",
    );
    expect(w.get().state).toBe("post-failed");
    delete w.replies.x;
    expect(
      (await w.retry("v-2026-10-28-1", { confirmNotPosted: ["x"] })).kind,
    ).toBe("posted");
    // postPlatform's own guard hears the confirmation for that platform only.
    expect(w.confirmedSeen).toEqual([
      ["x", false],
      ["x", true],
    ]);
  });

  describe("a YouTube retry after an uncertain upload", () => {
    // v-2026-11-01-6, 2026-11-05: the PUT ended "fetch failed", the upload
    // was on YouTube in "processing", and a retry uploaded it again.
    const uncertainYoutube = async () => {
      const w = world(["youtube"]);
      w.replies.youtube = (commit) => {
        commit();
        return {
          ok: false,
          uncertain: true,
          mode: "live",
          at: "t",
          error: "fetch failed",
        };
      };
      await w.post(SLOT);
      delete w.replies.youtube;
      return w;
    };
    const confirmed = { confirmNotPosted: ["youtube"] };

    test("an upload with the same title in processing refuses, with its id", async () => {
      const w = await uncertainYoutube();
      w.setYoutube([
        {
          id: "zzOther0001",
          title: "another video #Shorts",
          uploadStatus: "processed",
          processingStatus: "succeeded",
        },
        {
          id: "ARss61GrZXk",
          title: "title #Shorts",
          uploadStatus: "uploaded",
          processingStatus: "processing",
        },
      ]);
      expect(await refusal(w.retry("v-2026-10-28-1", confirmed))).toBe(
        'youtube: the channel already has this upload: ARss61GrZXk has the title "title #Shorts" (uploaded, processing); no retry',
      );
      expect(w.get().state).toBe("post-failed");
      expect(w.confirmedSeen).toEqual([["youtube", false]]);
    });

    test("no upload with the title: the retry runs", async () => {
      const w = await uncertainYoutube();
      // The copy title alone is not the posted title (the app adds #Shorts).
      w.setYoutube([
        {
          id: "zzOther0001",
          title: "title",
          uploadStatus: "processed",
          processingStatus: "succeeded",
        },
      ]);
      const r = await w.retry("v-2026-10-28-1", confirmed);
      expect(r).toMatchObject({ kind: "posted", platforms: ["youtube"] });
      expect(w.youtubeReads()).toBe(1);
      expect(w.confirmedSeen).toEqual([
        ["youtube", false],
        ["youtube", true],
      ]);
    });

    test("a read that fails refuses: no blind retry", async () => {
      const w = await uncertainYoutube();
      w.setYoutube(new Error("youtube videos: HTTP 403 quotaExceeded"));
      expect(await refusal(w.retry("v-2026-10-28-1", confirmed))).toBe(
        "youtube: the channel's last uploads cannot be read (youtube videos: HTTP 403 quotaExceeded), so the app cannot check for this upload; retry when the read works (GET /api/daily/youtube-recent)",
      );
      expect(w.get().state).toBe("post-failed");
      expect(w.confirmedSeen).toEqual([["youtube", false]]);
    });

    test("without the confirmation the refusal says the app checks; nothing is read", async () => {
      const w = await uncertainYoutube();
      expect(await refusal(w.retry("v-2026-10-28-1"))).toContain(
        "retry with --confirm-not-posted youtube: the app checks the channel's last uploads first",
      );
      expect(w.youtubeReads()).toBe(0);
    });

    test("a retry after a clear YouTube failure reads nothing", async () => {
      const w = world(["youtube"]);
      w.replies.youtube = () => ({
        ok: false,
        uncertain: false,
        mode: "live",
        at: "t",
        error: "youtube start: HTTP 401",
      });
      await w.post(SLOT);
      delete w.replies.youtube;
      w.setYoutube(new Error("not read"));
      expect((await w.retry("v-2026-10-28-1")).kind).toBe("posted");
      expect(w.youtubeReads()).toBe(0);
    });
  });

  test("postPlatform's last guard (StepRefused) is a clear failure, not uncertain", async () => {
    const w = world(["x"]);
    w.replies.x = () => {
      throw new StepRefused(
        "the video on disk is not the one that was approved",
      );
    };
    const r = await w.post(SLOT);
    expect(r.kind).toBe("post-failed");
    expect(r.posts.x).toMatchObject({ ok: false, uncertain: false });
  });

  test("a fault after the final request counts as uncertain", async () => {
    const w = world(["x"]);
    w.replies.x = (commit) => {
      commit();
      throw new Error("socket closed");
    };
    const r = await w.post(SLOT);
    expect(r.posts.x).toMatchObject({
      ok: false,
      uncertain: true,
      error: "socket closed",
    });
  });

  test("a stop during the post: recover leaves post-failed with the pending mark", async () => {
    const w = world(["x"]);
    w.replies.x = (commit) => {
      commit();
      return new Promise<Post>(() => undefined); // the app stops here
    };
    void w.post(SLOT);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.get().state).toBe("posting");
    const out = w.recover() as { posts: Record<string, Post> }[];
    expect(out as unknown).toEqual([
      {
        id: "v-2026-10-28-1",
        slotAt: SLOT.slotAt,
        platforms: ["x"],
        notApplicable: null,
        posts: {
          x: { ok: null, pending: true, mode: "live", at: out[0].posts.x.at },
        },
      },
    ]);
    expect(w.get().state).toBe("post-failed");
    expect(await refusal(w.retry("v-2026-10-28-1"))).toContain(
      "the app stopped during",
    );
  });

  test("a migrated post-failed item (posts{}, no posting) retries its day's platforms", async () => {
    const w = world(["x", "bluesky", "threads"]);
    Object.assign(w.get(), {
      state: "post-failed",
      posts: {
        x: { ok: false, uncertain: false, error: "x: HTTP 402" },
        bluesky: { ok: true },
      },
    });
    const r = await w.retry("v-2026-10-28-1");
    expect(r).toMatchObject({ kind: "posted", platforms: ["x", "bluesky"] });
    expect(w.logged).toEqual(["x"]);
  });

  test("a slot with no approved item left is empty; only a post-failed item retries", async () => {
    const w = world(["x"]);
    await w.post(SLOT);
    expect((await w.post(SLOT)) as unknown).toEqual({ kind: "empty" });
    expect(await refusal(w.retry("v-2026-10-28-1"))).toContain(
      "only a post-failed item",
    );
  });
});
