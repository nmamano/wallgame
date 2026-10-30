/**
 * What the daily video pipeline must refuse, and one whole dry-run cycle.
 *
 * Each video is an item (store.mjs): picked, directed, rendered, checked by
 * the director, given Growth's copy block, and then reviewed by Nil. The
 * refusals are the reason the item is a state machine: a step runs only
 * from the stage it expects, a check is about the current render's sheet,
 * a block belongs to one video, and each live render is one view of a real
 * game. The full cycle runs the daily routes with a stub in place of the
 * 4090 render step, and checks that posting an approved item in dry-run
 * writes the requests a live post would send, with no credential in them.
 * Nil's review actions and the post queue are not here: a test approves an
 * item through store.updateItem, as the review page will.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  ITEM_ID,
  PLATFORMS,
  blockedMusic,
  currentScriptReview,
  currentVet,
  renderScriptReview,
  openStore,
  postProblem,
  readPostLog,
  reviewState,
  stage,
  utcDay,
} from "./store.mjs";
import { openTokenStore } from "./token-store.mjs";
import { PUBLIC_IDS } from "./public-ids.mjs";
import {
  candidateFromReport,
  nextEnding,
  edlSummary,
  saveFrameProblems,
  storyProblems,
  playerNames,
  CAPTION_STYLE_VERSION,
  textProblems,
} from "./candidate.mjs";
import {
  copyLines,
  copyProblems,
  copySha256,
  parseCopy,
  postTexts,
  trackedLink,
  YOUTUBE_LINK,
} from "./copy.mjs";
import type {
  DescribedCloseCall,
  DescribedEscape,
  PickedJump,
} from "../daily-candidates";
import { oauth1Header, xDryRunReply } from "./post-x.mjs";
import {
  postToTiktok,
  tiktokDryRunReply,
  DRY_RUN_TIKTOK,
  TIKTOK_TOKEN_URL,
} from "./post-tiktok.mjs";
import { instagramDryRunReply, postToInstagram } from "./post-instagram.mjs";
import { dryRunPublicUrl } from "./public-url-r2.mjs";
import {
  dryRunTransport,
  NotPosted,
  PostFailed,
  sha256,
} from "./transport.mjs";
import { modeReasons, postingModes, createDaily } from "./routes.mjs";
import { parseResult } from "./render-4090.mjs";
import { MUSIC_TRACKS } from "../music-tracks.mjs";
import {
  loudnessVerdict,
  safeAreaVerdict,
  captionLinesVerdict,
  silenceVerdict,
  MAX_MEME_LUFS,
} from "./quality.mjs";
import { FRAME, STRIP_AREA, validateEdl } from "../edl.mjs";
import { batchLines, scriptChecklist, scriptDraft } from "./script.mjs";

const SERVER = resolve(import.meta.dir, "../app/server.mjs");

/** A move by player 1 that makes player 2's walk longer. */
const pick = (ply: number, before: number, after: number): PickedJump => ({
  ply,
  moveNumber: ply + 1,
  mover: 1,
  notation: "Ce4",
  ownBefore: 5,
  ownAfter: 5,
  opponentBefore: before,
  opponentAfter: after,
  jump: after - before,
  size: Math.abs(after - before),
  pawns: [],
  walls: [],
  wallsChange: 0,
  together: false,
  description: `Guest Tuatara's wall makes Ruby walk ${after - before} extra squares (${before} to ${after}).`,
});

/** Ruby's cat gets 1 square from the guest's mouse; a wall saves it. */
const CLOSE_CALL: DescribedCloseCall = {
  hunter: { player: 2, type: "cat" },
  prey: { player: 1, type: "mouse" },
  danger: {
    ply: 8,
    moveNumber: 9,
    notation: "Cg3",
    walk: 1,
    hunterCell: "g3",
    preyCell: "g4",
    pawns: [],
  },
  save: {
    ply: 9,
    moveNumber: 10,
    notation: "^g3.^h3",
    walk: 19,
    walkBefore: 1,
    hunterCell: "g3",
    preyCell: "g4",
    pawns: [],
    walls: [],
    wallsChange: 18,
    together: false,
  },
  relief: {
    ply: 10,
    moveNumber: 11,
    notation: ">a5.>d4",
    walk: 19,
    hunterCell: "g3",
    preyCell: "g4",
    pawns: [],
  },
  size: 18,
  description:
    "Ruby's cat gets 1 square from Guest Tuatara's mouse. Walls make it walk 19 (move 10), and the mouse is safe.",
};

const ESCAPE: DescribedEscape = {
  hunter: { player: 2, type: "cat" },
  prey: { player: 1, type: "mouse" },
  ply: 14,
  moveNumber: 15,
  notation: "^f4.Mf4",
  walk: 4,
  walkBefore: 1,
  hunterCell: "g4",
  preyFrom: "g5",
  preyCell: "f4",
  pawns: [],
  size: 3,
  description:
    "Ruby's cat is 1 square from Guest Tuatara's mouse. The mouse runs to f4 and places a wall, and the cat must walk 4 (move 15).",
};

/** Wall Game Growth's copy block for TESTGAME1 (copy.mjs). */
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
const COPY_VERSION = "growth-copy-1";
const COPY = { ...parseCopy(BLOCK).copy!, version: COPY_VERSION };
const COPY_SHA = copySha256(COPY);

const REPORT = {
  kind: "daily-video-candidates",
  createdAt: "2026-10-26T00:00:00.000Z",
  ranked: [
    {
      gameId: "TESTGAME1",
      startedAt: "2026-10-25T10:00:00.000Z",
      variant: "standard",
      boardWidth: 8,
      boardHeight: 8,
      movesCount: 41,
      moves: Array.from({ length: 41 }, (_, i) => (i % 2 ? "Ce5" : "Ce4")),
      // The race counter at each position; the guest's walk ends at 0.
      distances: Array.from({ length: 42 }, (_, k) => ({
        1: k === 41 ? 0 : 7,
        2: 12,
      })),
      seats: [
        { playerOrder: 1, kind: "guest", name: "Guest Tuatara" },
        { playerOrder: 2, kind: "official bot", name: "Ruby" },
      ],
      picks: [pick(22, 2, 8), pick(30, 4, 8)],
    },
  ],
};

/** A video as a render reports it. */
interface Video {
  path: string;
  bytes: number;
  sha256: string;
  durationSeconds?: number;
}

/** The parts of a video item (store.mjs) that these tests read. */
/** One independent review of an item's final video (store.recordVet). */
interface Vet {
  at: string;
  reviewer: string;
  verdict: string;
  notes: string;
  videoSha256: string;
}

interface Item {
  id: string;
  state: string;
  gameId: string;
  // Only a carry-over has it.
  source: { carriedFrom?: string };
  candidate: { gameId: string };
  edl: { sha256: string; needsPawnArt?: boolean; summary: string[] } | null;
  copy: {
    block: Record<string, string>;
    sha256: string;
    forVideoSha256: string;
  } | null;
  render: {
    jobId: string;
    finishedAt: string | null;
    error: string | null;
    fromCache: boolean;
    effect: string | null;
    ending: string;
    requestedAt: string;
    scriptReview?: { at: string; scriptSha256: string };
    sheet: { sha256: string; stills: unknown[] } | null;
    video: Video | null;
    quality: Record<string, { ok: boolean; note: string }> | null;
    music: { fromPly: number; track: string; at: number }[] | null;
    timeline: { events: object[] } | null;
    grid?: object | null;
    timings?: object | null;
  } | null;
  check: { ok: boolean } | null;
  // Absent on an item from before vets.
  vets?: Vet[];
  // Absent on an item from before script reviews (2026-10-29).
  scriptReviews?: {
    at: string;
    reviewer: string;
    verdict: string;
    notes: string;
    script: string;
    scriptSha256: string;
  }[];
  reviews?: { action: string; at: string }[];
  approval: {
    videoSha256: string;
    copySha256: string;
    by: string;
    at: string;
  } | null;
  events: { utc: string; what: string }[];
}

/** An item as GET /api/daily/state lists it: with what is derived. */
interface ItemView extends Item {
  stage: string;
  reviewState: string | null;
  staleCopy: string | null;
  vet: Vet | null;
}

interface DailyState {
  items: ItemView[];
  // The last items that posted or were discarded.
  over: { id: string; state: string }[];
  counts: Record<string, number>;
  suggestedEnding: string;
  lastMusic: string[] | null;
}

interface LogRow {
  itemId: string;
  gameId: string;
  videoSha256: string;
  platform: string;
  // A Story has no caption.
  caption: string | null;
  styleVersion: string | null;
  copyVersion: string;
}

/** postPlatform's result: the platform's reply, or why it did not post. */
type PostResult =
  | { ok: true; mode: string; postId: string; requestsFile: string }
  | {
      ok: false;
      uncertain: boolean;
      mode: string;
      error: string;
      requestsFile: string;
    };

type Store = ReturnType<typeof openStore>;

const tempDir = () => mkdtempSync(join(tmpdir(), "daily-video-test-"));

const DRY = {
  x: "dry-run",
  youtube: "dry-run",
  tiktok: "dry-run",
  instagram: "dry-run",
  "instagram-story": "dry-run",
  facebook: "dry-run",
  bluesky: "dry-run",
  threads: "dry-run",
};

/** A director's list for TESTGAME1: one zoom with a FAHHH on move 23. */
const EDL = {
  version: 1,
  gameId: "TESTGAME1",
  ending: "replay",
  music: [{ fromPly: 0, track: "deja-vus" }],
  events: [{ ply: 22, kind: "zoom", frame: ["e4", "e5"], sound: "fuahhh-1" }],
};

/** The music a render played: the list's one cue. */
const PLAYED = [{ fromPly: 0, track: "deja-vus", at: 0 }];

/** The contact sheet of a render of EDL: one still, the zoom. */
const SHEET = {
  path: "/nowhere-sheet.png",
  sha256: "ss",
  stills: [{ ply: 22, kind: "zoom", sound: "fuahhh-1" }],
};
const ZOOM_OK = {
  ply: 22,
  kind: "zoom",
  ok: true,
  note: "the zoom shows the wall at e4",
};
/** The app's measures of a render that passes them all. */
const MEASURED = {
  loudness: {
    ok: true,
    note: "fuahhh-1 at 5.6 s: -21 LUFS, 13.8 LU over the bed (-34.8 LUFS), true peak -13.4 dBTP",
  },
  safeArea: { ok: true, note: "board, caption inside the safe area" },
};

const VIDEO: Video = { path: "/nowhere.mp4", bytes: 1, sha256: "aa" };

/** A script review that passed (SCRIPT.md), as crew script-review sends it. */
const SCRIPT_PASS = {
  script: "SCRIPT test | game TESTGAME1\nBEATS\n9 | ~10 | the save | zoom",
  reviewer: "a fresh subagent",
  verdict: "pass",
  notes: "checked every beat against the storyboard\nVERDICT: pass",
};

/** A new item of TESTGAME1 (no script review); its id. */
const pickUnscripted = (store: Store): string =>
  store.pick({
    candidate: candidateFromReport(REPORT, 1),
    style: "daily",
    styleVersion: CAPTION_STYLE_VERSION,
    source: {
      report: "2026-10-26.json",
      reportCreatedAt: REPORT.createdAt,
      gameId: "TESTGAME1",
    },
  }).id;

/**
 * A new item of TESTGAME1, as pick makes it from the report, with its
 * script passed (phase 1), so that it may render; its id.
 */
const pickItem = (store: Store): string => {
  const id = pickUnscripted(store);
  store.recordScriptReview(id, SCRIPT_PASS);
  return id;
};

/** A new item with EDL as its list (`text`: the list's bytes). */
const directItem = (store: Store, text = JSON.stringify(EDL)): string => {
  const id = pickItem(store);
  store.direct(id, {
    edl: EDL,
    text,
    summary: edlSummary(EDL),
    needsPawnArt: false,
  });
  return id;
};

/**
 * Render the item's list as `video`. A second live render of TESTGAME1 the
 * same UTC day needs `force`.
 */
const renderItem = (
  store: Store,
  id: string,
  video: Video = VIDEO,
  {
    quality = MEASURED,
    force = false,
  }: { quality?: object | null; force?: boolean } = {},
) => {
  const job = `job-${id}-${video.sha256}`;
  store.startRender(id, job, { force });
  store.finishRender(id, job, {
    video,
    sheet: SHEET,
    music: PLAYED,
    effect: "zoom",
    sound: "shotgun",
    quality,
  });
};

/**
 * A passing independent review (vet) of the item's current video, seeded
 * as approveItem seeds an approval: the fixture videos have no file, and
 * store.recordVet hashes the file (its own tests use a real one).
 */
const vetItem = (store: Store, id: string) => {
  store.updateItem(
    id,
    ["draft", "finished"],
    (it: Item) => {
      it.vets = [
        ...(it.vets ?? []),
        {
          at: new Date().toISOString(),
          reviewer: "a fresh subagent",
          verdict: "pass",
          notes: "ok",
          videoSha256: it.render!.video!.sha256,
        },
      ];
    },
    "vet pass (test)",
  );
};

/** A new item rendered as `video`, checked, with Growth's block: in review. */
const finishItem = (
  store: Store,
  video: Video = VIDEO,
  copy: typeof COPY = COPY,
  force = false,
): string => {
  const id = directItem(store);
  renderItem(store, id, video, { force });
  store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
  vetItem(store, id);
  store.recordCopy(id, copy);
  return id;
};

const itemOf = (store: Store, id: string) => store.item(id) as Item;

/**
 * Nil's approval of the item's video and block, as the review page will
 * write it (it comes in a later commit).
 */
const approveItem = (store: Store, id: string): Item =>
  store.updateItem(
    id,
    ["finished"],
    (it: Item) => {
      it.state = "approved";
      it.approval = {
        videoSha256: it.render!.video!.sha256,
        copySha256: it.copy!.sha256,
        by: "Nil",
        at: new Date().toISOString(),
      };
    },
    "approved (test)",
  ) as Item;

describe("the director checks the contact sheet before the review", () => {
  /** A rendered item with a block, before its check. */
  const rendered = (quality: object | null = MEASURED) => {
    const store = openStore(tempDir());
    const id = directItem(store);
    renderItem(store, id, VIDEO, { quality });
    vetItem(store, id);
    store.recordCopy(id, COPY);
    return { store, id };
  };

  test("no render before a script review passes, since the pick or Nil's last revise", () => {
    const store = openStore(tempDir());
    const id = pickUnscripted(store);
    store.direct(id, {
      edl: EDL,
      text: JSON.stringify(EDL),
      summary: [],
      needsPawnArt: false,
    });
    expect(() => {
      store.startRender(id, "job-00000001");
    }).toThrow(
      `${id} has no script review: write the script (crew.mjs script)`,
    );
    store.recordScriptReview(id, { ...SCRIPT_PASS, verdict: "fail" });
    expect(() => {
      store.startRender(id, "job-00000001");
    }).toThrow(`${id}'s latest script review failed`);
    // The record keeps the script, its hash and the notes word for word.
    store.recordScriptReview(id, SCRIPT_PASS);
    const reviews = itemOf(store, id).scriptReviews!;
    expect(reviews.map((r) => r.verdict)).toEqual(["fail", "pass"]);
    expect(reviews[1]).toMatchObject({
      script: SCRIPT_PASS.script,
      notes: SCRIPT_PASS.notes,
      reviewer: "a fresh subagent",
    });
    expect(reviews[1].scriptSha256).toMatch(/^[0-9a-f]{64}$/);
    store.startRender(id, "job-00000001");
    expect(stage(itemOf(store, id))).toBe("rendering");
    // The render pins the review it passed under.
    expect(itemOf(store, id).render!.scriptReview).toEqual({
      at: reviews[1].at,
      scriptSha256: reviews[1].scriptSha256,
    });
    expect(renderScriptReview(itemOf(store, id))).toEqual(reviews[1]);
    // A fail of the same script in the same ms has the same at and hash:
    // the pin still names the pass.
    const sameMs = itemOf(store, id);
    sameMs.scriptReviews = [reviews[1], { ...reviews[1], verdict: "fail" }];
    expect(renderScriptReview(sameMs)).toEqual(reviews[1]);
    // A revise asks for a new story: the reviews before it do not count,
    // and a review after it does.
    const revised = itemOf(store, id);
    const reviseAt = new Date(Date.now() + 1000);
    revised.reviews = [{ action: "revise", at: reviseAt.toISOString() }];
    expect(currentScriptReview(revised)).toBeNull();
    const after = {
      ...reviews[1],
      at: new Date(reviseAt.getTime() + 1).toISOString(),
    };
    revised.scriptReviews = [...reviews, after];
    expect(currentScriptReview(revised)).toEqual(after);
    // Only a draft, and a whole record.
    expect(() => {
      store.recordScriptReview(id, { ...SCRIPT_PASS, notes: " " });
    }).toThrow("script-review needs notes");
    expect(() => {
      store.recordScriptReview(id, { ...SCRIPT_PASS, reviewer: "" });
    }).toThrow("script-review needs the reviewer");
  });

  test("a script review after the render keeps the video from Nil, and the vet sees the script the render passed under", async () => {
    const store = openStore(tempDir());
    const id = directItem(store);
    renderItem(store, id);
    const passed = itemOf(store, id).scriptReviews![0];
    await Bun.sleep(2);
    store.recordScriptReview(id, { ...SCRIPT_PASS, verdict: "fail" });
    store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
    vetItem(store, id);
    store.recordCopy(id, COPY);
    const it = itemOf(store, id);
    expect(reviewState(it)).toBe("waiting-copy");
    expect(renderScriptReview(it)).toEqual(passed);
    expect(currentScriptReview(it)).toMatchObject({ verdict: "fail" });
  });

  test("no render without an edit list", () => {
    const store = openStore(tempDir());
    const id = pickItem(store);
    expect(() => {
      store.startRender(id, "job-00000001");
    }).toThrow(
      `render needs ${id} directed or render-failed, but it is picked`,
    );
  });

  test("a bad still keeps the item a draft, out of review, and the way on is a new list", () => {
    const { store, id } = rendered();
    // Rendered with a block, but not checked: not for Nil yet.
    expect(reviewState(itemOf(store, id))).toBeNull();
    store.recordCheck(id, {
      sheetSha256: "ss",
      stills: [
        { ...ZOOM_OK, ok: false, note: "the zoom shows the cat, not the wall" },
      ],
    });
    expect(itemOf(store, id).state).toBe("draft");
    expect(stage(itemOf(store, id))).toBe("rendered");
    expect(reviewState(itemOf(store, id))).toBeNull();
    // A second look at the same render cannot turn the failure into a pass.
    expect(() => {
      store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
    }).toThrow(/already failed its check/);
    store.direct(id, {
      edl: EDL,
      text: JSON.stringify(EDL),
      summary: [],
      needsPawnArt: false,
    });
    expect(stage(itemOf(store, id))).toBe("directed");
    expect(itemOf(store, id).render).toBeNull();
  });

  test("every still needs its own verdict, in order, with a note", () => {
    const { store, id } = rendered();
    expect(() => {
      store.recordCheck(id, { sheetSha256: "ss", stills: [] });
    }).toThrow(/a verdict on each/);
    expect(() => {
      store.recordCheck(id, {
        sheetSha256: "ss",
        stills: [{ ...ZOOM_OK, ply: 23 }],
      });
    }).toThrow(/still 1 is ply 22 zoom/);
    expect(() => {
      store.recordCheck(id, {
        sheetSha256: "ss",
        stills: [{ ...ZOOM_OK, note: " " }],
      });
    }).toThrow(/needs a note/);
    expect(() => {
      store.recordCheck(id, { sheetSha256: "other", stills: [ZOOM_OK] });
    }).toThrow(/another contact sheet/);
    store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
    expect(itemOf(store, id).state).toBe("finished");
    expect(reviewState(itemOf(store, id))).toBe("in-review");
  });

  test("a silence WARN is a report: the check still finishes the item", () => {
    const { store, id } = rendered({
      ...MEASURED,
      silence: silenceVerdict({
        floorDbfs: -45,
        gaps: [{ start: 15.99, end: 17.6, seconds: 1.61 }],
        over: [{ start: 15.99, end: 17.6, seconds: 1.61, rule: 1.5 }],
      }),
    });
    store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
    expect(itemOf(store, id).state).toBe("finished");
    expect(
      silenceVerdict({
        floorDbfs: -45,
        gaps: [],
        over: [{ start: 15.99, end: 17.6, seconds: 1.61, rule: 1.5 }],
      }),
    ).toEqual({
      ok: true,
      warn: true,
      note: "15.99-17.6 s: 1.61 s, over 1.5 s (under -45 dBFS); the vet judges each",
    });
    // A render that did not measure fails, as the other measures do.
    expect(silenceVerdict(undefined).ok).toBe(false);
    expect(silenceVerdict({ error: "ffmpeg" }).note).toContain("ffmpeg");
    expect(silenceVerdict({ floorDbfs: -45, gaps: [], over: [] })).toEqual({
      ok: true,
      note: "no gap over the rules (under -45 dBFS)",
    });
  });

  test("a failed measure fails the check, even when every still is ok", () => {
    const { store, id } = rendered({
      loudness: {
        ok: false,
        note: "shotgun-2 at 1.1 s: -15.8 LUFS: a meme sound may be at most -18.5 LUFS",
      },
    });
    store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
    const it = itemOf(store, id);
    expect(it.state).toBe("draft");
    expect(stage(it)).toBe("rendered");
    expect(it.check?.ok).toBe(false);
    expect(it.events.at(-1)?.what).toBe(
      "check failed: loudness: shotgun-2 at 1.1 s: -15.8 LUFS: a meme sound may be at most -18.5 LUFS",
    );
  });

  test("a render with no measures cannot be checked", () => {
    const { store, id } = rendered(null);
    expect(() => {
      store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
    }).toThrow(/no measures/);
  });
});

