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
  YOUTUBE_LINK,
} from "./candidate.mjs";
import type { DescribedCloseCall, PickedJump } from "../daily-candidates";
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
  } | null;
  posts: Record<string, { postId: string; requestsFile: string }>;
}

interface DailyState {
  cycle: Cycle;
}

interface LogRow {
  platform: string;
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

/** Walk a cycle to "checked" (ready to ask) for this video. */
const checkedToday = (
  store: ReturnType<typeof openStore>,
  day: string,
  video: { path: string; bytes: number; sha256: string },
) => {
  directToday(store, day);
  store.startRender(day, "job-00000001");
  store.finishRender(day, "job-00000001", { video, sheet: SHEET });
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
  const rendered = () => {
    const store = openStore(tempDir());
    directToday(store, day);
    store.startRender(day, "job-00000001");
    store.finishRender(day, "job-00000001", { video, sheet: SHEET });
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
    expect(c.facts[0]).toBe(`Move 10: ${CLOSE_CALL.description}`);
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
const { createHash } = require("node:crypto");
const at = (n) => process.argv[process.argv.indexOf("--" + n) + 1];
const hash = (b) => createHash("sha256").update(b).digest("hex");
const raw = readFileSync(at("edl"));
const edl = JSON.parse(raw);
const bytes = Buffer.from("fake mp4 for " + edl.gameId + " " + at("job-id"));
writeFileSync(at("out"), bytes);
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
  expect((await direct(day, "a-legend")).status).toBe(200);
  expect((await call("/api/daily/render", { day })).status).toBe(200);
  let state: DailyState | undefined;
  for (let i = 0; i < 50; i++) {
    state = (await call<DailyState>(`/api/daily/state?day=${day}`)).body;
    if (state.cycle.state !== "rendering") break;
    await Bun.sleep(100);
  }
  expect(state?.cycle.state).toBe("rendered");
  expect(state?.cycle.render?.effect).toBe("daily");
  expect(state?.cycle.render?.ending).toBe("replay");
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
