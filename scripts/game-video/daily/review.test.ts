/**
 * Nil's review queue (review.mjs, store.mjs review()): only Nil acts, only
 * on what his page showed, every action is a feedback row and a message to
 * the director, and the review never writes the poster's states.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { copySha256, parseCopy, trackedLink, YOUTUBE_LINK } from "./copy.mjs";
import { ITEM_VERSION, openStore, readPostLog, reviewState } from "./store.mjs";
import { createDaily } from "./routes.mjs";
import { DIRECTOR_AGENT_ID } from "./office.mjs";
import { feedbackLines } from "./crew.mjs";
import {
  REVIEWER_MEMBER_ID,
  approveLine,
  directorText,
  reviewView,
} from "./review.mjs";

const BLOCK = [
  "X: bro thought he could just walk home 😭🙏 #wallgame",
  "YouTube title: bro thought he was safe... #wallgame #gaming #boardgames",
  `YouTube description: bro thought he could just walk home 😭🙏 Play Wall Game: ${YOUTUBE_LINK}`,
  "TikTok: bro thought he could just walk home 😭🙏 #wallgame #gaming #boardgames",
  "Instagram: bro thought he could just walk home 😭🙏 #wallgame #gaming #boardgames",
  "Facebook: bro thought he could just walk home 😭🙏 #wallgame",
  `Bluesky: bro thought he could just walk home 😭🙏 ${trackedLink("bluesky")} #wallgame`,
  "Threads: bro thought he could just walk home 😭🙏 #wallgame",
].join("\n");
const COPY = { ...parseCopy(BLOCK).copy!, version: "growth-copy-1" };

/** The parts of an item (store.mjs) that these tests read. */
interface Item {
  id: string;
  state: string;
  gameId: string;
  render: { finishedAt: string; video: { path: string; sha256: string } };
  copy: { sha256: string; storedAt: string };
  reviews: { action: string; notes: string; by: string; at: string }[];
  approval: {
    videoSha256: string;
    copySha256: string;
    by: string;
    at: string;
  } | null;
  posts: Record<string, unknown>;
  events: { what: string }[];
  posting?: unknown;
  directorNote: { text: string; at: string } | null;
}

interface FeedbackRow {
  itemId: string;
  gameId: string;
  edlSha256: string;
  videoSha256: string;
  copySha256: string;
  action: string;
  notes: string;
  by: string;
}

/** What reviewView gives the page (the parts these tests read). */
interface View {
  item: {
    id: string;
    videoSha256: string;
    copySha256: string;
    copy: string[];
    music: {
      track: string;
      credit: string | null;
      license: string;
      mayPlay: boolean;
    }[];
    directorNote: string | null;
    approveProblem: string | null;
    sameGame: { id: string; state: string }[];
  } | null;
  review: { count: number; target: number };
  ready: { count: number; days: number; items: { id: string }[] };
  lastReview: { stale: boolean; action: string } | null;
}
const viewOf = (...a: Parameters<typeof reviewView>) =>
  reviewView(...a) as unknown as View;

/** Nil's feedback rows. */
const feedbackOf = (store: ReturnType<typeof openStore>) =>
  readPostLog(store.feedbackLog) as unknown as FeedbackRow[];

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/**
 * A data dir with one finished item whose block is for its video: in
 * review. Its MP4 is a small file with known bytes.
 */
