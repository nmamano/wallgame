/**
 * The video items of the review queue (Nil, 2026-10-28): each day file's
 * candidates become items at start-up (itemFromDay), and the store API that
 * Wall Game Worker 1's poster builds on (updateItem, approvedQueue,
 * postFailed, counts, reviewState).
 */
import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { copySha256 } from "./copy.mjs";
import {
  ITEM_VERSION,
  itemFromDay,
  migrateV1,
  migrateV2,
  openStore,
  reviewState,
  isHeld,
} from "./store.mjs";
import { testTmp } from "../test-tmp";

/** This file's temp dirs, removed after its tests (cb84d862). */
const TEST_TMP = testTmp();

const FIXTURES = join(import.meta.dir, "fixtures");

interface Review {
  action: string;
  notes: string;
  by: string;
  at: string;
  migratedFromAsk?: string;
}
interface Item {
  version: number;
  id: string;
  createdAt: string;
  gameId: string | null;
  state: string;
  source: { migratedFrom: { day: string; label: string } };
  render: { finishedAt: string; video: { sha256: string } } | null;
  copy: {
    block: unknown;
    sha256: string;
    forVideoSha256: string | null;
    storedAt: string | null;
  } | null;
  vets?: { videoSha256: string; verdict: string }[];
  reviews: Review[];
  approval: {
    videoSha256: string;
    copySha256: string | null;
    by: string;
    at: string;
  } | null;
  posts: Record<string, unknown>;
  events: { utc: string; what: string }[];
}

const dataDir = () => {
  const dir = TEST_TMP.dir("daily-items-test-");
  mkdirSync(join(dir, "daily", "cycles"), { recursive: true });
  return dir;
};

