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
import {
  ITEM_VERSION,
  StepRefused,
  fixedApprovalProblem,
  openStore,
  readPostLog,
  reviewState,
} from "./store.mjs";
import { byteRange, createDaily } from "./routes.mjs";
import { DIRECTOR_AGENT_ID } from "./office.mjs";
import {
  askRecordLine,
  feedbackLines,
  holdLine,
  storyWarning,
  timingLines,
} from "./crew.mjs";
import { noStoryLine, STORY_MAX_BYTES } from "./post-instagram.mjs";
import { quoteLines } from "./quote.mjs";
import {
  REVIEW_PAGE,
  REVIEWER_MEMBER_ID,
  postCaption,
  directorText,
  reviewView,
  versionLine,
  approvedLine,
  carriedScriptLine,
} from "./review.mjs";
import {
  APP_NAME,
  ASK_OPTIONS,
  askAgain,
  openAskRecords,
  parseAnswer,
  reviewBatchAfter,
  syncReviewAsks,
} from "./review-asks.mjs";

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
/** An approval from Nil's revise's own words (store.approveFixed). */
interface Fixed {
  askId: string;
  words: string;
  revisedVideoSha256: string;
  armedBy: string;
}

interface Item {
  id: string;
  state: string;
  gameId: string;
  render: { finishedAt: string; video: { path: string; sha256: string } };
  copy: { sha256: string; storedAt: string };
  reviews: {
    action: string;
    notes: string;
    by: string;
    at: string;
    askId?: string;
    fixed?: Fixed;
  }[];
  approval: {
    videoSha256: string;
    copySha256: string;
    by: string;
    at: string;
    fixed?: Fixed;
  } | null;
  posts: Record<string, unknown>;
  events: { what: string }[];
  posting?: unknown;
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

/** What reviewView gives the page. */
interface View {
  items: {
    id: string;
    videoSha256: string;
    copySha256: string;
    caption: string;
    approveProblem: string | null;
    claimRiskSounds: string[];
    youtubeTitle: string | null;
    noStory: string | null;
    version: string | null;
    scriptCarried: string | null;
  }[];
  approved: { id: string; caption: string; when: string }[];
}
/** A next slot that posts (scheduler.mjs status nextSlot). */
const NEXT_SLOT = {
  pacific: "Fri 2026-10-30 09:00 PT",
  willPost: true,
  why: null,
};
const viewOf = (
  store: Parameters<typeof reviewView>[0],
  nextSlot: Parameters<typeof reviewView>[1] = NEXT_SLOT,
) => reviewView(store, nextSlot) as unknown as View;

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
    edl: {
      sha256: "edl1",
      doc: { vsSound: "shotgun-2", finishSound: "trombone-1", events: [] },
      text: "{}",
      summary: [],
    },
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
    vets: [
      {
        videoSha256: video,
        reviewer: "Video Reviewer 2",
        verdict: "pass",
        notes: "ok",
        at: "2026-10-27T09:05:00.000Z",
      },
    ],
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