const withItemInReview = (id = "v-2026-10-28-1") => {
  const dir = mkdtempSync(join(tmpdir(), "daily-review-test-"));
  const store = openStore(dir);
  const path = join(store.dirs.videos, `${id}.mp4`);
  writeFileSync(path, `video of ${id}`);
  const video = sha(`video of ${id}`);
  const item = {
    version: ITEM_VERSION,
    id,
    createdAt: "2026-10-27T08:00:00.000Z",
    updatedAt: "2026-10-27T09:00:00.000Z",
    gameId: "GAME1",
    source: { report: null, reportCreatedAt: null, gameId: "GAME1" },
    candidate: {
      gameId: "GAME1",
      seats: [{ name: "Guest Tuatara" }, { name: "Ruby" }],
    },
    style: "daily",
    styleVersion: "caption-1",
    edl: { sha256: "edl1", doc: {}, text: "{}", summary: [] },
    render: {
      jobId: "j1",
      finishedAt: "2026-10-27T09:00:00.000Z",
      error: null,
      video: { path, bytes: 10, sha256: video, durationSeconds: 20 },
      music: [{ fromPly: 0, track: "deja-vus" }],
    },
    check: { ok: true, verdicts: [] },
    caption: "bro thought he was safe",
    payoff: { text: "he was not" },
    copy: {
      block: COPY,
      sha256: copySha256(COPY),
      forVideoSha256: video,
      storedAt: "2026-10-27T09:10:00.000Z",
    },
    directorNote: null,
    state: "finished",
    reviews: [],
    approval: null,
    posts: {},
    events: [],
  };
  writeFileSync(join(store.dirs.items, `${id}.json`), JSON.stringify(item));
  return { dir, store, video, block: copySha256(COPY), path };
};

describe("store.review: Nil's action on an item in review", () => {
  test("approve binds the video and the block he saw; the row and the item say so", () => {
    const { store, video, block } = withItemInReview();
    const out = store.review("v-2026-10-28-1", {
      action: "approve",
      notes: "",
      videoSha256: video,
      copySha256: block,
      by: "Nil",
      memberId: REVIEWER_MEMBER_ID,
    }) as Item;
    expect(out.state).toBe("approved");
    expect(out.approval).toEqual({
      videoSha256: video,
      copySha256: block,
      by: "Nil",
      at: out.reviews[0].at,
    });
    expect(store.approvedQueue().map((it: Item) => it.id)).toEqual([
      "v-2026-10-28-1",
    ]);
    const rows = feedbackOf(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: "v-2026-10-28-1",
      gameId: "GAME1",
      edlSha256: "edl1",
      videoSha256: video,
      copySha256: block,
      action: "approve",
      notes: "",
      by: "Nil",
    });
  });

  test("discard and revise need notes; the notes are kept word for word", () => {
    const { store, video, block } = withItemInReview();
    for (const action of ["discard", "revise"]) {
      expect(() => {
        store.review("v-2026-10-28-1", {
          action,
          notes: "  \n ",
          videoSha256: video,
          copySha256: block,
          by: "Nil",
          memberId: REVIEWER_MEMBER_ID,
        });
      }).toThrow(`${action} needs notes`);
    }
    const notes = "  the FAHHH comes late; cut ply 3\n(keep the laugh)  ";
    const out = store.review("v-2026-10-28-1", {
      action: "revise",
      notes,
      videoSha256: video,
      copySha256: block,
      by: "Nil",
      memberId: REVIEWER_MEMBER_ID,
    }) as Item;
    // Revise: a draft again, same id, back to the director.
    expect(out.state).toBe("draft");
    expect(out.approval).toBeNull();
    expect(out.reviews.at(-1)?.notes).toBe(notes);
    expect(feedbackOf(store)[0].notes).toBe(notes);
  });

  test("only an item in review, and only with the hashes of the video and block it has now", () => {
    const { store, video, block, path } = withItemInReview();
    const act = (over: Record<string, unknown>): void => {
      store.review("v-2026-10-28-1", {
        action: "approve",
        notes: "",
        videoSha256: video,
        copySha256: block,
        by: "Nil",
        memberId: REVIEWER_MEMBER_ID,
        ...over,
      });
    };
    expect(() => act({ videoSha256: "older render" })).toThrow(
      "has a new video since the page showed it",
    );
    expect(() => act({ copySha256: "older block" })).toThrow(
      "has a new copy block since the page showed it",
    );
    expect(() => act({ action: "post" })).toThrow("a review action is");
    // The file on disk must still be the record's video.
    writeFileSync(path, "other bytes");
    expect(() => act({})).toThrow("video file is not the one in its record");
    writeFileSync(path, "video of v-2026-10-28-1");
    act({});
    // Approved: no second action.
    expect(() => act({ action: "discard", notes: "no" })).toThrow(
      "v-2026-10-28-1 is approved",
    );
    expect(readPostLog(store.feedbackLog)).toHaveLength(1);
  });

  test("after a revise, the item is in review again only with a new render AND a new block", () => {
    const { store, video, block } = withItemInReview();
    store.review("v-2026-10-28-1", {
      action: "revise",
      notes: "shorter",
      videoSha256: video,
      copySha256: block,
      by: "Nil",
      memberId: REVIEWER_MEMBER_ID,
    });
    // The director's check passes again on the same render: not enough.
    store.updateItem(
      "v-2026-10-28-1",
      ["draft"],
      (it: Item) => {
        it.state = "finished";
      },
      "check (test)",
    );
    const item = () => store.item("v-2026-10-28-1") as Item;
    expect(reviewState(item())).toBe("waiting-copy");
    expect(store.inReview()).toEqual([]);
  });

  test("the review never writes the poster's states or posts", () => {
    for (const [action, notes] of [
      ["approve", ""],
      ["discard", "no"],
      ["revise", "redo"],
    ]) {
      const { store, video, block } = withItemInReview();
      const out = store.review("v-2026-10-28-1", {
        action,
        notes,
        videoSha256: video,
        copySha256: block,
        by: "Nil",
        memberId: REVIEWER_MEMBER_ID,
      }) as Item;
      expect(["approved", "discarded", "draft"]).toContain(out.state);
      expect(out.posts).toEqual({});
      expect(out.posting).toBeUndefined();
    }
  });
});