describe("the independent review of the final video (vet)", () => {
  /** A finished item whose video is a real file; and that file's video. */
  const finishedWithFile = () => {
    const store = openStore(tempDir());
    const path = join(tempDir(), "v.mp4");
    writeFileSync(path, "the final bytes");
    const video = {
      path,
      bytes: 15,
      sha256: createHash("sha256").update("the final bytes").digest("hex"),
    };
    const id = directItem(store);
    renderItem(store, id, video);
    return { store, id, video };
  };
  const pass = (videoSha256: string) => ({
    videoSha256,
    reviewer: "Video Reviewer 1",
    verdict: "pass",
    notes: "ok",
  });

  test("only a finished item, only its current video, whose file is still those bytes", () => {
    const { store, id, video } = finishedWithFile();
    // Before the check passes, the video is not final.
    expect(() => void store.recordVet(id, pass(video.sha256))).toThrow(
      `${id} is draft; vet pass by Video Reviewer 1 needs finished`,
    );
    store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
    expect(() => void store.recordVet(id, pass("c".repeat(64)))).toThrow(
      "review the current video",
    );
    writeFileSync(video.path, "other bytes");
    expect(() => void store.recordVet(id, pass(video.sha256))).toThrow(
      `${id}'s video file is not the one in its record`,
    );
    writeFileSync(video.path, "the final bytes");
    const out = store.recordVet(id, pass(video.sha256)) as Item;
    expect(currentVet(out)).toMatchObject({
      verdict: "pass",
      reviewer: "Video Reviewer 1",
      videoSha256: video.sha256,
    });
    expect(out.events.at(-1)?.what).toBe("vet pass by Video Reviewer 1");
  });

  test("no vet of a video when a script review came after its render", async () => {
    const { store, id, video } = finishedWithFile();
    await Bun.sleep(2);
    store.recordScriptReview(id, SCRIPT_PASS);
    store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
    expect(() => void store.recordVet(id, pass(video.sha256))).toThrow(
      `${id}: a script review came after this render, so the video tells an older story`,
    );
  });

  test("copy needs the LATEST vet of the CURRENT video to pass; an item from before vets has none", () => {
    const { store, id, video } = finishedWithFile();
    store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
    store.recordVet(id, pass(video.sha256));
    store.recordVet(id, { ...pass(video.sha256), verdict: "fail" });
    expect(() => void store.recordCopy(id, COPY)).toThrow(
      `${id}: no passing independent review of video ${video.sha256.slice(0, 12)}`,
    );
    store.recordVet(id, pass(video.sha256));
    store.recordCopy(id, COPY);
    // A new render is a new video: its old vet does not count.
    const fresh = { ...itemOf(store, id) };
    fresh.render = { ...fresh.render!, video: { ...video, sha256: "dd" } };
    expect(currentVet(fresh)).toBeNull();
    delete fresh.vets;
    expect(currentVet(fresh)).toBeNull();
  });
});

describe("an item's production", () => {
  const COPY_B = { ...COPY, x: "B's own X line #wallgame" };
  const COPY_C = { ...COPY, x: "C's own X line #wallgame" };
  /** Three finished items of TESTGAME1, with videos aa, bb and cc. */
  const three = () => {
    const store = openStore(tempDir());
    const [a, b, c] = [
      finishItem(store, { ...VIDEO, sha256: "aa" }),
      finishItem(store, { ...VIDEO, sha256: "bb" }, COPY_B, true),
      finishItem(store, { ...VIDEO, sha256: "cc" }, COPY_C, true),
    ];
    return { store, a, b, c };
  };

  test("each pick is a new item, numbered within its UTC day", () => {
    const { a, b, c } = three();
    expect([a, b, c]).toEqual([1, 2, 3].map((n) => `v-${utcDay()}-${n}`));
    expect(a).toMatch(ITEM_ID);
  });

  test("its stage follows its fields: picked, directed, rendering, rendered, render-failed, checked", () => {
    const store = openStore(tempDir());
    const id = pickItem(store);
    const now = () => stage(itemOf(store, id));
    expect(now()).toBe("picked");
    store.direct(id, {
      edl: EDL,
      text: JSON.stringify(EDL),
      summary: [],
      needsPawnArt: false,
    });
    expect(now()).toBe("directed");
    store.startRender(id, "job-1");
    expect(now()).toBe("rendering");
    store.finishRender(id, "job-1", { error: "boom" });
    expect(now()).toBe("render-failed");
    store.startRender(id, "job-2", { force: true });
    store.finishRender(id, "job-2", {
      video: VIDEO,
      sheet: SHEET,
      music: PLAYED,
      quality: MEASURED,
    });
    expect(now()).toBe("rendered");
    store.recordCheck(id, { sheetSha256: "ss", stills: [ZOOM_OK] });
    expect(now()).toBe("checked");
    // Production is over; the item waits for Growth's block.
    expect(itemOf(store, id).state).toBe("finished");
    expect(reviewState(itemOf(store, id))).toBe("waiting-copy");
  });

  test("a new list sends a finished item back to draft, out of review", () => {
    const store = openStore(tempDir());
    const id = finishItem(store);
    expect(reviewState(itemOf(store, id))).toBe("in-review");
    store.direct(id, {
      edl: EDL,
      text: "a new list",
      summary: [],
      needsPawnArt: false,
    });
    const it = itemOf(store, id);
    expect([it.state, stage(it), reviewState(it)]).toEqual([
      "draft",
      "directed",
      null,
    ]);
    expect(it.render).toBeNull();
    expect(it.check).toBeNull();
  });

  test("items move on their own: one is directed again while the others stay finished", () => {
    const { store, a, b, c } = three();
    store.direct(b, {
      edl: EDL,
      text: "new list",
      summary: [],
      needsPawnArt: false,
    });
    expect(itemOf(store, a).state).toBe("finished");
    expect(stage(itemOf(store, b))).toBe("directed");
    expect(itemOf(store, c).state).toBe("finished");
  });

  test("a render with other bytes makes only that item's block stale", () => {
    const { store, a, b, c } = three();
    store.direct(b, {
      edl: EDL,
      text: "new list",
      summary: [],
      needsPawnArt: false,
    });
    renderItem(store, b, { ...VIDEO, sha256: "dd" }, { force: true });
    store.recordCheck(b, { sheetSha256: "ss", stills: [ZOOM_OK] });
    // Finished, but its block is for the old video: not for Nil.
    expect(itemOf(store, b).state).toBe("finished");
    expect(reviewState(itemOf(store, b))).toBe("waiting-copy");
    // The new video needs its vet first, then a block of its own.
    expect(store.staleCopy(itemOf(store, b))).toContain(
      `${b}'s video has no independent review (crew.mjs vet --item ${b})`,
    );
    for (const other of [a, c]) {
      expect(store.staleCopy(itemOf(store, other))).toBeNull();
      expect(reviewState(itemOf(store, other))).toBe("in-review");
    }
    vetItem(store, b);
    expect(store.staleCopy(itemOf(store, b))).toContain(
      `${b}'s copy block was written for another video (bb, now dd)`,
    );
    // A block for the new video (after its vet) puts it back in review.
    store.recordCopy(b, COPY_B);
    expect(reviewState(itemOf(store, b))).toBe("in-review");
  });

  test("a render of the same bytes keeps the block (a re-render from the cache)", () => {
    const { store, b } = three();
    store.direct(b, {
      edl: EDL,
      text: "same list",
      summary: [],
      needsPawnArt: false,
    });
    renderItem(store, b, { ...VIDEO, sha256: "bb" }, { force: true });
    expect(store.staleCopy(itemOf(store, b))).toBeNull();
    store.recordCheck(b, { sheetSha256: "ss", stills: [ZOOM_OK] });
    expect(reviewState(itemOf(store, b))).toBe("in-review");
  });

  test("drop needs a reason; a draft or a finished item is discarded, with the reason", () => {
    const store = openStore(tempDir());
    const draft = directItem(store);
    expect(() => {
      store.drop(draft, " ");
    }).toThrow("drop needs the reason");
    expect(itemOf(store, draft).state).toBe("draft");
    store.drop(draft, "the save is too small to read");
    expect(itemOf(store, draft).state).toBe("discarded");
    expect(itemOf(store, draft).events.at(-1)?.what).toBe(
      "dropped by the director: the save is too small to read",
    );
    const done = finishItem(store, VIDEO, COPY, true);
    store.drop(done, "a better game came in");
    expect(itemOf(store, done).state).toBe("discarded");
    // A discarded item takes no more steps.
    expect(() => {
      store.direct(done, {
        edl: EDL,
        text: "again",
        summary: [],
        needsPawnArt: false,
      });
    }).toThrow(`${done} is discarded`);
  });

  test("no drop while the render runs, nor once Nil approved the item", () => {
    const store = openStore(tempDir());
    const running = directItem(store);
    store.startRender(running, "job-1");
    expect(() => {
      store.drop(running, "late");
    }).toThrow(
      `drop needs ${running} picked or directed or rendered or render-failed or checked, but it is rendering`,
    );
    const approved = finishItem(store, VIDEO, COPY, true);
    approveItem(store, approved);
    expect(() => {
      store.drop(approved, "changed my mind");
    }).toThrow(`${approved} is approved`);
    // Nor can a new block change what Nil approved.
    expect(() => {
      store.recordCopy(approved, COPY);
    }).toThrow(`${approved} is approved`);
  });
});

describe("each render is one production view", () => {
  test("a second live render of a game the same UTC day needs force, also from a new item", () => {
    const store = openStore(tempDir());
    const first = directItem(store);
    store.startRender(first, "job-00000001");
    store.finishRender(first, "job-00000001", { error: "boom" });
    expect(() => {
      store.startRender(first, "job-00000002");
    }).toThrow(/already rendered 1 time/);
    // The count is the game's, over every item.
    const second = directItem(store);
    expect(() => {
      store.startRender(second, "job-00000003");
    }).toThrow(/already rendered 1 time/);
    // A render from the capture loads no page: no view, no refusal.
    store.startRender(second, "job-00000003", { fromCache: true });
    store.startRender(first, "job-00000004", { force: true });
    expect(stage(itemOf(store, first))).toBe("rendering");
    const counts = JSON.parse(
      readFileSync(store.rendersFile, "utf8"),
    ) as Record<string, Record<string, number>>;
    expect(counts[utcDay()]).toEqual({ TESTGAME1: 2 });
  });
});

test("the edit list summary names the start, the cold open, the payoff, a race flash and a lead zoom", () => {
  expect(
    edlSummary({
      ending: "gg",
      music: [
        { fromPly: 0, track: "skippy" },
        { fromPly: 31, track: "deja-vus" },
      ],
      caption: "Red is 2 steps from winning",
      payoff: { ply: 22, text: "one wall later: 12" },
      vsSound: "shotgun-2",
      finishSound: "shotgun-2",
      startPly: 6,
      coldOpenPly: 22,
      pace: [
        { fromPly: 6, toPly: 15, secondsPerMove: 0.2, fastForward: true },
        { fromPly: 16, toPly: 21, secondsPerMove: 1, fastForward: false },
      ],
      events: [
        { ply: 22, kind: "race", sound: null },
        {
          ply: 39,
          kind: "zoom",
          lead: true,
          frame: ["g2", "g1", "f1"],
          sound: "seeya-3",
        },
        { ply: 43, kind: "zoom", lead: false, frame: ["^d1"], sound: null },
      ],
    }),
  ).toEqual([
    'ending gg, music skippy, then deja-vus from ply 31, video caption "Red is 2 steps from winning"',
    "VS sound shotgun-2, finish sound shotgun-2",
    "starts at ply 6",
    "cold open: the position after ply 22",
    'from ply 22: video caption "one wall later: 12"',
    "plies 6-15: 0.2 s per move, fast-forward x4",
    "plies 16-21: 1 s per move",
    "ply 22: race counter flash",
    "ply 39: lead zoom (before the move) on g2 g1 f1 + seeya-3",
    "ply 43: zoom on ^d1",
  ]);
});

describe("the app's measures of a render", () => {
  /** A meme as the renderer reports it (mix-loudness.mjs). */
  const meme = (memeLufs: number, overLU: number | null) => ({
    key: "fuahhh-1",
    at: 16.9,
    loudestAt: 17.1,
    memeLufs,
    bedLufs: overLU === null ? null : memeLufs - overLU,
    overLU,
    truePeakDbtp: -13.4,
  });

  test("a meme sound passes at the -21 target, even over a quiet bed", () => {
    // Today's FAHHH: -20.6 LUFS; 15.2 LU over tea-for-two's quiet bar.
    const v = loudnessVerdict({ memes: [meme(-20.6, 15.2)] });
    expect(v.ok).toBe(true);
    expect(v.note).toBe(
      "fuahhh-1 at 16.9 s: -20.6 LUFS, 15.2 LU over the bed (-35.8 LUFS), true peak -13.4 dBTP",
    );
  });

  test("a meme sound at the old -16 level fails, however loud the bed", () => {
    // N42PHQnw (Nil: "a bit too loud"): -15.6 LUFS, 7.7 LU over its bed.
    expect(MAX_MEME_LUFS).toBe(-18.5);
    const v = loudnessVerdict({ memes: [meme(-20.6, 3), meme(-15.6, 7.7)] });
    expect(v.ok).toBe(false);
    expect(v.note).toMatch(
      /^fuahhh-1 at 16\.9 s: -15\.6 LUFS, 7\.7 LU over the bed .*: a meme sound may be at most -18\.5 LUFS; drop or change it/,
    );
  });

  test("how far a meme stands over its bed is told, not judged", () => {
    // mvpi6y28: a laugh in a rest of Tea For Two, up to 37 LU over the bed.
    const far = loudnessVerdict({ memes: [meme(-20.8, 37.3)] });
    expect(far.ok).toBe(true);
    expect(far.note).toContain("37.3 LU over the bed");
    const silence = loudnessVerdict({ memes: [meme(-21, null)] });
    expect(silence.ok).toBe(true);
    expect(silence.note).toContain("-21 LUFS, over silence");
  });

  test("a render that did not measure fails; one with no meme passes", () => {
    expect(loudnessVerdict(null).note).toMatch(/reported no meme loudness/);
    expect(loudnessVerdict(undefined).ok).toBe(false);
    expect(loudnessVerdict({ error: "ffmpeg gone" })).toEqual({
      ok: false,
      note: "the renderer could not measure the meme sounds: ffmpeg gone",
    });
    expect(loudnessVerdict({ memes: [] })).toEqual({
      ok: true,
      note: "no meme sound",
    });
  });

  test("every measured box must lie inside the safe area", () => {
    const board = { x: 81, y: 380, w: 918, h: 852 };
    const caption = { x: 81, y: 285, w: 918, h: 60 };
    const layout = { frame: { w: 1080, h: 1920 }, boxes: { board, caption } };
    expect(safeAreaVerdict(layout, FRAME)).toEqual({
      ok: true,
      note: "board, caption inside the safe area",
    });
    // The board of the audited renders (y 436-1483) ends under the buttons.
    const low = {
      ...layout,
      boxes: { board: { x: 16, y: 436, w: 1048, h: 1048 } },
    };
    const v = safeAreaVerdict(low, FRAME);
    expect(v.ok).toBe(false);
    expect(v.note).toBe(
      "board (x 16-1064, y 436-1484) is outside the safe area (x 65-1015, y 269-1248)",
    );
    expect(safeAreaVerdict(undefined, FRAME).note).toBe(
      "the render reported no layout",
    );
    expect(
      safeAreaVerdict({ ...layout, frame: { w: 1080, h: 1080 } }, FRAME).note,
    ).toBe("the frame is 1080x1080, not 1080x1920");
  });

  test("the players strip lies in the strip area under the safe area; no other box may", () => {
    const board = { x: 81, y: 380, w: 918, h: 852 };
    // The strip of ec1109cb's renders, about y 1248-1351.
    const strip = { x: 140, y: 1248, w: 800, h: 103 };
    interface Box {
      x: number;
      y: number;
      w: number;
      h: number;
    }
    const layout = (boxes: Record<string, Box>) => ({
      frame: { w: 1080, h: 1920 },
      boxes,
    });
    expect(safeAreaVerdict(layout({ board, strip }), FRAME)).toEqual({
      ok: true,
      note: "board inside the safe area; strip inside the strip area",
    });
    // A strip up in the safe area's band is out of its own area.
    expect(
      safeAreaVerdict(layout({ board, strip: { ...strip, y: 1100 } }), FRAME),
    ).toEqual({
      ok: false,
      note: "strip (x 140-940, y 1100-1203) is outside the strip area (x 140-940, y 1248-1436)",
    });
    // Any other box in the strip's band is below the safe area.
    expect(
      safeAreaVerdict(
        layout({ board, caption: { ...strip, y: STRIP_AREA.y + 10 } }),
        FRAME,
      ),
    ).toEqual({
      ok: false,
      note: "caption (x 140-940, y 1258-1361) is outside the safe area (x 65-1015, y 269-1248)",
    });
  });

  test("each caption beat must be one line inside its box", () => {
    const slot = { x: 81, y: 285, w: 918, h: 60 };
    const layout = (captionText?: object) => ({
      frame: { w: 1080, h: 1920 },
      boxes: { caption: slot, payoff: slot },
      captionText,
    });
    // Worker 2's measures on the 4090 stage, 2026-10-26.
    expect(
      captionLinesVerdict(
        layout({
          caption: { lines: 1, width: 702 },
          payoff: { lines: 1, width: 421 },
        }),
      ),
    ).toEqual({
      ok: true,
      note: "caption 1 line, 702 of 918 px; payoff 1 line, 421 of 918 px",
    });
    expect(
      captionLinesVerdict(
        layout({
          caption: { lines: 1, width: 702 },
          payoff: { lines: 2, width: 882 },
        }),
      ),
    ).toEqual({
      ok: false,
      note: "payoff 2 lines, 882 of 918 px: each beat must be one line inside its box; shorten it, direct again and render",
    });
    // One long word cannot wrap: one line, but past the box.
    expect(
      captionLinesVerdict(layout({ caption: { lines: 1, width: 1743 } })).ok,
    ).toBe(false);
    expect(captionLinesVerdict(layout({}))).toEqual({
      ok: true,
      note: "no caption",
    });
    // A renderer that did not measure fails, so a wrap cannot pass unseen.
    expect(captionLinesVerdict(layout()).ok).toBe(false);
  });
});

/** The message a promise is refused with, or null when it is not. */
const refusal = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};

