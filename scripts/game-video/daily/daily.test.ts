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
  YOUTUBE_LINK,
} from "./candidate.mjs";
import type { PickedJump } from "../daily-candidates";
import { oauth1Header, xDryRunReply } from "./post-x.mjs";
import { youtubeDryRunReply } from "./post-youtube.mjs";
import { sha256 } from "./transport.mjs";
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
  description: `Guest Tuatara's wall makes Ruby walk ${after - before} extra squares (${before} to ${after}).`,
});

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

const pickToday = (store: ReturnType<typeof openStore>, day: string): void => {
  const candidate = candidateFromReport(REPORT, 1);
  store.pick(day, {
    candidate,
    caption: captionFrom(CAPTION),
    style: "daily",
  });
};

const DRY = { x: "dry-run", youtube: "dry-run" };

/** Walk a cycle to "approved" for a video with this hash. */
const approved = (
  store: ReturnType<typeof openStore>,
  day: string,
  sha = "aa",
) => {
  pickToday(store, day);
  store.startRender(day, "job-00000001");
  store.finishRender(day, "job-00000001", {
    video: { path: "/nowhere.mp4", bytes: 1, sha256: sha },
    effect: "zoom",
    sound: "shotgun",
  });
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
    pickToday(store, day);
    store.startRender(day, "job-00000001");
    store.finishRender(day, "job-00000001", {
      video: { path: "/x", bytes: 1, sha256: "aa" },
    });
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
        currentModes: { x: "live", youtube: "dry-run" },
      });
    }).toThrow(/the ask says x dry-run, but the app would post live/);
  });
});

describe("a post that may exist is not posted again", () => {
  test("a lost reply to the final X request blocks a retry until a person confirms", async () => {
    const dir = tempDir();
    const video = join(dir, "v.mp4");
    writeFileSync(video, "bytes");
    const day = "2026-10-26";
    const store = openStore(dir);
    pickToday(store, day);
    store.startRender(day, "job-00000001");
    store.finishRender(day, "job-00000001", {
      video: { path: video, bytes: 5, sha256: sha256(readFileSync(video)) },
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
    pickToday(store, day);
    store.startRender(day, "job-00000001");
    store.finishRender(day, "job-00000001", {
      video: { path: "/x.mp4", bytes: 1, sha256: "aa" },
    });
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
        modes: { x: "live", youtube: "dry-run" },
        videoSha256: "aa",
      }),
    ).toThrow(/approval was for dry-run/);
  });

  test("once the ask is open, the candidate cannot be swapped under it", () => {
    const store = openStore(tempDir());
    pickToday(store, day);
    store.startRender(day, "job-00000001");
    store.finishRender(day, "job-00000001", {
      video: { path: "/x", bytes: 1, sha256: "aa" },
    });
    store.recordAsk(day, {
      askId: "ask1",
      modes: DRY,
      videoSha256: (store.read(day) as Cycle).render?.video?.sha256,
      currentModes: DRY,
    });
    expect(() => pickToday(store, day)).toThrow(/pick needs/);
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
    ]);
    expect(readPostLog(store.postLog.dryRun)).toHaveLength(1);
    expect(existsSync(store.postLog.live)).toBe(false);
  });
});

describe("each render is one production view", () => {
  test("a second render of the same game needs force, also after a re-pick", () => {
    const store = openStore(tempDir());
    const day = "2026-10-26";
    pickToday(store, day);
    store.startRender(day, "job-00000001");
    store.finishRender(day, "job-00000001", { error: "boom" });
    pickToday(store, day);
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
    ).toEqual({ x: "dry-run", youtube: "live" });
  });
});

describe("the render step", () => {
  test("only the last RESULT line counts", () => {
    expect(parseResult('noise\nRESULT {"mp4":"/a"}\n')).toEqual({ mp4: "/a" });
    expect(parseResult("RESULT {broken\n")).toBeNull();
    expect(parseResult("no result")).toBeNull();
  });

  test("a render cut off by an app restart is closed, not left stuck", () => {
    const dir = tempDir();
    const store = openStore(dir);
    pickToday(store, "2026-10-26");
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
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const at = (n) => process.argv[process.argv.indexOf("--" + n) + 1];
const job = JSON.parse(readFileSync(at("job"), "utf8"));
const bytes = Buffer.from("fake mp4 for " + job.gameId + " " + job.caption);
writeFileSync(at("out"), bytes);
console.log("[render] rendering on the 4090");
console.log("RESULT " + JSON.stringify({ mp4: at("out"), bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), durationSeconds: 30,
  effect: "zoom-" + job.style, sound: "shotgun" }));
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
  expect((await call("/api/daily/render", { day })).status).toBe(200);
  let state: DailyState | undefined;
  for (let i = 0; i < 50; i++) {
    state = (await call<DailyState>(`/api/daily/state?day=${day}`)).body;
    if (state.cycle.state !== "rendering") break;
    await Bun.sleep(100);
  }
  expect(state?.cycle.state).toBe("rendered");
  expect(state?.cycle.render?.effect).toBe("zoom-daily");

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
  expect(log.map((r) => r.platform)).toEqual(["x", "youtube"]);
  expect(log[0]).toMatchObject({
    gameId: "TESTGAME1",
    mode: "dry-run",
    approver: "Nil",
    effect: "zoom-daily",
    sound: "shotgun",
    swingMove: 23,
  });
  expect((await call<LogRow[]>("/api/daily/post-log")).body).toEqual([]);

  // Posting again posts nothing: both platforms are done.
  expect((await call("/api/daily/post", { day })).status).toBe(409);
}, 20_000);
