/**
 * The slot timer (scheduler.mjs) with a fake store, poster and office: a
 * slot posts the oldest approved item once, survives a restart (the state is
 * on disk), skips an empty queue with one message, keeps an unsent message
 * for the next tick, and closes a post that a stop cut off.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createScheduler } from "./scheduler.mjs";

const OCT29_0900 = Date.parse("2026-10-29T16:00:00Z");
const HOUR = 60 * 60 * 1000;
const LIVE = ["x", "bluesky", "tiktok"];

interface Item {
  id: string;
  state: string;
  posting?: { at: string; slotAt?: string; platforms?: string[] };
  posts?: Record<string, { ok: boolean; url?: string }>;
}

/** The timer's state file, as the tests read it. */
interface State {
  lastSlotAt: string | null;
  lastPostAt: string | null;
  lastSlot: {
    outcome: string;
    itemId: string | null;
    platforms: string[] | null;
  } | null;
}

const readState = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as State;

const world = (opts: { ready?: number; liveNow?: string[] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "schedule-"));
  const statePath = join(dir, "daily", "schedule.json");
  let t = OCT29_0900 - HOUR;
  const items: Item[] = Array.from({ length: opts.ready ?? 1 }, (_, i) => ({
    id: `v-2026-10-28-${i + 1}`,
    state: "approved",
  }));
  const sent: string[] = [];
  const posted: string[] = [];
  // The slot time each post was given (recover() matches it), and who
  // fired a slot by hand.
  const slotAts: string[] = [];
  const firedBys: (string | undefined)[] = [];
  // While set, a post waits for it (a post in flight).
  let hold: Promise<void> | null = null;
  let officeUp = true;
  let live = opts.liveNow ?? LIVE;
  let outcome: (id: string) => object = () => ({
    kind: "posted",
    platforms: live,
    posts: Object.fromEntries(
      live.map((p) => [p, { ok: true, url: `https://${p}.example/1` }]),
    ),
  });
  let leftPosting: {
    id: string;
    slotAt: string;
    posts: object;
    platforms: string[];
    notApplicable: Record<string, string> | null;
  }[] = [];
  const make = () =>
    createScheduler({
      statePath,
      now: () => t,
      store: {
        approvedQueue: () => items.filter((i) => i.state === "approved"),
        counts: () => ({
          draft: 0,
          revise: 0,
          finished: 0,
          inReview: 1,
          waitingCopy: 0,
          approved: items.filter((i) => i.state === "approved").length,
          posting: 0,
          postFailed: items.filter((i) => i.state === "post-failed").length,
          posted: items.filter((i) => i.state === "posted").length,
          discarded: 0,
        }),
        items: ({ states }: { states?: string[] } = {}) =>
          items.filter((i) => !states || states.includes(i.state)),
      },
      livePlatforms: () => live,
      busy: () => false,
      postItem: async ({
        slotAt,
        firedBy,
      }: {
        slotAt: string;
        firedBy?: string;
      }) => {
        slotAts.push(slotAt);
        firedBys.push(firedBy);
        if (hold) await hold;
        const next = items.find((i) => i.state === "approved");
        if (!next) return { kind: "empty" };
        const id = next.id;
        posted.push(id);
        const r = outcome(id) as { kind: string };
        const item = items.find((i) => i.id === id)!;
        item.state =
          r.kind === "posted"
            ? "posted"
            : r.kind === "no-live"
              ? "approved"
              : "post-failed";
        item.posting = { at: new Date(t).toISOString() };
        return { itemId: id, ...r };
      },
      recover: () => {
        const out = leftPosting;
        leftPosting = [];
        return out;
      },
      send: (text: string) => {
        if (!officeUp) return Promise.reject(new Error("office down"));
        sent.push(text);
        return Promise.resolve();
      },
      log: { warn: () => undefined },
    });
  return {
    make,
    statePath,
    items,
    sent,
    posted,
    slotAts,
    firedBys,
    setHold: (p: Promise<void> | null) => {
      hold = p;
    },
    setTime: (ms: number) => (t = ms),
    setOffice: (up: boolean) => (officeUp = up),
    setLive: (p: string[]) => (live = p),
    setOutcome: (f: (id: string) => object) => (outcome = f),
    leavePosting: (x: typeof leftPosting) => (leftPosting = x),
  };
};