describe("postPlatform posts an approved item in the platform's mode", () => {
  /** An approved item whose video is a file; its store, id and bytes. */
  const approvedOnDisk = () => {
    const dir = tempDir();
    const path = join(dir, "v.mp4");
    writeFileSync(path, "bytes");
    const store = openStore(dir);
    const id = finishItem(store, {
      path,
      bytes: 5,
      sha256: sha256(readFileSync(path)),
      // A render reports it; Facebook refuses a video of unknown length.
      durationSeconds: 30,
    });
    approveItem(store, id);
    return { dir, store, id, video: readFileSync(path) };
  };

  test("a lost reply to the final X request leaves the post uncertain", async () => {
    const { dir, store, id, video } = approvedOnDisk();
    let lose = true;
    const daily = createDaily({
      dataDir: dir,
      env: {},
      dryRunReplies: {
        x: (req: { url: string }) => {
          if (lose && req.url.endsWith("/2/tweets")) {
            throw new Error("socket hang up");
          }
          return xDryRunReply(req);
        },
      },
    });
    const post = async (confirmedNotPosted = false) =>
      (await daily.postPlatform("x", {
        item: itemOf(store, id),
        video,
        beforeCommit: () => undefined,
        confirmedNotPosted,
      })) as PostResult;
    const first = await post();
    expect(first).toMatchObject({
      ok: false,
      uncertain: true,
      mode: "dry-run",
    });
    // The poster records the result, as review-post.mjs does.
    store.updateItem(
      id,
      ["approved"],
      (it: { posts: Record<string, unknown> }) => {
        it.posts = { ...it.posts, x: first };
      },
      "x: uncertain",
    );
    lose = false;
    // No second post until a person checks X and says it is not there.
    expect(await refusal(post())).toMatch(/x may already have v-/);
    expect(await post(true)).toMatchObject({
      ok: true,
      postId: "DRY-RUN-POST-ID",
    });
  });

  test("the last guard before a public post: Nil's video and block, every line, no second post", async () => {
    const { dir, store, id, video } = approvedOnDisk();
    const daily = createDaily({ dataDir: dir, env: {} });
    const post = (bytes: Buffer = video, platform = "bluesky") =>
      daily.postPlatform(platform, {
        item: itemOf(store, id),
        video: bytes,
        beforeCommit: () => undefined,
      }) as Promise<PostResult>;
    const change = (
      mutate: (it: Item & { posts: Record<string, unknown> }) => void,
    ): void => {
      store.updateItem(id, ["approved"], mutate, "test change");
    };
    expect(await refusal(post(Buffer.from("other bytes")))).toMatch(
      "the video is not the one Nil approved",
    );
    const block = itemOf(store, id).copy!.block;
    change((it) => {
      it.copy!.block = { ...block, bluesky: "another text #wallgame" };
    });
    expect(await refusal(post())).toMatch(
      "the copy block is not the one Nil approved",
    );
    change((it) => {
      it.copy!.block = block;
      it.posts = { bluesky: { ok: true, mode: "dry-run" } };
    });
    expect(await refusal(post())).toMatch(/^bluesky already has v-/);
    expect(await refusal(post(video, "myspace"))).toMatch(
      "myspace is not a platform",
    );
    // A refusal sends nothing: no requests file.
    expect(readdirSync(store.dirs.requests)).toEqual([]);
    // Another platform of the same item still posts.
    expect(await post(video, "threads")).toMatchObject({ ok: true });
    // Only an approved (or posting) item.
    change((it) => {
      it.state = "discarded";
    });
    expect(await refusal(post(video, "x"))).toMatch(
      "is discarded; a post needs it approved or posting",
    );
  });

  test("an approval from before a platform had its line posts nothing there", () => {
    const item = {
      id: "v-2026-10-20-A",
      state: "approved",
      approval: { videoSha256: "v", copySha256: "", by: "Nil", at: "t" },
      copy: { block: { ...COPY, threads: undefined } },
      posts: {},
    };
    item.approval.copySha256 = copySha256(item.copy.block as never);
    expect(
      postProblem(item, "x", { videoSha256: "v", confirmedNotPosted: false }),
    ).toBe("the approved copy block of v-2026-10-20-A has no Threads line");
  });

  test("a track that may not play posts nothing, even when approved (its license can change after)", () => {
    const item = {
      id: "v-2026-10-20-A",
      state: "approved",
      approval: {
        videoSha256: "v",
        copySha256: copySha256(COPY),
        by: "Nil",
        at: "t",
      },
      copy: { block: COPY },
      render: { music: [{ fromPly: 0, track: "a-legend" }] },
      posts: {},
    };
    expect(
      postProblem(item, "x", { videoSha256: "v", confirmedNotPosted: false }),
    ).toBe(
      "the music a-legend has the license blocked-until-nil: v-2026-10-20-A may not post",
    );
    item.render.music = [{ fromPly: 0, track: "deja-vus" }];
    expect(
      postProblem(item, "x", { videoSha256: "v", confirmedNotPosted: false }),
    ).toBeNull();
  });

  test("the app stopped during the final request (pending): no post until a person confirms", () => {
    const item = {
      id: "v-2026-10-20-A",
      state: "posting",
      approval: {
        videoSha256: "v",
        copySha256: copySha256(COPY),
        by: "Nil",
        at: "t",
      },
      copy: { block: COPY },
      posts: {
        x: { ok: false, pending: true, at: "2026-10-28T12:00:00.000Z" },
      },
    };
    expect(
      postProblem(item, "x", { videoSha256: "v", confirmedNotPosted: false }),
    ).toBe(
      "x may already have v-2026-10-20-A (the app stopped during its final request at 2026-10-28T12:00:00.000Z); check the account, then post again with the confirmation that it is not there",
    );
    expect(
      postProblem(item, "x", { videoSha256: "v", confirmedNotPosted: true }),
    ).toBeNull();
  });

  describe("the TikTok refresh after a connect", () => {
    /**
     * An approved item with TikTok connected and live, while the env still
     * holds an old TIKTOK_CLIENT_KEY. `token` answers the refresh request.
     */
    const postWithTiktokLive = async (
      token: (req: { url: string }) => unknown,
    ) => {
      const { dir, store, id, video } = approvedOnDisk();
      // TikTok connected, as /daily/connect stores it.
      openTokenStore(join(store.dirs.root, "tokens")).write("tiktok", {
        connectedAt: "2026-10-26T20:00:00.000Z",
        connectedBy: "Nil",
        scopes: ["video.upload"],
        account: { id: null, name: null },
        refreshToken: "stored-refresh",
      });
      const sent: { url: string; body?: unknown }[] = [];
      const daily = createDaily({
        dataDir: dir,
        // The old secret of the key's name is still in the environment.
        env: { TIKTOK_CLIENT_KEY: "old-env-key", TIKTOK_CLIENT_SECRET: "s" },
        live: () => ({
          mode: "live",
          sent,
          request: (req: { url: string; body?: unknown }) => {
            sent.push(req);
            return Promise.resolve(
              req.url === TIKTOK_TOKEN_URL
                ? token(req)
                : tiktokDryRunReply(req),
            );
          },
        }),
      });
      expect(daily.livePlatforms()).toEqual(["tiktok"]);
      const result = (await daily.postPlatform("tiktok", {
        item: itemOf(store, id),
        video,
        beforeCommit: () => undefined,
      })) as PostResult;
      return { result, sent };
    };

    test("carries the client key from code and the stored refresh token; an env var of the key's name has no effect", async () => {
      const { result, sent } = await postWithTiktokLive(tiktokDryRunReply);
      expect(result).toMatchObject({ ok: true, mode: "live" });
      const refresh = sent.find((r) => r.url === TIKTOK_TOKEN_URL);
      const body = new URLSearchParams(String(refresh?.body));
      expect(body.get("client_key")).toBe(PUBLIC_IDS.TIKTOK_CLIENT_KEY);
      expect(body.get("client_key")).toBe("sbawgnt7vpik5zdozp");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("stored-refresh");
    });

    test("a refused refresh is a plain TikTok error, not a silent dry run", async () => {
      const { result } = await postWithTiktokLive(() => ({
        status: 400,
        json: { error: "invalid_client" },
      }));
      if (result.ok) throw new Error("the refused refresh posted");
      expect(result.mode).toBe("live");
      expect(result.error).toMatch(/^tiktok token: HTTP 400 .*invalid_client/);
      // A 4xx before the upload: nothing was made, so a retry is safe.
      expect(result.uncertain).toBe(false);
    });
  });
});

/** COPY with one text changed. */
const withText = (field: string, text: string) => ({ ...COPY, [field]: text });

describe("Growth's copy block", () => {
  test("the eight lines are the texts that post; the app adds only #Shorts", () => {
    const players = playerNames(candidateFromReport(REPORT, 1));
    expect(parseCopy(BLOCK).problems).toEqual([]);
    expect(copyProblems(COPY, "TESTGAME1", players)).toEqual([]);
    expect(copyLines(COPY).join("\n")).toBe(BLOCK);
    const texts = postTexts(COPY);
    expect(texts.x).toBe(COPY.x);
    expect(texts.youtubeTitle).toBe(`${COPY.youtubeTitle} #Shorts`);
    expect(texts.youtubeDescription).toBe(COPY.youtubeDescription);
    expect(texts.instagram).toBe(COPY.instagram);
    // Blank lines and indentation (as in Growth's playbook) do not count.
    const indented = `\n${BLOCK.split("\n")
      .map((l) => `    ${l}`)
      .join("\n\n")}\n`;
    expect(parseCopy(indented).copy).toEqual(parseCopy(BLOCK).copy);
  });

  test("a block that is not exactly the eight labelled lines is refused", () => {
    const lines = BLOCK.split("\n");
    expect(parseCopy(lines.slice(1).join("\n")).problems).toEqual([
      'no "X:" line',
    ]);
    expect(parseCopy([...lines, lines[0]].join("\n")).problems).toEqual([
      'line 9: "X" comes twice',
    ]);
    expect(parseCopy([...lines, "Pinterest: hi"].join("\n")).problems).toEqual([
      'line 9 does not start with one of "X:", "YouTube title:", "YouTube description:", "TikTok:", "Instagram:", "Facebook:", "Bluesky:", "Threads:"',
    ]);
    expect(
      parseCopy(
        [...lines.slice(0, 4), "Instagram:  ", ...lines.slice(5)].join("\n"),
      ).problems,
    ).toEqual(['the "Instagram:" line is empty']);
    expect(parseCopy(undefined).copy).toBeNull();
  });

  test("Facebook, Bluesky and Threads: each its own count, and only the tracked link", () => {
    const problems = (field: string, text: string) =>
      copyProblems(withText(field, text), "TESTGAME1");
    const bsky = trackedLink("bluesky");
    // Bluesky: 300 graphemes; the link counts in full.
    expect(
      problems("bluesky", `${"a".repeat(300 - bsky.length - 1)} ${bsky}`),
    ).toEqual([]);
    expect(
      problems("bluesky", `${"a".repeat(300 - bsky.length)} ${bsky}`),
    ).toEqual(["bluesky text is 301 characters (graphemes); the limit is 300"]);
    // Threads: 500, an emoji counting its UTF-8 bytes.
    expect(problems("threads", "😭".repeat(125))).toEqual([]);
    expect(problems("threads", "😭".repeat(126))).toHaveLength(1);
    // A link is allowed on all three (Facebook and Threads start without
    // one), but only the platform's tracked link.
    expect(problems("facebook", `hi ${trackedLink("facebook")}`)).toEqual([]);
    expect(problems("bluesky", `hi ${trackedLink("threads")}`)).toEqual([
      `Bluesky may hold only the link ${bsky}`,
    ]);
    expect(problems("threads", `hi https://example.com/x`)).toEqual([
      `Threads may hold only the link ${trackedLink("threads")}`,
    ]);
    // A bare domain becomes an untracked link on these platforms.
    expect(problems("facebook", "play at wallgame.io")).toEqual([
      `Facebook may hold only the link ${trackedLink("facebook")}`,
    ]);
    expect(problems("bluesky", `${bsky} or www.wallgame.io`)).toHaveLength(1);
  });

  test("every platform limit is checked when the block comes in", () => {
    const problems = (field: string, text: string) =>
      copyProblems(withText(field, text), "TESTGAME1");
    expect(problems("x", "a".repeat(281))).toEqual([
      "X is over 280 in X's count (an emoji or a non-Latin letter counts 2)",
    ]);
    expect(problems("youtubeTitle", "bro... #wallgame #Shorts")).toEqual([
      "YouTube title must not hold #Shorts: the app adds it",
    ]);
    // 93 characters + " #Shorts" is 101.
    expect(problems("youtubeTitle", "b".repeat(93))).toEqual([
      'YouTube title is over 100 characters with the "#Shorts" the app adds',
    ]);
    expect(problems("youtubeTitle", "b".repeat(92))).toEqual([]);
    expect(problems("youtubeDescription", "bro 😭 Play Wall Game")).toEqual([
      `YouTube description must hold the tracked link ${YOUTUBE_LINK}`,
    ]);
    expect(problems("tiktok", "a".repeat(2201))).toEqual([
      "TikTok is over 2200 characters",
    ]);
    expect(problems("instagram", "bro #a #b #c #d #e #f")).toEqual([
      "Instagram has 6 hashtags; at most 5 are allowed",
    ]);
    expect(problems("instagram", "bro #a #b #c #d #e")).toEqual([]);
    // X weighs an emoji 2: 140 of them is 280, one more letter is over.
    expect(problems("x", "😭".repeat(140))).toEqual([]);
    expect(problems("x", "😭".repeat(140) + "a")).toEqual([
      "X is over 280 in X's count (an emoji or a non-Latin letter counts 2)",
    ]);
    expect(problems("x", "日".repeat(141))).toEqual([
      "X is over 280 in X's count (an emoji or a non-Latin letter counts 2)",
    ]);
    // YouTube counts the description in UTF-8 bytes: an emoji is 4.
    const description = (n: number) =>
      `${"😭".repeat(n)} Play Wall Game: ${YOUTUBE_LINK}`;
    const room = (5000 - Buffer.byteLength(description(0))) / 4;
    expect(
      problems("youtubeDescription", description(Math.floor(room))),
    ).toEqual([]);
    expect(
      problems("youtubeDescription", description(Math.floor(room) + 1)),
    ).toEqual([
      `YouTube description is ${Buffer.byteLength(description(Math.floor(room) + 1))} bytes; YouTube takes at most 5000`,
    ]);
    // Growth's playbook: no link on Instagram (it is not clickable there).
    expect(problems("instagram", "bro 😭 wallgame.io")).toEqual([
      "Instagram must not hold a link",
    ]);
  });

  test("the copy hash covers the five texts and the version", () => {
    expect(copySha256({ ...COPY })).toBe(COPY_SHA);
    expect(copySha256(withText("tiktok", "other"))).not.toBe(COPY_SHA);
    expect(copySha256({ ...COPY, version: "growth-copy-2" })).not.toBe(
      COPY_SHA,
    );
  });

  test("no game id in anything posted", () => {
    expect(
      copyProblems(withText("tiktok", "see testgame1 lol"), "TESTGAME1"),
    ).toEqual(["TikTok must not hold the game id"]);
  });

  test("the facts are the picker's own sentences, with the move number", () => {
    expect(
      (candidateFromReport(REPORT, 1) as { facts: string[] }).facts[0],
    ).toBe(
      "Move 23: Guest Tuatara's wall makes Ruby walk 6 extra squares (2 to 8).",
    );
  });

  test("a close call comes before the walls, and carries its cells", () => {
    const report = {
      ...REPORT,
      ranked: [{ ...REPORT.ranked[0], beats: [CLOSE_CALL] }],
    };
    const c = candidateFromReport(report, 1) as {
      facts: string[];
      beats: DescribedCloseCall[];
    };
    expect(c.facts[0]).toBe(
      `Move 10: ${CLOSE_CALL.description} Guest Tuatara wins at move 41.`,
    );
    expect(c.facts[1]).toMatch(/^Move 23: /);
    expect(c.beats[0].danger.preyCell).toBe("g4");
    // The storyboard replays the moves from the start position.
    const start = { pawns: {}, walls: [] };
    expect(
      candidateFromReport(
        { ...REPORT, ranked: [{ ...REPORT.ranked[0], initialState: start }] },
        1,
      ).initialState,
    ).toEqual(start);
    // No beat: the walls alone, as before.
    expect(candidateFromReport(REPORT, 1).beats).toEqual([]);
  });

  test("an escape comes after the close calls, before the walls", () => {
    const report = (last?: Record<number, number>) => ({
      ...REPORT,
      ranked: [
        {
          ...REPORT.ranked[0],
          beats: [CLOSE_CALL],
          escapes: [ESCAPE],
          ...(last && {
            distances: [...REPORT.ranked[0].distances.slice(0, 41), last],
          }),
        },
      ],
    });
    const c = candidateFromReport(report(), 1) as {
      facts: string[];
      escapes: DescribedEscape[];
    };
    expect(c.facts[0]).toMatch(/^Move 10: /);
    expect(c.facts[1]).toBe(
      `Move 15: ${ESCAPE.description} Guest Tuatara wins at move 41.`,
    );
    expect(c.facts[2]).toMatch(/^Move 23: /);
    expect(c.escapes[0]).toMatchObject({
      ply: 14,
      preyFrom: "g5",
      preyCell: "f4",
      hunterCell: "g4",
    });
    // The hunter still wins: the fact counts the moves after the escape.
    expect(candidateFromReport(report({ 1: 3, 2: 0 }), 1).facts[1]).toMatch(
      /the cat must walk 4 \(move 15\)\. Ruby still wins at move 41, 26 moves after the escape\.$/,
    );
    // A report from before escapes has none.
    expect(candidateFromReport(REPORT, 1).escapes).toEqual([]);
    // A cell the renderer cannot place is refused.
    const bad = {
      ...REPORT,
      ranked: [
        { ...REPORT.ranked[0], escapes: [{ ...ESCAPE, preyFrom: "<b>" }] },
      ],
    };
    expect(() => candidateFromReport(bad, 1)).toThrow(/an escape/);
  });

  test("a zoom on a save frames every cause wall and both pawns", () => {
    const beat = {
      ...CLOSE_CALL,
      save: {
        ...CLOSE_CALL.save,
        walls: [
          { notation: "^g3", between: ["g4", "g3"], alone: 2, cause: true },
          { notation: "^h3", between: ["h4", "h3"], alone: 0, cause: true },
          { notation: ">a1", between: ["a1", "b1"], alone: 0, cause: false },
        ],
      },
    };
    const zoom = (frame: string[]) => ({
      ...EDL,
      events: [{ ply: 9, kind: "zoom", frame }],
    });
    expect(saveFrameProblems(zoom(["^g3", "^h3", "g3", "g4"]), [beat])).toEqual(
      [],
    );
    expect(saveFrameProblems(zoom(["^g3", "g3", "g4"]), [beat])).toEqual([
      "events[0]: the zoom on save ply 9 must frame ^g3 ^h3 g3 g4; missing ^h3",
    ]);
    // Another ply is not the save: no rule.
    expect(
      saveFrameProblems(
        { ...EDL, events: [{ ply: 3, kind: "zoom", frame: ["a1"] }] },
        [beat],
      ),
    ).toEqual([]);
  });

  test("a close call's fact says who wins the game after it", () => {
    const report = (last: Record<number, number>) => ({
      ...REPORT,
      ranked: [
        {
          ...REPORT.ranked[0],
          beats: [CLOSE_CALL],
          distances: [...REPORT.ranked[0].distances.slice(0, 41), last],
        },
      ],
    });
    // Ruby (player 2) hunts; the guest's mouse is the prey.
    expect(candidateFromReport(report({ 1: 3, 2: 0 }), 1).facts[0]).toMatch(
      /the mouse is safe\. Ruby still wins at move 41, 31 moves after the save\.$/,
    );
    expect(candidateFromReport(report({ 1: 0, 2: 4 }), 1).facts[0]).toMatch(
      /the mouse is safe\. Guest Tuatara wins at move 41\.$/,
    );
    // A resign: no walk ends at 0, so nothing is said.
    expect(candidateFromReport(report({ 1: 3, 2: 4 }), 1).facts[0]).toMatch(
      /the mouse is safe\.$/,
    );
  });

  test("race counts that are not one per position are refused", () => {
    const report = {
      ...REPORT,
      ranked: [
        {
          ...REPORT.ranked[0],
          distances: REPORT.ranked[0].distances.slice(1),
        },
      ],
    };
    expect(() => candidateFromReport(report, 1)).toThrow(/race counts/);
  });

  test("a close call with a cell the renderer cannot place is refused", () => {
    const bad = {
      ...CLOSE_CALL,
      relief: { ...CLOSE_CALL.relief, preyCell: "<b>" },
    };
    const report = {
      ...REPORT,
      ranked: [{ ...REPORT.ranked[0], beats: [bad] }],
    };
    expect(() => candidateFromReport(report, 1)).toThrow(/close call/);
  });

  test("no @mention, no < or >, in anything posted", () => {
    expect(
      copyProblems(withText("x", "@ruby you ok? <3"), "TESTGAME1"),
    ).toEqual(["X must not mention anyone (@)", "X must not hold < or >"]);
    expect(
      copyProblems(withText("youtubeTitle", "bro <3..."), "TESTGAME1"),
    ).toEqual(["YouTube title must not hold < or >"]);
    // An address-like @ inside a word is not a mention.
    expect(copyProblems(withText("x", "ruby@home"), "TESTGAME1")).toEqual([]);
  });

  test("a player is bro, never a name; the bot can be named; no #wallz", () => {
    const players = playerNames(candidateFromReport(REPORT, 1));
    expect(players).toEqual(["Guest Tuatara"]);
    const problems = copyProblems(
      {
        ...withText("x", "guest tuatara walled himself in 😭🙏"),
        youtubeTitle: "ruby got humbled... #wallz",
      },
      "TESTGAME1",
      players,
    );
    expect(problems).toEqual([
      "X must not name the player Guest Tuatara: say bro",
      "YouTube title must not hold #wallz",
    ]);
    expect(
      copyProblems(
        {
          ...withText("x", "bro walled himself in 😭🙏 #wallgame"),
          youtubeTitle: "ruby did not miss... #wallgame #gaming #boardgames",
        },
        "TESTGAME1",
        players,
      ),
    ).toEqual([]);
    // The whole name only: "Nil" is not in "vanilla".
    expect(textProblems({ x: "vanilla bro 😭" }, "TESTGAME1", ["Nil"])).toEqual(
      [],
    );
  });

  test("a link in the X text is refused, bare domain included", () => {
    expect(
      copyProblems(withText("x", "play at wallgame.io"), "TESTGAME1"),
    ).toEqual(["X must not hold a link"]);
  });

  test("a player name that could carry a link or a mention is refused", () => {
    const bad = structuredClone(REPORT);
    bad.ranked[0].seats[0].name = "@someone https://x";
    expect(() => candidateFromReport(bad, 1)).toThrow(
      /characters a post must not carry/,
    );
  });
});