/** A copy of the item in review as another item of the same game. */
const sameGameItem = (
  store: ReturnType<typeof openStore>,
  id: string,
  state: string,
) => {
  const it = store.item("v-2026-10-28-1") as Item;
  // An item that posts or posted has Nil's approval.
  const approved = ["approved", "posting", "posted", "post-failed"];
  const other = {
    ...it,
    id,
    state,
    createdAt: "2026-10-27T07:00:00.000Z",
    approval: approved.includes(state)
      ? {
          videoSha256: it.render.video.sha256,
          copySha256: it.copy.sha256,
          by: "Nil",
          at: "2026-10-27T10:00:00.000Z",
        }
      : null,
  };
  writeFileSync(join(store.dirs.items, `${id}.json`), JSON.stringify(other));
};

const approveAs = (
  store: ReturnType<typeof openStore>,
  video: string,
  block: string,
  id = "v-2026-10-28-1",
) =>
  store.review(id, {
    action: "approve",
    notes: "",
    videoSha256: video,
    copySha256: block,
    by: "Nil",
    memberId: REVIEWER_MEMBER_ID,
  }) as Item;

describe("only one video of a game posts (Wall Game Director, 2026-10-28)", () => {
  test("approve is refused while another item of the game is approved, posting, posted or post-failed; nothing is written", () => {
    for (const [state, why] of [
      ["approved", "withdraw it, or discard this one"],
      ["posting", "only one video of a game posts; discard this one"],
      ["posted", "only one video of a game posts; discard this one"],
      ["post-failed", "only one video of a game posts; discard this one"],
    ]) {
      const { store, video, block } = withItemInReview();
      sameGameItem(store, "v-2026-10-27-2", state);
      expect(() => approveAs(store, video, block)).toThrow(
        `another video of this game is ${state} (v-2026-10-27-2): ${why}`,
      );
      const it = store.item("v-2026-10-28-1") as Item;
      expect([it.state, it.approval, it.reviews]).toEqual([
        "finished",
        null,
        [],
      ]);
      expect(feedbackOf(store)).toEqual([]);
    }
  });

  test("the page disables Approve with the reason, and names the other video", () => {
    const { store } = withItemInReview();
    sameGameItem(store, "v-2026-10-27-2", "approved");
    const v = viewOf(store, { modes: {}, nowMs: Date.now() });
    expect(v.item?.sameGame).toEqual([
      { id: "v-2026-10-27-2", state: "approved" },
    ]);
    expect(v.item?.approveProblem).toBe(
      "another video of this game is approved (v-2026-10-27-2): withdraw it, or discard this one",
    );
    // Withdrawn, the other one no longer blocks it.
    store.withdraw("v-2026-10-27-2", { notes: "", by: "Nil", memberId: "x" });
    expect(
      viewOf(store, { modes: {}, nowMs: Date.now() }).item?.approveProblem,
    ).toBeNull();
  });

  test("two videos of a game may be in work or in review together, and one of them is approved", () => {
    for (const state of ["draft", "finished", "discarded"]) {
      const { store, video, block } = withItemInReview();
      sameGameItem(store, "v-2026-10-27-2", state);
      expect(approveAs(store, video, block).state).toBe("approved");
    }
  });

  test("pick refuses a game that posts or posted, and names an item of it in work or in review", () => {
    const candidate = {
      gameId: "GAME1",
      seats: [{ name: "Guest Tuatara" }, { name: "Ruby" }],
    };
    const pick = (store: ReturnType<typeof openStore>) =>
      store.pick({
        candidate,
        style: "daily",
        styleVersion: "caption-1",
        source: { report: null, reportCreatedAt: null, gameId: "GAME1" },
      }) as { id: string; gameId: string };
    for (const state of ["approved", "posting", "posted", "post-failed"]) {
      const { store } = withItemInReview();
      sameGameItem(store, "v-2026-10-27-2", state);
      expect(() => pick(store)).toThrow(
        `another video of GAME1 is ${state} (v-2026-10-27-2): only one video of a game posts`,
      );
      expect(store.items().length).toBe(2);
    }
    // In review (the fixture) and in work: picked, with both named.
    const { store } = withItemInReview();
    sameGameItem(store, "v-2026-10-27-2", "draft");
    const item = pick(store);
    expect(store.sameGame(item)).toEqual([
      { id: "v-2026-10-27-2", state: "draft" },
      { id: "v-2026-10-28-1", state: "finished" },
    ]);
    // A posted game is done: no carry-over from it.
    sameGameItem(store, "v-2026-10-27-3", "posted");
    expect(() =>
      store.pick({
        candidate,
        style: "daily",
        styleVersion: "caption-1",
        source: { carriedFrom: "v-2026-10-27-3" },
      }),
    ).toThrow("another video of GAME1 is posted (v-2026-10-27-3)");
  });
});

