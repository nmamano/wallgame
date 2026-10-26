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
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStore, readPostLog } from "./store.mjs";
import {
  candidateFromReport,
  captionProblems,
  captionFrom,
  nextEnding,
  edlSummary,
  saveFrameProblems,
  storyProblems,
  playerNames,
  CAPTION_STYLE_VERSION,
  textProblems,
  YOUTUBE_LINK,
} from "./candidate.mjs";
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
  tokenStore,
  DRY_RUN_TIKTOK,
  TIKTOK_TOKEN_URL,
} from "./post-tiktok.mjs";
import {
  instagramDryRunReply,
  postToInstagram,
  DRY_RUN_INSTAGRAM,
} from "./post-instagram.mjs";
import {
  dryRunTransport,
  NotPosted,
  PostFailed,
  sha256,
} from "./transport.mjs";
import { askText } from "./crew.mjs";
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

const CAPTION = "lmao Ruby thought it could just walk home";

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
  caption: { x: string };
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
  styleVersion: string | null;
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
    caption: captionFrom(CAPTION),
    style: "daily",
    styleVersion: CAPTION_STYLE_VERSION,
    replace,
  });
};

const DRY = {
  x: "dry-run",
  youtube: "dry-run",
  tiktok: "dry-run",
  instagram: "dry-run",
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
  video: { path: string; bytes: number; sha256: string },
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
    currentModes: DRY,
  });
  store.recordAnswer(day, {
    askId: "ask1",
    decision: "approve",
    approver: "Nil",
    reply: "Approve",
  });
};

