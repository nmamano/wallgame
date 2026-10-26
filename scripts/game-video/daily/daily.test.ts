/**
 * What the daily video pipeline must refuse, and one whole dry-run cycle.
 *
 * The refusals are the reason the pipeline is a state machine: a post must
 * only ever follow an approval of the same video, in the same posting mode,
 * and a platform must never get the same video twice. The full cycle runs the
 * real app (server.mjs) with a stub in place of the 4090 render step, and
 * checks that a dry run writes the requests a live post would send, with no
 * credential in them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
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
import { openStore, readPostLog } from "./store.mjs";
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
import { youtubeDryRunReply } from "./post-youtube.mjs";
import {
  postToTiktok,
  tiktokDryRunReply,
  DRY_RUN_TIKTOK,
  TIKTOK_TOKEN_URL,
} from "./post-tiktok.mjs";
import { instagramDryRunReply, postToInstagram } from "./post-instagram.mjs";
import {
  dryRunTransport,
  NotPosted,
  PostFailed,
  sha256,
} from "./transport.mjs";
import { approvedPackage, askText, postedTexts } from "./crew.mjs";
import { postingModes, createDaily } from "./routes.mjs";
import { parseResult } from "./render-4090.mjs";
import {
  loudnessVerdict,
  safeAreaVerdict,
  captionLinesVerdict,
  MAX_MEME_LUFS,
} from "./quality.mjs";
import { FRAME, SAFE_AREA, validateEdl } from "../edl.mjs";

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
  `Mastodon: bro thought he could just walk home 😭🙏 ${trackedLink("mastodon")} #wallgame`,
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

/** The parts of a cycle record (store.mjs) that these tests read. */
interface Cycle {
  day: string;
  state: string;
  candidate: { gameId: string };
  copy: Record<string, string> | null;
  approval: { copy: Record<string, string> | null } | null;
  render: {
    error: string | null;
    effect: string | null;
    ending: string;
    sheet: { sha256: string; stills: unknown[] } | null;
    video: { path: string; sha256: string } | null;
    quality: Record<string, { ok: boolean; note: string }> | null;
  } | null;
  check: { ok: boolean } | null;
  events: { what: string }[];
  posts: Record<string, { postId: string; requestsFile: string }>;
}

interface DailyState {
  cycle: Cycle;
}

interface LogRow {
  platform: string;
  caption: string;
  styleVersion: string | null;
  copyVersion: string;
}

const tempDir = () => mkdtempSync(join(tmpdir(), "daily-video-test-"));

const pickToday = (
  store: ReturnType<typeof openStore>,
  day: string,
  replace = false,
): void => {
  const candidate = candidateFromReport(REPORT, 1);
  store.pick(day, {
    candidate,
    style: "daily",
    styleVersion: CAPTION_STYLE_VERSION,
    replace,
  });
  store.recordCopy(day, COPY);
};

const DRY = {
  x: "dry-run",
  youtube: "dry-run",
  tiktok: "dry-run",
  instagram: "dry-run",
  facebook: "dry-run",
  bluesky: "dry-run",
  threads: "dry-run",
  mastodon: "dry-run",
};

/** A director's list for TESTGAME1: one zoom with a FAHHH on move 23. */
const EDL = {
  version: 1,
  gameId: "TESTGAME1",
  ending: "replay",
  events: [{ ply: 22, kind: "zoom", frame: ["e4", "e5"], sound: "fuahhh-1" }],
};

const directToday = (
  store: ReturnType<typeof openStore>,
  day: string,
  replace = false,
) => {
  pickToday(store, day, replace);
  store.direct(day, {
    edl: EDL,
    text: JSON.stringify(EDL),
    summary: edlSummary(EDL),
  });
};

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

/** Walk a cycle to "checked" (ready to ask) for this video. */
const checkedToday = (
  store: ReturnType<typeof openStore>,
  day: string,
  video: {
    path: string;
    bytes: number;
    sha256: string;
    durationSeconds?: number;
  },
) => {
  directToday(store, day);
  store.startRender(day, "job-00000001");
  store.finishRender(day, "job-00000001", {
    video,
    sheet: SHEET,
    quality: MEASURED,
  });
  store.recordCheck(day, { sheetSha256: "ss", stills: [ZOOM_OK] });
};

/** Walk a cycle to "approved" for a video with this hash. */
const approved = (
  store: ReturnType<typeof openStore>,
  day: string,
  sha = "aa",
) => {
  directToday(store, day);
  store.startRender(day, "job-00000001");
  store.finishRender(day, "job-00000001", {
    video: { path: "/nowhere.mp4", bytes: 1, sha256: sha },
    sheet: SHEET,
    effect: "zoom",
    sound: "shotgun",
    quality: MEASURED,
  });
  store.recordCheck(day, { sheetSha256: "ss", stills: [ZOOM_OK] });
  store.recordAsk(day, {
    askId: "ask1",
    modes: DRY,
    videoSha256: (store.read(day) as Cycle).render?.video?.sha256,
    copySha256: COPY_SHA,
    currentModes: DRY,
  });
  store.recordAnswer(day, {
    askId: "ask1",
    decision: "approve",
    approver: "Nil",
    reply: "Approve",
  });
};

describe("a text-only rejection: a new block, the same video", () => {
  const day = "2026-10-26";
  const NEW = { ...COPY, x: "bro walked right into it 😭🙏 #wallgame" };
  const ask = (
    store: ReturnType<typeof openStore>,
    askId: string,
    copy: typeof COPY,
    replacesAskId?: string,
  ) => {
    store.recordAsk(day, {
      askId,
      modes: DRY,
      videoSha256: "aa",
      copySha256: copySha256(copy),
      currentModes: DRY,
      ...(replacesAskId && { replacesAskId }),
    });
  };
  const rejected = (reply: string | null = "the X line is cringe") => {
    const store = openStore(tempDir());
    checkedToday(store, day, { path: "/x", bytes: 1, sha256: "aa" });
    ask(store, "ask1", COPY);
    store.recordAnswer(day, {
      askId: "ask1",
      decision: "reject",
      approver: "Nil",
      reply,
    });
    return store;
  };

  test("the rejected block cannot be asked again", () => {
    expect(() => {
      ask(rejected(), "ask2", COPY);
    }).toThrow(/the copy block is the one rejected in ask ask1/);
  });

  test("a new block opens a new ask about the same video, and it can post", () => {
    const store = rejected();
    store.recordCopy(day, NEW);
    expect((store.read(day) as Cycle).state).toBe("rejected");
    ask(store, "ask2", NEW);
    const cycle = store.read(day) as Cycle & {
      approval: { sameVideoAs: string; askId: string };
      earlierAsks: { askId: string; decision: string; reply: string }[];
    };
    expect(cycle.state).toBe("asked");
    expect(cycle.approval.sameVideoAs).toBe("ask1");
    expect(cycle.earlierAsks).toMatchObject([
      { askId: "ask1", decision: "reject", reply: "the X line is cringe" },
    ]);
    expect(cycle.events.at(-1)?.what).toBe(
      "ask ask2 opened: the video of ask ask1, a new copy block",
    );
    // Opened again for the right member, it is still about the same video.
    ask(store, "ask3", NEW, "ask2");
    expect(
      (store.read(day) as Cycle & { approval: { sameVideoAs: string } })
        .approval.sameVideoAs,
    ).toBe("ask1");
    store.recordAnswer(day, {
      askId: "ask3",
      decision: "approve",
      approver: "Nil",
      reply: "Approve",
    });
    expect(store.checkPost(day, { modes: DRY, videoSha256: "aa" })).toEqual([
      "x",
      "youtube",
      "tiktok",
      "instagram",
      "facebook",
      "bluesky",
      "threads",
      "mastodon",
    ]);
    expect((store.read(day) as Cycle).approval?.copy).toEqual(NEW);
  });

  // The cycle as askText reads it once the video is rendered and checked.
  const askable = (store: ReturnType<typeof openStore>) => ({
    ...(store.read(day) as object),
    candidate: {
      seats: [{ name: "A" }, { name: "B" }],
      movesCount: 9,
      gameId: "g",
    },
    render: { video: { bytes: 1e6 }, ending: "e" },
    edl: { summary: [] },
    check: { verdicts: [] },
  });

  test("the ask says it is the same video, with Nil's reply", () => {
    const store = rejected();
    store.recordCopy(day, NEW);
    const c = askable(store);
    const same =
      'SAME VIDEO as ask ask1 (sha256 aa), which you rejected with: "the X line is cringe". Only the post text is new.';
    expect(askText(c, DRY, "aa").split("\n")[1]).toBe(same);
    // After the new ask is recorded (a reopen builds the text then).
    ask(store, "ask2", NEW);
    const asked = { ...c, ...(store.read(day) as object) };
    expect(askText(asked, DRY, "aa").split("\n")[1]).toBe(same);
  });

  test("a dismissed ask is not quoted as a reply", () => {
    const store = rejected(null);
    store.recordCopy(day, NEW);
    const c = askable(store);
    expect(askText(c, DRY, "aa").split("\n")[1]).toBe(
      "SAME VIDEO as ask ask1 (sha256 aa), which you dismissed without a reply. Only the post text is new.",
    );
  });
});