describe("each day's candidates become items at start-up", () => {
  test("the real 2026-10-26 (posted) and 2026-10-27 (asked) days", () => {
    const dir = dataDir();
    const cycles = join(dir, "daily", "cycles");
    for (const day of ["2026-10-26", "2026-10-27"]) {
      copyFileSync(
        join(FIXTURES, `v1-${day}.json`),
        join(cycles, `${day}.json`),
      );
    }
    const store = openStore(dir);
    const posted = store.item("v-2026-10-26-A") as Item;
    const asked = store.item("v-2026-10-27-A") as Item;
    const v1 = JSON.parse(
      readFileSync(join(FIXTURES, "v1-2026-10-26.json"), "utf8"),
    ) as {
      approval: { videoSha256: string; reply: string };
      posts: Record<string, unknown>;
    };
    // 2026-10-26 is older than Growth's blocks: its approval bound no block.
    expect(Object.keys(v1.approval)).not.toContain("copy");

    // The posted day: posted, with its posts and the approval's bytes.
    expect(posted.version).toBe(ITEM_VERSION);
    expect(posted.state).toBe("posted");
    expect(posted.source.migratedFrom).toMatchObject({
      day: "2026-10-26",
      label: "A",
    });
    expect(posted.approval).toEqual({
      videoSha256: v1.approval.videoSha256,
      copySha256: null,
      by: "Nil",
      at: posted.reviews[0].at,
    });
    expect(posted.reviews).toMatchObject([
      { action: "approve", notes: v1.approval.reply, by: "Nil" },
    ]);
    expect(posted.posts).toEqual(v1.posts);
    expect(posted.copy).toBeNull();

    // An open ask was not answered: its checked candidate is finished.
    expect(asked.state).toBe("finished");
    expect(asked.reviews).toEqual([]);
    expect(asked.approval).toBeNull();

    // The day files stay as history; the view counts move.
    const dayBytes = readFileSync(join(cycles, "2026-10-26.json"), "utf8");
    expect(
      JSON.parse(readFileSync(store.rendersFile, "utf8")) as unknown,
    ).toEqual({
      "2026-10-26": { N42PHQnw: 1, VoSWbMDd: 10 },
      "2026-10-27": { "v-lQeZ8T": 1, VoSWbMDd: 1 },
    });

    // A second start writes nothing.
    const itemBytes = readFileSync(
      join(store.dirs.items, "v-2026-10-26-A.json"),
      "utf8",
    );
    const again = openStore(dir);
    expect(readFileSync(join(cycles, "2026-10-26.json"), "utf8")).toBe(
      dayBytes,
    );
    expect(
      readFileSync(join(again.dirs.items, "v-2026-10-26-A.json"), "utf8"),
    ).toBe(itemBytes);
    expect(readdirSync(again.dirs.items).sort()).toEqual([
      "v-2026-10-26-A.json",
      "v-2026-10-27-A.json",
    ]);
  });

  // A version 3 day with four candidates, from the real 2026-10-27 one.
  const day = () => {
    const real = migrateV2(
      migrateV1(
        JSON.parse(readFileSync(join(FIXTURES, "v1-2026-10-27.json"), "utf8")),
      ),
    ) as {
      cands: Record<string, Record<string, unknown>>;
      approval: Record<string, unknown>;
    } & Record<string, unknown>;
    const A = real.cands.A;
    // A's offer binds A's real video and block, as an ask does.
    const aVideo = A.copyFor as string;
    const aBlock = copySha256(A.copy as never);
    const offer = (sha: string, copySha = `copy-${sha}`) => ({
      videoSha256: sha,
      copySha256: copySha,
      copy: null,
      gameId: "G",
      edlSha256: "e",
      caption: null,
    });
    return {
      ...real,
      state: "approved",
      cands: {
        A,
        B: { ...A, label: "B" },
        C: { ...A, label: "C", state: "checked" },
        D: { ...A, label: "D", state: "directed" },
      },
      approval: {
        ...real.approval,
        askId: "ask2",
        decision: "pick",
        picked: "A",
        approver: "Nil",
        answeredAt: "2026-10-27T21:00:00.000Z",
        reply: "A, the save reads best",
        offered: { A: offer(aVideo, aBlock), B: offer("bb") },
        videoSha256: aVideo,
      },
      posts: { x: { ok: true, mode: "live" } },
    };
  };

  test("picked: approved; offered and passed over: discarded with Nil's words; the rest by their check", () => {
    const record = day();
    const [A, B, C, D] = ["A", "B", "C", "D"].map(
      (l) => itemFromDay(record, l) as Item,
    );
    expect(A.state).toBe("approved");
    expect(A.approval).toEqual({
      videoSha256: record.cands.A.copyFor as string,
      copySha256: copySha256(record.cands.A.copy as never),
      by: "Nil",
      at: "2026-10-27T21:00:00.000Z",
    });
    expect(A.posts).toEqual({ x: { ok: true, mode: "live" } });
    // Growth's block, hashed as the ask binds it, for its video.
    const block = record.cands.A.copy as never;
    expect(block).not.toBeNull();
    expect(A.copy).toEqual({
      block,
      sha256: copySha256(block),
      forVideoSha256: record.cands.A.copyFor as string,
      storedAt: null,
    });
    expect(B.state).toBe("discarded");
    expect(B.reviews).toEqual([
      {
        action: "discard",
        notes: "A, the save reads best",
        by: "Nil",
        memberId: null,
        at: "2026-10-27T21:00:00.000Z",
        videoSha256: "bb",
        copySha256: "copy-bb",
        migratedFromAsk: "ask2",
      } as Review,
    ]);
    expect(B.posts).toEqual({});
    expect([C.state, D.state]).toEqual(["finished", "draft"]);
    expect(C.reviews).toEqual([]);

    // "None today": every candidate it offered is discarded.
    const none = {
      ...record,
      state: "rejected",
      approval: {
        ...record.approval,
        decision: "none",
        picked: null,
        reply: "none of these",
      },
    };
    expect(["A", "B"].map((l) => (itemFromDay(none, l) as Item).state)).toEqual(
      ["discarded", "discarded"],
    );
  });

  test("an approval still to post that binds another block or video stops it", () => {
    const record = day();
    const offered = record.approval.offered as Record<string, object>;
    for (const wrong of [
      { copySha256: "another block" },
      { videoSha256: "another video" },
    ]) {
      const bad = {
        ...record,
        approval: {
          ...record.approval,
          offered: { ...offered, A: { ...offered.A, ...wrong } },
        },
      };
      expect(() => itemFromDay(bad, "A")).toThrow(
        /2026-10-27 candidate A: the approval binds video/,
      );
    }
    // A posted day is history: it migrates as it is.
    const posted = {
      ...record,
      state: "posted",
      approval: {
        ...record.approval,
        offered: { ...offered, A: { ...offered.A, copySha256: "old" } },
      },
    };
    expect((itemFromDay(posted, "A") as Item).state).toBe("posted");
  });

  test("a candidate field the migration does not know stops it", () => {
    const record = day();
    record.cands.A = { ...record.cands.A, surprise: 1 };
    expect(() => itemFromDay(record, "A")).toThrow(
      /a candidate has no field surprise; the migration would lose it/,
    );
  });
});