describe("music that may not play is never approved (Video Reviewer 2, 2026-10-28)", () => {
  test("approve is refused, the page marks the track and disables Approve", () => {
    const { store, video, block } = withItemInReview();
    const it = store.item("v-2026-10-28-1") as Item;
    writeFileSync(
      join(store.dirs.items, "v-2026-10-28-1.json"),
      JSON.stringify({
        ...it,
        render: {
          ...it.render,
          music: [
            { fromPly: 0, track: "deja-vus" },
            { fromPly: 10, track: "tea-for-two" },
          ],
        },
      }),
    );
    const v = viewOf(store, { modes: {}, nowMs: Date.now() });
    expect(v.item?.music.map((m) => [m.track, m.license, m.mayPlay])).toEqual([
      ["deja-vus", "ok-with-credit", true],
      ["tea-for-two", "blocked-until-nil", false],
    ]);
    const why =
      "the music tea-for-two has the license blocked-until-nil: re-direct with a track that may play";
    expect(v.item?.approveProblem).toBe(why);
    expect(() => approveAs(store, video, block)).toThrow(why);
    expect((store.item("v-2026-10-28-1") as Item).state).toBe("finished");
    expect(feedbackOf(store)).toEqual([]);
    // Revise and discard still work.
    expect(
      (
        store.review("v-2026-10-28-1", {
          action: "revise",
          notes: "another track",
          videoSha256: video,
          copySha256: block,
          by: "Nil",
          memberId: REVIEWER_MEMBER_ID,
        }) as Item
      ).state,
    ).toBe("draft");
  });

  test("a track that is not in the table is refused too", () => {
    const { store, video, block } = withItemInReview();
    const it = store.item("v-2026-10-28-1") as Item;
    writeFileSync(
      join(store.dirs.items, "v-2026-10-28-1.json"),
      JSON.stringify({
        ...it,
        render: { ...it.render, music: [{ fromPly: 0, track: "nope" }] },
      }),
    );
    expect(() => approveAs(store, video, block)).toThrow(
      "the music nope has the license unknown",
    );
  });
});