describe("an ask opened again for the right member", () => {
  const day = "2026-10-26";
  const asked = () => {
    const store = openStore(tempDir());
    checkedToday(store, day, { path: "/x", bytes: 1, sha256: "aa" });
    store.recordAsk(day, {
      askId: "old",
      modes: DRY,
      videoSha256: "aa",
      copySha256: COPY_SHA,
      currentModes: DRY,
    });
    return store;
  };
  const reopen = (
    store: ReturnType<typeof openStore>,
    replacesAskId: string,
  ) => {
    store.recordAsk(day, {
      askId: "new",
      modes: DRY,
      videoSha256: "aa",
      copySha256: COPY_SHA,
      currentModes: DRY,
      replacesAskId,
    });
  };

  test("the new ask takes over, and only its answer counts", () => {
    const store = asked();
    reopen(store, "old");
    const cycle = store.read(day) as Cycle;
    expect(cycle.state).toBe("asked");
    expect(cycle.events.at(-1)?.what).toBe("ask new opened again (was old)");
    expect(() => {
      store.recordAnswer(day, {
        askId: "old",
        decision: "approve",
        approver: "Nil",
        reply: "Approve",
      });
    }).toThrow(/ask old is not this cycle's ask \(new\)/);
    store.recordAnswer(day, {
      askId: "new",
      decision: "approve",
      approver: "Nil",
      reply: "Approve",
    });
    expect((store.read(day) as Cycle).state).toBe("approved");
  });

  test("only the cycle's open ask can be replaced", () => {
    expect(() => {
      reopen(asked(), "other");
    }).toThrow(/ask other is not this cycle's ask \(old\)/);
    const answered = asked();
    answered.recordAnswer(day, {
      askId: "old",
      decision: "reject",
      approver: "Nil",
      reply: "Reject",
    });
    expect(() => {
      reopen(answered, "old");
    }).toThrow(/reopen the ask needs the cycle in asked/);
  });
});

describe("the ask must show what the approval will cover", () => {
  const day = "2026-10-26";
  const rendered = () => {
    const store = openStore(tempDir());
    checkedToday(store, day, { path: "/x", bytes: 1, sha256: "aa" });
    return store;
  };

  test("a new block replaces the old one, and the ask must show the stored one", () => {
    const store = openStore(tempDir());
    const candidate = candidateFromReport(REPORT, 1);
    store.pick(day, {
      candidate,
      style: "daily",
      styleVersion: CAPTION_STYLE_VERSION,
    });
    store.recordCopy(day, { ...COPY, x: "first draft" });
    // A new block replaces the old one until the ask.
    store.recordCopy(day, COPY);
    expect((store.read(day) as Cycle).events.at(-1)?.what).toBe(
      `copy block replaced (${COPY_VERSION})`,
    );
    const ask = (copySha256: string) => {
      rendered().recordAsk(day, {
        askId: "a",
        modes: DRY,
        videoSha256: "aa",
        copySha256,
        currentModes: DRY,
      });
    };
    expect(() => {
      ask(copySha256({ ...COPY, x: "first draft" }));
    }).toThrow(/another copy block than the stored one/);
  });

  test("an ask that showed another video is refused", () => {
    expect(() => {
      rendered().recordAsk(day, {
        askId: "a",
        modes: DRY,
        videoSha256: "bb",
        copySha256: COPY_SHA,
        currentModes: DRY,
      });
    }).toThrow(/another video/);
  });

  test("an ask that said dry-run is refused once the app would post live", () => {
    expect(() => {
      rendered().recordAsk(day, {
        askId: "a",
        modes: DRY,
        videoSha256: "aa",
        copySha256: COPY_SHA,
        currentModes: {
          x: "live",
          youtube: "dry-run",
          tiktok: "dry-run",
          instagram: "dry-run",
        },
      });
    }).toThrow(/the ask says x dry-run, but the app would post live/);
  });
});

describe("the director checks the contact sheet before the ask", () => {
  const day = "2026-10-26";
  const video = { path: "/x", bytes: 1, sha256: "aa" };
  const rendered = (quality: object | null = MEASURED) => {
    const store = openStore(tempDir());
    directToday(store, day);
    store.startRender(day, "job-00000001");
    store.finishRender(day, "job-00000001", { video, sheet: SHEET, quality });
    return store;
  };
  const ask = (store: ReturnType<typeof openStore>) => {
    store.recordAsk(day, {
      askId: "a",
      modes: DRY,
      videoSha256: "aa",
      copySha256: COPY_SHA,
      currentModes: DRY,
    });
  };

  test("no render without an edit list", () => {
    const store = openStore(tempDir());
    pickToday(store, day);
    expect(() => {
      store.startRender(day, "job-00000001");
    }).toThrow(/render needs the cycle in directed/);
  });

  test("no ask before the check", () => {
    expect(() => {
      ask(rendered());
    }).toThrow(/ask needs the cycle in checked/);
  });

  test("a bad still keeps the ask closed, and the way on is a new list", () => {
    const store = rendered();
    store.recordCheck(day, {
      sheetSha256: "ss",
      stills: [
        { ...ZOOM_OK, ok: false, note: "the zoom shows the cat, not the wall" },
      ],
    });
    expect((store.read(day) as Cycle).state).toBe("rendered");
    expect(() => {
      ask(store);
    }).toThrow(/ask needs the cycle in checked/);
    // A second look at the same render cannot turn the failure into a pass.
    expect(() => {
      store.recordCheck(day, { sheetSha256: "ss", stills: [ZOOM_OK] });
    }).toThrow(/already failed its check/);
    store.direct(day, { edl: EDL, text: JSON.stringify(EDL), summary: [] });
    const cycle = store.read(day) as Cycle;
    expect(cycle.state).toBe("directed");
    expect(cycle.render).toBeNull();
  });

  test("every still needs its own verdict, in order, with a note", () => {
    const store = rendered();
    expect(() => {
      store.recordCheck(day, { sheetSha256: "ss", stills: [] });
    }).toThrow(/a verdict on each/);
    expect(() => {
      store.recordCheck(day, {
        sheetSha256: "ss",
        stills: [{ ...ZOOM_OK, ply: 23 }],
      });
    }).toThrow(/still 1 is ply 22 zoom/);
    expect(() => {
      store.recordCheck(day, {
        sheetSha256: "ss",
        stills: [{ ...ZOOM_OK, note: " " }],
      });
    }).toThrow(/needs a note/);
    expect(() => {
      store.recordCheck(day, { sheetSha256: "other", stills: [ZOOM_OK] });
    }).toThrow(/another contact sheet/);
    store.recordCheck(day, { sheetSha256: "ss", stills: [ZOOM_OK] });
    ask(store);
    expect((store.read(day) as Cycle).state).toBe("asked");
  });

  test("a failed measure fails the check, even when every still is ok", () => {
    const store = rendered({
      loudness: {
        ok: false,
        note: "shotgun-2 at 1.1 s: -15.8 LUFS: a meme sound may be at most -18.5 LUFS",
      },
    });
    store.recordCheck(day, { sheetSha256: "ss", stills: [ZOOM_OK] });
    const cycle = store.read(day) as Cycle;
    expect(cycle.state).toBe("rendered");
    expect(cycle.check?.ok).toBe(false);
    expect(cycle.events.at(-1)?.what).toBe(
      "check failed: loudness: shotgun-2 at 1.1 s: -15.8 LUFS: a meme sound may be at most -18.5 LUFS",
    );
  });

  test("a render with no measures cannot be checked", () => {
    const store = rendered(null);
    expect(() => {
      store.recordCheck(day, { sheetSha256: "ss", stills: [ZOOM_OK] });
    }).toThrow(/no measures/);
  });
});

test("the edit list summary names the start, the cold open, the payoff, a race flash and a lead zoom", () => {
  expect(
    edlSummary({
      ending: "gg",
      music: "skippy",
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
    'ending gg, music skippy, video caption "Red is 2 steps from winning"',
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
    expect(safeAreaVerdict(layout, FRAME, SAFE_AREA)).toEqual({
      ok: true,
      note: "board, caption inside the safe area",
    });
    // The board of the audited renders (y 436-1483) ends under the buttons.
    const low = {
      ...layout,
      boxes: { board: { x: 16, y: 436, w: 1048, h: 1048 } },
    };
    const v = safeAreaVerdict(low, FRAME, SAFE_AREA);
    expect(v.ok).toBe(false);
    expect(v.note).toBe(
      "board (x 16-1064, y 436-1484) is outside the safe area (x 65-1015, y 269-1248)",
    );
    expect(safeAreaVerdict(undefined, FRAME, SAFE_AREA).note).toBe(
      "the render reported no layout",
    );
    expect(
      safeAreaVerdict(
        { ...layout, frame: { w: 1080, h: 1080 } },
        FRAME,
        SAFE_AREA,
      ).note,
    ).toBe("the frame is 1080x1080, not 1080x1920");
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
      note: "payoff 2 lines, 882 of 918 px: each beat must be one line inside its box; shorten it, direct again and render --force",
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

describe("a post that may exist is not posted again", () => {
  test("a lost reply to the final X request blocks a retry until a person confirms", async () => {
    const dir = tempDir();
    const video = join(dir, "v.mp4");
    writeFileSync(video, "bytes");
    const day = "2026-10-26";
    const store = openStore(dir);
    checkedToday(store, day, {
      path: video,
      bytes: 5,
      sha256: sha256(readFileSync(video)),
      // A render reports it; Facebook refuses a video of unknown length.
      durationSeconds: 30,
    });
    store.recordAsk(day, {
      askId: "a",
      modes: DRY,
      videoSha256: sha256(readFileSync(video)),
      copySha256: COPY_SHA,
      currentModes: DRY,
    });
    store.recordAnswer(day, {
      askId: "a",
      decision: "approve",
      approver: "Nil",
      reply: "Approve",
    });

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
        youtube: youtubeDryRunReply,
        tiktok: tiktokDryRunReply,
      },
    });
    const first = (await daily.post(day)) as Cycle & {
      posts: Record<string, { uncertain?: boolean }>;
    };
    expect(first.state).toBe("post-failed");
    expect(first.posts.x.uncertain).toBe(true);
    expect(first.posts.youtube.postId).toBe("DRY-RUN-VIDEO-ID");

    lose = false;
    expect(daily.post(day)).rejects.toThrow(/x may already have this post/);
    const second = (await daily.post(day, ["x"])) as Cycle;
    expect(second.state).toBe("posted");
  });
});

describe("an approval covers one video in one mode", () => {
  const day = "2026-10-26";

  test("post is refused before an approval", () => {
    const store = openStore(tempDir());
    pickToday(store, day);
    expect(() =>
      store.checkPost(day, { modes: DRY, videoSha256: "aa" }),
    ).toThrow(/post needs the cycle in approved/);
  });

  test("an answer to another ask does not count", () => {
    const store = openStore(tempDir());
    checkedToday(store, day, { path: "/x.mp4", bytes: 1, sha256: "aa" });
    store.recordAsk(day, {
      askId: "ask1",
      modes: DRY,
      videoSha256: (store.read(day) as Cycle).render?.video?.sha256,
      copySha256: COPY_SHA,
      currentModes: DRY,
    });
    expect(() => {
      store.recordAnswer(day, {
        askId: "other",
        decision: "approve",
        approver: "Nil",
        reply: "Approve",
      });
    }).toThrow(/not this cycle's ask/);
  });

  test("a different video on disk is refused", () => {
    const store = openStore(tempDir());
    approved(store, day, "aa");
    expect(() =>
      store.checkPost(day, { modes: DRY, videoSha256: "bb" }),
    ).toThrow(/not the one that was approved/);
  });

  /** Change the stored cycle by hand, as a bad edit or an old record would. */
  interface Stored {
    copy: Record<string, string>;
    approval: { copy?: Record<string, string> };
  }
  const edit = (
    store: ReturnType<typeof openStore>,
    change: (c: Stored) => void,
  ) => {
    const path = join(store.dirs.cycles, `${day}.json`);
    const cycle = JSON.parse(readFileSync(path, "utf8")) as Stored;
    change(cycle);
    writeFileSync(path, JSON.stringify(cycle));
  };

  test("a copy block that is not the approved one is refused", () => {
    const store = openStore(tempDir());
    approved(store, day, "aa");
    edit(store, (c) => {
      c.copy.x = "something else";
    });
    expect(() =>
      store.checkPost(day, { modes: DRY, videoSha256: "aa" }),
    ).toThrow(/the copy block is not the one that was approved/);
  });

  test("an approval from before the copy block posts nothing", () => {
    const store = openStore(tempDir());
    approved(store, day, "aa");
    edit(store, (c) => {
      delete c.approval.copy;
    });
    expect(() =>
      store.checkPost(day, { modes: DRY, videoSha256: "aa" }),
    ).toThrow(/this approval has no copy block/);
  });

  test("the approved package names the video and the block as approved", () => {
    const store = openStore(tempDir());
    approved(store, day, "aa");
    const release = "/srv/release/scripts/game-video/daily/crew.mjs";
    const lines = approvedPackage(store.read(day), release).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      `APPROVED PACKAGE, day ${day}`,
      "Video: /nowhere.mp4",
      "Video sha256: aa",
      `Copy block as approved (${COPY_VERSION}, copy sha256 ${COPY_SHA}):`,
    ]);
    expect(lines.slice(4, 13).join("\n")).toBe(BLOCK);
    expect(lines[13]).toMatch(/^Ask: ask1, approved by Nil at \d{4}-/);
    expect(lines[14]).toBe("Nil's reply, verbatim: Approve");
    // The release checkout's crew.mjs, whichever checkout ran `answer`.
    expect(lines[15]).toBe(`Post it with: node ${release} post --day ${day}`);
  });

  test("keys that arrived after the ask do not turn a dry-run approval live", () => {
    const store = openStore(tempDir());
    approved(store, day);
    expect(() =>
      store.checkPost(day, {
        modes: {
          x: "live",
          youtube: "dry-run",
          tiktok: "dry-run",
          instagram: "dry-run",
        },
        videoSha256: "aa",
      }),
    ).toThrow(/approval was for dry-run/);
  });

  test("once the ask is open, the candidate cannot be swapped under it", () => {
    const store = openStore(tempDir());
    checkedToday(store, day, { path: "/x", bytes: 1, sha256: "aa" });
    store.recordAsk(day, {
      askId: "ask1",
      modes: DRY,
      videoSha256: (store.read(day) as Cycle).render?.video?.sha256,
      copySha256: COPY_SHA,
      currentModes: DRY,
    });
    expect(() => {
      pickToday(store, day, true);
    }).toThrow(/pick needs/);
  });

  test("a retry posts only the platform that failed, and logs dry runs apart", () => {
    const store = openStore(tempDir());
    approved(store, day);
    const cycle = store.read(day) as Cycle;
    const row = { utc: "t", gameId: cycle.candidate.gameId };
    store.recordPost(day, "x", { ok: true, mode: "dry-run", postId: "p" }, row);
    store.recordPost(
      day,
      "youtube",
      { ok: false, mode: "dry-run", error: "boom" },
      null,
    );
    expect((store.read(day) as Cycle).state).toBe("post-failed");
    expect(store.checkPost(day, { modes: DRY, videoSha256: "aa" })).toEqual([
      "youtube",
      "tiktok",
      "instagram",
      "facebook",
      "bluesky",
      "threads",
      "mastodon",
    ]);
    expect(readPostLog(store.postLog.dryRun)).toHaveLength(1);
    expect(existsSync(store.postLog.live)).toBe(false);
  });
});

describe("a day has one cycle", () => {
  test("a second pick on the same day needs replace", () => {
    const store = openStore(tempDir());
    const day = "2026-10-26";
    pickToday(store, day);
    expect(() => {
      pickToday(store, day);
    }).toThrow(
      /2026-10-26 already has a cycle \(picked, TESTGAME1\); the day is taken/,
    );
    pickToday(store, day, true);
    expect((store.read(day) as Cycle).state).toBe("picked");
  });
});

describe("each render is one production view", () => {
  test("a second render of the same game needs force, also after a re-pick", () => {
    const store = openStore(tempDir());
    const day = "2026-10-26";
    directToday(store, day);
    store.startRender(day, "job-00000001");
    store.finishRender(day, "job-00000001", { error: "boom" });
    directToday(store, day, true);
    expect(() => {
      store.startRender(day, "job-00000002");
    }).toThrow(/already rendered 1 time/);
    store.startRender(day, "job-00000002", { force: true });
    expect((store.read(day) as Cycle).state).toBe("rendering");
  });
});

/** COPY with one text changed. */
const withText = (field: string, text: string) => ({ ...COPY, [field]: text });

describe("Growth's copy block", () => {
  test("the nine lines are the texts that post; the app adds only #Shorts", () => {
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

  test("a block that is not exactly the nine labelled lines is refused", () => {
    const lines = BLOCK.split("\n");
    expect(parseCopy(lines.slice(1).join("\n")).problems).toEqual([
      'no "X:" line',
    ]);
    expect(parseCopy([...lines, lines[0]].join("\n")).problems).toEqual([
      'line 10: "X" comes twice',
    ]);
    expect(parseCopy([...lines, "Pinterest: hi"].join("\n")).problems).toEqual([
      'line 10 does not start with one of "X:", "YouTube title:", "YouTube description:", "TikTok:", "Instagram:", "Facebook:", "Bluesky:", "Threads:", "Mastodon:"',
    ]);
    expect(
      parseCopy(
        [...lines.slice(0, 4), "Instagram:  ", ...lines.slice(5)].join("\n"),
      ).problems,
    ).toEqual(['the "Instagram:" line is empty']);
    expect(parseCopy(undefined).copy).toBeNull();
  });

  test("Facebook, Bluesky, Threads and Mastodon: each its own count, and only the tracked link", () => {
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
    // Mastodon: 500, a link counting 23 however long it is.
    const masto = trackedLink("mastodon");
    expect(problems("mastodon", `${"a".repeat(476)} ${masto}`)).toEqual([]);
    expect(problems("mastodon", `${"a".repeat(477)} ${masto}`)).toHaveLength(1);
    // Threads: 500, an emoji counting its UTF-8 bytes.
    expect(problems("threads", "😭".repeat(125))).toEqual([]);
    expect(problems("threads", "😭".repeat(126))).toHaveLength(1);
    // A link is allowed on all four (Facebook and Threads start without
    // one), but only the platform's tracked link.
    expect(problems("facebook", `hi ${trackedLink("facebook")}`)).toEqual([]);
    expect(problems("bluesky", `hi ${trackedLink("mastodon")}`)).toEqual([
      `Bluesky may hold only the link ${bsky}`,
    ]);
    expect(problems("threads", `hi https://example.com/x`)).toEqual([
      `Threads may hold only the link ${trackedLink("threads")}`,
    ]);
    // A bare domain becomes an untracked link on these platforms.
    expect(problems("facebook", "play at wallgame.io")).toEqual([
      `Facebook may hold only the link ${trackedLink("facebook")}`,
    ]);
    expect(problems("mastodon", `${masto} or www.wallgame.io`)).toHaveLength(1);
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

  test("DIRECTOR.md names the caption style version that the posts carry", () => {
    const director = readFileSync(
      resolve(import.meta.dir, "DIRECTOR.md"),
      "utf8",
    );
    expect(director).toContain(
      `Style version: \`${CAPTION_STYLE_VERSION}\` (\`CAPTION_STYLE_VERSION\`)`,
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
    // A video that starts later is read later.
    expect(
      storyProblems(
        list({ caption: "Red is 2 steps away", startPly: 2 }),
        game,
      ),
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

  test("the ask shows the stored block word for word, and the TikTok step only when live", () => {
    const c = {
      day: "2026-10-26",
      copy: COPY,
      candidate: {
        seats: [{ name: "A" }, { name: "B" }],
        movesCount: 9,
        gameId: "g",
      },
      render: { video: { bytes: 1e6 }, ending: "e" },
      edl: { summary: [] },
      check: { verdicts: [] },
    };
    const live = askText(
      c,
      { ...DRY, x: "live", youtube: "live", tiktok: "live", bluesky: "live" },
      "0".repeat(64),
    ).split("\n");
    const at = live.indexOf(`Post text (by Growth, ${COPY_VERSION}):`);
    expect(at).toBeGreaterThan(-1);
    expect(live.slice(at + 1, at + 10).join("\n")).toBe(BLOCK);
    // Whether it posts for real comes right after the block, live first.
    expect(live.slice(at + 10, at + 14)).toEqual([
      'The app adds "#Shorts" to the YouTube title.',
      "LIVE on X, YouTube, TikTok, Bluesky: this posts for real on approval.",
      "Posting mode: X live, YouTube live, TikTok live, Instagram dry-run, Facebook dry-run, Bluesky live, Threads dry-run, Mastodon dry-run.",
      "TikTok: open the inbox draft, paste the TikTok line, tap Post.",
    ]);
    const dry = askText(
      c,
      { ...DRY, x: "live", instagram: "live" },
      "0".repeat(64),
    ).split("\n");
    expect(dry.slice(at + 11, at + 14)).toEqual([
      "LIVE on X, Instagram: this posts for real on approval.",
      "Posting mode: X live, YouTube dry-run, TikTok dry-run, Instagram live, Facebook dry-run, Bluesky dry-run, Threads dry-run, Mastodon dry-run.",
      "TikTok: dry run, no draft.",
    ]);
    const none = askText(c, DRY, "0".repeat(64));
    expect(none).not.toContain("LIVE on");
    expect(none).toContain(
      "Posting mode: X dry-run, YouTube dry-run, TikTok dry-run, Instagram dry-run, Facebook dry-run, Bluesky dry-run, Threads dry-run, Mastodon dry-run.",
    );
    // The mode is stated once, under the block, not again for Nil only.
    expect(none.split("Posting mode:").length).toBe(2);
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

  /** media_publish answers 400; the container check after it says `after`. */
  const publishRefused = (after: string) => {
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
        return { status: 200, json: { status_code: after } };
      }
      return instagramDryRunReply(req);
    };
  };

  test("a refused media_publish whose container is PUBLISHED is a posted Reel", async () => {
    const { r } = await run(publishRefused("PUBLISHED"));
    expect(r).toEqual({ postId: null, url: null });
  });

  test("a refused media_publish whose container is FINISHED is a clear no", async () => {
    const { e } = await run(publishRefused("FINISHED"));
    expect(e).toBeInstanceOf(PostFailed);
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
    expect(steps.slice(-3)).toEqual([
      "COMMIT",
      "media_publish",
      "DRY-RUN-MEDIA-ID?fields=permalink",
    ]);
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
        X_API_KEY: "xvz1evFS4wEEPTGEFPHBog",
        X_API_SECRET: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        X_ACCESS_TOKEN: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        X_ACCESS_TOKEN_SECRET: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      1318622958,
      "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    );
    expect(header).toContain(
      'oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"',
    );
  });

  test("a platform goes live only with every one of its keys", () => {
    expect(postingModes({})).toEqual(DRY);
    expect(
      postingModes({ X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t" })
        .x,
    ).toBe("dry-run");
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
    directToday(store, "2026-10-26");
    store.startRender("2026-10-26", "job-00000001");
    createDaily({ dataDir: dir, env: {} });
    const cycle = openStore(dir).read("2026-10-26") as Cycle;
    expect(cycle.state).toBe("render-failed");
    expect(cycle.render?.error).toMatch(/app restarted/);
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

/** A stand-in for render-4090.mjs that follows the same contract. */
const STUB_RENDER = `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const at = (n) => process.argv[process.argv.indexOf("--" + n) + 1];
const hash = (b) => createHash("sha256").update(b).digest("hex");
const raw = readFileSync(at("edl"));
const edl = JSON.parse(raw);
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
  music: existsSync(__dirname + "/music-override")
    ? readFileSync(__dirname + "/music-override", "utf8")
    : (edl.music ?? "skippy"),
  ending: edl.ending, edlSha256: hash(raw),
  layout: { frame: { w: 1080, h: 1920 }, boxes: {
    board: { x: 81, y: 380, w: 918, h: 852 },
    caption: { x: 81, y: 285, w: 918, h: 60 } },
    captionText: edl.caption ? { caption: { lines: 1, width: 640 } } : {} },
  loudness: { memes: [{ key: "shotgun-2", at: 0.9, loudestAt: 0.9,
    memeLufs: -24, bedLufs: -33.7, overLU: 9.7, truePeakDbtp: -14.3 }] },
  sheet: { png: at("out") + "-sheet.png", sha256: hash(png), stills },
  timeline: {
    moves: edl.events.map((e) => ({ ply: e.ply, at: 10 })),
    events: edl.events.map((e, index) => ({ index, ply: e.ply, kind: e.kind,
      start: 10, end: 11, extra: "dropped" })),
    sounds: [{ name: "pawn", role: "move", start: 10, event: null }] } }));
`;

test("one dry-run cycle: pick, render, ask, approve, post, log", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-render.cjs");
  writeFileSync(stub, STUB_RENDER);
  const port = await freePort();
  const child = Bun.spawn(["node", SERVER, "--daily-renderer", stub], {
    env: {
      PATH: process.env.PATH!,
      PORT: String(port),
      ISOMUX_APP_DATA_DIR: dir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  stops.push(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/daily/state`);
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  const call = async <T = Cycle>(path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const day = "2026-10-26";

  // Post text is Growth's copy block, not the pick's.
  const withCaption = await call("/api/daily/pick", {
    day,
    report: REPORT,
    caption: "lmao",
  });
  expect(withCaption.status).toBe(409);
  expect(JSON.stringify(withCaption.body)).toContain(
    "pick takes no caption or title",
  );
  expect((await call("/api/daily/pick", { day, report: REPORT })).status).toBe(
    200,
  );
  expect((await call("/api/daily/post", { day })).status).toBe(409);
  // No render without the director's list.
  expect((await call("/api/daily/render", { day })).status).toBe(409);
  const direct = async (d: string, music?: string) => {
    const { suggestedEnding } = (
      await call<DailyState & { suggestedEnding: string }>(
        `/api/daily/state?day=${d}`,
      )
    ).body;
    return call("/api/daily/direct", {
      day: d,
      edl: { ...EDL, ending: suggestedEnding, ...(music ? { music } : {}) },
    });
  };
  expect(
    (
      await call("/api/daily/direct", {
        day,
        edl: { ...EDL, gameId: "OTHERGAME" },
      })
    ).status,
  ).toBe(409);
  // A sound Nil disliked on /daily/sounds is allowed, and the edit list's
  // summary (which the ask shows) names it.
  const pickSound = (choice: string) =>
    call("/api/daily/sounds", { key: "fuahhh-1", choice });
  expect((await pickSound("disliked")).status).toBe(200);
  const allowed = await direct(day, "a-legend");
  expect(allowed.status).toBe(200);
  expect(JSON.stringify(allowed.body)).toMatch(
    /ply \d+ uses disliked fuahhh-1: Nil's preference, allowed/,
  );
  expect((await pickSound("ok")).status).toBe(200);
  // A sound with a high claim risk is refused whatever Nil's level, and
  // allowed only on purpose; the summary then names it.
  const risky = (claimRiskOk?: unknown) =>
    call("/api/daily/direct", {
      day,
      edl: { ...EDL, vsSound: "win-2" },
      ...(claimRiskOk === undefined ? {} : { claimRiskOk }),
    });
  const riskRefused = await risky();
  expect(riskRefused.status).toBe(409);
  expect(JSON.stringify(riskRefused.body)).toContain(
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
    call("/api/daily/direct", { day, edl: { ...EDL, ...edl } });
  const coldOpen = await told({ coldOpenPly: 22 });
  expect(coldOpen.status).toBe(409);
  expect(JSON.stringify(coldOpen.body)).toContain(
    "coldOpenPly is cut from the daily video (Nil, 2026-10-26",
  );
  const offCounter = await told({ caption: "Ruby was 2 steps away" });
  expect(offCounter.status).toBe(409);
  expect(JSON.stringify(offCounter.body)).toContain("the caption says 2");
  const named = await told({
    caption: "can bro get home? 😭",
    payoff: { ply: 22, text: "guest tuatara got humbled" },
  });
  expect(named.status).toBe(409);
  expect(JSON.stringify(named.body)).toContain(
    "video payoff must not name the player Guest Tuatara",
  );
  const mention = await told({
    caption: "Can Ruby get home?",
    payoff: { ply: 22, text: "ask @someone" },
  });
  expect(mention.status).toBe(409);
  expect(JSON.stringify(mention.body)).toContain(
    "video payoff must not mention",
  );
  // The laugh plays on the save ply, after its zoom (Nil, 2026-10-26).
  const zoomThenLaugh = await told({
    events: [
      { ply: 22, kind: "zoom", frame: ["e4", "e5"], sound: "fuahhh-1" },
      { ply: 22, kind: "laugh", cell: "e4", sound: "laugh-2" },
    ],
  });
  expect(zoomThenLaugh.status).toBe(200);
  expect((await direct(day, "a-legend")).status).toBe(200);
  // What a restart would cut (crew.mjs ship refuses while any is busy).
  interface Busy {
    renders: { day: string; jobId: string; state: string }[];
    posting: boolean;
  }
  expect((await call<Busy>("/api/daily/busy")).body).toEqual({
    renders: [],
    posting: false,
  });
  const started = await call<{ jobId: string }>("/api/daily/render", { day });
  expect(started.status).toBe(200);
  // The queue takes the job before the POST answers; the stub is a process.
  expect((await call<Busy>("/api/daily/busy")).body).toEqual({
    renders: [{ day, jobId: started.body.jobId, state: "running" }],
    posting: false,
  });
  let state: DailyState | undefined;
  for (let i = 0; i < 50; i++) {
    state = (await call<DailyState>(`/api/daily/state?day=${day}`)).body;
    if (state.cycle.state !== "rendering") break;
    await Bun.sleep(100);
  }
  expect(state?.cycle.state).toBe("rendered");
  expect((await call<Busy>("/api/daily/busy")).body.renders).toEqual([]);
  // The renderer's timeline is kept for the event strips, without extras.
  const timeline = (
    state?.cycle.render as { timeline: { events: object[] } } | undefined
  )?.timeline;
  expect(timeline?.events[0]).toEqual({
    index: 0,
    ply: EDL.events[0].ply,
    kind: EDL.events[0].kind,
    start: 10,
    end: 11,
  });
  expect(state?.cycle.render?.effect).toBe("daily");
  expect(state?.cycle.render?.ending).toBe("replay");
  expect(state?.cycle.render?.quality?.loudness?.ok).toBe(true);
  expect(state?.cycle.render?.quality?.safeArea?.ok).toBe(true);
  const sheet = state?.cycle.render?.sheet;
  expect(sheet?.stills).toEqual([{ ply: 22, kind: "zoom", sound: "fuahhh-1" }]);
  expect(
    (
      await call("/api/daily/check", {
        day,
        sheetSha256: sheet?.sha256,
        stills: [ZOOM_OK],
      })
    ).body.state,
  ).toBe("checked");

  const videoSha256 = state?.cycle.render?.video?.sha256;
  const ask = (copySha256: string) =>
    call("/api/daily/ask", {
      day,
      askId: "ask-xyz",
      modes: DRY,
      videoSha256,
      copySha256,
    });
  // No ask before Growth's copy block.
  const noCopy = await ask(COPY_SHA);
  expect(noCopy.status).toBe(409);
  expect(JSON.stringify(noCopy.body)).toContain("crew.mjs copy");
  const copy = (body: object) =>
    call<DailyState["cycle"]>("/api/daily/copy", { day, ...body });
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
  expect(JSON.stringify(long.body)).toContain("X is over 280 in X's count");
  const stored = await copy({ text: BLOCK, copyVersion: COPY_VERSION });
  expect(stored.status).toBe(200);
  expect(stored.body.copy).toEqual(COPY);
  // The ask must show the stored block, and then the block cannot change.
  expect((await ask("0".repeat(64))).status).toBe(409);
  expect((await ask(COPY_SHA)).status).toBe(200);
  const late = await copy({ text: BLOCK, copyVersion: COPY_VERSION });
  expect(late.status).toBe(409);
  expect(JSON.stringify(late.body)).toContain("copy needs the cycle in");
  // An approval with no reply text is not evidence of one.
  expect(
    (
      await call("/api/daily/answer", {
        askId: "ask-xyz",
        decision: "approve",
        approver: "Nil",
      })
    ).status,
  ).toBe(409);
  const answered = await call("/api/daily/answer", {
    askId: "ask-xyz",
    decision: "approve",
    approver: "Nil",
    reply: "Approve",
  });
  expect(answered.body.state).toBe("approved");

  const posted = await call("/api/daily/post", { day });
  expect(posted.body.state).toBe("posted");
  expect(posted.body.posts.x.postId).toBe("DRY-RUN-POST-ID");

  const xPlan = JSON.parse(
    readFileSync(posted.body.posts.x.requestsFile, "utf8"),
  ) as { url: string; body: { text?: string } }[];
  expect(xPlan.map((r) => r.url.replace("https://api.x.com", ""))).toEqual([
    "/2/media/upload/initialize",
    "/2/media/upload/DRY-RUN-MEDIA-ID/append",
    "/2/media/upload/DRY-RUN-MEDIA-ID/finalize",
    "/2/tweets",
  ]);
  // Each platform posts the approved block's own line.
  expect(xPlan[3].body.text).toBe(COPY.x);
  const ytPlan = readFileSync(posted.body.posts.youtube.requestsFile, "utf8");
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
  const planOf = (p: string) =>
    JSON.parse(
      readFileSync(
        (posted.body.posts as Record<string, { requestsFile: string }>)[p]
          .requestsFile,
        "utf8",
      ),
    ) as { url: string; body: Record<string, unknown> | null }[];
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
  const container = planOf("threads").find((r) => r.url.endsWith("/threads"));
  expect(container?.body?.text).toBe(COPY.threads);
  // Threads: the video goes to the private R2 bucket under a random name,
  // Threads gets a signed URL, and the copy is deleted at the end.
  const threadsPlan = planOf("threads") as unknown as {
    method: string;
    url: string;
  }[];
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
  expect(planOf("mastodon").at(-1)?.body?.status).toBe(COPY.mastodon);
  // What `crew.mjs post` prints: each platform's mode and exact text.
  expect(postedTexts(posted.body)).toEqual([
    `dry-run X: ${JSON.stringify(COPY.x)}`,
    `dry-run YouTube: title ${JSON.stringify(`${COPY.youtubeTitle} #Shorts`)}, description ${JSON.stringify(COPY.youtubeDescription)}`,
    `dry-run TikTok: ${JSON.stringify(COPY.tiktok)} (not sent: Nil pastes it in the inbox draft)`,
    `dry-run Instagram: ${JSON.stringify(COPY.instagram)}`,
    `dry-run Facebook: ${JSON.stringify(COPY.facebook)}`,
    `dry-run Bluesky: ${JSON.stringify(COPY.bluesky)}`,
    `dry-run Threads: ${JSON.stringify(COPY.threads)}`,
    `dry-run Mastodon: ${JSON.stringify(COPY.mastodon)}`,
  ]);

  const log = (await call<LogRow[]>("/api/daily/post-log?dryRun=1")).body;
  expect(log.map((r) => r.platform)).toEqual([
    "x",
    "youtube",
    "tiktok",
    "instagram",
    "facebook",
    "bluesky",
    "threads",
    "mastodon",
  ]);
  // Each row names the on-video caption style and Growth's copy style.
  expect(log.map((r) => r.styleVersion)).toEqual(
    log.map(() => CAPTION_STYLE_VERSION),
  );
  expect(log.map((r) => r.copyVersion)).toEqual(log.map(() => COPY_VERSION));
  expect(log.map((r) => r.caption)).toEqual([
    COPY.x,
    `${COPY.youtubeTitle} #Shorts\n\n${COPY.youtubeDescription}`,
    COPY.tiktok,
    COPY.instagram,
    COPY.facebook,
    COPY.bluesky,
    COPY.threads,
    COPY.mastodon,
  ]);
  // TikTok: a draft in Nil's inbox, one chunk, no caption in the API.
  expect(posted.body.posts.tiktok.postId).toBe("DRY-RUN-PUBLISH-ID");
  const tiktokPlan = JSON.parse(
    readFileSync(posted.body.posts.tiktok.requestsFile, "utf8"),
  ) as {
    method: string;
    url: string;
    body: unknown;
    headers: Record<string, string>;
  }[];
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
  const instagramPlan = JSON.parse(
    readFileSync(posted.body.posts.instagram.requestsFile, "utf8"),
  ) as {
    method: string;
    url: string;
    body: unknown;
    headers: Record<string, string>;
  }[];
  // The Page and its Instagram account come from the one Meta secret first.
  expect(instagramPlan.map((r) => `${r.method} ${r.url}`)).toEqual([
    "GET https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token",
    "GET https://graph.facebook.com/v26.0/DRY-RUN-PAGE-ID?fields=instagram_business_account",
    "POST https://graph.facebook.com/v26.0/DRY-RUN-IG-USER-ID/media",
    "POST https://rupload.facebook.com/ig-api-upload/v26.0/DRY-RUN-CONTAINER",
    "GET https://graph.facebook.com/v26.0/DRY-RUN-CONTAINER?fields=status_code",
    "POST https://graph.facebook.com/v26.0/DRY-RUN-IG-USER-ID/media_publish",
    "GET https://graph.facebook.com/v26.0/DRY-RUN-MEDIA-ID?fields=permalink",
  ]);
  expect(instagramPlan[2].body).toEqual({
    media_type: "REELS",
    upload_type: "resumable",
    caption: COPY.instagram,
  });
  expect(instagramPlan[3].headers.file_size).toBe(
    String((instagramPlan[3].body as { bytes: number }).bytes),
  );
  // Discovery uses the system user token; the post uses the Page token.
  expect(instagramPlan[0].headers.authorization).toBe(
    "Bearer <META_SYSTEM_USER_TOKEN>",
  );
  expect(instagramPlan[2].headers.authorization).toBe(
    "Bearer <Page token from /me/accounts>",
  );
  expect(log[3]).toMatchObject({
    platform: "instagram",
    postId: "DRY-RUN-MEDIA-ID",
    url: "https://www.instagram.com/reel/DRY-RUN/",
  });
  expect(log[0]).toMatchObject({
    gameId: "TESTGAME1",
    mode: "dry-run",
    approver: "Nil",
    effect: "daily",
    ending: "replay",
    music: "a-legend",
    sound: "shotgun",
    swingMove: 23,
  });
  expect((await call<LogRow[]>("/api/daily/post-log")).body).toEqual([]);

  // Posting again posts nothing: both platforms are done.
  expect((await call("/api/daily/post", { day })).status).toBe(409);

  // The next day's default reads the log and is the next ending.
  const next = "2026-10-27";
  await call("/api/daily/pick", {
    day: next,
    report: REPORT,
  });
  // The director sees the last posted track, to pick another.
  expect(
    (await call<{ lastMusic: string }>(`/api/daily/state?day=${next}`)).body
      .lastMusic,
  ).toBe("a-legend");
  await direct(next);
  await call("/api/daily/render", { day: next });
  for (let i = 0; i < 50; i++) {
    state = (await call<DailyState>(`/api/daily/state?day=${next}`)).body;
    if (state.cycle.state !== "rendering") break;
    await Bun.sleep(100);
  }
  expect(state?.cycle.state).toBe("rendered");
  expect(state?.cycle.render?.ending).toBe("gg");

  // Day 2 is not answered yet when day 3 is directed: its ending is taken too.
  const third = "2026-10-28";
  await call("/api/daily/pick", {
    day: third,
    report: REPORT,
  });
  // A list with no event has no still to check, so it is refused.
  expect(
    (
      await call("/api/daily/direct", {
        day: third,
        edl: {
          ...EDL,
          events: [],
        },
      })
    ).status,
  ).toBe(409);
  // The most events edl.mjs allows: 40 stills come back whole.
  const { suggestedEnding } = (
    await call<{ suggestedEnding: string }>(`/api/daily/state?day=${third}`)
  ).body;
  expect(
    (
      await call("/api/daily/direct", {
        day: third,
        edl: {
          ...EDL,
          ending: suggestedEnding,
          events: Array.from({ length: 40 }, (_, ply) => ({
            ply,
            kind: "zoom",
            frame: ["e4"],
            sound: "fuahhh-1",
          })),
        },
      })
    ).status,
  ).toBe(200);
  await call("/api/daily/render", { day: third });
  for (let i = 0; i < 50; i++) {
    state = (await call<DailyState>(`/api/daily/state?day=${third}`)).body;
    if (state.cycle.state !== "rendering") break;
    await Bun.sleep(100);
  }
  expect(state?.cycle.render?.ending).toBe("ko");
  expect(state?.cycle.render?.sheet?.stills).toHaveLength(40);
  // Day 2 waits for its ask, so its track is the last one, not day 1's.
  // (Day 2's list named none: the stub played its stand-in.)
  expect(
    (await call<{ lastMusic: string }>(`/api/daily/state?day=${third}`)).body
      .lastMusic,
  ).toBe("skippy");

  // The music the video played must be the one the list named, and a
  // track the site has.
  const fourth = "2026-10-29";
  const renderWith = async (played: string, force = false) => {
    writeFileSync(join(dir, "music-override"), played);
    await call("/api/daily/render", { day: fourth, force });
    for (let i = 0; i < 50; i++) {
      state = (await call<DailyState>(`/api/daily/state?day=${fourth}`)).body;
      if (state.cycle.state !== "rendering") break;
      await Bun.sleep(100);
    }
  };
  await call("/api/daily/pick", {
    day: fourth,
    report: REPORT,
  });
  await direct(fourth, "a-legend");
  await renderWith("tea-for-two");
  expect(state?.cycle.state).toBe("render-failed");
  expect(state?.cycle.render?.error).toMatch(/music tea-for-two, not a-legend/);
  await direct(fourth);
  await renderWith("elevator-jazz", true);
  expect(state?.cycle.render?.error).toMatch(/music elevator-jazz/);
}, 20_000);

/** A stand-in for render-4090.mjs --has-capture and --plies. */
const STUB_PREVIEW = `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const at = (n) => process.argv[process.argv.indexOf("--" + n) + 1];
const hash = (b) => createHash("sha256").update(b).digest("hex");
if (process.argv.includes("--has-capture")) {
  if (existsSync(__dirname + "/no-capture")) {
    console.error("the 4090 has no capture of game " + at("has-capture") + " yet");
    process.exit(1);
  }
  console.log("cached");
  process.exit(0);
}
const edl = JSON.parse(readFileSync(at("edl"), "utf8"));
writeFileSync(__dirname + "/last-plies", at("plies") + " " + edl.events.length);
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
  "-c:v", "mpeg4", at("out")]);
const bytes = readFileSync(at("out"));
const [from, to] = at("plies").split("..").map(Number);
console.log("RESULT " + JSON.stringify({ mp4: at("out"), bytes: bytes.length,
  sha256: hash(bytes), durationSeconds: 1, fromCache: true,
  preview: { from, to }, edlSha256: null, sheet: null }));
`;

test("a preview: a few plies from the capture, and the cycle does not change", async () => {
  const dir = tempDir();
  const stub = join(dir, "stub-preview.cjs");
  writeFileSync(stub, STUB_PREVIEW);
  const port = await freePort();
  const child = Bun.spawn(["node", SERVER, "--daily-renderer", stub], {
    env: {
      PATH: process.env.PATH!,
      PORT: String(port),
      ISOMUX_APP_DATA_DIR: dir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  stops.push(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/daily/state`);
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  const call = async <T = { error: string }>(path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  interface Preview {
    previewId: string;
    plies: string;
    state: string;
    video: { path: string; bytes: number } | null;
    error: string | null;
  }
  const finished = async (body: unknown) => {
    const started = await call<{ previewId: string }>(
      "/api/daily/preview",
      body,
    );
    expect(started.status).toBe(200);
    for (let i = 0; i < 100; i++) {
      const p = await call<Preview>(
        `/api/daily/preview?id=${started.body.previewId}`,
      );
      if (["done", "failed"].includes(p.body.state)) return p.body;
      await Bun.sleep(100);
    }
    throw new Error("the preview did not end");
  };
  const day = "2026-10-26";
  await call("/api/daily/pick", { day, report: REPORT });

  // No list to preview before direct, unless the call brings one.
  const early = await call("/api/daily/preview", { day, plies: "20..23" });
  expect(early.status).toBe(409);
  expect(early.body.error).toContain("has no edit list yet");
  const otherGame = await call("/api/daily/preview", {
    day,
    plies: "20..23",
    edl: { ...EDL, gameId: "OTHERGAME" },
  });
  expect(otherGame.status).toBe(409);
  expect(otherGame.body.error).toContain("the day's game is TESTGAME1");

  const { suggestedEnding } = (
    await call<{ suggestedEnding: string }>(`/api/daily/state?day=${day}`)
  ).body;
  await call("/api/daily/direct", {
    day,
    edl: { ...EDL, ending: suggestedEnding },
  });
  // The window is checked here, not after the 4090 starts.
  const pastEnd = await call("/api/daily/preview", { day, plies: "38..41" });
  expect(pastEnd.status).toBe(409);
  expect(pastEnd.body.error).toContain("after the game's last ply 40");
  expect((await call("/api/daily/preview", { day, plies: "22" })).status).toBe(
    409,
  );

  // A game with no capture on the 4090 is refused before a job exists.
  writeFileSync(join(dir, "no-capture"), "");
  const refused = await call("/api/daily/preview", { day, plies: "20..23" });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain("has no capture of game TESTGAME1");
  expect(
    (await call<{ renders: unknown[] }>("/api/daily/busy")).body.renders,
  ).toEqual([]);
  expect(existsSync(join(dir, "last-plies"))).toBe(false);
  unlinkSync(join(dir, "no-capture"));

  const before = (await call(`/api/daily/state?day=${day}`)).body;
  const shown = await finished({ day, plies: "20..23" });
  expect(shown.state).toBe("done");
  expect(shown.plies).toBe("20..23");
  expect(shown.video!.path).toBe(
    join(dir, "daily", "previews", `${shown.previewId}.mp4`),
  );
  expect(readFileSync(shown.video!.path).length).toBe(shown.video!.bytes);
  // A list given with the call is previewed as given.
  const given = await finished({
    day,
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
  const crew = Bun.spawnSync(
    [
      "node",
      resolve(import.meta.dir, "crew.mjs"),
      "preview",
      "--day",
      day,
      "--plies",
      "21..22",
      "--app",
      base,
    ],
    { env: { PATH: process.env.PATH! } },
  );
  expect(crew.exitCode).toBe(0);
  expect(crew.stdout.toString()).toMatch(
    /preview of plies 21\.\.22: .*\/previews\/.*\.mp4 \(1 s, 0\.0 MB\)\. Not the day's video/,
  );
  // Nothing in the cycle moved: the previews are not the day's video.
  expect((await call(`/api/daily/state?day=${day}`)).body).toEqual(before);
  expect((await call("/api/daily/preview?id=nope")).status).toBe(404);
  // A file step that throws ends the preview as failed, not running.
  rmSync(join(dir, "daily", "previews"), { recursive: true });
  const lost = await finished({ day, plies: "20..23" });
  expect(lost.state).toBe("failed");
  expect(lost.error).toContain("the preview step failed: ENOENT");
}, 30_000);

test("a new app start removes the previews that the last one forgot", () => {
  const dir = tempDir();
  const old = join(createDaily({ dataDir: dir }).store.dirs.root, "previews");
  writeFileSync(join(old, "2026-10-26-TESTGAME1-pold.mp4"), "x");
  createDaily({ dataDir: dir });
  expect(readdirSync(old)).toEqual([]);
});