describe("the store API the poster builds on", () => {
  const item = (id: string, over: Partial<Item>): Item => ({
    version: ITEM_VERSION,
    id,
    createdAt: "2026-10-28T10:00:00.000Z",
    gameId: "G",
    state: "draft",
    source: { migratedFrom: { day: "2026-10-28", label: "A" } },
    render: null,
    copy: null,
    reviews: [],
    approval: null,
    posts: {},
    events: [],
    ...over,
  });
  const storeWith = (items: Item[]) => {
    const dir = dataDir();
    const store = openStore(dir);
    for (const it of items) {
      writeFileSync(
        join(store.dirs.items, `${it.id}.json`),
        JSON.stringify(it),
      );
    }
    return store;
  };
  const approved = (at: string) => ({
    state: "approved",
    approval: { videoSha256: "v", copySha256: "c", by: "Nil", at },
  });

  test("updateItem changes an item only from the states it names", () => {
    const store = storeWith([item("v-2026-10-28-1", approved("t"))]);
    const noChange = (): void => undefined;
    expect(() => {
      store.updateItem("v-2026-10-28-1", ["draft"], noChange, "direct");
    }).toThrow("v-2026-10-28-1 is approved; direct needs draft");
    expect(() => {
      store.updateItem("v-2026-10-28-9", ["approved"], noChange, "x");
    }).toThrow("no item v-2026-10-28-9");
    expect(() => {
      store.item("../cycles/2026-10-26");
    }).toThrow("not an item id");
    const out = store.updateItem(
      "v-2026-10-28-1",
      ["approved"],
      (it: Item) => {
        it.state = "posting";
      },
      "slot 09:00 took it",
    ) as Item;
    expect(out.state).toBe("posting");
    expect(out.events.map((e) => e.what)).toEqual(["slot 09:00 took it"]);
    expect((store.item("v-2026-10-28-1") as Item).state).toBe("posting");
  });

  test("updateItem writes nothing when the change leaves an unknown state or another id", () => {
    const store = storeWith([item("v-2026-10-28-1", approved("t"))]);
    const before = readFileSync(
      join(store.dirs.items, "v-2026-10-28-1.json"),
      "utf8",
    );
    expect(() => {
      store.updateItem(
        "v-2026-10-28-1",
        ["approved"],
        (it: Item) => {
          it.state = "post_failed";
        },
        "slot 09:00 failed",
      );
    }).toThrow(
      "slot 09:00 failed left v-2026-10-28-1 in an unknown state: post_failed",
    );
    expect(() => {
      store.updateItem(
        "v-2026-10-28-1",
        ["approved"],
        (it: Item) => {
          it.id = "v-2026-10-28-2";
        },
        "rename",
      );
    }).toThrow("rename changed the item's id to v-2026-10-28-2");
    expect(
      readFileSync(join(store.dirs.items, "v-2026-10-28-1.json"), "utf8"),
    ).toBe(before);
    expect(readdirSync(store.dirs.items)).toEqual(["v-2026-10-28-1.json"]);
    expect(store.counts().approved).toBe(1);
  });

  test("the queue is approved items, oldest approval first; post-failed items are listed apart", () => {
    const store = storeWith([
      item("v-2026-10-28-1", approved("2026-10-28T12:00:00.000Z")),
      item("v-2026-10-28-2", approved("2026-10-28T11:00:00.000Z")),
      item("v-2026-10-28-3", { state: "post-failed" }),
      item("v-2026-10-28-4", { state: "posted" }),
    ]);
    expect(store.approvedQueue().map((it: Item) => it.id)).toEqual([
      "v-2026-10-28-2",
      "v-2026-10-28-1",
    ]);
    expect(store.postFailed().map((it: Item) => it.id)).toEqual([
      "v-2026-10-28-3",
    ]);
  });

  test("a held item stays approved and leaves the post queue until a new video is approved, or a release", () => {
    // Wall Game PM, 2026-10-31: a render fault in approved videos; the
    // queue was -30-3, -30-4 (faulty), -30-9: the next slot must take -30-9.
    const store = storeWith([
      item("v-2026-10-30-3", approved("2026-10-30T10:00:00.000Z")),
      item("v-2026-10-30-4", approved("2026-10-30T11:00:00.000Z")),
      item("v-2026-10-30-9", approved("2026-10-30T12:00:00.000Z")),
      item("v-2026-10-28-5", { state: "draft" }),
    ]);
    const queue = () => store.approvedQueue().map((it: Item) => it.id);
    expect(() => {
      store.hold("v-2026-10-30-4", " ", "PM");
    }).toThrow("hold needs the reason");
    expect(() => {
      store.hold("v-2026-10-28-5", "x", "PM");
    }).toThrow("v-2026-10-28-5 is draft");
    const held = store.hold(
      "v-2026-10-30-4",
      "ghost walk through a wall",
      "Wall Game PM",
    ) as Item;
    expect(held.state).toBe("approved");
    expect(held.approval?.videoSha256).toBe("v");
    expect(isHeld(held)).toBe(true);
    expect(held.events.at(-1)?.what).toBe(
      "held by Wall Game PM: ghost walk through a wall",
    );
    expect(queue()).toEqual(["v-2026-10-30-3", "v-2026-10-30-9"]);
    expect(store.held().map((it: Item) => it.id)).toEqual(["v-2026-10-30-4"]);
    expect(store.counts()).toMatchObject({ approved: 3, held: 1 });
    // The slot took -30-3: the next pick is -30-9, not the held -30-4.
    store.updateItem(
      "v-2026-10-30-3",
      ["approved"],
      (it: Item) => {
        it.state = "posted";
      },
      "posted",
    );
    expect(queue()[0]).toBe("v-2026-10-30-9");
    // A new approved video (other bytes) is not held.
    store.updateItem(
      "v-2026-10-30-4",
      ["approved"],
      (it: Item) => {
        it.approval = { ...it.approval!, videoSha256: "v2" };
      },
      "approved again after a new render",
    );
    expect(queue()).toEqual(["v-2026-10-30-4", "v-2026-10-30-9"]);
    expect(() => {
      store.release("v-2026-10-30-4", "PM");
    }).toThrow("v-2026-10-30-4 is not held");
    // A release by hand.
    store.hold("v-2026-10-30-9", "check", "PM");
    expect(queue()).toEqual(["v-2026-10-30-4"]);
    store.release("v-2026-10-30-9", "PM");
    expect(queue()).toEqual(["v-2026-10-30-4", "v-2026-10-30-9"]);
    expect(store.counts().held).toBe(0);
  });

  test("in review: a finished item with a block for its video; after a revise, a new render AND a new block", () => {
    const render = (finishedAt: string) => ({
      finishedAt,
      video: { sha256: "v2" },
    });
    const copy = (forVideoSha256: string, storedAt: string | null) => ({
      block: {},
      sha256: "c",
      forVideoSha256,
      storedAt,
    });
    const revise: Review = {
      action: "revise",
      notes: "slower opening",
      by: "Nil",
      at: "2026-10-28T12:00:00.000Z",
    };
    const pass = { videoSha256: "v2", verdict: "pass" };
    const finished = (over: Partial<Item>) =>
      item("v-2026-10-28-1", {
        state: "finished",
        render: render("2026-10-28T11:00:00.000Z"),
        copy: copy("v2", "2026-10-28T11:30:00.000Z"),
        vets: [pass],
        ...over,
      });
    expect(reviewState(finished({}))).toBe("in-review");
    // Rule R10: the latest vet of the current video must pass. A fail
    // recorded after the block takes the item out of review; a pass of
    // another video does not count.
    expect(reviewState(finished({ vets: [] }))).toBe("waiting-copy");
    expect(
      reviewState(
        finished({ vets: [pass, { videoSha256: "v2", verdict: "fail" }] }),
      ),
    ).toBe("waiting-copy");
    expect(
      reviewState(finished({ vets: [{ videoSha256: "v1", verdict: "pass" }] })),
    ).toBe("waiting-copy");
    expect(reviewState(finished({ copy: copy("v1", null) }))).toBe(
      "waiting-copy",
    );
    expect(reviewState(finished({ copy: null }))).toBe("waiting-copy");
    expect(reviewState(item("v-2026-10-28-1", {}))).toBeNull();
    // Revised: the old render and block do not count, nor a new render alone.
    expect(reviewState(finished({ reviews: [revise] }))).toBe("waiting-copy");
    expect(
      reviewState(
        finished({
          reviews: [revise],
          render: render("2026-10-28T13:00:00.000Z"),
        }),
      ),
    ).toBe("waiting-copy");
    expect(
      reviewState(
        finished({
          reviews: [revise],
          render: render("2026-10-28T13:00:00.000Z"),
          copy: copy("v2", "2026-10-28T13:30:00.000Z"),
        }),
      ),
    ).toBe("in-review");
  });

  test("counts", () => {
    const store = storeWith([
      item("v-2026-10-28-1", {}),
      item("v-2026-10-28-2", {
        reviews: [
          { action: "revise", notes: "n", by: "Nil", at: "2026-10-28T12:00Z" },
        ],
      }),
      item("v-2026-10-28-3", {
        state: "finished",
        render: { finishedAt: "t", video: { sha256: "v" } },
        copy: { block: {}, sha256: "c", forVideoSha256: "v", storedAt: null },
        vets: [{ videoSha256: "v", verdict: "pass" }],
      }),
      item("v-2026-10-28-4", { state: "finished" }),
      item("v-2026-10-28-5", approved("t")),
      item("v-2026-10-28-6", { state: "discarded" }),
    ]);
    expect(store.counts()).toEqual({
      draft: 1,
      revise: 1,
      finished: 2,
      inReview: 1,
      waitingCopy: 1,
      approved: 1,
      held: 0,
      posting: 0,
      postFailed: 0,
      posted: 0,
      discarded: 1,
    });
  });
});