describe("what a stranger reads matches what the video shows", () => {
  // Rehearsal, 2026-10-26: "Red was 2 steps from winning" over a counter that
  // said 10, and a laugh 4 plies before the laughing side lost.
  const counts = (red: number[]) =>
    red.map((n, k) => ({ 1: k === red.length - 1 ? 0 : 9, 2: n }));
  // Player 2 (Red) walks 10, 10, 8, 2, then a wall makes it 12 (ply 3).
  const game = {
    distances: counts([10, 10, 8, 2, 12, 12, 12]),
    beats: [] as DescribedCloseCall[],
    movesCount: 6,
  };
  const list = (edl: Record<string, unknown>) => {
    const r = validateEdl({
      version: 1,
      gameId: "TESTGAME1",
      ending: "gg",
      ...edl,
    });
    if (!r.edl) throw new Error((r.errors ?? []).join("; "));
    return r.edl;
  };

  test("a caption's number must be on the counter when it is first read", () => {
    expect(
      storyProblems(list({ caption: "Red was 2 steps away" }), game),
    ).toEqual([
      "the caption says 2, but the race counter shows 9 or 10 when the caption is first read; use a number that the counter shows then, or say it in words",
    ]);
    expect(
      storyProblems(list({ caption: "Red is 10 steps away" }), game),
    ).toEqual([]);
    expect(
      storyProblems(list({ caption: "Can Blue keep Red out?" }), game),
    ).toEqual([]);
  });

  test("a payoff's number is on the counter just before or after its move", () => {
    const payoff = (text: string) =>
      list({ caption: "Can Blue keep Red out?", payoff: { ply: 3, text } });
    expect(storyProblems(payoff("2 to 12"), game)).toEqual([]);
    expect(storyProblems(payoff("now it's 11"), game)).toEqual([
      "the payoff says 11, but the race counter shows 2 or 9 or 12 around ply 3; use a number that the counter shows then, or say it in words",
    ]);
  });

  test("no laugh on a save that the hunter wins soon after", () => {
    // Red (player 2) hunts the guest's mouse; the save is ply 9, and the
    // laugh plays after its zoom.
    const laugh = list({
      events: [
        { ply: 9, kind: "zoom", frame: ["g3", "g4"] },
        { ply: 9, kind: "laugh", cell: "g4" },
      ],
    });
    const ending = (winner: 1 | 2, plies: number) => ({
      distances: Array.from({ length: plies + 1 }, (_, k) =>
        k === plies
          ? { 1: winner === 1 ? 0 : 4, 2: winner === 2 ? 0 : 4 }
          : { 1: 6, 2: 6 },
      ),
      beats: [CLOSE_CALL],
      movesCount: plies,
    });
    expect(storyProblems(laugh, ending(2, 15))).toEqual([
      "events[1]: a laugh on save ply 9, but the hunter wins 5 plies later; the save only delays the loss, so say that in the payoff instead",
    ]);
    // The prey's side wins, or the hunter wins much later: the save was real.
    expect(storyProblems(laugh, ending(1, 15))).toEqual([]);
    expect(storyProblems(laugh, ending(2, 30))).toEqual([]);
  });
});

describe("TikTok", () => {
  test("a FAILED upload is a clear no, not an uncertain post", async () => {
    const transport = dryRunTransport((req: { url: string }) =>
      req.url.endsWith("/status/fetch/")
        ? {
            status: 200,
            json: {
              data: { status: "FAILED", fail_reason: "duration_check_failed" },
            },
          }
        : tiktokDryRunReply(req),
    );
    const err = await postToTiktok({
      video: Buffer.from("v"),
      transport,
      creds: DRY_RUN_TIKTOK,
      onRefreshToken: () => undefined,
      sleep: () => Promise.resolve(),
      beforeCommit: () => undefined,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotPosted);
    expect(String(err)).toMatch(/duration_check_failed/);
  });

  /** A live-mode transport that answers from `reply` and sends nothing. */
  const fakeLive = (reply: (req: { url: string }) => unknown) => ({
    mode: "live",
    sent: [],
    request: (req: { url: string }) => Promise.resolve(reply(req)),
  });
  const LIVE_CREDS = {
    TIKTOK_CLIENT_KEY: "k",
    TIKTOK_CLIENT_SECRET: "s",
    refreshToken: "kept",
  };

  test("a token reply without a refresh token keeps the old one", async () => {
    const saved: unknown[] = [];
    await postToTiktok({
      video: Buffer.from("v"),
      transport: fakeLive((req) =>
        req.url === TIKTOK_TOKEN_URL
          ? { status: 200, json: { access_token: "a", expires_in: 86400 } }
          : tiktokDryRunReply(req),
      ),
      creds: LIVE_CREDS,
      onRefreshToken: (t: unknown) => saved.push(t),
      sleep: () => Promise.resolve(),
      beforeCommit: () => undefined,
    });
    expect(saved).toEqual([]);
  });

  test("a refused status request after the upload leaves the post uncertain", async () => {
    const err = await postToTiktok({
      video: Buffer.from("v"),
      transport: fakeLive((req) =>
        req.url.endsWith("/status/fetch/")
          ? { status: 429, json: { error: { code: "rate_limit_exceeded" } } }
          : tiktokDryRunReply(req),
      ),
      creds: LIVE_CREDS,
      onRefreshToken: () => undefined,
      sleep: () => Promise.resolve(),
      beforeCommit: () => undefined,
    }).catch((e: unknown) => e);
    // routes reads a PostFailed 4xx as "not created"; this one may be a draft.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PostFailed);
    expect(String(err)).toMatch(/HTTP 429.*may exist/);
  });
});

describe("Instagram", () => {
  const run = (reply: (req: { url: string }) => unknown) => {
    const steps: string[] = [];
    const transport = dryRunTransport((req: { url: string }) => {
      steps.push(req.url.split("/").pop() ?? "");
      return reply(req);
    });
    return postToInstagram({
      video: Buffer.from("v"),
      caption: "c",
      publicUrl: dryRunPublicUrl,
      transport,
      creds: {
        igUserId: "DRY-RUN-IG-USER-ID",
        pageToken: "<Page token from /me/accounts>",
      },
      sleep: () => Promise.resolve(),
      beforeCommit: () => {
        steps.push("COMMIT");
      },
    })
      .then((r: unknown) => ({ r, e: undefined as unknown, steps }))
      .catch((e: unknown) => ({ r: undefined as unknown, e, steps }));
  };

  test("processing that ends in ERROR is a clear no, before the commit", async () => {
    const { e, steps } = await run((req) =>
      req.url.includes("fields=status_code")
        ? { status: 200, json: { status_code: "ERROR" } }
        : instagramDryRunReply(req),
    );
    expect(e).toBeInstanceOf(NotPosted);
    expect(steps).not.toContain("COMMIT");
  });

  /**
   * media_publish answers 400; the container reads after it say `after`, one
   * by one, and the last one again.
   */
  const publishRefused = (...after: string[]) => {
    let publishSeen = false;
    return (req: { url: string }) => {
      if (req.url.endsWith("/media_publish")) {
        publishSeen = true;
        return {
          status: 400,
          json: { error: { code: 2, is_transient: true } },
        };
      }
      if (publishSeen && req.url.includes("fields=status_code")) {
        const code = after.length > 1 ? after.shift() : after[0];
        return { status: 200, json: { status_code: code } };
      }
      return instagramDryRunReply(req);
    };
  };

  test("a refused media_publish whose container is PUBLISHED is a posted Reel", async () => {
    const { r } = await run(publishRefused("PUBLISHED"));
    expect(r).toEqual({ postId: null, url: null });
  });

  test("a refused media_publish whose container stays FINISHED is a clear no", async () => {
    const { e, steps } = await run(publishRefused("FINISHED"));
    expect(e).toBeInstanceOf(NotPosted);
    // Three reads after the refused publish (SETTLE_READS).
    const reads = steps.slice(steps.indexOf("media_publish") + 1);
    expect(reads.filter((s) => s.includes("fields=status_code"))).toHaveLength(
      3,
    );
  });

  test("an accepted publish that reads FINISHED for a moment, then PUBLISHED, is a posted Reel", async () => {
    const { r } = await run(publishRefused("FINISHED", "PUBLISHED"));
    expect(r).toEqual({ postId: null, url: null });
  });

  test("a refused media_publish with any other container state is uncertain", async () => {
    const { e } = await run(publishRefused("IN_PROGRESS"));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(PostFailed);
    expect(String(e)).toMatch(/IN_PROGRESS: look at the Instagram profile/);
  });

  test("the commit is media_publish, and a lost permalink does not fail the post", async () => {
    const { r, steps } = await run((req) =>
      req.url.includes("fields=permalink")
        ? { status: 500, json: null }
        : instagramDryRunReply(req),
    );
    expect(r).toEqual({ postId: "DRY-RUN-MEDIA-ID", url: null });
    // The R2 copy is deleted last.
    expect(steps.slice(-4, -1)).toEqual([
      "COMMIT",
      "media_publish",
      "DRY-RUN-MEDIA-ID?fields=permalink",
    ]);
    expect(steps.at(-1)).toMatch(/^[0-9a-f]{32}\.mp4$/);
  });
});

describe("X signing", () => {
  test("matches the OAuth 1.0a example X publishes", () => {
    // developer.x.com "Creating a signature": the status body parameter is
    // moved into the query string here, which leaves the signature base equal.
    const header = oauth1Header(
      {
        method: "POST",
        url:
          "https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=" +
          encodeURIComponent(
            "Hello Ladies + Gentlemen, a signed OAuth request!",
          ),
      },
      {
        consumerKey: "xvz1evFS4wEEPTGEFPHBog",
        consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      {},
      1318622958,
      "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    );
    expect(header).toContain(
      'oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"',
    );
  });

  test("a platform goes live only with every one of its keys", () => {
    expect(postingModes({})).toEqual(DRY);
    expect(postingModes({ X_API_KEY: "k" }).x).toBe("dry-run");
    // X: the key pair AND a Connect (the access token is not an env var).
    expect(postingModes({ X_API_KEY: "k", X_API_SECRET: "s" }).x).toBe(
      "dry-run",
    );
    expect(
      postingModes({ X_API_KEY: "k", X_API_SECRET: "s" }, new Set(["x"])).x,
    ).toBe("live");
  });

  test("YouTube, TikTok and Threads go live only with their client keys AND a Connect", () => {
    const youtube = { YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b" };
    const tiktok = { TIKTOK_CLIENT_KEY: "a", TIKTOK_CLIENT_SECRET: "b" };
    expect(postingModes(youtube)).toEqual(DRY);
    expect(postingModes(youtube, new Set(["youtube"]))).toEqual({
      ...DRY,
      youtube: "live",
    });
    expect(postingModes({}, new Set(["youtube", "tiktok"]))).toEqual(DRY);
    expect(postingModes(tiktok, new Set(["tiktok"])).tiktok).toBe("live");
    // The old token secrets do nothing now: one flow, through Connect.
    expect(
      postingModes({
        ...youtube,
        YOUTUBE_REFRESH_TOKEN: "c",
        ...tiktok,
        TIKTOK_REFRESH_TOKEN: "c",
      }),
    ).toEqual(DRY);
  });

  test("Threads goes live only with its keys, the R2 keys AND a Connect", () => {
    const keys = { THREADS_APP_ID: "u", THREADS_APP_SECRET: "t" };
    const connected = new Set(["threads"]);
    const r2 = {
      R2_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
    };
    expect(postingModes(keys, connected).threads).toBe("dry-run");
    expect(postingModes(r2, connected).threads).toBe("dry-run");
    expect(
      postingModes({ ...keys, ...r2, R2_ACCOUNT_ID: "" }, connected).threads,
    ).toBe("dry-run");
    expect(postingModes({ ...keys, ...r2 }).threads).toBe("dry-run");
    expect(postingModes({ ...keys, ...r2 }, connected)).toEqual({
      ...DRY,
      threads: "live",
    });
  });
});

test("the Instagram Story is live exactly when Instagram is, for the same reasons", () => {
  const meta = { META_SYSTEM_USER_TOKEN: "t" };
  const r2 = {
    R2_ACCOUNT_ID: "a",
    R2_ACCESS_KEY_ID: "k",
    R2_SECRET_ACCESS_KEY: "s",
  };
  for (const env of [{}, meta, r2, { ...meta, ...r2 }]) {
    const reasons = modeReasons(env);
    expect(reasons["instagram-story"]).toEqual(reasons.instagram);
  }
  expect(modeReasons(meta)["instagram-story"]).toEqual([
    "R2 secrets missing: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
    "R2 account id not set in code",
  ]);
  expect(postingModes({ ...meta, ...r2 })).toEqual({
    ...DRY,
    instagram: "live",
    "instagram-story": "live",
    facebook: "live",
  });
});

describe("the ending rotates", () => {
  const row = (utc: string, ending: string) => ({ utc, ending });

  test("an ending never posted comes first, in the renderer's order", () => {
    expect(nextEnding([])).toBe("replay");
    expect(nextEnding([row("2026-10-26T12:00:00Z", "replay")])).toBe("gg");
    expect(
      nextEnding([
        row("2026-10-26T12:00:00Z", "replay"),
        row("2026-10-27T12:00:00Z", "gg"),
      ]),
    ).toBe("ko");
  });

  test("then the one posted least recently, by its latest row", () => {
    // Each posted day has a row per platform; a re-use moves an ending last.
    const rows = [
      row("2026-10-26T12:00:00Z", "replay"),
      row("2026-10-26T12:01:00Z", "replay"),
      row("2026-10-27T12:00:00Z", "gg"),
      row("2026-10-28T12:00:00Z", "ko"),
      row("2026-10-29T12:00:00Z", "replay"),
    ];
    expect(nextEnding(rows)).toBe("gg");
    // Read order does not matter: live and dry-run rows arrive file by file.
    expect(nextEnding([...rows].reverse())).toBe("gg");
  });

  test("a row with no known ending does not count", () => {
    expect(nextEnding([{ utc: "2026-10-26T12:00:00Z" }])).toBe("replay");
  });
});

describe("the render step", () => {
  test("a RESULT line with 40 stills is read whole", () => {
    // Over 1 KB: the adapter brings it back by scp, not over ssh stdout.
    const stills = Array.from({ length: 40 }, (_, ply) => ({
      ply,
      kind: "zoom",
      sound: "fuahhh-1",
    }));
    const line = `RESULT ${JSON.stringify({ mp4: "/a", sheet: { png: "/a-sheet.png", sha256: "s", stills } })}\n`;
    expect(line.length).toBeGreaterThan(1024);
    const parsed = parseResult(line) as { sheet: { stills: unknown[] } };
    expect(parsed.sheet.stills).toHaveLength(40);
  });

  test("only the last RESULT line counts", () => {
    expect(parseResult('noise\nRESULT {"mp4":"/a"}\n')).toEqual({ mp4: "/a" });
    expect(parseResult("RESULT {broken\n")).toBeNull();
    expect(parseResult("no result")).toBeNull();
  });

  test("a render cut off by an app restart is closed, not left stuck", () => {
    const dir = tempDir();
    const store = openStore(dir);
    const id = directItem(store);
    store.startRender(id, "job-00000001");
    createDaily({ dataDir: dir, env: {} });
    const it = itemOf(openStore(dir), id);
    expect([it.state, stage(it)]).toEqual(["draft", "render-failed"]);
    expect(it.render?.error).toMatch(/app restarted/);
  });
});

/* ------------------------------------------------------- the whole cycle -- */

const freePort = (): Promise<number> =>
  new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

/**
 * A stand-in for render-4090.mjs that follows the same contract. A live
 * render saves the game's capture (a file "captured-<game>"; its text
 * "no-pawn-art" makes it an old one), which --has-capture reports and
 * --from-cache needs; the file "probe-fails"
 * makes --has-capture fail as an unreachable 4090 would, and the file
 * "claim-draft" makes the render say it is a quick look (RESULT.draft).
 * --lint gives lint.json when a test writes one.
 */
const STUB_RENDER = `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const at = (n) => process.argv[process.argv.indexOf("--" + n) + 1];
const hash = (b) => createHash("sha256").update(b).digest("hex");
const captured = (game) => __dirname + "/captured-" + game;
if (process.argv.includes("--has-capture")) {
  if (existsSync(__dirname + "/probe-fails")) {
    console.error("ssh: connect to host desktop: Connection timed out");
    process.exit(1);
  }
  // A capture file that says "no-pawn-art" is one from before the pawn art.
  const file = captured(at("has-capture"));
  console.log(!existsSync(file) ? "none"
    : readFileSync(file, "utf8") === "no-pawn-art" ? "cached-no-pawn-art"
    : "cached");
  process.exit(0);
}
if (process.argv.includes("--lint")) {
  // The renderer's lint: lint.json next to the stub when a test writes one.
  const file = __dirname + "/lint.json";
  const lint = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
    faults: [], notes: [],
    counts: { seconds: 30, events: {}, overlays: {}, sounds: {} } };
  console.log("RESULT " + JSON.stringify({ lint, timings: { check: 0.3,
    total: 2.1, workers: 1, renderer: { compose: 1.3, total: 1.6 } } }));
  process.exit(0);
}
const raw = readFileSync(at("edl"));
const edl = JSON.parse(raw);
const fromCache = process.argv.includes("--from-cache");
if (fromCache && !existsSync(captured(edl.gameId))) {
  console.error("the 4090 render failed (exit 4): ERROR no capture cache");
  process.exit(1);
}
if (!fromCache) writeFileSync(captured(edl.gameId), "");
// A real one-second MP4 (a steady tone).
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
  "-shortest", "-c:v", "mpeg4", "-c:a", "aac",
  "-metadata", "comment=" + edl.gameId + " " + at("job-id"), at("out")]);
const bytes = readFileSync(at("out"));
const png = Buffer.from("fake sheet");
writeFileSync(at("out") + "-sheet.png", png);
const stills = edl.events.map((e) => ({ ply: e.ply, kind: e.kind, sound: e.sound ?? null }));
console.log("[render] rendering on the 4090");
console.log("RESULT " + JSON.stringify({ mp4: at("out"), bytes: bytes.length,
  sha256: hash(bytes), durationSeconds: 30, effect: "daily", sound: "shotgun",
  timings: { check: 0.4, render: 20.5, total: 23.1, workers: 8, renderer: null },
  // As the renderer: no music ([]) is RESULT music null.
  music: existsSync(__dirname + "/music-override")
    ? JSON.parse(readFileSync(__dirname + "/music-override", "utf8"))
    : edl.music && edl.music.length === 0
      ? null
      : (edl.music ?? [{ fromPly: 0, track: "deja-vus" }]).map((c, i) =>
          ({ ...c, at: i === 0 ? 0 : 10 })),
  ending: edl.ending, edlSha256: hash(raw),
  fromCache: existsSync(__dirname + "/lie-about-cache") ? !fromCache : fromCache,
  draft: existsSync(__dirname + "/claim-draft"),
  layout: { frame: { w: 1080, h: 1920 }, boxes: {
    board: { x: 81, y: 380, w: 918, h: 852 },
    caption: { x: 81, y: 285, w: 918, h: 60 } },
    captionText: edl.caption ? { caption: { lines: 1, width: 640 } } : {},
    grid: { clip: { x: 170, y: 490, width: 740, height: 740 },
      first: { x: 180, y: 500, width: 80, height: 80 },
      last: { x: 810, y: 1130, width: 80, height: 80 },
      cols: 8, rows: 8, extra: "dropped" } },
  loudness: { memes: [{ key: "shotgun-2", at: 0.9, loudestAt: 0.9,
    memeLufs: -24, bedLufs: -33.7, overLU: 9.7, truePeakDbtp: -14.3 }] },
  silence: { floorDbfs: -45, gaps: [], over: [] },
  sheet: { png: at("out") + "-sheet.png", sha256: hash(png), stills },
  timeline: {
    moves: edl.events.map((e) => ({ ply: e.ply, at: 10 })),
    events: edl.events.map((e, index) => ({ index, ply: e.ply, kind: e.kind,
      start: 10, end: 11, extra: "dropped" })),
    sounds: [{ name: "pawn", role: "move", start: 10, event: null }] } }));
`;

/**
 * desktop-status as the 4090 would print it: desktop-status.txt next to it
 * when a test writes one, else a free 4090 with Nil's screen unlocked.
 */
const STUB_STATUS = `
const { existsSync, readFileSync } = require("node:fs");
const file = __dirname + "/desktop-status.txt";
const text = existsSync(file) ? readFileSync(file, "utf8") : [
  "win_cpu_pct=5", "win_locked=False", "wsl_free_ram_gb=20 of 24",
  "gpu=0 %, 3270 MiB, 24564 MiB", "jobs:",
  "budget=max 12 threads. Nil may use the PC (screen unlocked).", ""].join("\\n");
process.stdout.write(text);
process.exit(/^budget=WAIT/m.test(text) ? 2 : 0);
`;
const stubStatus = (dir: string) => {
  const path = join(dir, "stub-status.cjs");
  writeFileSync(path, STUB_STATUS);
  return path;
};

/** Wait for the app at `base` to answer. */
const answering = async (base: string) => {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/daily/state`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
};

/** The app's server.mjs in a child process, with `renderer` as its 4090 step. */
const serve = async (dir: string, renderer: string): Promise<string> => {
  const port = await freePort();
  const child = Bun.spawn(
    [
      "node",
      SERVER,
      "--daily-renderer",
      renderer,
      "--daily-desktop-status",
      stubStatus(dir),
      "--daily-no-backup-window",
    ],
    {
      env: {
        PATH: process.env.PATH!,
        PORT: String(port),
        ISOMUX_APP_DATA_DIR: dir,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  stops.push(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  await answering(base);
  return base;
};

/**
 * The daily routes in this process, behind an HTTP server, so a test can
 * also call the poster's parts (postPlatform, logPost) of the same app.
 */
const serveHere = async (
  dir: string,
  renderer: string,
  budgetEveryMs?: number,
) => {
  const daily = createDaily({
    dataDir: dir,
    renderer,
    env: { PATH: process.env.PATH! },
    desktopStatus: [process.execPath, stubStatus(dir)],
    backupWindow: null,
    ...(budgetEveryMs !== undefined && { budgetEveryMs }),
  });
  const server = createHttpServer((req, res) => {
    void daily
      .handle(req, res, new URL(req.url ?? "/", "http://localhost"))
      .then((done: boolean) => {
        if (!done) res.writeHead(404).end();
      });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  stops.push(() => {
    server.close();
    daily.stop();
  });
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, daily };
};

/** A reply of the item routes: the item, or why the step was refused. */
type Reply = Item & { error?: string };

/** GET `path`, or POST `body` to it: the status and the JSON reply. */
const call = async <T = Reply>(base: string, path: string, body?: object) => {
  const res = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
};

const dailyState = async (base: string) =>
  (await call<DailyState>(base, "/api/daily/state")).body;

/** The item, whatever its state. */
const fetchItem = async (base: string, id: string) =>
  (await call<Item>(base, `/api/daily/item?id=${id}`)).body;

/** Wait for the end of the item's render; the item. */
const rendered = async (base: string, id: string) => {
  for (let i = 0; i < 100; i++) {
    const it = await fetchItem(base, id);
    if (stage(it) !== "rendering") return it;
    await Bun.sleep(100);
  }
  throw new Error("the render did not end");
};

/** POST the render (or have it refused) and wait for its end. */
const renderAndWait = async (base: string, id: string, body: object = {}) => {
  const started = await call<{ jobId: string; error?: string }>(
    base,
    "/api/daily/render",
    { item: id, ...body },
  );
  return { started, it: await rendered(base, id) };
};

/**
 * Direct EDL, changed by `edl`, with the app's default ending. No lint:
 * the lint's own test ("a list that cannot render is never stored") runs it.
 */
const directOver = async (base: string, id: string, edl: object = {}) => {
  // Phase 1 passed, so that the item may render (SCRIPT.md).
  await call(base, "/api/daily/script-review", { item: id, ...SCRIPT_PASS });
  return call(base, "/api/daily/direct", {
    item: id,
    edl: { ...EDL, ending: (await dailyState(base)).suggestedEnding, ...edl },
    noLint: true,
  });
};

/** The live captures of each game today (UTC), over every item. */
const viewsToday = (dir: string) =>
  (
    JSON.parse(
      readFileSync(join(dir, "daily", "renders.json"), "utf8"),
    ) as Record<string, Record<string, number>>
  )[utcDay()];

/** DIRECTOR.md's line that names the caption style the posts carry. */
const STYLE_LINE = `Style version: \`${CAPTION_STYLE_VERSION}\` (\`CAPTION_STYLE_VERSION\`)`;

/**
 * Stand-ins for the director's docs, which live in ~/nil/wallgame-director
 * (local only; CI never has it): the files crew.mjs reads, with no more
 * than it needs from each.
 */
const writeDocs = (
  dir: string,
  director = `# Directing\n\n${STYLE_LINE}\n`,
) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SCRIPT.md"), "## Checklist\n\n- [ ] stand-in\n");
  writeFileSync(join(dir, "SCRIPT-REVIEW.md"), "# Script review stand-in\n");
  writeFileSync(join(dir, "VET-BRIEF.md"), "# Vet brief stand-in\n");
  writeFileSync(join(dir, "DIRECTOR.md"), director);
};
const DOCS = tempDir();
writeDocs(DOCS);

/** crew.mjs against the app at `base`, with the stand-in docs. */
const crew = (base: string, ...args: string[]) => {
  const run = Bun.spawnSync(
    [
      "node",
      resolve(import.meta.dir, "crew.mjs"),
      ...args,
      "--app",
      base,
      "--docs",
      DOCS,
    ],
    { env: { PATH: process.env.PATH! } },
  );
  return {
    code: run.exitCode,
    out: run.stdout.toString(),
    err: run.stderr.toString(),
  };
};

test("a render reads the game's capture when the 4090 has one: no view", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-render.cjs");
  writeFileSync(stub, STUB_RENDER);
  const base = await serve(dir, stub);
  const picked = await call(base, "/api/daily/pick", { report: REPORT });
  expect(picked.status).toBe(200);
  const id = picked.body.id;
  const direct = (edl: object) => directOver(base, id, edl);
  const render = (body: object = {}) => renderAndWait(base, id, body);

  // Without a named track a second render could play another song.
  const unnamed = await direct({ music: undefined });
  expect(unnamed.status).toBe(409);
  expect(unnamed.body.error).toContain(
    'name a music track ("music"): a list without one gets a random track',
  );
  // A track whose license does not let a video play it is refused here,
  // before a render (music-tracks.mjs; only deja-vus may play today).
  const blocked = await direct({
    music: [
      { fromPly: 0, track: "deja-vus" },
      { fromPly: 10, track: "skippy" },
    ],
  });
  expect(blocked.status).toBe(409);
  expect(blocked.body.error).toContain(
    "music skippy may not play in a video (license blocked-until-nil; see scripts/game-video/MUSIC-LICENSES.md); use ",
  );
  expect((await direct({})).status).toBe(200);

  // The game's first render captures it live: one view.
  let { it } = await render();
  expect(stage(it)).toBe("rendered");
  expect(it.render?.fromCache).toBe(false);
  expect(viewsToday(dir)).toEqual({ TESTGAME1: 1 });
  const live = it.render?.video?.sha256;

  // A new list renders from the capture: no view, no --force.
  expect((await direct({ caption: "a new list" })).status).toBe(200);
  ({ it } = await render());
  expect(stage(it)).toBe("rendered");
  expect(it.render?.fromCache).toBe(true);
  expect(viewsToday(dir)).toEqual({ TESTGAME1: 1 });
  expect(it.events.map((e) => e.what)).toContain(
    `render ${it.render?.jobId} queued (from the capture)`,
  );
  expect(it.render?.video?.sha256).not.toBe(live);

  // A live capture on purpose is one more view, so it needs force.
  expect((await direct({ caption: "another list" })).status).toBe(200);
  const refused = await render({ live: true });
  expect(refused.started.status).toBe(409);
  expect(refused.started.body.error).toContain(
    "TESTGAME1 was already rendered 1 time(s) today",
  );
  ({ it } = await render({ live: true, force: true }));
  expect(it.render?.fromCache).toBe(false);
  expect(viewsToday(dir)).toEqual({ TESTGAME1: 2 });

  // A new item of the same game counts against the same game.
  const again = (await call(base, "/api/daily/pick", { report: REPORT })).body
    .id;
  expect((await directOver(base, again)).status).toBe(200);
  const second = await renderAndWait(base, again, { live: true });
  expect(second.started.body.error).toContain(
    "TESTGAME1 was already rendered 2 time(s) today",
  );

  // When the app cannot ask the 4090, it does not guess (a live render
  // would be a view nobody counted): nothing starts.
  expect((await direct({ caption: "a third list" })).status).toBe(200);
  writeFileSync(join(dir, "probe-fails"), "");
  const unknown = await render();
  expect(unknown.started.status).toBe(409);
  expect(unknown.started.body.error).toContain(
    "Connection timed out; the app must know whether the 4090 has the game's capture before it renders, so try again",
  );
  expect(stage(unknown.it)).toBe("directed");
  unlinkSync(join(dir, "probe-fails"));

  // A render that was not what the app asked for fails.
  writeFileSync(join(dir, "lie-about-cache"), "");
  ({ it } = await render());
  expect(stage(it)).toBe("render-failed");
  // A renderer that ignores --from-cache captured live: that view counts.
  expect(it.render?.error).toBe(
    "the renderer captured the game live, but the app asked for its capture: one view of the game, now counted; the 4090 kit may be older than --from-cache, so sync it",
  );
  expect(viewsToday(dir)).toEqual({ TESTGAME1: 3 });
  // The other way: counted as live but read from the capture; it stays
  // counted (an overcount is safe).
  ({ it } = await render({ live: true, force: true }));
  expect(it.render?.error).toBe(
    "the render was from the capture, but the app asked for a live capture",
  );
  expect(viewsToday(dir)).toEqual({ TESTGAME1: 4 });

  // A quick look (RESULT.draft) is never the item's video.
  unlinkSync(join(dir, "lie-about-cache"));
  writeFileSync(join(dir, "claim-draft"), "");
  ({ it } = await render());
  expect(stage(it)).toBe("render-failed");
  expect(it.render?.error).toBe(
    "the render step gave a quick look (RESULT.draft), not the item's video",
  );
}, 30_000);

test("a list that needs the pawn art is stored; its render captures live only while the capture has none", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-render.cjs");
  writeFileSync(stub, STUB_RENDER);
  const base = await serve(dir, stub);
  const id = (await call(base, "/api/daily/pick", { report: REPORT })).body.id;
  expect((await directOver(base, id)).status).toBe(200);
  // The game's first render captures it: one view. Then that capture is
  // made an old one, from before the board's pawn art was kept.
  expect((await renderAndWait(base, id)).it.render?.fromCache).toBe(false);
  expect(viewsToday(dir)).toEqual({ TESTGAME1: 1 });
  writeFileSync(join(dir, "captured-TESTGAME1"), "no-pawn-art");

  // A reactor needs the pawn art: the only stop is the capture's, so
  // direct stores the list and marks it.
  const recapture = {
    kind: "reactor-capture",
    ply: 4,
    at: 0,
    stops: true,
    message:
      "the reactor-shock: this game's capture was made before the board's pawn art was kept",
  };
  writeFileSync(
    join(dir, "lint.json"),
    JSON.stringify({
      faults: [recapture],
      notes: [],
      counts: { seconds: 30, events: {}, overlays: {}, sounds: {} },
    }),
  );
  const path = join(dir, "reactor.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...EDL,
      ending: (await dailyState(base)).suggestedEnding,
      caption: "a reactor list",
    }),
  );
  const stored = crew(base, "direct", "--item", id, "--edl", path);
  expect(stored.code).toBe(0);
  expect(stored.out).toContain(
    "lint: nothing stops the list; its render captures the game live (one view)",
  );
  expect(stored.out).toContain(
    "LIVE ply 4, 0.0 s, reactor-capture: the reactor-shock:",
  );
  let it = await fetchItem(base, id);
  expect(it.edl?.needsPawnArt).toBe(true);
  expect(JSON.stringify(it.edl?.summary)).toContain(
    "the next render captures the game live",
  );
  // The capture has no pawn art: the render captures again, a second view,
  // which needs force as every live render does. This one saves a new
  // capture and then fails.
  const refused = await renderAndWait(base, id);
  expect(refused.started.body.error).toContain(
    "TESTGAME1 was already rendered 1 time(s) today",
  );
  writeFileSync(join(dir, "claim-draft"), "");
  ({ it } = await renderAndWait(base, id, { force: true }));
  expect(stage(it)).toBe("render-failed");
  expect(it.render?.fromCache).toBe(false);
  expect(viewsToday(dir)).toEqual({ TESTGAME1: 2 });
  unlinkSync(join(dir, "claim-draft"));

  // The 4090's capture decides, not the list (VR1, review 81): the same
  // list renders again from the new capture, with no view and no force.
  ({ it } = await renderAndWait(base, id));
  expect(stage(it)).toBe("rendered");
  expect(it.render?.fromCache).toBe(true);
  expect(viewsToday(dir)).toEqual({ TESTGAME1: 2 });

  // A list that does not need the pawn art reads an old capture too.
  writeFileSync(join(dir, "captured-TESTGAME1"), "no-pawn-art");
  unlinkSync(join(dir, "lint.json"));
  expect(crew(base, "direct", "--item", id, "--edl", path).code).toBe(0);
  expect((await fetchItem(base, id)).edl?.needsPawnArt).toBe(false);
  ({ it } = await renderAndWait(base, id));
  expect(it.render?.fromCache).toBe(true);
  expect(viewsToday(dir)).toEqual({ TESTGAME1: 2 });
}, 30_000);