describe("withdraw: Nil takes back an approval that no slot took", () => {
  test("the item is in review again with the same video and block; a feedback row, notes optional", () => {
    const { store, video, block } = withItemInReview();
    approveAs(store, video, block);
    const out = store.withdraw("v-2026-10-28-1", {
      notes: "",
      by: "Nil",
      memberId: REVIEWER_MEMBER_ID,
    }) as Item;
    expect(out.state).toBe("finished");
    expect(out.approval).toBeNull();
    expect(reviewState(out)).toBe("in-review");
    expect(store.approvedQueue()).toEqual([]);
    expect(out.reviews.map((r) => r.action)).toEqual(["approve", "withdraw"]);
    expect(feedbackOf(store).map((r) => [r.action, r.notes])).toEqual([
      ["approve", ""],
      ["withdraw", ""],
    ]);
    // Approved again: it binds the same content.
    expect(approveAs(store, video, block).approval?.videoSha256).toBe(video);
  });

  test("refused once a slot took the item, and for an item that is not approved", () => {
    for (const state of ["posting", "posted", "post-failed"]) {
      const { store } = withItemInReview();
      sameGameItem(store, "v-2026-10-27-2", state);
      expect(
        () =>
          void store.withdraw("v-2026-10-27-2", {
            notes: "",
            by: "Nil",
            memberId: "x",
          }),
      ).toThrow(
        `a slot took v-2026-10-27-2 already (${state}): it can no longer be withdrawn`,
      );
      expect((store.item("v-2026-10-27-2") as Item).state).toBe(state);
    }
    const { store } = withItemInReview();
    expect(
      () =>
        void store.withdraw("v-2026-10-28-1", {
          notes: "",
          by: "Nil",
          memberId: "x",
        }),
    ).toThrow("v-2026-10-28-1 is finished; only an approved item is withdrawn");
    expect(feedbackOf(store)).toEqual([]);
  });
});

describe("the director's note", () => {
  test("one line of at most 100 characters, set in production, shown above the video, frozen in review", () => {
    const { store } = withItemInReview();
    const id = "v-2026-10-28-1";
    // The fixture is in review: frozen.
    expect(() => void store.setNote(id, "watch the save at 0:18")).toThrow(
      `${id} is in review: its note is frozen`,
    );
    // Revised, it is a draft again: the note opens.
    const it = store.item(id) as Item;
    writeFileSync(
      join(store.dirs.items, `${id}.json`),
      JSON.stringify({ ...it, state: "draft" }),
    );
    for (const bad of ["", "  ", "two\nlines", "x".repeat(101)]) {
      expect(() => void store.setNote(id, bad)).toThrow(
        "the director's note is one line of 1 to 100 characters",
      );
    }
    const out = store.setNote(id, " watch the save at 0:18 ") as Item;
    expect(out.directorNote?.text).toBe("watch the save at 0:18");
    expect(out.events.at(-1)?.what).toBe(
      "director's note: watch the save at 0:18",
    );
    writeFileSync(
      join(store.dirs.items, `${id}.json`),
      JSON.stringify({ ...out, state: "finished" }),
    );
    const v = viewOf(store, { modes: {}, nowMs: Date.now() });
    expect(v.item?.directorNote).toBe("watch the save at 0:18");
  });
});

