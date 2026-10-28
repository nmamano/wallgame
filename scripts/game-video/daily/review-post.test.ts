/**
 * post(itemId) (review-post.mjs) with a fake item store: the platforms live
 * at the slot are fixed on the item, the approval's two hashes gate the
 * post, a retry touches only the slot's failed platforms and never an
 * uncertain one without a check, and a stop mid-post leaves post-failed.
 */
import { describe, expect, test } from "bun:test";
import { StepRefused } from "./store.mjs";
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
  render: { video: { path: string }; music?: { track: string }[] };
  copy: { block: typeof COPY; sha256: string };
  approval: {
    videoSha256: string;
    copySha256: string;
    by: string;
    at: string;
  } | null;
  posts: Record<string, Post>;
  posting?: { slotAt: string; at: string; platforms: string[] };
  events: string[];
}

/** What postNext and retry return. */
interface Outcome {
  kind: string;
  itemId?: string;
  platforms: string[];
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
    render: { video: { path: "/videos/1.mp4" } },
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
  let livePlatforms = live;
  const replies: Record<
    string,
    (beforeCommit: () => void) => Post | Promise<Post>
  > = {};
  let staleQueue: Item[] | null = null;
  const logged: string[] = [];
  const confirmedSeen: [string, boolean][] = [];
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
    livePlatforms: () => livePlatforms,
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
  });
  const post = async (slot: { slotAt: string }) =>
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
    setLive: (p: string[]) => (livePlatforms = p),
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
      "x is not live now: connect it (/daily/connect), then retry",
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