test("one dry-run cycle: pick, direct, render, check, copy, review, post, log", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-render.cjs");
  writeFileSync(stub, STUB_RENDER);
  const { base, daily } = await serveHere(dir, stub);
  const post = (path: string, body: object) =>
    call(base, `/api/daily/${path}`, body);

  // Post text is Growth's copy block, not the pick's.
  const withCaption = await post("pick", { report: REPORT, caption: "lmao" });
  expect(withCaption.status).toBe(409);
  expect(withCaption.body.error).toContain("pick takes no caption or title");
  const picked = await post("pick", { report: REPORT });
  expect(picked.status).toBe(200);
  const id = picked.body.id;
  expect(id).toMatch(ITEM_ID);
  expect(picked.body).toMatchObject({ state: "draft", gameId: "TESTGAME1" });
  // Every production step names its item.
  expect((await post("render", {})).body.error).toContain("name the item");
  // No render without the director's list.
  expect((await post("render", { item: id })).status).toBe(409);
  const direct = (edl: object = {}) => directOver(base, id, edl);
  expect((await direct({ gameId: "OTHERGAME" })).status).toBe(409);
  // A sound Nil disliked on /daily/sounds is allowed, and the edit list's
  // summary (which the review shows) names it.
  const pickSound = (choice: string) =>
    post("sounds", { key: "fuahhh-1", choice });
  expect((await pickSound("disliked")).status).toBe(200);
  const allowed = await direct();
  expect(allowed.status).toBe(200);
  expect(JSON.stringify(allowed.body)).toMatch(
    /ply \d+ uses disliked fuahhh-1: Nil's preference, allowed/,
  );
  // No sound on the last move: allowed, with a warning in the summary.
  expect(JSON.stringify(allowed.body)).toMatch(
    /WARNING: no sound lands on the last move \(ply \d+\)/,
  );
  expect((await pickSound("ok")).status).toBe(200);
  // A sound with a high claim risk is refused whatever Nil's level, and
  // allowed only on purpose; the summary then names it.
  const risky = (claimRiskOk?: unknown) =>
    post("direct", {
      item: id,
      edl: { ...EDL, vsSound: "win-2" },
      noLint: true,
      ...(claimRiskOk === undefined ? {} : { claimRiskOk }),
    });
  const riskRefused = await risky();
  expect(riskRefused.status).toBe(409);
  expect(riskRefused.body.error).toContain(
    "vsSound: win-2: high claim risk: a Rockstar Games music sting",
  );
  expect((await risky(["boom-2"])).status).toBe(409);
  expect((await risky("win-2")).status).toBe(409);
  const onPurpose = await risky(["win-2"]);
  expect(onPurpose.status).toBe(200);
  expect(JSON.stringify(onPurpose.body)).toContain(
    "vsSound uses win-2 on purpose: high claim risk: a Rockstar Games music sting",
  );
  // What the video says must match the counter, and the payoff goes out too.
  const told = (edl: Record<string, unknown>) =>
    post("direct", { item: id, edl: { ...EDL, ...edl }, noLint: true });
  const coldOpen = await told({ coldOpenPly: 22 });
  expect(coldOpen.status).toBe(409);
  expect(coldOpen.body.error).toContain(
    "coldOpenPly is cut from the daily video (Nil, 2026-10-26",
  );
  const offCounter = await told({ caption: "Ruby was 2 steps away" });
  expect(offCounter.status).toBe(409);
  expect(offCounter.body.error).toContain("the caption says 2");
  const named = await told({
    caption: "can bro get home? 😭",
    payoff: { ply: 22, text: "guest tuatara got humbled" },
  });
  expect(named.status).toBe(409);
  expect(named.body.error).toContain(
    "video payoff must not name the player Guest Tuatara",
  );
  const mention = await told({
    caption: "Can Ruby get home?",
    payoff: { ply: 22, text: "ask @someone" },
  });
  expect(mention.status).toBe(409);
  expect(mention.body.error).toContain("video payoff must not mention");
  // The laugh plays on the save ply, after its zoom (Nil, 2026-10-26).
  const zoomThenLaugh = await told({
    events: [
      { ply: 22, kind: "zoom", frame: ["e4", "e5"], sound: "fuahhh-1" },
      { ply: 22, kind: "laugh", cell: "e4", sound: "laugh-2" },
    ],
  });
  expect(zoomThenLaugh.status).toBe(200);
  expect((await direct()).status).toBe(200);

  // What a restart would cut (crew.mjs ship refuses while any is busy).
  interface Busy {
    renders: {
      itemId: string;
      jobId: string;
      gameId: string;
      live: boolean;
      state: string;
    }[];
    posting: boolean;
  }
  const busy = async () => (await call<Busy>(base, "/api/daily/busy")).body;
  expect(await busy()).toEqual({ renders: [], posting: false });
  const started = await call<{ jobId: string }>(base, "/api/daily/render", {
    item: id,
  });
  expect(started.status).toBe(200);
  // The queue takes the job before the POST answers. It starts once the
  // app has read the 4090's budget (desktop-budget.mjs).
  const taken = await busy();
  expect(taken.posting).toBe(false);
  expect(taken.renders).toHaveLength(1);
  expect(taken.renders[0]).toMatchObject({
    itemId: id,
    jobId: started.body.jobId,
    gameId: "TESTGAME1",
    live: true,
  });
  expect(["queued", "running"]).toContain(taken.renders[0].state);
  const it = await rendered(base, id);
  expect(stage(it)).toBe("rendered");
  expect((await busy()).renders).toEqual([]);
  // The renderer's timeline is kept for the event strips, without extras.
  expect(it.render?.timeline?.events[0]).toEqual({
    index: 0,
    ply: EDL.events[0].ply,
    kind: EDL.events[0].kind,
    start: 10,
    end: 11,
  });
  // The board's cells at rest, for crew.mjs crop --cell, without extras.
  expect(it.render?.grid).toEqual({
    clip: { x: 170, y: 490, width: 740, height: 740 },
    first: { x: 180, y: 500, width: 80, height: 80 },
    last: { x: 810, y: 1130, width: 80, height: 80 },
    cols: 8,
    rows: 8,
  });
  expect(it.render?.effect).toBe("daily");
  expect(it.render?.ending).toBe("replay");
  expect(it.render?.quality?.loudness?.ok).toBe(true);
  // How long each step took, as the adapter said (S4).
  expect(it.render?.timings).toEqual({
    check: 0.4,
    render: 20.5,
    total: 23.1,
    workers: 8,
    renderer: null,
  });
  expect(it.render?.quality?.safeArea?.ok).toBe(true);
  const sheet = it.render?.sheet;
  expect(sheet?.stills).toEqual([{ ply: 22, kind: "zoom", sound: "fuahhh-1" }]);
  const checked = await post("check", {
    item: id,
    sheetSha256: sheet?.sha256,
    stills: [ZOOM_OK],
  });
  expect(checked.body.state).toBe("finished");

  // Finished, but not for Nil before Growth's block for this video.
  const viewOf = async () =>
    (await dailyState(base)).items.find((x) => x.id === id);
  expect(await viewOf()).toMatchObject({
    stage: "checked",
    reviewState: "waiting-copy",
  });
  expect((await viewOf())?.staleCopy).toContain(`crew.mjs vet --item ${id}`);
  const copy = (body: object) => post("copy", { item: id, ...body });

  // The independent review of the final video comes first (R10): copy
  // refuses the item until the latest vet of its current video passes.
  const sha = (await viewOf())!.render!.video!.sha256;
  expect(await viewOf()).toMatchObject({ vet: null });
  const unvetted = await copy({ text: BLOCK, copyVersion: COPY_VERSION });
  expect(unvetted.status).toBe(409);
  expect(unvetted.body.error).toContain(
    `${id}: no passing independent review of video ${sha.slice(0, 12)}; the director runs crew.mjs vet`,
  );
  const vet = (body: object) =>
    post("vet", {
      item: id,
      videoSha256: sha,
      reviewer: "a fresh subagent",
      verdict: "pass",
      notes: "every overlay frame clear; the capture has its sound",
      ...body,
    });
  expect((await vet({ videoSha256: "b".repeat(64) })).body.error).toContain(
    "review the current video",
  );
  expect((await vet({ verdict: "maybe" })).body.error).toContain(
    "pass or fail",
  );
  expect((await vet({ notes: " " })).body.error).toContain("vet needs notes");
  expect((await vet({ reviewer: "two\nlines" })).body.error).toContain(
    "vet needs the reviewer",
  );
  expect(
    (await vet({ verdict: "fail", notes: "a pawn under the panel" })).status,
  ).toBe(200);
  expect((await viewOf())?.vet).toMatchObject({ verdict: "fail" });
  expect((await viewOf())?.staleCopy).toContain("a fresh subagent");
  expect((await copy({ text: BLOCK, copyVersion: COPY_VERSION })).status).toBe(
    409,
  );
  const passed = await vet({});
  expect(passed.status).toBe(200);
  expect((await viewOf())?.staleCopy).toContain(`crew.mjs copy --item ${id}`);
  expect((passed.body.vets ?? []).map((v: Vet) => v.verdict)).toEqual([
    "fail",
    "pass",
  ]);
  expect((await viewOf())?.vet).toMatchObject({
    verdict: "pass",
    reviewer: "a fresh subagent",
    videoSha256: sha,
  });
  expect(
    (
      await copy({
        text: BLOCK.split("\n").slice(1).join("\n"),
        copyVersion: COPY_VERSION,
      })
    ).status,
  ).toBe(409);
  expect((await copy({ text: BLOCK })).status).toBe(409);
  const long = await copy({
    text: BLOCK.replace("X: ", `X: ${"a".repeat(280)}`),
    copyVersion: COPY_VERSION,
  });
  expect(long.body.error).toContain("X is over 280 in X's count");
  const stored = await copy({ text: BLOCK, copyVersion: COPY_VERSION });
  expect(stored.status).toBe(200);
  expect(stored.body.copy?.block).toEqual(COPY);
  // Now it is in review: what Nil sees on /review.
  const state = await dailyState(base);
  expect(state.counts.inReview).toBe(1);
  expect(await viewOf()).toMatchObject({
    state: "finished",
    stage: "checked",
    reviewState: "in-review",
    staleCopy: null,
  });

  // Nil approves this video and this block; then the block cannot change.
  const approved = approveItem(daily.store, id);
  expect(approved.approval).toMatchObject({
    videoSha256: it.render?.video?.sha256,
    copySha256: COPY_SHA,
  });
  const late = await copy({ text: BLOCK, copyVersion: COPY_VERSION });
  expect(late.status).toBe(409);
  expect(late.body.error).toContain(`${id} is approved`);

  // The poster's part: each platform in its mode (all dry-run here), with
  // the approved item's file, and a post-log row for each.
  const video = readFileSync(approved.render!.video!.path);
  const posts: Record<string, PostResult> = {};
  await daily.asThePost(async () => {
    for (const platform of PLATFORMS) {
      const result = (await daily.postPlatform(platform, {
        item: approved,
        video,
        beforeCommit: () => undefined,
      })) as PostResult;
      expect([platform, result.ok, result.mode]).toEqual([
        platform,
        true,
        "dry-run",
      ]);
      posts[platform] = result;
      daily.logPost(approved, platform, result);
    }
  });
  expect(posts.x).toMatchObject({ postId: "DRY-RUN-POST-ID" });

  const planOf = (p: string) =>
    JSON.parse(readFileSync(posts[p].requestsFile, "utf8")) as {
      method: string;
      url: string;
      body: Record<string, unknown> | null;
      headers: Record<string, string>;
    }[];
  const xPlan = planOf("x");
  expect(xPlan.map((r) => r.url.replace("https://api.x.com", ""))).toEqual([
    "/2/media/upload/initialize",
    "/2/media/upload/DRY-RUN-MEDIA-ID/append",
    "/2/media/upload/DRY-RUN-MEDIA-ID/finalize",
    "/2/tweets",
  ]);
  // Each platform posts the approved block's own line.
  expect(xPlan[3].body?.text).toBe(COPY.x);
  const ytPlan = readFileSync(posts.youtube.requestsFile, "utf8");
  expect(ytPlan).toContain(JSON.stringify(`${COPY.youtubeTitle} #Shorts`));
  expect(ytPlan).toContain(
    "utm_source=youtube&utm_medium=social&utm_campaign=daily-video",
  );
  // The form is shown as it goes on the wire, URL-encoded, naming where the
  // refresh token comes from.
  expect(ytPlan).toContain(
    "refresh_token=%3Crefresh+token+from+%2Fdaily%2Fconnect%3E",
  );

  // The four newer platforms: each public request carries its line as is.
  const finish = planOf("facebook").find(
    (r) => r.body?.upload_phase === "finish",
  );
  expect(finish?.body?.description).toBe(COPY.facebook);
  const record = planOf("bluesky").at(-1)?.body?.record as {
    text: string;
    facets: { features: { $type: string }[] }[];
  };
  expect(record.text).toBe(COPY.bluesky);
  // The tracked link and the line's one hashtag.
  expect(record.facets.map((f) => f.features[0].$type).sort()).toEqual([
    "app.bsky.richtext.facet#link",
    "app.bsky.richtext.facet#tag",
  ]);
  const threadsPlan = planOf("threads");
  const container = threadsPlan.find((r) => r.url.endsWith("/threads"));
  expect(container?.body?.text).toBe(COPY.threads);
  // Threads: the video goes to the private R2 bucket under a random name,
  // Threads gets a signed URL, and the copy is deleted at the end.
  const object = threadsPlan.find((r) => r.method === "PUT")?.url ?? "";
  const key = object.split("/").slice(-2).join("/");
  expect(key).toMatch(/^wallgame-threads-video\/[0-9a-f]{32}\.mp4$/);
  expect(threadsPlan.map((r) => r.method)).toEqual([
    "GET", // token refresh
    "PUT", // the copy in R2
    "POST", // container
    "GET", // status
    "POST", // publish
    "GET", // permalink
    "DELETE", // the copy, removed
  ]);
  expect(threadsPlan.at(-1)?.url).toBe(object);
  // The signed URL is a bearer link: only Threads gets it. The plan names
  // the object, and no file the app writes holds a signature.
  expect(container?.body?.video_url).toBe(`<signed URL of ${key}>`);
  const written = (readdirSync(dir, { recursive: true }) as string[])
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && !path.endsWith(".mp4"));
  expect(written.some((path) => path.includes("post-log"))).toBe(true);
  for (const path of written) {
    expect(readFileSync(path, "utf8")).not.toContain("X-Amz-Signature");
  }

  const log = (await call<LogRow[]>(base, "/api/daily/post-log?dryRun=1")).body;
  expect(log.map((r) => r.platform)).toEqual(PLATFORMS);
  // Each row names its item, the on-video caption style and Growth's copy
  // style.
  expect(log.map((r) => r.itemId)).toEqual(log.map(() => id));
  expect(log.map((r) => r.styleVersion)).toEqual(
    log.map(() => CAPTION_STYLE_VERSION),
  );
  expect(log.map((r) => r.copyVersion)).toEqual(log.map(() => COPY_VERSION));
  expect(log.map((r) => r.caption)).toEqual([
    COPY.x,
    `${COPY.youtubeTitle} #Shorts\n\n${COPY.youtubeDescription}`,
    COPY.tiktok,
    COPY.instagram,
    null, // a Story has no caption
    COPY.facebook,
    COPY.bluesky,
    COPY.threads,
  ]);
  // TikTok: a draft in Nil's inbox, one chunk, no caption in the API.
  expect(posts.tiktok).toMatchObject({ postId: "DRY-RUN-PUBLISH-ID" });
  const tiktokPlan = planOf("tiktok");
  expect(tiktokPlan.map((r) => `${r.method} ${r.url.split("?")[0]}`)).toEqual([
    "POST https://open.tiktokapis.com/v2/oauth/token/",
    "POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
    "PUT https://open-upload.tiktokapis.com/video/",
    "POST https://open.tiktokapis.com/v2/post/publish/status/fetch/",
  ]);
  expect(tiktokPlan[1].body).toMatchObject({
    source_info: { source: "FILE_UPLOAD", total_chunk_count: 1 },
  });
  expect(tiktokPlan[2].headers["content-range"]).toMatch(/^bytes 0-\d+\/\d+$/);
  expect(log[2]).toMatchObject({
    platform: "tiktok",
    tiktokStatus: "SEND_TO_USER_INBOX",
  });
  const instagramPlan = planOf("instagram");
  const igObject = instagramPlan.find((r) => r.method === "PUT")?.url ?? "";
  expect(igObject).toMatch(/\/wallgame-threads-video\/[0-9a-f]{32}\.mp4$/);
  // The Page and its Instagram account come from the one Meta secret first.
  expect(instagramPlan.map((r) => `${r.method} ${r.url}`)).toEqual([
    "GET https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token",
    "GET https://graph.facebook.com/v26.0/DRY-RUN-PAGE-ID?fields=instagram_business_account",
    `PUT ${igObject}`,
    "POST https://graph.facebook.com/v26.0/DRY-RUN-IG-USER-ID/media",
    "GET https://graph.facebook.com/v26.0/DRY-RUN-CONTAINER?fields=status_code,status",
    "POST https://graph.facebook.com/v26.0/DRY-RUN-IG-USER-ID/media_publish",
    "GET https://graph.facebook.com/v26.0/DRY-RUN-MEDIA-ID?fields=permalink",
    `DELETE ${igObject}`,
  ]);
  // Instagram fetches the video from R2 (no resumable upload); the plan
  // names the object, never the signed URL.
  expect(instagramPlan[3].body).toEqual({
    media_type: "REELS",
    video_url: `<signed URL of ${igObject.split("/").slice(-2).join("/")}>`,
    caption: COPY.instagram,
  });
  // Discovery uses the system user token; the post uses the Page token.
  expect(instagramPlan[0].headers.authorization).toBe(
    "Bearer <META_SYSTEM_USER_TOKEN>",
  );
  expect(instagramPlan[3].headers.authorization).toBe(
    "Bearer <Page token from /me/accounts>",
  );
  expect(log[3]).toMatchObject({
    platform: "instagram",
    postId: "DRY-RUN-MEDIA-ID",
    url: "https://www.instagram.com/reel/DRY-RUN/",
  });
  // The Story: the same steps on the same account, with its OWN R2 copy
  // (put and deleted in its own attempt), media_type STORIES, no caption.
  const storyPlan = planOf("instagram-story");
  const storyObject = storyPlan.find((r) => r.method === "PUT")?.url ?? "";
  expect(storyObject).toMatch(/\/wallgame-threads-video\/[0-9a-f]{32}\.mp4$/);
  expect(storyObject).not.toBe(igObject);
  expect(storyPlan.map((r) => `${r.method} ${r.url}`)).toEqual(
    instagramPlan
      .map((r) => `${r.method} ${r.url}`)
      .map((line) => line.replace(igObject, storyObject)),
  );
  expect(storyPlan.find((r) => r.url.endsWith("/media"))?.body).toEqual({
    media_type: "STORIES",
    video_url: `<signed URL of ${storyObject.split("/").slice(-2).join("/")}>`,
  });
  expect(log[4]).toMatchObject({
    platform: "instagram-story",
    postId: "DRY-RUN-MEDIA-ID",
    caption: null,
  });
  expect(log[0]).toMatchObject({
    itemId: id,
    // The UTC day of the post.
    day: utcDay(),
    gameId: "TESTGAME1",
    mode: "dry-run",
    approver: "Nil",
    firedBy: null,
    videoSha256: approved.approval?.videoSha256,
    effect: "daily",
    ending: "replay",
    music: ["deja-vus"],
    sound: "shotgun",
    swingMove: 23,
  });
  expect((await call<LogRow[]>(base, "/api/daily/post-log")).body).toEqual([]);
  expect(readPostLog(daily.store.postLog.dryRun)).toHaveLength(
    PLATFORMS.length,
  );

  // A game posts once (Wall Game Director, 2026-10-28): it is not picked
  // again, and each item from here on has its own game. (No poster runs
  // here, so the first item is still approved.)
  expect((await post("pick", { report: REPORT })).body.error).toBe(
    `another video of TESTGAME1 is approved (${id}): only one video of a game posts; Nil may withdraw it on /review`,
  );
  const game = (gameId: string) => ({
    report: { ...REPORT, ranked: [{ ...REPORT.ranked[0], gameId }] },
  });
  // The next item's default reads the log and is the next ending.
  const next = (await post("pick", game("TESTGAME2"))).body.id;
  // The director sees the last posted track, to pick another.
  expect((await dailyState(base)).lastMusic).toEqual(["deja-vus"]);
  expect((await directOver(base, next, { gameId: "TESTGAME2" })).status).toBe(
    200,
  );
  let second = (await renderAndWait(base, next)).it;
  expect(stage(second)).toBe("rendered");
  expect(second.render?.ending).toBe("gg");

  // The second item is only rendered: an unapproved video takes no ending
  // from a third.
  const third = (await post("pick", game("TESTGAME3"))).body.id;
  expect((await dailyState(base)).suggestedEnding).toBe("gg");
  // Nil approves the second video, which waits to post: now its ending is
  // taken.
  expect(
    (
      await post("check", {
        item: next,
        sheetSha256: second.render?.sheet?.sha256,
        stills: [ZOOM_OK],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post("vet", {
        item: next,
        videoSha256: second.render?.video?.sha256,
        reviewer: "a fresh subagent",
        verdict: "pass",
        notes: "ok",
      })
    ).status,
  ).toBe(200);
  expect(
    (await post("copy", { item: next, text: BLOCK, copyVersion: COPY_VERSION }))
      .status,
  ).toBe(200);
  approveItem(daily.store, next);
  expect((await dailyState(base)).suggestedEnding).toBe("ko");
  // A list with no event has no still to check, so it is refused.
  expect(
    (await directOver(base, third, { gameId: "TESTGAME3", events: [] })).status,
  ).toBe(409);
  // The most events edl.mjs allows: 40 stills come back whole.
  expect(
    (
      await directOver(base, third, {
        gameId: "TESTGAME3",
        events: Array.from({ length: 40 }, (_, ply) => ({
          ply,
          kind: "zoom",
          frame: ["e4"],
          sound: "fuahhh-1",
        })),
      })
    ).status,
  ).toBe(200);
  second = (await renderAndWait(base, third)).it;
  expect(second.render?.ending).toBe("ko");
  expect(second.render?.sheet?.stills).toHaveLength(40);
  // The second video waits to post, so its track is the last one.
  expect((await dailyState(base)).lastMusic).toEqual(["deja-vus"]);

  // The music the video played must be the list's cues, each a track the
  // site has.
  const fourth = (await post("pick", game("TESTGAME4"))).body.id;
  const renderWith = async (
    played: { fromPly: number; track: string; at: number }[],
  ) => {
    writeFileSync(join(dir, "music-override"), JSON.stringify(played));
    return (await renderAndWait(base, fourth)).it;
  };
  const one = (track: string) => [{ fromPly: 0, track, at: 0 }];
  await directOver(base, fourth, { gameId: "TESTGAME4" });
  let wrong = await renderWith(one("tea-for-two"));
  expect(stage(wrong)).toBe("render-failed");
  expect(wrong.render?.error).toMatch(/music tea-for-two, not deja-vus/);
  await directOver(base, fourth, { gameId: "TESTGAME4" });
  wrong = await renderWith(one("elevator-jazz"));
  expect(wrong.render?.error).toMatch(/music elevator-jazz/);
}, 30_000);