describe("the review page's view", () => {
  test("the line next to Approve names what is live now, not a slot time", () => {
    const dry = {
      x: "dry-run",
      youtube: "dry-run",
      tiktok: "dry-run",
      instagram: "dry-run",
      facebook: "dry-run",
      bluesky: "dry-run",
      threads: "dry-run",
    };
    expect(approveLine(dry)).toBe(
      "Posts at the next slot to every platform that is live then; now: none (a dry run posts nothing).",
    );
    expect(approveLine({ ...dry, x: "live", tiktok: "live" })).toBe(
      "Posts at the next slot to every platform that is live then; now: X, TikTok draft.",
    );
  });

  test("the oldest item in review, its block word for word, the counts and the age of the last review", () => {
    const { store } = withItemInReview();
    store.setReviewTarget(5);
    const nowMs = Date.parse("2026-10-31T09:00:00.000Z");
    const v = viewOf(store, { modes: {}, nowMs });
    expect(v.item?.id).toBe("v-2026-10-28-1");
    expect(v.item?.copy[0]).toBe(
      "X: bro thought he could just walk home 😭🙏 #wallgame",
    );
    expect(v.item?.music).toEqual([
      expect.objectContaining({
        track: "deja-vus",
        credit: "Deja Vus by YannZ (CC BY 4.0)",
      }),
    ]);
    expect(v.review).toEqual({ count: 1, target: 5 });
    expect(v.ready).toEqual({ count: 0, days: 0, items: [] });
    expect(v.lastReview).toBeNull();
    store.review("v-2026-10-28-1", {
      action: "approve",
      notes: "",
      videoSha256: v.item!.videoSha256,
      copySha256: v.item!.copySha256,
      by: "Nil",
      memberId: REVIEWER_MEMBER_ID,
    });
    const after = viewOf(store, { modes: {}, nowMs });
    expect(after.item).toBeNull();
    expect(after.ready).toMatchObject({
      count: 1,
      days: 1,
      items: [
        {
          id: "v-2026-10-28-1",
          players: ["Guest Tuatara", "Ruby"],
          caption: "bro thought he was safe",
        },
      ],
    });
    // Today's review, read three days later: over 48 h, marked.
    expect(after.lastReview?.stale).toBe(true);
    expect(after.lastReview?.action).toBe("approve");
  });

  test("the review target is a whole number from 1 to 50, 3 until set", () => {
    const { store } = withItemInReview();
    expect(store.queue()).toEqual({ reviewTarget: 3 });
    expect(() => {
      store.setReviewTarget(0);
    }).toThrow("1 to 50");
    expect(() => {
      store.setReviewTarget(2.5);
    }).toThrow("1 to 50");
    expect(store.setReviewTarget(10)).toEqual({ reviewTarget: 10 });
  });
});