describe("scheduler", () => {
  test("the 09:00 slot posts the oldest approved item once, across a restart", async () => {
    const w = world({ ready: 2 });
    let s = w.make();
    await s.tick(); // first run: records now
    expect(w.posted).toEqual([]);
    w.setTime(OCT29_0900);
    await s.tick();
    expect(w.posted).toEqual(["v-2026-10-28-1"]);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toContain(
      "Slot Thu 2026-10-29 09:00 PT: POSTED v-2026-10-28-1.",
    );
    expect(w.sent[0]).toContain("- x: posted https://x.example/1");
    expect(w.sent[0]).toContain("- tiktok: inbox draft");
    expect(w.sent[0]).toContain("Status: ready (approved) 1,");
    expect(w.sent[0]).toContain("posted today 1.");
    // 16:00 needs 3 ready: the next is tomorrow 09:00.
    expect(w.sent[0]).toContain("Next slot: Fri 2026-10-30 09:00 PT");
    // A new app (a restart) reads the file and does not post again.
    s = w.make();
    w.setTime(OCT29_0900 + 60_000);
    await s.tick();
    expect(w.posted).toEqual(["v-2026-10-28-1"]);
    const state = readState(w.statePath);
    expect(state.lastSlot).toMatchObject({
      itemId: "v-2026-10-28-1",
      outcome: "posted",
      platforms: LIVE,
    });
  });

  test("an empty queue skips the 09:00 slot with one message", async () => {
    const w = world({ ready: 0 });
    const s = w.make();
    await s.tick();
    w.setTime(OCT29_0900);
    await s.tick();
    w.setTime(OCT29_0900 + 60_000);
    await s.tick();
    expect(w.posted).toEqual([]);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toContain("SKIPPED, the approved queue is empty.");
    expect(w.sent[0]).toContain("no post (the approved queue is empty)");
  });

  test("a slot missed while the app was down posts late and says so", async () => {
    const w = world({ ready: 1 });
    await w.make().tick();
    w.setTime(OCT29_0900 + 2 * HOUR + 12 * 60_000);
    await w.make().tick();
    expect(w.posted).toEqual(["v-2026-10-28-1"]);
    expect(w.sent[0]).toContain(
      "Slot Thu 2026-10-29 09:00 PT, LATE: fired Thu 2026-10-29 11:12 PT: POSTED",
    );
  });

  test("a message the office refused is sent at a later tick", async () => {
    const w = world({ ready: 1 });
    const s = w.make();
    await s.tick();
    w.setOffice(false);
    w.setTime(OCT29_0900);
    await s.tick();
    expect(w.sent).toEqual([]);
    w.setOffice(true);
    w.setTime(OCT29_0900 + 30_000);
    await s.tick();
    expect(w.sent).toHaveLength(1);
    expect(w.posted).toHaveLength(1);
  });

  test("no live platform: skipped, the item stays approved, no gap", async () => {
    const w = world({ ready: 1, liveNow: [] });
    w.setOutcome(() => ({ kind: "no-live" }));
    const s = w.make();
    await s.tick();
    w.setTime(OCT29_0900);
    await s.tick();
    expect(w.sent[0]).toContain(
      "SKIPPED, no platform is live. The approved items stay approved.",
    );
    expect(readState(w.statePath).lastPostAt).toBeNull();
  });

  test("a failed and an uncertain platform; and a platform live after the slot", async () => {
    const w = world({ ready: 1 });
    w.setOutcome(() => ({
      kind: "post-failed",
      platforms: LIVE,
      posts: {
        x: { ok: false, uncertain: false, error: "x: HTTP 402" },
        bluesky: { ok: false, uncertain: true, error: "bluesky: HTTP 502" },
        tiktok: { ok: true },
      },
    }));
    const s = w.make();
    await s.tick();
    w.setTime(OCT29_0900);
    w.setLive([...LIVE, "threads"]);
    await s.tick();
    const m = w.sent[0];
    expect(m).toContain("POST FAILED v-2026-10-28-1.");
    expect(m).toContain("- x: FAILED (x: HTTP 402)");
    expect(m).toContain("- bluesky: UNCERTAIN, the post may exist");
    expect(m).toContain("Live now but not in this slot: threads.");
    expect(m).toContain("crew.mjs post --item v-2026-10-28-1");
    expect(
      (s.status() as { lastSlot: { notInSlot: string[] } }).lastSlot.notInSlot,
    ).toEqual(["threads"]);
  });

  test("a Story that does not apply is a line, not a failure, and not 'live but not in this slot'", async () => {
    const live = ["instagram", "instagram-story"];
    const why = "instagram story: the video is 72 s; a Story takes 3-60 s";
    const w = world({ ready: 1, liveNow: live });
    w.setOutcome(() => ({
      kind: "posted",
      platforms: ["instagram"],
      notApplicable: { "instagram-story": why },
      posts: { instagram: { ok: true, url: "https://instagram/1" } },
    }));
    const s = w.make();
    await s.tick();
    w.setTime(OCT29_0900);
    await s.tick();
    const m = w.sent[0];
    expect(m).toContain("POSTED v-2026-10-28-1.");
    expect(m).toContain(
      `- instagram-story: not applicable, nothing to retry (${why})`,
    );
    expect(m).not.toContain("Live now but not in this slot");
    expect(
      (s.status() as { lastSlot: { notInSlot: string[] } }).lastSlot.notInSlot,
    ).toEqual([]);
  });

  test("an error after the item was taken: the 6 h gap still holds", async () => {
    const w = world({ ready: 1 });
    w.setOutcome(() => {
      throw new Error("ENOSPC");
    });
    const s = w.make();
    await s.tick();
    w.setTime(OCT29_0900);
    await s.tick();
    const state = readState(w.statePath);
    expect(state.lastPostAt).toBe(new Date(OCT29_0900).toISOString());
    expect(w.sent[0]).toContain("SKIPPED, the post could not run: ENOSPC");
  });

  test("every approved item refused: the gap does not hold, Growth sees each", async () => {
    const w = world({ ready: 1 });
    w.setOutcome(() => ({
      kind: "refused",
      refused: [
        {
          itemId: "v-2026-10-28-1",
          error:
            "content changed since approval: the copy block sha256 is aaaaaaaaaaaa, Nil approved bbbbbbbbbbbb",
        },
      ],
    }));
    const s = w.make();
    await s.tick();
    w.setTime(OCT29_0900);
    await s.tick();
    expect(readState(w.statePath).lastPostAt).toBeNull();
    expect(w.sent[0]).toContain(
      "SKIPPED, every approved item failed its checks:",
    );
    expect(w.sent[0]).toContain(
      "- v-2026-10-28-1 failed its checks and is post-failed: content changed since approval: the copy block sha256 is aaaaaaaaaaaa, Nil approved bbbbbbbbbbbb. It needs a new approval (send it to the Director); a retry fails the same check.",
    );
  });

  test("a stop before the slot took an item: interrupted, the gap restored, Growth told", async () => {
    const w = world({ ready: 1 });
    const prev = new Date(OCT29_0900 - 20 * HOUR).toISOString();
    mkdirSync(dirname(w.statePath), { recursive: true });
    writeFileSync(
      w.statePath,
      JSON.stringify({
        lastSlotAt: new Date(OCT29_0900).toISOString(),
        lastPostAt: new Date(OCT29_0900).toISOString(),
        lastSlot: {
          slotAt: new Date(OCT29_0900).toISOString(),
          firedAt: new Date(OCT29_0900).toISOString(),
          itemId: null,
          outcome: "posting",
          platforms: null,
          folded: 0,
          prevPostAt: prev,
        },
        outbox: [],
      }),
    );
    w.setTime(OCT29_0900 + 60_000);
    const stop = w.make().start(60_000);
    stop();
    await new Promise((r) => setTimeout(r, 20));
    const state = readState(w.statePath);
    expect(state.lastSlot?.outcome).toBe("interrupted");
    expect(state.lastPostAt).toBe(prev);
    expect(w.sent[0]).toContain(
      "Slot Thu 2026-10-29 09:00 PT stopped before it took an item (the app stopped); nothing posted.",
    );
  });

  test("a hard kill as the post ended: the item says what happened, the gap holds", async () => {
    const w = world({ ready: 1 });
    const slotAt = new Date(OCT29_0900).toISOString();
    Object.assign(w.items[0], {
      state: "posted",
      posting: { at: slotAt, slotAt, platforms: ["x"] },
      posts: { x: { ok: true, url: "https://x.example/1" } },
    });
    mkdirSync(dirname(w.statePath), { recursive: true });
    writeFileSync(
      w.statePath,
      JSON.stringify({
        lastSlotAt: slotAt,
        lastPostAt: slotAt,
        lastSlot: {
          slotAt,
          firedAt: slotAt,
          itemId: null,
          outcome: "posting",
          platforms: null,
          folded: 0,
          prevPostAt: null,
        },
        outbox: [],
      }),
    );
    w.setTime(OCT29_0900 + 60_000);
    const stop = w.make().start(60_000);
    stop();
    await new Promise((r) => setTimeout(r, 20));
    const state = readState(w.statePath);
    expect(state.lastSlot).toMatchObject({
      itemId: "v-2026-10-28-1",
      outcome: "posted",
    });
    expect(state.lastPostAt).toBe(slotAt);
    expect(w.sent[0]).toContain(
      "the app stopped as the post of v-2026-10-28-1 ended; it is posted.",
    );
    expect(w.sent[0]).toContain("- x: posted https://x.example/1");
  });

  test("both recoveries keep a Story that does not apply: a line, and not 'not in this slot'", async () => {
    const why = "instagram story: the video is 72 s; a Story takes 3-60 s";
    const live = ["instagram", "instagram-story"];
    const slotAt = new Date(OCT29_0900).toISOString();
    const posting = (prev: string | null) =>
      JSON.stringify({
        lastSlotAt: slotAt,
        lastPostAt: slotAt,
        lastSlot: {
          slotAt,
          firedAt: slotAt,
          itemId: null,
          outcome: "posting",
          platforms: null,
          folded: 0,
          prevPostAt: prev,
        },
        outbox: [],
      });
    const started = async (w: ReturnType<typeof world>) => {
      w.setTime(OCT29_0900 + 60_000);
      const s = w.make();
      const stop = s.start(60_000);
      stop();
      await new Promise((r) => setTimeout(r, 20));
      return s;
    };
    const notInSlot = (s: ReturnType<ReturnType<typeof world>["make"]>) =>
      (s.status() as { lastSlot: { notInSlot: string[] } }).lastSlot.notInSlot;

    // A hard kill as the post ended: the item that the slot took.
    const w = world({ ready: 1, liveNow: live });
    Object.assign(w.items[0], {
      state: "posted",
      posting: {
        at: slotAt,
        slotAt,
        platforms: ["instagram"],
        notApplicable: { "instagram-story": why },
      },
      posts: { instagram: { ok: true, url: "https://instagram.example/1" } },
    });
    mkdirSync(dirname(w.statePath), { recursive: true });
    writeFileSync(w.statePath, posting(null));
    const s = await started(w);
    expect(readState(w.statePath).lastSlot).toMatchObject({
      outcome: "posted",
      notApplicable: { "instagram-story": why },
    });
    expect(w.sent[0]).toContain(
      `- instagram-story: not applicable, nothing to retry (${why})`,
    );
    expect(notInSlot(s)).toEqual([]);

    // A stop during the post: recover() reports the item.
    const w2 = world({ ready: 0, liveNow: live });
    mkdirSync(dirname(w2.statePath), { recursive: true });
    writeFileSync(w2.statePath, posting(null));
    w2.leavePosting([
      {
        id: "v-2026-10-28-1",
        slotAt,
        platforms: ["instagram"],
        notApplicable: { "instagram-story": why },
        posts: { instagram: { ok: null, pending: true, at: slotAt } },
      },
    ]);
    const s2 = await started(w2);
    expect(readState(w2.statePath).lastSlot).toMatchObject({
      outcome: "interrupted",
      notApplicable: { "instagram-story": why },
    });
    expect(w2.sent[0]).toContain("- instagram: UNCERTAIN");
    expect(w2.sent[0]).toContain(
      `- instagram-story: not applicable, nothing to retry (${why})`,
    );
    expect(notInSlot(s2)).toEqual([]);
  });

  test("a damaged state file is moved aside; the timer starts again and says so", async () => {
    const w = world({ ready: 1 });
    mkdirSync(dirname(w.statePath), { recursive: true });
    writeFileSync(w.statePath, "{ not json");
    const s = w.make();
    await s.tick();
    expect(w.sent[0]).toContain("state file was damaged");
    expect(
      readdirSync(dirname(w.statePath)).some((f) => f.includes(".corrupt-")),
    ).toBe(true);
    // Started again: the next slot posts as usual.
    w.setTime(OCT29_0900);
    await s.tick();
    expect(w.posted).toEqual(["v-2026-10-28-1"]);
  });

  test("a post that a stop cut off is reported at start", async () => {
    const w = world({ ready: 0 });
    w.leavePosting([
      {
        id: "v-2026-10-28-1",
        slotAt: "2026-10-29T16:00:00.000Z",
        platforms: ["x"],
        notApplicable: null,
        posts: { x: { ok: null, pending: true, at: "2026-10-29T16:00:05Z" } },
      },
    ]);
    const stop = w.make().start(60_000);
    stop();
    // start's first tick runs in the background; let it end.
    await new Promise((r) => setTimeout(r, 20));
    expect(w.sent[0]).toContain(
      "The app stopped while v-2026-10-28-1 was posting",
    );
    expect(w.sent[0]).toContain("- x: UNCERTAIN");
  });
});