test("two music cues: direct takes them, and the render must play both from their plies", async () => {
  // Two cues need two tracks that may play; only deja-vus may today. The app
  // runs in this process here, so the test clears skippy and puts it back.
  const cleared = MUSIC_TRACKS.filter((t) => t.slug === "skippy");
  const licenses = cleared.map((t) => t.license);
  for (const t of cleared) t.license = "ok";
  try {
    const dir = tempDir();
    const stub = join(dir, "stub-render.cjs");
    writeFileSync(stub, STUB_RENDER);
    const { base } = await serveHere(dir, stub);
    const picked = await call(base, "/api/daily/pick", { report: REPORT });
    expect(picked.status).toBe(200);
    const id = picked.body.id;
    await call(base, "/api/daily/script-review", { item: id, ...SCRIPT_PASS });
    const render = async (played?: object[]) => {
      const override = join(dir, "music-override");
      if (played) writeFileSync(override, JSON.stringify(played));
      else rmSync(override, { force: true });
      return (await renderAndWait(base, id, { force: true })).it;
    };
    const cues = [
      { fromPly: 0, track: "deja-vus" },
      { fromPly: 10, track: "skippy" },
    ];
    const direct = (music: object[] = cues) =>
      call(base, "/api/daily/direct", {
        item: id,
        edl: { ...EDL, music },
        noLint: true,
      });
    expect((await direct()).status).toBe(200);

    // The stub plays the list's cues, the second from second 10.
    let it = await render();
    expect(stage(it)).toBe("rendered");
    expect(it.render?.music).toEqual([
      { ...cues[0], at: 0 },
      { ...cues[1], at: 10 },
    ]);

    // A cue that starts on another ply is another video.
    expect((await direct()).status).toBe(200);
    it = await render([
      { ...cues[0], at: 0 },
      { ...cues[1], fromPly: 12, at: 11 },
    ]);
    expect(stage(it)).toBe("render-failed");
    expect(it.render?.error).toBe(
      "the render played the music deja-vus, then skippy from ply 12, not deja-vus, then skippy from ply 10",
    );

    // At most 2 different tracks fit the credit (edl.mjs), and a track may
    // come back in a later cue.
    const third = await direct([...cues, { fromPly: 20, track: "a-legend" }]);
    expect(third.status).toBe(409);
    expect(third.body.error).toContain(
      "music plays 3 different tracks; at most 2 fit the credit",
    );
    expect(
      (await direct([...cues, { fromPly: 20, track: "deja-vus" }])).status,
    ).toBe(200);
  } finally {
    cleared.forEach((t, i) => (t.license = licenses[i]));
  }
});

test('no music ("music": []): direct takes it, and the render stores no cues, not null', async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-render.cjs");
  writeFileSync(stub, STUB_RENDER);
  const { base } = await serveHere(dir, stub);
  const picked = await call(base, "/api/daily/pick", { report: REPORT });
  const id = picked.body.id;
  expect((await directOver(base, id, { music: [] })).status).toBe(200);
  // The renderer says null; the item says [], which the post row maps.
  const { it } = await renderAndWait(base, id, { force: true });
  expect(stage(it)).toBe("rendered");
  expect(edlSummary({ ...EDL, music: [] })[0]).toContain("music none");
  expect(it.render?.music).toEqual([]);
  expect(blockedMusic(it)).toEqual([]);
});

test("two items in the render queue: each render finishes on its own item", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-render.cjs");
  writeFileSync(stub, STUB_RENDER);
  const { base } = await serveHere(dir, stub);
  const entry = REPORT.ranked[0];
  const report = {
    ...REPORT,
    ranked: [entry, { ...entry, gameId: "TESTGAME2" }],
  };
  const ids: string[] = [];
  for (const rank of [1, 2]) {
    const picked = await call(base, "/api/daily/pick", { report, rank });
    expect(picked.status).toBe(200);
    ids.push(picked.body.id);
  }
  const games = ["TESTGAME1", "TESTGAME2"];
  for (const [i, id] of ids.entries()) {
    expect((await directOver(base, id, { gameId: games[i] })).status).toBe(200);
  }
  // Both queued before either ends: the queue runs them one after the
  // other, and each result lands on its own item.
  for (const id of ids) {
    expect((await call(base, "/api/daily/render", { item: id })).status).toBe(
      200,
    );
  }
  const done = [await rendered(base, ids[0]), await rendered(base, ids[1])];
  expect(done.map((it) => stage(it))).toEqual(["rendered", "rendered"]);
  expect(done.map((it) => it.render?.error)).toEqual([null, null]);
  expect(done[0].render?.video?.sha256).not.toBe(done[1].render?.video?.sha256);
  expect(done.map((it) => it.render?.jobId.startsWith(it.id))).toEqual([
    true,
    true,
  ]);
});