describe("the review routes", () => {
  const servers: Server[] = [];
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const stop of stops.splice(0)) stop();
  });

  /** The app's daily routes on a port, with a recorder for messages. */
  const serve = async (dir: string, fails = false) => {
    const sent: { to: string; text: string }[] = [];
    const daily = createDaily({
      dataDir: dir,
      env: {},
      send: (to: string, text: string) => {
        if (fails) return Promise.reject(new Error("office down"));
        sent.push({ to, text });
        return Promise.resolve();
      },
    });
    stops.push(() => daily.stop());
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void daily.handle(req, res, url).then((done: boolean) => {
        if (!done) res.writeHead(404).end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (
      path: string,
      {
        method = "GET",
        member,
        body,
      }: { method?: string; member?: string; body?: object } = {},
    ) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body && { "content-type": "application/json" }),
          ...(member && {
            "x-isomux-member-id": member,
            "x-isomux-member-name": encodeURIComponent("Nil"),
          }),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, text };
    };
    return { call, sent };
  };

  test("only Nil, through the office, acts; anyone may look", async () => {
    const { dir, store, video, block } = withItemInReview();
    const { call, sent } = await serve(dir);
    const body = { notes: "", videoSha256: video, copySha256: block };
    const path = "/api/review/v-2026-10-28-1/approve";
    // No member: not through the office (crew.mjs, a poster, a process on
    // the box that does not set the header).
    const none = await call(path, { method: "POST", body });
    expect(none.status).toBe(403);
    const other = await call(path, {
      method: "POST",
      body,
      member: "someone-else",
    });
    expect(other.status).toBe(403);
    expect((JSON.parse(other.text) as { error: string }).error).toBe(
      "only Nil reviews videos",
    );
    expect(sent).toEqual([]);
    // Nothing was written.
    expect((store.item("v-2026-10-28-1") as Item).state).toBe("finished");
    expect(feedbackOf(store)).toEqual([]);
    const page = await call("/review", { member: "someone-else" });
    expect(page.status).toBe(200);
    const view = JSON.parse(
      (await call("/api/review/queue", { member: "someone-else" })).text,
    ) as View & { canReview: boolean };
    expect(view.canReview).toBe(false);
    expect(view.item?.id).toBe("v-2026-10-28-1");
    const nil = JSON.parse(
      (await call("/api/review/queue", { member: REVIEWER_MEMBER_ID })).text,
    ) as { canReview: boolean };
    expect(nil.canReview).toBe(true);
  });

  test("each action goes to the director at once: item, action, game, notes verbatim, video", async () => {
    const { dir, video, block, path } = withItemInReview();
    const { call, sent } = await serve(dir);
    const notes = 'the "bro" caption is great; keep it';
    const res = await call("/api/review/v-2026-10-28-1/discard", {
      method: "POST",
      member: REVIEWER_MEMBER_ID,
      body: { notes, videoSha256: video, copySha256: block },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      id: "v-2026-10-28-1",
      state: "discarded",
      directorTold: true,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(DIRECTOR_AGENT_ID);
    expect(sent[0].text).toContain("DISCARD on v-2026-10-28-1 (game GAME1)");
    expect(sent[0].text).toContain(`Notes, verbatim: ${JSON.stringify(notes)}`);
    expect(sent[0].text).toContain(`Video: ${path}`);
    // A stale page: refused, and nothing is sent.
    const again = await call("/api/review/v-2026-10-28-1/approve", {
      method: "POST",
      member: REVIEWER_MEMBER_ID,
      body: { notes: "", videoSha256: video, copySha256: block },
    });
    expect(again.status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  test("a message the office does not take: the action counts, the row is stored, the page is told", async () => {
    const { dir, store, video, block } = withItemInReview();
    const { call } = await serve(dir, true);
    const res = await call("/api/review/v-2026-10-28-1/approve", {
      method: "POST",
      member: REVIEWER_MEMBER_ID,
      body: { notes: "", videoSha256: video, copySha256: block },
    });
    expect(res.status).toBe(200);
    expect(
      (JSON.parse(res.text) as { directorTold: boolean }).directorTold,
    ).toBe(false);
    expect((store.item("v-2026-10-28-1") as Item).state).toBe("approved");
    expect(readPostLog(store.feedbackLog)).toHaveLength(1);
  });

  test("Withdraw on a READY item: only Nil, back in review, the director told; the page lists the READY items", async () => {
    const { dir, store, video, block } = withItemInReview();
    const { call, sent } = await serve(dir);
    approveAs(store, video, block);
    const view = JSON.parse(
      (await call("/api/review/queue", { member: REVIEWER_MEMBER_ID })).text,
    ) as View;
    expect(view.item).toBeNull();
    expect(view.ready.items.map((r) => r.id)).toEqual(["v-2026-10-28-1"]);
    const path = "/api/review/v-2026-10-28-1/withdraw";
    const other = await call(path, {
      method: "POST",
      member: "someone-else",
      body: { notes: "" },
    });
    expect(other.status).toBe(403);
    const res = await call(path, {
      method: "POST",
      member: REVIEWER_MEMBER_ID,
      body: { notes: "mis-tap" },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      id: "v-2026-10-28-1",
      state: "finished",
      directorTold: true,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("WITHDRAW on v-2026-10-28-1");
    expect(sent[0].text).toContain('Notes, verbatim: "mis-tap"');
    expect(sent[0].text).toContain("in review again");
    // Twice: refused, nothing more is sent.
    const again = await call(path, {
      method: "POST",
      member: REVIEWER_MEMBER_ID,
      body: { notes: "" },
    });
    expect(again.status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  test("crew.mjs cannot reach the review actions: it never sends the member header", () => {
    const crew = readFileSync(join(import.meta.dir, "crew.mjs"), "utf8");
    expect(crew).not.toMatch(/x-isomux-member/i);
    expect(crew).not.toContain("/api/review/");
  });

  test("the director's message for each action says what to do next", () => {
    const { store } = withItemInReview();
    const item = store.item("v-2026-10-28-1") as Item;
    expect(directorText(item, "revise", "x")).toContain(
      "make a new render, then get a new block",
    );
    expect(directorText(item, "approve", "")).toContain(
      "Notes, verbatim: (none)",
    );
  });
});

describe("what the director reads", () => {
  test("crew feedback prints a review row and an old ask row, notes and replies verbatim", () => {
    expect(
      feedbackLines({
        utc: "2026-10-29T17:00:00.000Z",
        itemId: "v-2026-10-29-1",
        gameId: "GAME1",
        edlSha256: "e".repeat(64),
        videoSha256: "v".repeat(64),
        copySha256: "c".repeat(64),
        action: "revise",
        notes: 'cut the "bro" line',
        by: "Nil",
      }),
    ).toEqual([
      "v-2026-10-29-1 (game GAME1): revise by Nil at 2026-10-29T17:00:00.000Z, video vvvvvvvvvvvv, edit list eeeeeeeeeeee",
      '  notes, verbatim: "cut the \\"bro\\" line"',
    ]);
    // The rows from before the review queue stay in the log.
    expect(
      feedbackLines({
        utc: "2026-10-27T21:00:00.000Z",
        day: "2026-10-27",
        askId: "ask-two",
        approver: "Nil",
        picked: "B",
        reply: "B, the save reads best",
        recommended: { label: "A", why: "the cleaner save" },
        offered: [
          {
            label: "A",
            gameId: "G1",
            edlSha256: "a".repeat(64),
            videoSha256: "b".repeat(64),
            caption: "bro thought",
          },
        ],
      }),
    ).toEqual([
      "2026-10-27 ask ask-two: B picked by Nil at 2026-10-27T21:00:00.000Z",
      "  you recommended A: the cleaner save",
      '  A: game G1, edit list aaaaaaaaaaaa, video bbbbbbbbbbbb, caption "bro thought"',
      '  reply, verbatim: "B, the save reads best"',
    ]);
  });

  test("another live video of the same game is named, so Nil does not approve both", () => {
    const { store } = withItemInReview("v-2026-10-28-1");
    sameGameItem(store, "v-2026-10-28-2", "approved");
    sameGameItem(store, "v-2026-10-28-3", "discarded");
    const v = reviewView(store, { modes: {}, nowMs: Date.now() }) as {
      item: { id: string; sameGame: { id: string; state: string }[] };
    };
    expect(v.item.id).toBe("v-2026-10-28-1");
    expect(v.item.sameGame).toEqual([
      { id: "v-2026-10-28-2", state: "approved" },
    ]);
  });
});