describe("an ask opened again for the right member", () => {
  const day = "2026-10-26";
  const asked = () => {
    const store = openStore(tempDir());
    checkedToday(store, day, { path: "/x", bytes: 1, sha256: "aa" });
    store.recordAsk(day, {
      askId: "old",
      modes: DRY,
      videoSha256: "aa",
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

  test("an ask that showed another video is refused", () => {
    expect(() => {
      rendered().recordAsk(day, {
        askId: "a",
        modes: DRY,
        videoSha256: "bb",
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
    });
    store.recordAsk(day, {
      askId: "a",
      modes: DRY,
      videoSha256: sha256(readFileSync(video)),
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
        instagram: instagramDryRunReply,
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

describe("captions", () => {
  test("the crew lead's caption goes out as is on X, and above the tracked link on YouTube", () => {
    const caption = captionFrom(CAPTION);
    expect(captionProblems(caption, "TESTGAME1")).toEqual([]);
    expect(caption.x).toBe(CAPTION);
    expect(caption.youtubeTitle).toBe(`${CAPTION} #Shorts`);
    expect(caption.youtubeDescription).toBe(
      `${CAPTION}\n\nPlay Wall Game: ${YOUTUBE_LINK}`,
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

  test("a long title loses the end of its teaser, never its hashtags", () => {
    const tags = "#wallgame #gaming #boardgames";
    const teaser =
      "bro really thought the bot would never find the one gap in his wall and then it walked right through it";
    const { youtubeTitle } = captionFrom(CAPTION, `${teaser} ${tags}`);
    expect(youtubeTitle).toBe(
      `bro really thought the bot would never find the one gap in\u2026 ${tags} #Shorts`,
    );
    expect([...youtubeTitle].length).toBeLessThanOrEqual(100);
    // A #Shorts that the crew lead wrote is not doubled.
    expect(captionFrom(CAPTION, "bro... #wallgame #Shorts").youtubeTitle).toBe(
      "bro... #wallgame #Shorts",
    );
    // Hashtags that cannot fit are refused, not cut.
    const tooMany = captionFrom(
      CAPTION,
      `bro ${Array.from({ length: 12 }, (_, i) => `#boardgames${i}`).join(" ")}`,
    );
    expect(captionProblems(tooMany, "TESTGAME1")).toContain(
      "YouTube title is over 100 characters",
    );
  });

  test("no game id in anything posted", () => {
    expect(
      captionProblems(captionFrom("see testgame1 lol"), "TESTGAME1"),
    ).toEqual([
      "x must not hold the game id",
      "youtubeTitle must not hold the game id",
      "youtubeDescription must not hold the game id",
    ]);
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
    const problems = captionProblems(
      captionFrom("@ruby you ok? <3"),
      "TESTGAME1",
    );
    expect(problems).toContain("x must not mention anyone (@)");
    expect(problems).toContain("youtubeTitle must not hold < or >");
    // An address-like @ inside a word is not a mention.
    expect(captionProblems(captionFrom("ruby@home"), "TESTGAME1")).toEqual([]);
  });

  test("a player is bro, never a name; the bot can be named; no #wallz", () => {
    const players = playerNames(candidateFromReport(REPORT, 1));
    expect(players).toEqual(["Guest Tuatara"]);
    const problems = captionProblems(
      captionFrom(
        "guest tuatara walled himself in 😭🙏",
        "ruby got humbled... #wallz",
      ),
      "TESTGAME1",
      players,
    );
    expect(problems).toContain(
      "x must not name the player Guest Tuatara: say bro",
    );
    expect(problems).toContain("youtubeTitle must not hold #wallz");
    expect(
      captionProblems(
        captionFrom(
          "bro walled himself in 😭🙏 #wallgame",
          "ruby did not miss... #wallgame #gaming #boardgames",
        ),
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
    const caption = captionFrom(CAPTION);
    expect(captionProblems({ ...caption, x: "play at wallgame.io" })).toContain(
      "X text must not hold a link",
    );
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
  test("a rotated refresh token is kept, and a new secret starts a new chain", () => {
    const dir = tempDir();
    expect(tokenStore(dir, "seed-1").current()).toBe("seed-1");
    tokenStore(dir, "seed-1").save("rotated-1");
    expect(tokenStore(dir, "seed-1").current()).toBe("rotated-1");
    // Nil set a new secret: it wins over the kept token of the old one.
    expect(tokenStore(dir, "seed-2").current()).toBe("seed-2");
  });

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

  test("the ask shows the TikTok caption on its own line only when live", () => {
    const c = {
      day: "2026-10-26",
      caption: {
        x: "Red walls in Blue",
        youtubeTitle: "t",
        youtubeDescription: "d",
      },
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
      { x: "live", youtube: "live", tiktok: "live", instagram: "live" },
      "0".repeat(64),
    ).split("\n");
    const at = live.indexOf("TikTok caption:");
    expect(live.slice(at, at + 3)).toEqual([
      "TikTok caption:",
      "Red walls in Blue",
      "Open the TikTok inbox draft, paste, tap Post.",
    ]);
    const dry = askText(
      c,
      { x: "live", youtube: "live", tiktok: "dry-run", instagram: "live" },
      "0".repeat(64),
    );
    expect(dry).toContain("TikTok: dry run, no draft.");
    expect(dry).not.toContain("TikTok caption:");
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
      creds: DRY_RUN_INSTAGRAM,
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
    expect(
      postingModes({
        YOUTUBE_CLIENT_ID: "a",
        YOUTUBE_CLIENT_SECRET: "b",
        YOUTUBE_REFRESH_TOKEN: "c",
      }),
    ).toEqual({
      x: "dry-run",
      youtube: "live",
      tiktok: "dry-run",
      instagram: "dry-run",
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
    createDaily({ dataDir: dir });
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
  sheet: { png: at("out") + "-sheet.png", sha256: hash(png), stills } }));
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

  expect((await call("/api/daily/pick", { day, report: REPORT })).status).toBe(
    409,
  );
  expect(
    (await call("/api/daily/pick", { day, report: REPORT, caption: CAPTION }))
      .status,
  ).toBe(200);
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
  // A sound Nil dropped on /daily/sounds is refused, and no longer once the
  // choice is cleared.
  const pickSound = (choice: string | null) =>
    call("/api/daily/sounds", { key: "fuahhh-1", choice });
  expect((await pickSound("drop")).status).toBe(200);
  const refused = await direct(day, "a-legend");
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.body)).toContain("dropped the sound fuahhh-1");
  expect((await pickSound(null)).status).toBe(200);
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
  expect(
    (
      await call("/api/daily/ask", {
        day,
        askId: "ask-xyz",
        modes: DRY,
        videoSha256,
      })
    ).status,
  ).toBe(200);
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
  expect(xPlan[3].body.text).toBe(state?.cycle.caption.x);
  const ytPlan = readFileSync(posted.body.posts.youtube.requestsFile, "utf8");
  expect(ytPlan).toContain(
    "utm_source=youtube&utm_medium=social&utm_campaign=daily-video",
  );
  // The form is shown as it goes on the wire, URL-encoded, naming the secret.
  expect(ytPlan).toContain("refresh_token=%3CYOUTUBE_REFRESH_TOKEN%3E");

  const log = (await call<LogRow[]>("/api/daily/post-log?dryRun=1")).body;
  expect(log.map((r) => r.platform)).toEqual([
    "x",
    "youtube",
    "tiktok",
    "instagram",
  ]);
  // Each row names the caption style its caption was written under.
  expect(log.map((r) => r.styleVersion)).toEqual(
    log.map(() => CAPTION_STYLE_VERSION),
  );
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
    caption: state?.cycle.caption.x,
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
  expect(instagramPlan.map((r) => `${r.method} ${r.url}`)).toEqual([
    "POST https://graph.facebook.com/v26.0/<INSTAGRAM_USER_ID>/media",
    "POST https://rupload.facebook.com/ig-api-upload/v26.0/DRY-RUN-CONTAINER",
    "GET https://graph.facebook.com/v26.0/DRY-RUN-CONTAINER?fields=status_code",
    "POST https://graph.facebook.com/v26.0/<INSTAGRAM_USER_ID>/media_publish",
    "GET https://graph.facebook.com/v26.0/DRY-RUN-MEDIA-ID?fields=permalink",
  ]);
  expect(instagramPlan[0].body).toEqual({
    media_type: "REELS",
    upload_type: "resumable",
    caption: state?.cycle.caption.x,
  });
  expect(instagramPlan[1].headers.file_size).toBe(
    String((instagramPlan[1].body as { bytes: number }).bytes),
  );
  expect(log[3]).toMatchObject({
    platform: "instagram",
    caption: state?.cycle.caption.x,
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
    caption: CAPTION,
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
    caption: CAPTION,
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
    caption: CAPTION,
  });
  await direct(fourth, "a-legend");
  await renderWith("tea-for-two");
  expect(state?.cycle.state).toBe("render-failed");
  expect(state?.cycle.render?.error).toMatch(/music tea-for-two, not a-legend/);
  await direct(fourth);
  await renderWith("elevator-jazz", true);
  expect(state?.cycle.render?.error).toMatch(/music elevator-jazz/);
}, 20_000);