test("a carry-over: a new item with the game of one that was dropped", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-render.cjs");
  writeFileSync(stub, STUB_RENDER);
  // An older day's report that ranks the game second: pick takes it by id,
  // not by rank.
  const entry = REPORT.ranked[0];
  const oldReport = join(dir, "2026-10-26.json");
  writeFileSync(
    oldReport,
    JSON.stringify({
      ...REPORT,
      createdAt: "2026-10-26T11:30:00.000Z",
      ranked: [
        { ...entry, gameId: "OTHERGAME" },
        { ...entry, gameId: "CARRYOVR1" },
      ],
    }),
  );
  // crew.mjs runs synchronously, so the app runs in its own process.
  const base = await serve(dir, stub);
  const ok = async (path: string, body: object) => {
    const r = await call(base, path, body);
    expect([path, r.status]).toEqual([path, 200]);
    return r.body;
  };

  expect(crew(base, "pick").err).toContain(
    "pick needs --report <file> (or --from <item>)",
  );
  const pickedFirst = crew(
    base,
    "pick",
    "--report",
    oldReport,
    "--game",
    "CARRYOVR1",
  );
  expect(pickedFirst.code).toBe(0);
  const first = /^picked: (\S+)$/m.exec(pickedFirst.out)?.[1] ?? "";
  expect(first).toMatch(ITEM_ID);
  expect(pickedFirst.out).toContain(`ITEM ${first}: draft, picked`);
  expect(pickedFirst.out).toContain("game CARRYOVR1");
  // A production command must name its item.
  expect(crew(base, "render").err).toContain("name the item: --item <id>");

  // Only a game that is not in work any more is carried over: work on a
  // draft or a finished item itself.
  const carry = (from: string) => crew(base, "pick", "--from", from);
  expect(carry(first).err).toContain(
    `${first} is draft: carry over only an item that is discarded;`,
  );
  await ok("/api/daily/script-review", { item: first, ...SCRIPT_PASS });
  await ok("/api/daily/direct", {
    noLint: true,
    item: first,
    edl: {
      ...EDL,
      gameId: "CARRYOVR1",
      ending: (await dailyState(base)).suggestedEnding,
    },
  });
  const it = (await renderAndWait(base, first)).it;
  await ok("/api/daily/check", {
    item: first,
    sheetSha256: it.render?.sheet?.sha256,
    stills: [ZOOM_OK],
  });
  // The independent review, through crew.mjs: the record, with the length
  // and counts its notes are checked against.
  expect(crew(base, "status").out).toContain(
    "independent review: none for this video (copy refuses)",
  );
  const vetted = crew(
    base,
    "vet",
    "--item",
    first,
    "--video",
    it.render!.video!.sha256,
    "--reviewer",
    "a fresh subagent",
    "--verdict",
    "pass",
    "--notes",
    "zoom clear\n\nno pawn hidden",
  );
  expect(vetted.err).toBe("");
  const counts = Object.entries(
    EDL.events.reduce<Record<string, number>>(
      (n, e) => ({ ...n, [e.kind]: (n[e.kind] ?? 0) + 1 }),
      {},
    ),
  )
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  expect(vetted.out).toContain(`${first}: vet PASS by a fresh subagent at `);
  expect(vetted.out).toContain(`  effects: ${counts}`);
  expect(vetted.out).toContain("  overlays: none");
  expect(vetted.out).toContain(
    "  notes:\n  > zoom clear\n  > \n  > no pawn hidden",
  );
  expect(vetted.out).toMatch(/ {2}video length: [\d.?]+ s/);
  expect(crew(base, "status").out).toContain(
    `independent review: PASS by a fresh subagent at `,
  );
  await ok("/api/daily/copy", {
    item: first,
    text: BLOCK,
    copyVersion: COPY_VERSION,
  });
  expect(crew(base, "status").out).toContain(
    `ITEM ${first}: finished (in-review), checked`,
  );
  expect(carry(first).err).toContain(`${first} is finished`);
  expect(
    crew(base, "pick", "--from", first, "--report", oldReport).err,
  ).toContain("pick takes --report or --from, not both");

  // The director drops it, with a reason, and it leaves the work list.
  expect(crew(base, "drop", "--item", first).err).toContain(
    'drop needs --why "<reason>"',
  );
  const dropped = crew(base, "drop", "--item", first, "--why", "too slow");
  expect(dropped.out).toContain(`${first} dropped: too slow`);
  const after = await dailyState(base);
  expect(after.items.map((x) => x.id)).not.toContain(first);
  expect(after.over.map((x) => [x.id, x.state])).toEqual([
    [first, "discarded"],
  ]);

  // Now its game can come back as a new item, which names where it came
  // from.
  const carried = carry(first);
  expect(carried.code).toBe(0);
  const second = /^picked: (\S+)$/m.exec(carried.out)?.[1] ?? "";
  expect(second).not.toBe(first);
  const old = await fetchItem(base, first);
  const now = await fetchItem(base, second);
  expect(now).toMatchObject({
    state: "draft",
    gameId: "CARRYOVR1",
    source: { carriedFrom: first },
    candidate: old.candidate,
    render: null,
    copy: null,
  });
  expect(now.events[0].what).toBe(
    `picked CARRYOVR1 (carried over from ${first})`,
  );
  expect(old.state).toBe("discarded");
  expect(crew(base, "pick", "--from", "v-2026-01-01-9").err).toContain(
    "there is no item v-2026-01-01-9",
  );
}, 30_000);

/**
 * A stand-in for render-4090.mjs --has-capture, --plies and --draft (also
 * of the whole list, --from-cache). The file "no-draft" makes it give a
 * full render where a quick look was asked for.
 */
const STUB_PREVIEW = `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const at = (n) => process.argv[process.argv.indexOf("--" + n) + 1];
const hash = (b) => createHash("sha256").update(b).digest("hex");
if (process.argv.includes("--threads-of")) {
  // The other users' jobs: 8 workers each, as desktop-run's usual job.
  console.log(at("threads-of").split(",").length * 8);
  process.exit(0);
}
if (process.argv.includes("--has-capture")) {
  console.log(existsSync(__dirname + "/no-capture") ? "none" : "cached");
  process.exit(0);
}
if (process.argv.includes("--lint")) {
  // The renderer's lint: lint.json next to the stub when a test writes one.
  writeFileSync(__dirname + "/last-lint-args", process.argv.slice(2).join(" "));
  const file = __dirname + "/lint.json";
  const lint = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
    faults: [], notes: [],
    counts: { seconds: 30, events: {}, overlays: {}, sounds: {} } };
  console.log("RESULT " + JSON.stringify({ lint, timings: { check: 0.3,
    total: 2.1, workers: 1, renderer: { compose: 1.3, total: 1.6 } } }));
  process.exit(0);
}
const edl = JSON.parse(readFileSync(at("edl"), "utf8"));
// A "slow" file holds every job that long (ms), so that jobs overlap; each
// job's workers and time on the 4090 go to jobs.log.
const started = Date.now();
if (existsSync(__dirname + "/slow")) {
  const ms = Number(readFileSync(__dirname + "/slow", "utf8"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
require("node:fs").appendFileSync(__dirname + "/jobs.log", JSON.stringify({
  job: at("job-id"), workers: Number(at("workers")), start: started,
  end: Date.now() }) + "\\n");
const plies = process.argv.includes("--plies") ? at("plies") : null;
const draft = process.argv.includes("--draft");
writeFileSync(__dirname + "/last-plies",
  (plies ?? "all") + " " + edl.events.length + (draft ? " draft" : ""));
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
  "-c:v", "mpeg4", at("out")]);
const bytes = readFileSync(at("out"));
const [from, to] = (plies ?? "").split("..").map(Number);
console.log("RESULT " + JSON.stringify({ mp4: at("out"), bytes: bytes.length,
  sha256: hash(bytes), durationSeconds: 1, fromCache: true,
  draft: draft && !existsSync(__dirname + "/no-draft"),
  preview: plies ? { from, to } : null,
  edlSha256: plies ? null : hash(readFileSync(at("edl"))), sheet: null }));
`;

test("a preview: a few plies from the capture, and the item does not change", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-preview.cjs");
  writeFileSync(stub, STUB_PREVIEW);
  const base = await serve(dir, stub);
  interface Preview {
    previewId: string;
    itemId: string;
    plies: string;
    state: string;
    video: { path: string; bytes: number } | null;
    error: string | null;
  }
  const preview = (body: object) =>
    call<{ previewId: string; error?: string }>(base, "/api/daily/preview", {
      item: id,
      ...body,
    });
  const finished = async (body: object) => {
    const started = await preview(body);
    expect(started.status).toBe(200);
    for (let i = 0; i < 100; i++) {
      const p = await call<Preview>(
        base,
        `/api/daily/preview?id=${started.body.previewId}`,
      );
      if (["done", "failed"].includes(p.body.state)) return p.body;
      await Bun.sleep(100);
    }
    throw new Error("the preview did not end");
  };
  const id = (await call(base, "/api/daily/pick", { report: REPORT })).body.id;

  // No list to preview before direct, unless the call brings one.
  const early = await preview({ plies: "20..23" });
  expect(early.status).toBe(409);
  expect(early.body.error).toContain("has no edit list yet");
  const otherGame = await preview({
    plies: "20..23",
    edl: { ...EDL, gameId: "OTHERGAME" },
  });
  expect(otherGame.status).toBe(409);
  expect(otherGame.body.error).toContain(`${id}'s game is TESTGAME1`);

  await directOver(base, id);
  // The window is checked here, not after the 4090 starts.
  const pastEnd = await preview({ plies: "38..41" });
  expect(pastEnd.status).toBe(409);
  expect(pastEnd.body.error).toContain("after the game's last ply 40");
  expect((await preview({ plies: "22" })).status).toBe(409);

  // A game with no capture on the 4090 is refused before a job exists.
  writeFileSync(join(dir, "no-capture"), "");
  const refused = await preview({ plies: "20..23" });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe(
    "the 4090 has no capture of game TESTGAME1 yet: a preview reads the capture that the game's full render saves, so render the item's video first",
  );
  expect(
    (await call<{ renders: unknown[] }>(base, "/api/daily/busy")).body.renders,
  ).toEqual([]);
  expect(existsSync(join(dir, "last-plies"))).toBe(false);
  unlinkSync(join(dir, "no-capture"));

  const before = await fetchItem(base, id);
  const shown = await finished({ plies: "20..23" });
  expect(shown.state).toBe("done");
  expect(shown.itemId).toBe(id);
  expect(shown.plies).toBe("20..23");
  expect(shown.video!.path).toBe(
    join(dir, "daily", "previews", `${shown.previewId}.mp4`),
  );
  expect(readFileSync(shown.video!.path).length).toBe(shown.video!.bytes);
  // A list given with the call is previewed as given.
  const given = await finished({
    plies: "20..23",
    edl: {
      ...EDL,
      events: [
        ...EDL.events,
        { ply: 23, kind: "laugh", cell: "e4", sound: "laugh-2" },
      ],
    },
  });
  expect(given.state).toBe("done");
  expect(readFileSync(join(dir, "last-plies"), "utf8")).toBe("20..23 2");
  // crew.mjs preview waits for the MP4 and prints its path.
  const printed = crew(base, "preview", "--item", id, "--plies", "21..22");
  expect(printed.code).toBe(0);
  expect(printed.out).toMatch(
    /preview of plies 21\.\.22: .*\/previews\/.*\.mp4 \(1 s, 0\.0 MB\)\. Not the item's video: the item did not change\./,
  );
  // Several lists (variants of the game) are all queued first, then each
  // prints when it is done, in the order given.
  const variants = ["a.json", "b.json"].map((name, i) => {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({ ...EDL, caption: `variant ${i + 1}` }),
    );
    return path;
  });
  const batch = crew(
    base,
    "preview",
    "--item",
    id,
    "--plies",
    "21..22",
    "--edl",
    variants[0],
    "--edl",
    variants[1],
  );
  expect(batch.code).toBe(0);
  const lines = batch.out.trim().split("\n");
  expect(lines[0]).toMatch(/^preview \S+ queued \(a\.json\)$/);
  expect(lines[1]).toMatch(/^preview \S+ queued \(b\.json\)$/);
  expect(
    lines
      .filter((l) => l.startsWith("preview of plies"))
      .map((l) => l.replace(/: .*/, "")),
  ).toEqual([
    "preview of plies 21..22 (a.json)",
    "preview of plies 21..22 (b.json)",
  ]);
  // A variant that the app refuses prints why; the others still render
  // and print, and the run fails.
  const typo = join(dir, "typo.json");
  writeFileSync(typo, JSON.stringify({ ...EDL, gameId: "OTHERGAME" }));
  const mixed = crew(
    base,
    "preview",
    "--item",
    id,
    "--plies",
    "21..22",
    "--edl",
    variants[0],
    "--edl",
    typo,
    "--edl",
    variants[1],
  );
  expect(mixed.code).toBe(1);
  expect(mixed.err).toContain(
    `preview (typo.json) refused: the list is for OTHERGAME, but ${id}'s game is TESTGAME1`,
  );
  expect(mixed.err).toContain("1 of 3 previews failed");
  expect(
    mixed.out
      .trim()
      .split("\n")
      .map((l) =>
        l.replace(/^preview \S+ queued/, "queued").replace(/: .*/, ""),
      ),
  ).toEqual([
    "queued (a.json)",
    "queued (b.json)",
    "preview of plies 21..22 (a.json)",
    "preview of plies 21..22 (b.json)",
  ]);
  // Nothing in the item moved: a preview is not the item's video.
  expect(await fetchItem(base, id)).toEqual(before);
  expect((await call(base, "/api/daily/preview?id=nope")).status).toBe(404);
  // A file step that throws ends the preview as failed, not running.
  rmSync(join(dir, "daily", "previews"), { recursive: true });
  const lost = await finished({ plies: "20..23" });
  expect(lost.state).toBe("failed");
  expect(lost.error).toContain("the preview step failed: ENOENT");
}, 30_000);

test("the lint: every fault at once, and a list that cannot render is never stored", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-preview.cjs");
  writeFileSync(stub, STUB_PREVIEW);
  const base = await serve(dir, stub);
  const id = (await call(base, "/api/daily/pick", { report: REPORT })).body.id;
  const ending = (await dailyState(base)).suggestedEnding;
  const list = (name: string, edl: object = {}) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ ...EDL, ending, ...edl }));
    return path;
  };
  const good = list("good.json");
  const renderer = (lint: object) =>
    writeFileSync(
      join(dir, "lint.json"),
      JSON.stringify({
        notes: [],
        counts: {
          seconds: 31.5,
          events: { zoom: 1 },
          overlays: {},
          sounds: { "fuahhh-1": 1 },
        },
        ...lint,
      }),
    );
  const silence = {
    kind: "silence",
    ply: 12,
    at: 19.9,
    stops: false,
    message: "no sound for 1.7 s, from 19.9 s to 21.6 s",
  };
  const zoomNote = {
    kind: "zoom-scale",
    ply: 22,
    at: 20,
    message: "zoom on ply 22: 1.50 -> 1.56, the window closes in",
  };
  const noPlace = {
    kind: "overlay-place",
    ply: 33,
    at: 41.2,
    stops: true,
    message: "no free place: top-left: pawn on d5",
  };

  // Nothing stops it: warnings and notes are shown, with the counts.
  renderer({ faults: [silence], notes: [zoomNote] });
  const clean = crew(base, "lint", "--item", id, "--edl", good);
  expect(clean.code).toBe(0);
  expect(clean.out).toContain("lint: nothing stops the list");
  expect(clean.out).toContain(
    "WARN ply 12, 19.9 s, silence: no sound for 1.7 s",
  );
  expect(clean.out).toContain("NOTE ply 22, 20.0 s, zoom-scale:");
  expect(clean.out).toContain(
    "31.5 s; events: zoom 1; overlays: none; sounds: fuahhh-1 1",
  );
  // One worker: a lint has no shoot.
  expect(readFileSync(join(dir, "last-lint-args"), "utf8")).toContain(
    "--lint --edl",
  );
  expect(readFileSync(join(dir, "last-lint-args"), "utf8")).toContain(
    "--workers 1",
  );

  // A fault that stops it, and the app's own checks, all at once: direct
  // does not store the list.
  renderer({ faults: [silence, noPlace] });
  const mention = list("mention.json", {
    caption: "Can Ruby get home?",
    payoff: { ply: 22, text: "ask @someone" },
  });
  const refused = crew(base, "direct", "--item", id, "--edl", mention);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain("lint: 2 fault(s) stop the list");
  expect(refused.out).toContain("STOP video payoff must not mention");
  expect(refused.out).toContain(
    "STOP ply 33, 41.2 s, overlay-place: no free place: top-left: pawn on d5",
  );
  expect(refused.err).toContain(
    "mention.json is not stored: the lint stops it",
  );
  expect((await fetchItem(base, id)).edl).toBeNull();

  // The app holds the line too: no lint, a lint of another list, a lint
  // that a fault stops.
  const direct = (edl: object, extra: object) =>
    call(base, "/api/daily/direct", {
      item: id,
      edl: { ...EDL, ending, ...edl },
      ...extra,
    });
  const lintId = async (edl: object) =>
    (
      await call<{ lintId: string }>(base, "/api/daily/lint", {
        item: id,
        edl: { ...EDL, ending, ...edl },
      })
    ).body.lintId;
  const lintDone = async (lid: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await call<{ state: string }>(
        base,
        `/api/daily/lint?id=${encodeURIComponent(lid)}`,
      );
      if (r.body.state === "done") return;
      await Bun.sleep(100);
    }
    throw new Error("the lint did not end");
  };
  expect((await direct({}, {})).body.error).toContain(
    "direct stores a list only after a lint of it",
  );
  const stopped = await lintId({});
  await lintDone(stopped);
  const stoppedDirect = await direct({}, { lint: stopped });
  expect(stoppedDirect.status).toBe(409);
  expect(stoppedDirect.body.error).toContain(
    "the lint found 1 fault(s) that stop the list: ply 33, 41.2 s, overlay-place",
  );
  renderer({ faults: [silence], notes: [zoomNote] });
  const passed = await lintId({});
  await lintDone(passed);
  expect(
    (await direct({ caption: "another caption" }, { lint: passed })).body.error,
  ).toContain("the lint was of another list");

  // crew direct: lint, then store; the summary keeps the warnings.
  const stored = crew(base, "direct", "--item", id, "--edl", good);
  expect(stored.code).toBe(0);
  const item = JSON.stringify(await fetchItem(base, id));
  expect(item).toContain("lint: nothing stops the list (31.5 s)");
  expect(item).toContain("WARN ply 12, 19.9 s, silence");

  // No capture yet: only the app's checks, and direct says so.
  writeFileSync(join(dir, "no-capture"), "");
  const early = crew(base, "direct", "--item", id, "--edl", good);
  expect(early.code).toBe(0);
  expect(early.out).toContain(
    "the renderer did not lint: the 4090 has no capture of game TESTGAME1 yet",
  );
  expect(JSON.stringify(await fetchItem(base, id))).toContain(
    "not linted by the renderer: the 4090 has no capture",
  );
  // --no-lint, for a 4090 that cannot lint.
  const bypass = crew(base, "direct", "--item", id, "--edl", good, "--no-lint");
  expect(bypass.code).toBe(0);
  expect(JSON.stringify(await fetchItem(base, id))).toContain(
    "NOT LINTED (direct --no-lint)",
  );
}, 30_000);

test("the 4090's budget: jobs wait on WAIT, then run two at a time", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-preview.cjs");
  writeFileSync(stub, STUB_PREVIEW);
  const { base } = await serveHere(dir, stub, 100);
  const id = (await call(base, "/api/daily/pick", { report: REPORT })).body.id;
  await directOver(base, id);
  interface Preview {
    state: string;
    progress: string | null;
  }
  const preview = async (previewId: string) =>
    (
      await call<Preview>(
        base,
        `/api/daily/preview?id=${encodeURIComponent(previewId)}`,
      )
    ).body;

  // Windows is busy: three previews queue and say why; none starts.
  writeFileSync(
    join(dir, "desktop-status.txt"),
    [
      "win_cpu_pct=75",
      "win_locked=False",
      "budget=WAIT: Windows CPU 75%. Wait, or ask Infra & Security.",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "slow"), "600");
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const queued = await call<{ previewId: string }>(
      base,
      "/api/daily/preview",
      { item: id, plies: "20..23" },
    );
    expect(queued.status).toBe(200);
    ids.push(queued.body.previewId);
  }
  await Bun.sleep(400);
  for (const previewId of ids) {
    expect(await preview(previewId)).toMatchObject({
      state: "queued",
      progress:
        "waiting for the 4090: desktop-status says WAIT: Windows CPU 75%. Wait, or ask Infra & Security.",
    });
  }
  expect(existsSync(join(dir, "jobs.log"))).toBe(false);

  // Free (unlocked, 12 workers): two run side by side with 6 each, and the
  // third starts when one ends.
  unlinkSync(join(dir, "desktop-status.txt"));
  for (const previewId of ids) {
    for (let i = 0; (await preview(previewId)).state !== "done"; i++) {
      expect(i).toBeLessThan(100);
      await Bun.sleep(100);
    }
  }
  const jobs = readFileSync(join(dir, "jobs.log"), "utf8")
    .trim()
    .split("\n")
    .map(
      (l) => JSON.parse(l) as { workers: number; start: number; end: number },
    )
    .sort((a, b) => a.start - b.start);
  expect(jobs.map((j) => j.workers)).toEqual([6, 6, 6]);
  expect(jobs[1].start).toBeLessThan(jobs[0].end);
  expect(jobs[2].start).toBeGreaterThanOrEqual(
    Math.min(jobs[0].end, jobs[1].end),
  );
}, 30_000);