  test("a vet that fails after Growth's block takes the item out of review; approve is refused", () => {
    const { store, video, block } = withItemInReview();
    store.recordVet("v-2026-10-28-1", {
      videoSha256: video,
      reviewer: "Video Reviewer 1",
      verdict: "fail",
      notes: "a pawn under the panel",
    });
    expect(reviewState(store.item("v-2026-10-28-1"))).toBe("waiting-copy");
    expect(store.inReview()).toEqual([]);
    expect(() => {
      store.review("v-2026-10-28-1", {
        action: "approve",
        notes: "",
        videoSha256: video,
        copySha256: block,
        by: "Nil",
        memberId: REVIEWER_MEMBER_ID,
      });
    }).toThrow(
      /v-2026-10-28-1 is not in review: the independent review of v-2026-10-28-1's video by Video Reviewer 1 at .* failed; re-direct, or vet the video again/,
    );
    expect((store.item("v-2026-10-28-1") as Item).state).toBe("finished");
    expect(feedbackOf(store)).toEqual([]);
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

describe("a card names the other videos of its game (Nil, 2026-10-29, C15)", () => {
  test("one line, from the rule pick uses: the other item and its state as the page says it", () => {
    for (const [state, shown] of [
      ["draft", "draft"],
      ["finished", "in review"],
      ["approved", "approved"],
      ["posted", "posted"],
    ]) {
      const { store } = withItemInReview();
      const gameId = (store.item("v-2026-10-28-1") as Item).gameId;
      sameGameItem(store, "v-2026-10-27-2", state);
      const mine = viewOf(store).items.find((x) => x.id === "v-2026-10-28-1");
      expect(mine?.version).toBe(
        `one of 2 videos of game ${gameId}; the other is v-2026-10-27-2 (${shown})`,
      );
    }
  });

  test("both cards of a two-video game say the same count: the older one never reads as the remake", () => {
    const { store } = withItemInReview();
    const gameId = (store.item("v-2026-10-28-1") as Item).gameId;
    sameGameItem(store, "v-2026-10-27-2", "finished");
    const lines = viewOf(store).items.map((x) => x.version);
    expect(lines).toEqual([
      `one of 2 videos of game ${gameId}; the other is v-2026-10-28-1 (in review)`,
      `one of 2 videos of game ${gameId}; the other is v-2026-10-27-2 (in review)`,
    ]);
  });

  test("no line when the game has no other item, or only a discarded one", () => {
    const { store } = withItemInReview();
    expect(viewOf(store).items[0].version).toBeNull();
    sameGameItem(store, "v-2026-10-27-2", "discarded");
    expect(viewOf(store).items[0].version).toBeNull();
  });

  test("three videos of a game: a count, the others named", () => {
    expect(
      versionLine({ gameId: "VX-IPenv" }, [
        { id: "v-a", shown: "posted" },
        { id: "v-b", shown: "draft" },
      ]),
    ).toBe(
      "one of 3 videos of game VX-IPenv; the others are v-a (posted), v-b (draft)",
    );
  });
});

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

  test("the page disables Approve with the reason, which names the other video", () => {
    const { store } = withItemInReview();
    sameGameItem(store, "v-2026-10-27-2", "approved");
    const v = viewOf(store);
    expect(v.items[0].approveProblem).toBe(
      "another video of this game is approved (v-2026-10-27-2): withdraw it, or discard this one",
    );
    // Withdrawn, the other one no longer blocks it.
    store.withdraw("v-2026-10-27-2", { notes: "", by: "Nil", memberId: "x" });
    expect(viewOf(store).items[0].approveProblem).toBeNull();
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
      { id: "v-2026-10-27-2", state: "draft", shown: "draft" },
      { id: "v-2026-10-28-1", state: "finished", shown: "in review" },
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
    const v = viewOf(store);
    const why =
      "the music tea-for-two has the license blocked-until-nil: re-direct with a track that may play";
    expect(v.items[0].approveProblem).toBe(why);
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

describe("the review page's view", () => {
  test("Nil, 2026-10-28: the page gets only the video, its caption and what the card needs", () => {
    const { store } = withItemInReview();
    expect(Object.keys(viewOf(store).items[0]).sort()).toEqual([
      "approveProblem",
      "caption",
      "claimRiskSounds",
      "copySha256",
      "id",
      "noStory",
      "scriptCarried",
      "version",
      "videoSha256",
      "youtubeTitle",
    ]);
    expect(viewOf(store).items[0].noStory).toBeNull();
    expect(viewOf(store).items[0].scriptCarried).toBeNull();
  });

  test("a video rendered from a script carried over Nil's revise: the card says no fresh reviewer read it (VR1, review 100)", () => {
    const { store } = withItemInReview();
    const pass = {
      at: "2026-10-30T14:02:11.000Z",
      reviewer: "Wall Game Director",
      verdict: "pass",
      notes: "SCRIPT UNCHANGED ...",
      script: "s",
      scriptSha256: "abc",
      carried: {
        from: "2026-10-30T09:41:05.123Z",
        revisedAt: "2026-10-30T13:00:00.000Z",
        why: "a sound only",
      },
    };
    store.updateItem(
      "v-2026-10-28-1",
      ["finished"],
      (it: Record<string, unknown> & { render: Record<string, unknown> }) => {
        it.scriptReviews = [pass];
        it.render.scriptReview = {
          at: pass.at,
          scriptSha256: pass.scriptSha256,
        };
      },
      "a carried script (test)",
    );
    expect(viewOf(store).items[0].scriptCarried).toBe(
      "Script unchanged (carried from the script review of 2026-10-30 09:41 UTC).",
    );
    expect(REVIEW_PAGE).toContain("it.scriptCarried");
    // A fresh review: no line.
    expect(carriedScriptLine({ ...pass, carried: undefined })).toBeNull();
  });

  test("a video over 60 s: the card tells Nil it posts no Instagram Story", () => {
    const { store } = withItemInReview();
    store.updateItem(
      "v-2026-10-28-1",
      ["finished"],
      (it: { render: { video: { durationSeconds: number } } }) => {
        it.render.video.durationSeconds = 72.5;
      },
      "a long render (test)",
    );
    expect(viewOf(store).items[0].noStory).toBe(
      "No Instagram Story: the video is 72.5 s (Stories take 60 s at most).",
    );
    // Approve still works: Nil approves the exception knowingly.
    expect(viewOf(store).items[0].approveProblem).toBeNull();
  });

  test("every item in review, oldest first, with its caption: the post's X line without the music credit", () => {
    const { store } = withItemInReview("v-2026-10-28-2");
    // A second item in review, older, whose block carries a music credit.
    const it = store.item("v-2026-10-28-2") as Item & {
      copy: { block: Record<string, string> };
    };
    const credited = {
      ...it.copy.block,
      x: "bro was free 😭💀 #wallgame · music: Deja Vus by YannZ (CC BY 4.0)",
      youtubeTitle: "bro was free 😭💀 #wallgame",
    };
    writeFileSync(
      join(store.dirs.items, "v-2026-10-28-1.json"),
      JSON.stringify({
        ...it,
        id: "v-2026-10-28-1",
        createdAt: "2026-10-27T07:00:00.000Z",
        copy: { ...it.copy, block: credited },
      }),
    );
    const v = viewOf(store);
    expect(v.items.map((x) => [x.id, x.caption])).toEqual([
      ["v-2026-10-28-1", "bro was free 😭💀 #wallgame"],
      ["v-2026-10-28-2", "bro thought he could just walk home 😭🙏 #wallgame"],
    ]);
    expect(v.items[1].copySha256).toBe(copySha256(COPY));
    // The YouTube title is its own text: the card shows it, unless it is
    // the caption.
    expect(v.items[0].youtubeTitle).toBeNull();
    expect(v.items[1].youtubeTitle).toBe(
      "bro thought he was safe... #wallgame #gaming #boardgames",
    );
    expect(REVIEW_PAGE).toContain('"YouTube: " + it.youtubeTitle');
    store.review("v-2026-10-28-2", {
      action: "approve",
      notes: "",
      videoSha256: v.items[1].videoSha256,
      copySha256: v.items[1].copySha256,
      by: "Nil",
      memberId: REVIEWER_MEMBER_ID,
    });
    expect(viewOf(store).items.map((x) => x.id)).toEqual(["v-2026-10-28-1"]);
    expect(postCaption({ x: "no credit here #wallgame" })).toBe(
      "no credit here #wallgame",
    );
  });

  test("a sound with a high claim risk that the video plays: named once, from the slots and the events", () => {
    const { store } = withItemInReview();
    expect(viewOf(store).items[0].claimRiskSounds).toEqual([]);
    const it = store.item("v-2026-10-28-1") as Item & {
      edl: { doc: Record<string, unknown> };
    };
    writeFileSync(
      join(store.dirs.items, "v-2026-10-28-1.json"),
      JSON.stringify({
        ...it,
        edl: {
          ...it.edl,
          doc: {
            vsSound: "shotgun-1",
            finishSound: "trombone-1",
            events: [
              { ply: 4, kind: "laugh", sound: "laugh-1" },
              { ply: 6, kind: "zoom" },
              { ply: 9, kind: "scared", sound: "scared-1" },
              { ply: 12, kind: "laugh", sound: "laugh-1" },
            ],
          },
        },
      }),
    );
    expect(viewOf(store).items[0].claimRiskSounds).toEqual([
      "shotgun-1",
      "laugh-1",
    ]);
    expect(REVIEW_PAGE).toContain('"Uses " + key + ": a claim is possible."');
  });

  test("byteRange: one range of the file, the whole file, or unsatisfiable", () => {
    expect(byteRange(undefined, 10)).toBeNull();
    expect(byteRange("bytes=0-1", 10)).toEqual({ start: 0, end: 1 });
    expect(byteRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(byteRange("bytes=2-99", 10)).toEqual({ start: 2, end: 9 });
    expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange("bytes=-30", 10)).toEqual({ start: 0, end: 9 });
    // Several ranges, or a form this does not read: the whole file.
    expect(byteRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(byteRange("items=0-1", 10)).toBeNull();
    expect(byteRange("bytes=-", 10)).toBeNull();
    for (const h of ["bytes=10-", "bytes=5-3", "bytes=-0"]) {
      expect(byteRange(h, 10)).toBe("unsatisfiable");
    }
    expect(byteRange("bytes=0-", 0)).toBe("unsatisfiable");
  });

  test("zoom (Nil, 2026-10-28): − and +, steps of 25%, kept per browser; zoom 1 is the old size", () => {
    expect(REVIEW_PAGE).toContain('id="zoom-out"');
    expect(REVIEW_PAGE).toContain('id="zoom-in"');
    expect(REVIEW_PAGE).toContain("max-width: calc(520px * var(--z, 1))");
    expect(REVIEW_PAGE).toContain(
      // The largest video fits under the top space: its controls show.
      "max-height: min(calc(78vh * var(--z, 1)), calc(100vh - var(--top) - 8px))",
    );
    expect(REVIEW_PAGE).toContain("1.25 ** k");
    expect(REVIEW_PAGE).toContain('"review-zoom"');
  });

  test("the page puts no untrusted text in innerHTML", () => {
    // The page's own rule names innerHTML, so this looks for a write.
    expect(REVIEW_PAGE).not.toMatch(
      /(inner|outer)HTML\s*\+?=|insertAdjacentHTML|document\.write/,
    );
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
        range,
      }: {
        method?: string;
        member?: string;
        body?: object;
        range?: string;
      } = {},
    ) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body && { "content-type": "application/json" }),
          ...(range && { range }),
          ...(member && {
            "x-isomux-member-id": member,
            "x-isomux-member-name": encodeURIComponent("Nil"),
          }),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, text, headers: res.headers };
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
    expect(view.items.map((it) => it.id)).toEqual(["v-2026-10-28-1"]);
    const nil = JSON.parse(
      (await call("/api/review/queue", { member: REVIEWER_MEMBER_ID })).text,
    ) as { canReview: boolean };
    expect(nil.canReview).toBe(true);
  });

  test("the video answers byte ranges: iPhone Safari plays a <video> only from a 206", async () => {
    const { dir } = withItemInReview();
    const { call } = await serve(dir);
    const path = "/api/daily/video?item=v-2026-10-28-1";
    const whole = await call(path);
    expect([whole.status, whole.text]).toEqual([
      200,
      "video of v-2026-10-28-1",
    ]);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    // Safari's first request.
    const first = await call(path, { range: "bytes=0-1" });
    expect([first.status, first.text]).toEqual([206, "vi"]);
    expect(first.headers.get("content-range")).toBe("bytes 0-1/23");
    const tail = await call(path, { range: "bytes=9-" });
    expect([tail.status, tail.text]).toEqual([206, "v-2026-10-28-1"]);
    const out = await call(path, { range: "bytes=23-" });
    expect(out.status).toBe(416);
    expect(out.headers.get("content-range")).toBe("bytes */23");
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
    expect(sent[0].text).toContain(
      ["Notes, verbatim:", ...notes.split("\n").map((l) => `> ${l}`)].join(
        "\n",
      ),
    );
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

  test("Undo after an Approve (withdraw): only Nil, back in review, the director told", async () => {
    const { dir, store, video, block } = withItemInReview();
    const { call, sent } = await serve(dir);
    approveAs(store, video, block);
    const view = JSON.parse(
      (await call("/api/review/queue", { member: REVIEWER_MEMBER_ID })).text,
    ) as View;
    expect(view.items).toEqual([]);
    // Approved and no slot took it: the page lists it, with its caption,
    // for "Undo approval" (Nil, 2026-10-29).
    expect(view.approved).toEqual([
      {
        id: "v-2026-10-28-1",
        caption: postCaption(parseCopy(BLOCK).copy!),
        when: expect.stringMatching(/^Approved: /) as unknown as string,
      },
    ]);
    // Held (store.hold): still listed as approved, with its hold.
    store.hold("v-2026-10-28-1", "a render fault", "Wall Game PM");
    const held = JSON.parse(
      (await call("/api/review/queue", { member: REVIEWER_MEMBER_ID })).text,
    ) as View;
    expect(held.approved.map((x) => x.when)).toEqual([
      "Approved, held: it does not post (a render fault).",
    ]);
    store.release("v-2026-10-28-1", "Wall Game PM");
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
    expect(sent[0].text).toContain("Notes, verbatim:\n> mis-tap\n");
    expect(sent[0].text).toContain("in review again");
    // In review again, and no longer listed as approved.
    const after = JSON.parse(
      (await call("/api/review/queue", { member: REVIEWER_MEMBER_ID })).text,
    ) as View;
    expect(after.items.map((x) => x.id)).toEqual(["v-2026-10-28-1"]);
    expect(after.approved).toEqual([]);
    // Twice: refused, nothing more is sent.
    const again = await call(path, {
      method: "POST",
      member: REVIEWER_MEMBER_ID,
      body: { notes: "" },
    });
    expect(again.status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  test("a slot took the item (posting, posted, post-failed): not listed, so no Undo approval", () => {
    for (const state of ["posting", "posted", "post-failed"]) {
      const { store, video, block } = withItemInReview();
      approveAs(store, video, block);
      store.updateItem(
        "v-2026-10-28-1",
        ["approved"],
        (it: { state: string }) => {
          it.state = state;
        },
        "a slot took it (test)",
      );
      expect(viewOf(store).approved).toEqual([]);
    }
    // When each approved item posts: the head of the post queue at the
    // next slot, the others after it; a slot that will not post says why.
    expect(approvedLine(0, NEXT_SLOT)).toBe(
      "Approved: posts at Fri 2026-10-30 09:00 PT.",
    );
    expect(approvedLine(1, NEXT_SLOT)).toBe(
      "Approved: posts after the video above.",
    );
    expect(
      approvedLine(0, {
        ...NEXT_SLOT,
        willPost: false,
        why: "no platform is live",
      }),
    ).toBe("Approved: no slot posts it yet (no platform is live).");
    // The page: the list under the queue, one button, Nil only.
    // Two tabs with their counts (Nil, 2026-10-30); "#approved" opens
    // its tab. The Social tab moved to the app's "/" (stats-page.mjs, Nil,
    // 2026-10-31).
    expect(REVIEW_PAGE).toContain(
      'const TABS = [["review", "In review"], ["approved", "Approved"]];',
    );
    expect(REVIEW_PAGE).toContain('label + " (" + of[key].length + ")"');
    expect(REVIEW_PAGE).toContain('location.hash === "#approved"');
    expect(REVIEW_PAGE).not.toContain("#social");
    // The page draws text only: its no-innerHTML rule holds.
    expect(REVIEW_PAGE).not.toContain("innerHTML =");
    // Revise and Discard with no note (Nil, 2026-10-30: a refused Revise
    // looked done): nothing is sent; the card says why and puts the cursor
    // in the note box. The page's rule is the store's (approve needs none).
    const click = REVIEW_PAGE.slice(
      REVIEW_PAGE.indexOf("b.onclick = async () => {"),
      REVIEW_PAGE.indexOf("done(box, it, action);"),
    );
    expect(
      click.indexOf('if (action !== "approve" && !notes.value.trim())'),
    ).toBeLessThan(click.indexOf("await post("));
    expect(click).toContain("notes.focus();");
    expect(click).toContain('refused("Write a note first: "');
    // Every refusal is scrolled into view, right under the buttons.
    expect(REVIEW_PAGE).toContain('why.scrollIntoView({ block: "nearest" })');
    expect(click).toContain("if (failed) { refused(failed.error);");
    expect(REVIEW_PAGE).toContain('el("button", "undo", "Undo approval")');
    expect(REVIEW_PAGE).toContain("undo.disabled = !canReview;");
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
    expect(directorText(item, "approve", "")).toContain("Notes: (none)");
  });

  test('Nil\'s notes reach the director as lines, word for word (Nil, 2026-10-28: no "\\n")', () => {
    const { store } = withItemInReview();
    const item = store.item("v-2026-10-28-1") as Item;
    const notes =
      'this is the best of the 3.\n\nthe cat  saying "c\'mon" makes no sense\n  keep this indent ';
    const text = directorText(item, "revise", notes);
    expect(text).not.toContain("\\n");
    expect(text.split("\n").slice(1, 6)).toEqual([
      "Notes, verbatim:",
      "> this is the best of the 3.",
      "> ",
      '> the cat  saying "c\'mon" makes no sense',
      ">   keep this indent ",
    ]);
    expect(quoteLines("a\n\nb", "  ")).toEqual(["  > a", "  > ", "  > b"]);
    // Another client may send "\r\n": no "\r" stays at a line's end.
    expect(quoteLines("a\r\nb")).toEqual(["> a", "> b"]);
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
        notes: 'cut the "bro" line\n\nand the laugh',
        by: "Nil",
      }),
    ).toEqual([
      "v-2026-10-29-1 (game GAME1): revise by Nil at 2026-10-29T17:00:00.000Z, video vvvvvvvvvvvv, edit list eeeeeeeeeeee",
      "  notes, verbatim:",
      '  > cut the "bro" line',
      "  > ",
      "  > and the laugh",
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
      "  reply, verbatim:",
      "  > B, the save reads best",
    ]);
  });

  test("a render's times, by step, in one line; none before the timings", () => {
    expect(
      timingLines({
        check: 0.4,
        send: 0.3,
        start: 1.5,
        render: 34.1,
        fetch: 7.7,
        cleanup: 0.4,
        total: 44.4,
        workers: 8,
        renderer: null,
      }),
    ).toEqual([
      "  times (s): check 0.4, send 0.3, start 1.5, render 34.1, fetch 7.7, cleanup 0.4; total 44.4, 8 workers",
    ]);
    expect(
      timingLines({ total: 9, workers: 8, renderer: { shoot: 5.9 } }),
    ).toEqual(["  times (s): total 9, 8 workers; renderer: shoot 5.9"]);
    expect(timingLines(null)).toEqual([]);
    expect(timingLines(undefined)).toEqual([]);
  });

  test("a video the poster posts no Story of: one line for Nil, the same as a WARNING for the director", () => {
    const MB = 1024 * 1024;
    expect(noStoryLine({ bytes: 9 * MB, durationSeconds: 60 })).toBeNull();
    expect(noStoryLine({ bytes: 9 * MB, durationSeconds: 61.2 })).toBe(
      "No Instagram Story: the video is 61.2 s (Stories take 60 s at most).",
    );
    // The poster's other limits give its own reason.
    const big = STORY_MAX_BYTES + 1;
    expect(noStoryLine({ bytes: big, durationSeconds: 40 })).toBe(
      `No Instagram Story: the video is ${big} bytes; a Story takes ${STORY_MAX_BYTES} at most.`,
    );
    expect(noStoryLine({ bytes: 9 * MB, durationSeconds: null })).toBe(
      "No Instagram Story: the video has no known duration.",
    );
    expect(storyWarning({ bytes: 9 * MB, durationSeconds: 61.2 })).toEqual([
      "  WARNING No Instagram Story: the video is 61.2 s (Stories take 60 s at most).",
    ]);
    expect(storyWarning({ bytes: 9 * MB, durationSeconds: 60 })).toEqual([]);
    // A render that is still running has no video yet.
    expect(storyWarning(undefined)).toEqual([]);
  });

  test("another live video of the same game blocks Approve; a discarded one does not", () => {
    const { store } = withItemInReview("v-2026-10-28-1");
    sameGameItem(store, "v-2026-10-28-3", "discarded");
    expect(viewOf(store).items[0].approveProblem).toBeNull();
    sameGameItem(store, "v-2026-10-28-2", "approved");
    expect(viewOf(store).items[0].approveProblem).toBe(
      "another video of this game is approved (v-2026-10-28-2): withdraw it, or discard this one",
    );
  });
});

/** An ask as the office returns it (GET /api/asks/:askId). */
interface OfficeAsk {
  id: string;
  app?: { name: string };
  memberUserId?: string;
  member: string | null;
  text?: string;
  options?: string[];
  recommended?: string;
  priority?: string;
  readFiles?: string[];
  closed?: { outcome: string; by: string | null; answer?: string };
}

/**
 * The office's ask routes as the app sees them (office.mjs appAsks): the
 * app's open asks, and every ask by id, open or closed. `answer` closes one
 * as a member would.
 */
const fakeOffice = () => {
  const open = new Map<string, OfficeAsk>();
  const closed = new Map<string, OfficeAsk>();
  const bodies: Record<string, unknown>[] = [];
  // The Director's own asks: the app reads them, but they are not its own.
  const hand = new Map<string, OfficeAsk>();
  let n = 0;
  return {
    bodies,
    down: false,
    open(body: Record<string, unknown>) {
      bodies.push(body);
      // The office names the member as they are now (the body has the
      // username).
      const ask: OfficeAsk = {
        ...body,
        id: `ask-${++n}`,
        app: { name: APP_NAME },
        memberUserId: REVIEWER_MEMBER_ID,
        member: "Nil",
      };
      open.set(ask.id, ask);
      return Promise.resolve(ask);
    },
    listOpen() {
      if (this.down) {
        return Promise.reject(
          new Error("the office did not answer (ECONNREFUSED)"),
        );
      }
      return Promise.resolve([...open.values()]);
    },
    remove(id: string) {
      const ask = open.get(id);
      if (!ask) return Promise.reject(new Error("HTTP 404 not_found"));
      open.delete(id);
      closed.set(id, { ...ask, closed: { outcome: "withdrawn", by: null } });
      return Promise.resolve(null);
    },
    read(id: string) {
      return Promise.resolve(closed.get(id) ?? open.get(id) ?? hand.get(id));
    },
    answer(
      id: string,
      part: OfficeAsk["closed"],
      change: Partial<OfficeAsk> = {},
    ) {
      const ask = open.get(id)!;
      open.delete(id);
      closed.set(id, { ...ask, ...change, closed: part });
    },
    openIds: () => [...open.keys()],
    handAsk(id: string, closedPart?: OfficeAsk["closed"]) {
      hand.set(id, {
        id,
        memberUserId: REVIEWER_MEMBER_ID,
        member: "Nil",
        ...(closedPart ? { closed: closedPart } : {}),
      });
    },
  };
};

/**
 * A review batch time: 09:00 PDT on 2026-10-31. The tests' clock starts
 * there, so an item in review gets its ask in the first sync.
 */
const BATCH_AT = "2026-10-31T16:00:00.000Z";

/** One app with one item in review, its fake office and the director's inbox. */
const withAsks = () => {
  const base = withItemInReview();
  const office = fakeOffice();
  const records = openAskRecords(base.store.dirs.root);
  const told: string[] = [];
  const clock = { at: BATCH_AT };
  const sync = () =>
    syncReviewAsks({
      store: base.store,
      records,
      office: office as never,
      send: (_to: string, text: string) => {
        told.push(text);
        return Promise.resolve();
      },
      nextSlot: NEXT_SLOT,
      log: { warn: () => undefined },
      now: () => new Date(clock.at),
      cut: (video: string, span: { from: number; to: number }) =>
        `${video}#${span.from}-${span.to}`,
    });
  return { ...base, office, records, told, sync, clock };
};

const ID = "v-2026-10-28-1";
const itemOf = (store: ReturnType<typeof openStore>) =>
  store.item(ID) as unknown as Item;

/**
 * The record of the one adopted ask (214bf6df, the cut-over of
 * v-2026-10-31-2): a hand ask the sync reads until it closes. The route
 * that adopted it is gone; the sync keeps reading such a record.
 */
const adopted = (
  { records, video, block }: ReturnType<typeof withAsks>,
  askId: string,
) =>
  records.put(ID, {
    videoSha256: video,
    copySha256: block,
    round: 0,
    askId,
    status: "adopted",
    adoptedAt: "2026-10-31T11:20:00.000Z",
  });

/** A new vetted render of the item, with a block for it, in `state`. */
const rerender = (
  store: ReturnType<typeof openStore>,
  dir: string,
  bytes: string,
  state: string,
) => {
  const file = join(store.dirs.items, `${ID}.json`);
  const it = JSON.parse(readFileSync(file, "utf8")) as {
    state: string;
    render: { finishedAt: string; video: { path: string; sha256: string } };
    copy: { forVideoSha256: string; storedAt: string };
    vets: { videoSha256: string }[];
  };
  const path = join(dir, `${sha(bytes)}.mp4`);
  writeFileSync(path, bytes);
  const video = sha(bytes);
  it.state = state;
  it.render.video = { ...it.render.video, path, sha256: video };
  it.copy.forVideoSha256 = video;
  it.vets.push({ ...it.vets[0], videoSha256: video });
  // After any revise: a render and a block that come after it.
  const later = new Date(Date.now() + 60_000).toISOString();
  it.render.finishedAt = later;
  it.copy.storedAt = later;
  writeFileSync(file, JSON.stringify(it));
};

describe("Nil's review asks (review-asks.mjs; Nil, 2026-10-31)", () => {
  test("his words read as one action, or as none", () => {
    expect(parseAnswer("Approve")).toEqual({ action: "approve", notes: "" });
    expect(parseAnswer("approve - nice")).toEqual({
      action: "approve",
      notes: "nice",
    });
    expect(parseAnswer("Revise: shorter caption")).toEqual({
      action: "revise",
      notes: "shorter caption",
    });
    expect(parseAnswer("DISCARD:bad pick")).toEqual({
      action: "discard",
      notes: "bad pick",
    });
    // A placeholder of the options is not a note; a revise or discard
    // with no notes comes back with none (the sync applies nothing).
    expect(parseAnswer("Revise: <what to change>")).toEqual({
      action: "revise",
      notes: "",
    });
    expect(parseAnswer("Revise: <what to change> the caption")).toEqual({
      action: "revise",
      notes: "the caption",
    });
    expect(parseAnswer("Discard")).toEqual({ action: "discard", notes: "" });
    // Other words are no action.
    expect(parseAnswer("approved it yesterday")).toBeNull();
    expect(parseAnswer("yes")).toBeNull();
    expect(parseAnswer(undefined)).toBeNull();
  });

  test("the review batch is 09:00 in Los Angeles, PST or PDT (Nil, 2026-11-01)", () => {
    const at = (iso: string) =>
      new Date(reviewBatchAfter(Date.parse(iso))).toISOString();
    // 2026-11-01 03:00 PST: today's 09:00 PST.
    expect(at("2026-11-01T11:00:00.000Z")).toBe("2026-11-01T17:00:00.000Z");
    // At the batch time it is that batch; a second later, the next day's.
    expect(at("2026-11-01T17:00:00.000Z")).toBe("2026-11-01T17:00:00.000Z");
    expect(at("2026-11-01T17:00:01.000Z")).toBe("2026-11-02T17:00:00.000Z");
    // Before the change (PDT) and after the spring one: 16:00 UTC.
    expect(at("2026-10-31T15:00:00.000Z")).toBe(BATCH_AT);
    expect(at("2027-03-14T12:00:00.000Z")).toBe("2027-03-14T16:00:00.000Z");
  });

  test("an item that enters review after the batch is held until the next day's batch", async () => {
    const { office, records, sync, clock } = withAsks();
    clock.at = "2026-10-31T16:30:00.000Z";
    expect(await sync()).toMatchObject({ opened: [], held: [ID] });
    expect(office.openIds()).toEqual([]);
    expect(records.get(ID)).toMatchObject({
      status: "held",
      heldAt: "2026-10-31T16:30:00.000Z",
      batchAt: "2026-11-01T17:00:00.000Z",
    });
    // Still held a minute before the batch, its hold unchanged.
    clock.at = "2026-11-01T16:59:00.000Z";
    expect(await sync()).toMatchObject({ opened: [], held: [ID] });
    expect(records.get(ID)).toMatchObject({
      heldAt: "2026-10-31T16:30:00.000Z",
    });
    // At the batch its ask opens.
    clock.at = "2026-11-01T17:00:00.000Z";
    expect(await sync()).toMatchObject({ opened: [ID], held: [] });
    expect(office.openIds()).toHaveLength(1);
    expect(records.get(ID)).toMatchObject({ status: "open" });
  });

  test("crew.mjs names a held item's batch", () => {
    expect(
      askRecordLine({
        status: "held",
        batchAt: "2026-11-01T17:00:00.000Z",
        videoSha256: "abcdef0123456789",
      }),
    ).toBe(
      "no ask yet: held for the 09:00 PT batch (Sun 2026-11-01 09:00 PT, America/Los_Angeles), video abcdef012345",
    );
  });

  test("one ask for an item in review: Nil, P3, the video, Approve recommended; a second sync opens none", async () => {
    const { office, sync, path } = withAsks();
    expect((await sync()).opened).toEqual([ID]);
    expect(office.bodies).toHaveLength(1);
    expect(office.bodies[0]).toMatchObject({
      member: "nil",
      priority: "P3",
      options: ASK_OPTIONS,
      recommended: "Approve",
      readFiles: [path],
    });
    const text = String(office.bodies[0].text);
    expect(text).toContain(
      'On the video: "bro thought he was safe" then "he was not"',
    );
    expect(text).toContain(`Post: ${postCaption(COPY)}`);
    expect((await sync()).opened).toEqual([]);
    expect(office.bodies).toHaveLength(1);
  });

  test("Nil's Approve is applied once, bound to the video and block of his ask", async () => {
    const { store, office, sync, told, video, block } = withAsks();
    await sync();
    const [askId] = office.openIds();
    office.answer(askId, { outcome: "replied", by: "Nil", answer: "Approve" });
    expect((await sync()).applied).toEqual([ID]);
    const item = itemOf(store);
    expect(item.state).toBe("approved");
    expect(item.approval).toMatchObject({
      videoSha256: video,
      copySha256: block,
    });
    expect(item.reviews.at(-1)!.askId).toBe(askId);
    expect(
      feedbackOf(store).map((r) => [r.action, (r as { askId?: string }).askId]),
    ).toEqual([["approve", askId]]);
    expect(told.at(-1)).toContain(`REVIEW: Nil chose APPROVE on ${ID}`);
    expect(told.at(-1)).toContain(`ask ${askId}`);
    // Idempotent: the next syncs apply nothing more and open no ask.
    const again = await sync();
    expect(again.applied).toEqual([]);
    expect(again.opened).toEqual([]);
    expect(feedbackOf(store)).toHaveLength(1);
    expect(told).toHaveLength(1);
  });

  test("Revise: goes back to the director as a draft with his notes", async () => {
    const { store, office, sync } = withAsks();
    await sync();
    const [askId] = office.openIds();
    office.answer(askId, {
      outcome: "replied",
      by: "Nil",
      answer: "Revise: the wave makes no sense",
    });
    await sync();
    const item = itemOf(store);
    expect(item.state).toBe("draft");
    expect(item.reviews.at(-1)).toMatchObject({
      action: "revise",
      notes: "the wave makes no sense",
      askId,
    });
  });

  test("a dismiss changes nothing, and no second ask opens for the same video", async () => {
    const { store, office, sync, told } = withAsks();
    await sync();
    const [askId] = office.openIds();
    office.answer(askId, { outcome: "dismissed", by: "Nil", answer: "later" });
    const did = await sync();
    expect(did.applied).toEqual([]);
    expect(did.opened).toEqual([]);
    expect(itemOf(store).state).toBe("finished");
    expect(feedbackOf(store)).toHaveLength(0);
    expect(told.at(-1)).toContain(
      "closed as dismissed by Nil: nothing changed",
    );
  });

  test("a reply by another member, or to an ask not for Nil or not the app's, changes nothing", async () => {
    for (const [part, change] of [
      [{ outcome: "replied", by: "Isomuxer 3", answer: "Approve" }, {}],
      [
        { outcome: "replied", by: "Nil", answer: "Approve" },
        { memberUserId: "someone" },
      ],
      [
        { outcome: "replied", by: "Nil", answer: "Approve" },
        { app: { name: "other-app" } },
      ],
    ] as const) {
      const { store, office, sync, told } = withAsks();
      await sync();
      const [askId] = office.openIds();
      office.answer(askId, part, change as Partial<OfficeAsk>);
      expect((await sync()).applied).toEqual([]);
      expect(itemOf(store).state).toBe("finished");
      expect(feedbackOf(store)).toHaveLength(0);
      expect(told.at(-1)).toMatch(/nothing changed/i);
    }
  });

  test("the Revise option sent with no notes changes nothing; the director is told so", async () => {
    const { store, office, sync, told } = withAsks();
    await sync();
    const [askId] = office.openIds();
    office.answer(askId, {
      outcome: "replied",
      by: "Nil",
      answer: ASK_OPTIONS[1],
    });
    expect((await sync()).applied).toEqual([]);
    expect(itemOf(store).state).toBe("finished");
    expect(feedbackOf(store)).toHaveLength(0);
    expect(told.at(-1)).toContain("Nil chose Revise with no notes");
    expect(told.at(-1)).toContain("nothing done");
  });

  test("words that are not an action change nothing; the director gets them verbatim", async () => {
    const { store, office, sync, told } = withAsks();
    await sync();
    const [askId] = office.openIds();
    office.answer(askId, {
      outcome: "replied",
      by: "Nil",
      answer: "hmm, not sure",
    });
    await sync();
    expect(itemOf(store).state).toBe("finished");
    expect(told.at(-1)).toContain("> hmm, not sure");
  });

  test("a reply to an old ask is not applied after the video changed; a new ask opens", async () => {
    const { store, office, sync, told, dir } = withAsks();
    await sync();
    const [oldAsk] = office.openIds();
    // A new render and a new block, vetted: in review with another video.
    const file = join(store.dirs.items, `${ID}.json`);
    const it = JSON.parse(readFileSync(file, "utf8")) as {
      render: { video: { path: string; sha256: string } };
      copy: { forVideoSha256: string };
      vets: { videoSha256: string }[];
    };
    const newPath = join(dir, "new.mp4");
    writeFileSync(newPath, "a new render");
    const newVideo = sha("a new render");
    it.render.video = { ...it.render.video, path: newPath, sha256: newVideo };
    it.copy.forVideoSha256 = newVideo;
    it.vets.push({ ...it.vets[0], videoSha256: newVideo });
    writeFileSync(file, JSON.stringify(it));
    office.answer(oldAsk, { outcome: "replied", by: "Nil", answer: "Approve" });
    const did = await sync();
    expect(did.applied).toEqual([]);
    expect(itemOf(store).state).toBe("finished");
    expect(told.at(-1)).toContain("not applied");
    // The item gets one ask for its new video.
    expect(did.opened).toEqual([ID]);
    expect(office.bodies.at(-1)!.readFiles).toEqual([newPath]);
  });

  test("an ask after Nil's Revise names it first, his notes word for word (C15)", async () => {
    const { store, office, sync, dir } = withAsks();
    await sync();
    const [askId] = office.openIds();
    office.answer(askId, {
      outcome: "replied",
      by: "Nil",
      answer: "Revise: the sound at 00:31 sucks.\nand the wave",
    });
    await sync();
    const revisedAt = itemOf(store).reviews.at(-1)!.at;
    rerender(store, dir, "the revised render", "finished");
    expect((await sync()).opened).toEqual([ID]);
    const lines = String(office.bodies.at(-1)!.text).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      `Revision after your Revise of ${revisedAt.slice(0, 16).replace("T", " ")} UTC:`,
      "> the sound at 00:31 sucks.",
      "> and the wave",
      "Post this video?",
    ]);
    // The first ask of an item says nothing of a revision.
    expect(String(office.bodies[0].text).split("\n")[0]).toBe(
      "Post this video?",
    );
  });

  test("after a Revise, the ask shows only the clip of what changed, and says what and where (C54)", async () => {
    const { store, office, sync, dir } = withAsks();
    await sync();
    const [askId] = office.openIds();
    office.answer(askId, {
      outcome: "replied",
      by: "Nil",
      answer: "Revise: what if both pawns wave the flag?",
    });
    await sync();
    rerender(store, dir, "the flags render", "finished");
    // As direct --changed 20 --what ... stores it, and the render's timeline.
    const file = join(store.dirs.items, `${ID}.json`);
    const it = JSON.parse(readFileSync(file, "utf8")) as {
      edl: Record<string, unknown>;
      render: { video: Record<string, unknown> } & Record<string, unknown>;
    };
    it.edl.changed = {
      plies: [20],
      beats: [],
      end: false,
      what: "both of bro's pawns wave flags",
    };
    it.render.video.durationSeconds = 41.867;
    it.render.timeline = {
      moves: [
        { ply: 19, at: 25.23 },
        { ply: 20, at: 28.6 },
      ],
      events: [{ index: 0, ply: 20, start: 34.23, end: 36.8 }],
      sounds: [],
    };
    writeFileSync(file, JSON.stringify(it));
    expect((await sync()).opened).toEqual([ID]);
    const body = office.bodies.at(-1)!;
    const video = String(it.render.video.path);
    expect(body.readFiles).toEqual([`${video}#26.6-41.9`]);
    const lines = String(body.text).split("\n");
    expect(lines[0]).toStartWith("Revision after your Revise of ");
    expect(lines.slice(1, 4)).toEqual([
      "> what if both pawns wave the flag?",
      "Changed: both of bro's pawns wave flags, 26.6-41.9 s. The clip shows only that moment.",
      "Post this video?",
    ]);
  });

  test("after a Revise with --changed all, or with no timeline, the ask shows the whole video", async () => {
    const { store, office, sync, dir } = withAsks();
    await sync();
    const [askId] = office.openIds();
    office.answer(askId, {
      outcome: "replied",
      by: "Nil",
      answer: "Revise: a new caption",
    });
    await sync();
    rerender(store, dir, "the caption render", "finished");
    const file = join(store.dirs.items, `${ID}.json`);
    const it = JSON.parse(readFileSync(file, "utf8")) as {
      edl: Record<string, unknown>;
      render: { video: { path: string } };
    };
    it.edl.changed = { plies: "all", what: "the caption" };
    writeFileSync(file, JSON.stringify(it));
    expect((await sync()).opened).toEqual([ID]);
    expect(office.bodies.at(-1)!.readFiles).toEqual([it.render.video.path]);
    expect(String(office.bodies.at(-1)!.text)).not.toContain("Changed:");
  });

  test("an ask for a new video says which ask it replaces when the old one was withdrawn unanswered", async () => {
    const { office, sync, records, store, dir } = withAsks();
    await sync();
    const sentAt = (records.get(ID) as { openedAt: string }).openedAt;
    rerender(store, dir, "a new render", "finished");
    const did = await sync();
    expect(did.withdrawn).toEqual([ID]);
    expect(did.opened).toEqual([ID]);
    expect(String(office.bodies.at(-1)!.text).split("\n")[0]).toBe(
      `This video replaces the one sent to you at ${sentAt.slice(0, 16).replace("T", " ")} UTC (that ask was withdrawn before your answer).`,
    );
  });

  test("after a dismiss, askAgain opens a new ask for the same video; never twice, never over an open ask", async () => {
    const { office, sync, records, told } = withAsks();
    expect(() => askAgain(records, ID)).toThrow(StepRefused);
    await sync();
    expect(() => askAgain(records, ID)).toThrow(/is open/);
    const [askId] = office.openIds();
    office.answer(askId, { outcome: "dismissed", by: "Nil", answer: "later" });
    await sync();
    expect(told.at(-1)).toContain(`crew.mjs asks --again --item ${ID}`);
    expect(told.join("\n")).not.toContain("review page");
    askAgain(records, ID);
    expect(() => askAgain(records, ID)).toThrow(/is again/);
    const did = await sync();
    expect(did.opened).toEqual([ID]);
    // The same video: the new ask is not told as a replacement.
    expect(String(office.bodies.at(-1)!.text).split("\n")[0]).toBe(
      "Post this video?",
    );
    expect((await sync()).opened).toEqual([]);
  });

  test("an open ask whose item left review is withdrawn (an action on the page)", async () => {
    const { store, office, sync, video, block } = withAsks();
    await sync();
    store.review(ID, {
      action: "approve",
      notes: "",
      videoSha256: video,
      copySha256: block,
      by: "Nil",
      memberId: REVIEWER_MEMBER_ID,
    });
    expect((await sync()).withdrawn).toEqual([ID]);
    expect(office.openIds()).toEqual([]);
  });

  test("the office down: no item changes and no ask opens", async () => {
    const { store, office, sync } = withAsks();
    office.down = true;
    expect(await sync()).toEqual({
      opened: [],
      applied: [],
      withdrawn: [],
      told: [],
      held: [],
    });
    expect(itemOf(store).state).toBe("finished");
  });

  test("an adopted hand ask: applied with the same checks once Nil replies", async () => {
    const asks = withAsks();
    const { store, office, records, sync, video, block } = asks;
    office.handAsk("214bf6df");
    adopted(asks, "214bf6df");
    // Still open: nothing happens, the app opens no ask of its own.
    const first = await sync();
    expect(first).toMatchObject({ opened: [], applied: [] });
    expect(records.get(ID)).toMatchObject({
      status: "adopted",
      videoSha256: video,
    });
    office.handAsk("214bf6df", {
      outcome: "replied",
      by: "Nil",
      answer: "Approve",
    });
    expect((await sync()).applied).toEqual([ID]);
    const item = itemOf(store);
    expect(item.approval).toMatchObject({
      videoSha256: video,
      copySha256: block,
    });
    expect(item.reviews.at(-1)!.askId).toBe("214bf6df");
    expect((await sync()).applied).toEqual([]);
  });

  test("an adopted ask answered by another member changes nothing", async () => {
    const asks = withAsks();
    const { store, office, records, sync } = asks;
    office.handAsk("hand1", {
      outcome: "replied",
      by: "Isomuxer 3",
      answer: "Approve",
    });
    adopted(asks, "hand1");
    await sync();
    expect(itemOf(store).state).toBe("finished");
    expect(records.get(ID)).toMatchObject({ status: "ignored" });
  });
});

describe("a held item shows its age (VR1 review 117 N1)", () => {
  const held = (at: string) => ({
    state: "approved",
    approval: { videoSha256: "v1" },
    hold: { videoSha256: "v1", why: "ghost fault", by: "the director", at },
  });
  const now = Date.parse("2026-10-31T20:00:00.000Z");
  test("hours, then days; none when not held", () => {
    expect(holdLine(held("2026-10-31T16:27:00.000Z"), now)).toBe(
      "HELD 3.5 h (since 2026-10-31 16:27 UTC, by the director): ghost fault. It does not post: re-render it, release it or discard it.",
    );
    expect(holdLine(held("2026-10-28T19:00:00.000Z"), now)).toMatch(
      /^HELD 3 days /,
    );
    // A new approved video is not held by the old hold.
    expect(
      holdLine(
        {
          ...held("2026-10-31T16:27:00.000Z"),
          approval: { videoSha256: "v2" },
        },
        now,
      ),
    ).toBeNull();
  });
});

describe("Nil's revise says the fix needs no second look (approve-fixed, C41)", () => {
  const WORDS =
    "the sound at 0021 makes no sense. Remove it. If you just fix those don't need to rerun it by me";
  /** The app's ask, answered with Nil's revise; returns its id. */
  const revised = async (env: ReturnType<typeof withAsks>) => {
    await env.sync();
    const [askId] = env.office.openIds();
    env.office.answer(askId, {
      outcome: "replied",
      by: "Nil",
      answer: `Revise: ${WORDS}`,
    });
    await env.sync();
    return askId;
  };

  test("armed, the fixed render is approved by Nil with his words, and no ask opens", async () => {
    const env = withAsks();
    const { store, office, dir, told, sync } = env;
    const askId = await revised(env);
    const revisedVideo = itemOf(store).render.video.sha256;
    store.armFixedApproval(ID, { askId, by: "Wall Game Director" });
    expect(fixedApprovalProblem(store.item(ID))).toMatch(/not in review yet/);
    // The director's render, check, vet and Growth's block.
    rerender(store, dir, "the fixed render", "finished");
    const did = await sync();
    expect(did.opened).toEqual([]);
    expect(did.applied).toEqual([ID]);
    expect(office.bodies).toHaveLength(1);
    const item = itemOf(store);
    expect(item.state).toBe("approved");
    const fixed = {
      askId,
      words: WORDS,
      revisedVideoSha256: revisedVideo,
      armedBy: "Wall Game Director",
    };
    expect(item.approval).toMatchObject({
      by: "Nil",
      videoSha256: sha("the fixed render"),
      fixed,
    });
    expect(item.reviews.at(-1)).toMatchObject({ action: "approve", fixed });
    expect(feedbackOf(store).at(-1)).toMatchObject({ action: "approve" });
    expect(told.at(-1)).toContain(`No ask: Nil's revise on ask ${askId}`);
    expect(told.at(-1)).toContain(`> ${WORDS}`);
    // Once: the next sync does nothing.
    const again = await sync();
    expect([again.applied, again.opened]).toEqual([[], []]);
  });

  test("arming needs his last review to be his revise from that ask", async () => {
    const env = withAsks();
    const { store } = env;
    expect(() => {
      store.armFixedApproval(ID, { askId: "ask-1", by: "d" });
    }).toThrow(/it has none/);
    const askId = await revised(env);
    expect(() => {
      store.armFixedApproval(ID, { askId: "ask-9", by: "d" });
    }).toThrow(`last review is not Nil's revise from ask ask-9`);
    store.armFixedApproval(ID, { askId, by: "d" });
    // Not in review: the director's direct approval waits.
    expect(() => {
      store.approveFixed(ID);
    }).toThrow(/not in review yet/);
  });

  test("a render with the bytes Nil revised, or a later review, gets his ask as before", async () => {
    const env = withAsks();
    const { store, dir, sync, block } = env;
    const askId = await revised(env);
    store.armFixedApproval(ID, { askId, by: "d" });
    // The same bytes as the video he revised.
    rerender(store, dir, `video of ${ID}`, "finished");
    expect(fixedApprovalProblem(store.item(ID))).toMatch(/the one Nil revised/);
    expect((await sync()).opened).toEqual([ID]);
    expect(itemOf(store).state).toBe("finished");
    // Nil revises again on the review page: the arm is void.
    const it = itemOf(store);
    store.review(ID, {
      action: "revise",
      notes: "one more change",
      videoSha256: it.render.video.sha256,
      copySha256: block,
      by: "Nil",
      memberId: "m",
    });
    rerender(store, dir, "the second fix", "finished");
    expect(fixedApprovalProblem(store.item(ID))).toMatch(/void/);
    expect((await sync()).opened).toEqual([ID]);
  });

  test("a refused approval tells the director and opens his ask after all", async () => {
    const env = withAsks();
    const { store, dir, sync, told } = env;
    const askId = await revised(env);
    store.armFixedApproval(ID, { askId, by: "d" });
    rerender(store, dir, "the fixed render", "finished");
    // The file is no longer the record's video.
    writeFileSync(itemOf(store).render.video.path, "other bytes");
    const did = await sync();
    expect(did.applied).toEqual([]);
    expect(did.opened).toEqual([ID]);
    expect(
      told.some((t) => t.includes("armed approval") && t.includes("refused")),
    ).toBe(true);
  });
});