describe("a slot by hand (fireNow)", () => {
  test("posts the oldest approved item now, says so, and the 6 h gap counts from it; the timed slot is not used up", async () => {
    const w = world({ ready: 2 });
    const s = w.make();
    await s.tick(); // first run: records 08:00 PT
    const before = readState(w.statePath);
    const r = await s.fireNow({ by: "Wall Game Growth" });
    expect(r).toMatchObject({
      ok: true,
      lastSlot: { itemId: "v-2026-10-28-1", outcome: "posted" },
    });
    expect(w.posted).toEqual(["v-2026-10-28-1"]);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toContain(
      "Slot by hand (Wall Game Growth) Thu 2026-10-29 08:00 PT: POSTED v-2026-10-28-1.",
    );
    expect(w.sent[0]).toContain("- x: posted https://x.example/1");
    const state = readState(w.statePath) as State & {
      lastSlot: { slotAt: string };
    };
    const at = new Date(OCT29_0900 - HOUR).toISOString();
    expect(state.lastSlotAt).toBe(before.lastSlotAt);
    expect(state.lastPostAt).toBe(at);
    // The post was given the slot's own time: recover() finds the item.
    expect(state.lastSlot.slotAt).toBe(at);
    expect(w.slotAts).toEqual([at]);
    // Who fired it: on the post (the post log's firedBy) and in lastSlot.
    expect(w.firedBys).toEqual(["Wall Game Growth"]);
    expect(state.lastSlot).toMatchObject({ firedBy: "Wall Game Growth" });

    // Within 6 h: refused, nothing posted, written or sent.
    w.setTime(OCT29_0900 - HOUR + 5 * HOUR);
    const raw = readFileSync(w.statePath, "utf8");
    const again = await s.fireNow({ by: "Wall Game Growth" });
    expect(again.ok).toBe(false);
    expect((again as { reason: string }).reason).toContain(
      "the 6 h gap after the last post",
    );
    expect(w.posted).toEqual(["v-2026-10-28-1"]);
    expect(w.sent).toHaveLength(1);
    expect(readFileSync(w.statePath, "utf8")).toBe(raw);

    // The 09:00 slot came during the gap: it waits, then posts late.
    w.setTime(OCT29_0900);
    await s.tick();
    expect(w.posted).toEqual(["v-2026-10-28-1"]);
    w.setTime(OCT29_0900 - HOUR + 6 * HOUR);
    await s.tick();
    expect(w.posted).toEqual(["v-2026-10-28-1", "v-2026-10-28-2"]);
    expect(w.sent[1]).toContain("Slot Thu 2026-10-29 09:00 PT, LATE");
    expect(w.firedBys).toEqual(["Wall Game Growth", undefined]);
  });

  test("refused before the first tick and with no approved item: nothing written or sent", async () => {
    const empty = world({ ready: 0 });
    const s = empty.make();
    // Unnamed: refused first.
    expect(await s.fireNow({ by: " " })).toEqual({
      ok: false,
      reason: "name who fires it (by)",
    });
    expect(await s.fireNow({ by: "Wall Game Growth" })).toEqual({
      ok: false,
      reason: "the slot timer has not run its first tick yet",
    });
    await s.tick();
    const raw = readFileSync(empty.statePath, "utf8");
    expect(await s.fireNow({ by: "Wall Game Growth" })).toEqual({
      ok: false,
      reason: "the approved queue is empty",
    });
    expect(readFileSync(empty.statePath, "utf8")).toBe(raw);
    expect(empty.sent).toEqual([]);
    expect(empty.posted).toEqual([]);
  });

  test("it holds the tick's turn: no tick and no second slot by hand while it posts", async () => {
    const w = world({ ready: 2 });
    const s = w.make();
    await s.tick();
    let release = () => undefined as void;
    w.setHold(new Promise<void>((r) => (release = r)));
    const first = s.fireNow({ by: "Wall Game Growth" });
    // The 09:00 slot is due while the post by hand runs.
    w.setTime(OCT29_0900);
    await s.tick();
    expect(await s.fireNow({ by: "Wall Game Growth" })).toEqual({
      ok: false,
      reason: "a slot or a post is running: try again in a minute",
    });
    expect(w.slotAts).toHaveLength(1);
    w.setHold(null);
    release();
    expect((await first).ok).toBe(true);
    expect(w.posted).toEqual(["v-2026-10-28-1"]);
    // After it, the 09:00 slot waits for the gap; nothing else posted.
    await s.tick();
    expect(w.posted).toEqual(["v-2026-10-28-1"]);
  });
});