test("a quick look: the whole list or a few plies at 15 fps, never the item's video", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-preview.cjs");
  writeFileSync(stub, STUB_PREVIEW);
  // Its own process: crew below blocks this one while it runs.
  const base = await serve(dir, stub);
  const id = (await call(base, "/api/daily/pick", { report: REPORT })).body.id;
  await directOver(base, id);
  interface Look {
    plies: string | null;
    draft: boolean;
    state: string;
    video: { path: string } | null;
    error: string | null;
  }
  const look = async (body: object) => {
    const started = await call<{ previewId: string; error?: string }>(
      base,
      "/api/daily/preview",
      { item: id, ...body },
    );
    if (started.status !== 200) return started.body.error;
    for (let i = 0; i < 100; i++) {
      const p = await call<Look>(
        base,
        `/api/daily/preview?id=${encodeURIComponent(started.body.previewId)}`,
      );
      if (["done", "failed"].includes(p.body.state)) return p.body;
      await Bun.sleep(100);
    }
    throw new Error("the quick look did not end");
  };

  // The whole list: from the capture, with the list's hash, into previews/.
  const whole = (await look({ draft: true })) as Look;
  expect(whole).toMatchObject({ plies: null, draft: true, state: "done" });
  expect(whole.video?.path).toContain("/previews/");
  expect(readFileSync(join(dir, "last-plies"), "utf8")).toMatch(
    /^all \d+ draft$/,
  );
  // A few plies, as a preview.
  expect(await look({ draft: true, plies: "20..23" })).toMatchObject({
    plies: "20..23",
    draft: true,
    state: "done",
  });
  // Only a quick look may leave out the plies.
  expect(await look({})).toContain("plies");
  expect(await look({ draft: "yes" })).toBe("draft is true or false");
  // A full render where a quick look was asked for fails.
  writeFileSync(join(dir, "no-draft"), "");
  expect(await look({ draft: true })).toMatchObject({
    state: "failed",
    error: "the render step gave a full render, not a quick look",
  });
  unlinkSync(join(dir, "no-draft"));

  // crew: the whole list, said as a quick look.
  const out = crew(base, "preview", "--item", id, "--draft");
  expect(out.out).toContain("quick look of the whole list: ");
  expect(out.out).toContain("A clean quick look is not a clean render.");
  expect((await fetchItem(base, id)).render).toBeNull();
}, 30_000);

describe("phase 1, the script (SCRIPT.md)", () => {
  const item = {
    id: "v-2026-10-26-1",
    candidate: candidateFromReport(REPORT, 1),
  };
  const edl = {
    ...EDL,
    caption: "bro thought he was safe",
    payoff: { ply: 22, text: "he was not" },
    pace: [{ fromPly: 0, toPly: 20, secondsPerMove: 0.3, fastForward: true }],
    events: [
      ...EDL.events,
      {
        ply: 30,
        kind: "trap",
        walls: [">e4"],
        text: "NO EXIT",
        sound: "sting-1",
      },
      {
        ply: 40,
        kind: "overlay",
        form: "bar",
        asset: "ending-caption",
        text: "bro got caught",
      },
    ],
  };

  test("the draft: header, texts, facts, a row per beat with its second, the checklist", () => {
    const text = scriptDraft({
      item,
      edl,
      timeline: { moves: [{ ply: 22, at: 10.04 }], events: [], sounds: [] },
      timesNote: "from the lint of this list",
      checklist: ["[ ] one", "[ ] two"],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "SCRIPT v-2026-10-26-1 | game TESTGAME1 | 41 plies (0-40)",
    );
    // A bot is red; the guest's walk ends at 0, so the guest catches.
    expect(lines[1]).toBe(
      "Players: Guest Tuatara (guest) BLUE, Ruby (official bot) RED.",
    );
    expect(lines[2]).toBe(
      "Winner: Guest Tuatara (blue), by capture at ply 40.",
    );
    expect(lines[3]).toBe(
      "Start: steps to catch red 12, blue 7. End: red 12, blue 0.",
    );
    expect(text).toContain(
      '- caption (0 s): "bro thought he was safe" (5 words). True: <the fact it rests on>',
    );
    expect(text).toContain('- payoff (from ply 22): "he was not" (3 words).');
    expect(text).toContain(
      '- ending bar (ply 40): "bro got caught" (3 words).',
    );
    expect(text).toContain("- director, wall jump: ply 22 ");
    expect(text).toContain(
      '22 | <label> | ~10.0 | <sees> | zoom + fuahhh-1 | payoff "he was not" | <speaker> | steps red 12, blue 7; wall jump ',
    );
    expect(text).toContain(
      '30 | <label> | ~? | <sees> | trap + sting-1 | "NO EXIT" | <speaker> | steps red 12, blue 7',
    );
    expect(text).toContain("- plies 0-20: 0.3 s a move, fast-forward");
    expect(text.split("CHECKLIST")[1].split("\n").slice(1)).toEqual([
      "[ ] one",
      "[ ] two",
    ]);
  });

  test("a row's label is its explain event's; the checklist is SCRIPT.md's", () => {
    const text = scriptDraft({
      item,
      edl: {
        ...edl,
        events: [{ ply: 22, kind: "explain", label: "detour" }, ...edl.events],
      },
      timeline: null,
      timesNote: "no times",
      checklist: scriptChecklist(
        [
          "# Phase 1",
          "",
          "## Checklist (tick each before the review)",
          "",
          "- [ ] Every meme sits on a move whose label matches its meme-list line.",
          "- [ ] Each beat names a moment the viewer sees and says why it is funny;",
          "      its cause is on screen just before it. No moment, no meme.",
          "- [ ] Dull plies are sped through, not filled.",
          "",
          "## After the checklist",
          "",
          "- [ ] not an item",
        ].join("\n"),
      ),
    });
    expect(text).toContain(
      "\n22 | detour | ~? | <sees> | explain; zoom + fuahhh-1 | ",
    );
    expect(text).toContain(
      "\n[ ] Every meme sits on a move whose label matches its meme-list line.\n",
    );
    // A wrapped item is one line.
    expect(text).toContain(
      "\n[ ] Each beat names a moment the viewer sees and says why it is funny; its cause is on screen just before it. No moment, no meme.\n",
    );
    // Only the checklist section's items.
    expect(text).not.toContain("not an item");
    expect(() => scriptChecklist("# no checklist")).toThrow("## Checklist");
  });

  test("the batch: the other videos' texts and sounds, not this one's", () => {
    const other = {
      id: "v-2026-10-26-2",
      gameId: "OTHER",
      state: "finished",
      edl: { doc: validateEdl({ ...edl, gameId: "OTHER" }).edl },
    };
    const lines = batchLines(
      [
        other,
        { ...other, id: "v-2026-10-26-1" },
        { ...other, id: "v-2026-10-25-9", state: "posted" },
      ],
      "v-2026-10-26-1",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(
      '- v-2026-10-26-2 (game OTHER, finished); caption "bro thought he was safe"; payoff "he was not"; trap words: "NO EXIT"; ending "bro got caught"; sounds: ',
    );
    expect(lines[0]).toContain("fuahhh-1, sting-1");
    expect(batchLines([], "x")).toEqual([
      "- (no other video in draft or review)",
    ]);
  });

  test("crew: script drafts the file with the lint's times; script-review records; render waits for a pass", async () => {
    const dir = tempDir();
    const stub = join(dir, "stub-preview.cjs");
    writeFileSync(stub, STUB_PREVIEW);
    // crew blocks this process while it runs: the app runs in its own.
    const base = await serve(dir, stub);
    const id = (await call(base, "/api/daily/pick", { report: REPORT })).body
      .id;
    const ending = (await dailyState(base)).suggestedEnding;
    const list = join(dir, "list.json");
    writeFileSync(list, JSON.stringify({ ...edl, ending }));
    writeFileSync(
      join(dir, "lint.json"),
      JSON.stringify({
        faults: [],
        notes: [],
        counts: { seconds: 30, events: {}, overlays: {}, sounds: {} },
        timeline: {
          moves: [
            { ply: 22, at: 12.5 },
            { ply: 30, at: 18 },
          ],
          events: [],
          sounds: [],
        },
      }),
    );
    const out = join(dir, "s.txt");
    const drafted = crew(
      base,
      "script",
      "--item",
      id,
      "--edl",
      list,
      "--out",
      out,
    );
    expect(drafted.err).toBe("");
    expect(drafted.out).toContain(`script draft: ${out}`);
    const draft = readFileSync(out, "utf8");
    expect(draft).toContain("Times: from the lint of this list");
    expect(draft).toContain("22 | <label> | ~12.5 | <sees> | zoom + fuahhh-1");
    expect(draft).toContain(
      '30 | <label> | ~18.0 | <sees> | trap + sting-1 | "NO EXIT"',
    );
    // With no --docs, the docs are the director's repo's main, as
    // committed in ~/nil/wallgame-director, never its working tree; with
    // no such repo, a clear error.
    const home = join(dir, "home");
    const repo = join(home, "nil/wallgame-director");
    const docs = join(repo, "scripts/game-video/daily");
    const noDocs = (file: string) =>
      Bun.spawnSync(
        [
          "node",
          resolve(import.meta.dir, "crew.mjs"),
          "script",
          "--item",
          id,
          "--edl",
          list,
          "--out",
          file,
          "--app",
          base,
        ],
        { env: { PATH: process.env.PATH!, HOME: home } },
      );
    expect(noDocs(join(dir, "s0.txt")).stderr.toString()).toContain(
      `briefs not found at ${repo} (main:scripts/game-video/daily/DIRECTOR.md): give --docs DIR`,
    );
    const git = (...args: string[]) =>
      Bun.spawnSync([
        "git",
        "-C",
        repo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        ...args,
      ]);
    // A DIRECTOR.md that does not name the caption style the posts carry
    // stops the script before it is written.
    writeDocs(docs, "# Directing\n\nStyle version: `older-style`\n");
    writeFileSync(join(docs, "SCRIPT.md"), "## Checklist\n\n- [ ] committed\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "docs");
    const oldStyle = noDocs(join(dir, "s1.txt"));
    expect(oldStyle.exitCode).not.toBe(0);
    expect(oldStyle.stderr.toString()).toContain(
      `DIRECTOR.md does not name the caption style ${CAPTION_STYLE_VERSION}`,
    );
    expect(existsSync(join(dir, "s1.txt"))).toBe(false);
    writeFileSync(join(docs, "DIRECTOR.md"), `# Directing\n\n${STYLE_LINE}\n`);
    git("commit", "-q", "-am", "the style");
    writeFileSync(join(docs, "SCRIPT.md"), "## Checklist\n\n- [ ] half done\n");
    const fromMain = join(dir, "s-main.txt");
    expect(noDocs(fromMain).exitCode).toBe(0);
    expect(readFileSync(fromMain, "utf8")).toContain("\n[ ] committed\n");
    expect(readFileSync(fromMain, "utf8")).not.toContain("half done");
    // Never over a file that exists.
    expect(crew(base, "script", "--item", id, "--out", out).err).toContain(
      `${out} exists`,
    );

    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "ply 30: the trap is true\nVERDICT: fail");
    const review = (verdict: string) =>
      crew(
        base,
        "script-review",
        "--item",
        id,
        "--script",
        out,
        "--notes-file",
        notes,
        "--reviewer",
        "a fresh subagent",
        "--verdict",
        verdict,
      );
    expect(review("fail").out).toContain(
      "script review fail by a fresh subagent",
    );
    expect(
      (
        await call(base, "/api/daily/direct", {
          item: id,
          edl: { ...EDL, ending },
          noLint: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(base, "/api/daily/render", { item: id })).body.error,
    ).toContain(`${id}'s latest script review failed`);
    expect(review("pass").out).toContain("The item may render.");
    const it = await fetchItem(base, id);
    expect(it.scriptReviews?.map((r) => r.verdict)).toEqual(["fail", "pass"]);
    expect(it.scriptReviews?.[1].script).toBe(draft);
  }, 30_000);
});

test("crew: crop --cell reads the grid, the timeline and the video of one render", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-render.cjs");
  writeFileSync(stub, STUB_RENDER);
  const base = await serve(dir, stub);
  const id = (await call(base, "/api/daily/pick", { report: REPORT })).body.id;
  await directOver(base, id);
  await renderAndWait(base, id);
  // The stub's events play at 10-11 s, so 0.5 s is at rest; its video is
  // 64x64, so the refusal shows the cell's box met the video's own size.
  expect(
    crew(base, "crop", "--item", id, "--at", "0.5", "--cell", "e7").err,
  ).toContain("the 64x64 video is not 1080x1920 or a scale of it");
  // Only an item's render has a grid.
  expect(
    crew(
      base,
      "crop",
      "--video",
      join(dir, "x.mp4"),
      "--at",
      "0.5",
      "--cell",
      "e7",
    ).err,
  ).toContain("--cell reads the grid of an item's render: --item ID only");
}, 30_000);

test("the app forgets only finished lints: a queued one keeps its record", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-preview.cjs");
  writeFileSync(stub, STUB_PREVIEW);
  const { base } = await serveHere(dir, stub, 100);
  const id = (await call(base, "/api/daily/pick", { report: REPORT })).body.id;
  const ending = (await dailyState(base)).suggestedEnding;
  const lint = async () =>
    (
      await call<{ lintId: string }>(base, "/api/daily/lint", {
        item: id,
        edl: { ...EDL, ending },
      })
    ).body.lintId;
  const state = async (lid: string) =>
    (
      await call<{ state?: string }>(
        base,
        `/api/daily/lint?id=${encodeURIComponent(lid)}`,
      )
    ).body.state;

  // The 4090 says WAIT: 51 lints queue, more than the 50 kept, and the
  // first one keeps its record while its job waits in the queue.
  writeFileSync(
    join(dir, "desktop-status.txt"),
    "budget=WAIT: Windows CPU 75%. Wait, or ask Infra & Security.\n",
  );
  const ids: string[] = [];
  for (let i = 0; i < 51; i++) ids.push(await lint());
  expect(await state(ids[0])).toBe("queued");

  // Free: all 51 run. The next lint forgets the oldest finished one.
  unlinkSync(join(dir, "desktop-status.txt"));
  for (const lid of ids) {
    for (let i = 0; (await state(lid)) !== "done"; i++) {
      expect(i).toBeLessThan(200);
      await Bun.sleep(50);
    }
  }
  const last = await lint();
  for (let i = 0; (await state(last)) !== "done"; i++) {
    expect(i).toBeLessThan(100);
    await Bun.sleep(50);
  }
  expect(await state(ids[0])).toBeUndefined();
  expect(await state(ids[1])).toBe("done");
}, 60_000);

test("a new app start removes the previews that the last one forgot", () => {
  const dir = tempDir();
  const old = join(createDaily({ dataDir: dir }).store.dirs.root, "previews");
  writeFileSync(join(old, "2026-10-26-TESTGAME1-pold.mp4"), "x");
  createDaily({ dataDir: dir });
  expect(readdirSync(old)).toEqual([]);
});

describe("the approved queue in the app (review-post.mjs, scheduler.mjs)", () => {
  test("status: counts and the next slot, no path; the timer keeps its state on disk", async () => {
    const dir = tempDir();
    const store = openStore(dir);
    approveItem(store, finishItem(store));
    const { base } = await serveHere(dir, "unused");
    const { status, body } = await call<{
      counts: { approved: number; postedToday: number };
      nextSlot: { at: string; pacific: string; willPost: boolean };
      livePlatforms: string[];
      postFailed: unknown[];
    }>(base, "/api/review/status");
    expect(status).toBe(200);
    expect(body.counts).toMatchObject({ approved: 1, postedToday: 0 });
    expect(body.nextSlot.willPost).toBe(true);
    expect(body.nextSlot.pacific).toMatch(/ (09|16):00 PT$/);
    // No key in the test env: nothing is live, so a slot would skip.
    expect(body.livePlatforms).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(dir);
    // The first tick of the timer recorded its start.
    const schedule = join(store.dirs.root, "schedule.json");
    for (let i = 0; i < 50 && !existsSync(schedule); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(
      (JSON.parse(readFileSync(schedule, "utf8")) as { lastSlotAt: unknown })
        .lastSlotAt,
    ).toBeString();
  });

  test("slot --now: the timer's own slot step; refused with its reason", async () => {
    const waitFirstTick = async (root: string) => {
      const schedule = join(root, "schedule.json");
      for (let i = 0; i < 50 && !existsSync(schedule); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return schedule;
    };
    // No approved item: a 409 with the reason; crew says it and fails.
    const emptyDir = tempDir();
    // crew blocks this process while it runs: the app runs in its own.
    const emptyBase = await serve(emptyDir, "unused");
    await waitFirstTick(openStore(emptyDir).dirs.root);
    const unnamed = await call(emptyBase, "/api/daily/slot-now", {});
    expect(unnamed.status).toBe(409);
    expect(unnamed.body.error).toBe("slot --now: name who fires it (by)");
    const refused = await call(emptyBase, "/api/daily/slot-now", {
      by: "Wall Game Growth",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("slot --now: the approved queue is empty");
    expect(crew(emptyBase, "slot", "--now").err).toContain(
      'slot --now needs --by "<your agent name>"',
    );
    const said = crew(emptyBase, "slot", "--now", "--by", "Wall Game Growth");
    expect(said.code).toBe(1);
    expect(said.err).toContain("slot --now: the approved queue is empty");
    expect(crew(emptyBase, "slot").err).toContain("slot needs --now");

    // An approved item, and no platform live in the test env: the slot
    // runs and skips, the item stays approved, and the gap does not hold.
    const dir = tempDir();
    const store = openStore(dir);
    const id = finishItem(store);
    approveItem(store, id);
    const base = await serve(dir, "unused");
    const schedule = await waitFirstTick(store.dirs.root);
    const ran = crew(base, "slot", "--now", "--by", "Wall Game Growth");
    expect(ran.out).toContain("slot by hand: no item no-live");
    expect(ran.code).toBe(1);
    const state = JSON.parse(readFileSync(schedule, "utf8")) as {
      lastPostAt: string | null;
      lastSlot: { outcome: string };
    };
    expect(state.lastSlot.outcome).toBe("no-live");
    expect(state.lastPostAt).toBeNull();
    expect(itemOf(openStore(dir), id).state).toBe("approved");
  });

  test("Growth's retry: only a post-failed item, and never a platform that is not live", async () => {
    const dir = tempDir();
    const path = join(dir, "v.mp4");
    writeFileSync(path, "bytes");
    const store = openStore(dir);
    const id = finishItem(store, {
      path,
      bytes: 5,
      sha256: sha256(readFileSync(path)),
      durationSeconds: 30,
    });
    approveItem(store, id);
    const { base } = await serveHere(dir, "unused");
    const early = await call(base, "/api/daily/post", { itemId: id });
    expect(early.status).toBe(409);
    expect(early.body.error).toContain("only a post-failed item is retried");
    // As a slot leaves it: bluesky refused (a clear failure), x posted.
    store.updateItem(
      id,
      ["approved"],
      (it: Item & { posting?: object; posts?: object }) => {
        it.state = "post-failed";
        it.posting = {
          slotAt: "2026-10-29T16:00:00.000Z",
          at: "2026-10-29T16:00:01.000Z",
          platforms: ["x", "bluesky"],
        };
        it.posts = {
          x: { ok: true, mode: "dry-run", at: "2026-10-29T16:00:02.000Z" },
          bluesky: { ok: false, uncertain: false, error: "bluesky: HTTP 400" },
        };
      },
      "a slot (test)",
    );
    // Bluesky is not live in the test env: a retry would post a dry run,
    // so it is refused before any request and nothing counts as posted.
    const retry = await call(base, "/api/daily/post", { itemId: id });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe(
      "bluesky is not live now: connect it (/daily/connect), then retry",
    );
    expect(readPostLog(store.postLog.dryRun)).toEqual([]);
    expect(itemOf(store, id).state).toBe("post-failed");
  });
});
