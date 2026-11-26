/**
 * The special item (store.mjs ITEM_KINDS; Wall Game PM, 2026-11-26, the
 * billboard one-off): a video made outside the renderer, tied to the game
 * of a posted item. It skips only the one-post-of-a-game rule; its script
 * review gates its video, and its own vet gates its review.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  copyHeldReason,
  copySha256,
  parseCopy,
  puzzleLink,
  trackedLink,
  YOUTUBE_LINK,
} from "./copy.mjs";
import {
  blockedMusic,
  ITEM_VERSION,
  isSpecial,
  PLATFORMS,
  openStore,
  readPostLog,
  reviewState,
  stage,
} from "./store.mjs";
import { createDaily, logRow } from "./routes.mjs";
import { reviewView } from "./review.mjs";
import { specialVetPrompt, vetChecks } from "./script.mjs";
import { REVIEWER_MEMBER_ID } from "./review.mjs";
import { testTmp } from "../test-tmp";

const TEST_TMP = testTmp();
const DAILIES: { stop: () => void }[] = [];
afterAll(() => DAILIES.forEach((d) => d.stop()));

type Store = ReturnType<typeof openStore>;

interface Item {
  id: string;
  kind?: string;
  state: string;
  gameId: string;
  source: Record<string, string>;
  candidate: { gameId: string };
  render: {
    requestedAt: string;
    edlSha256: string | null;
    music: unknown[];
    sheet: null;
    video: {
      path: string;
      bytes: number;
      sha256: string;
      durationSeconds: number;
    };
    sources: { file: string; sha256: string; text: string };
    scriptReview: { at: string; scriptSha256: string };
  } | null;
  reviews: { action: string; notes: string; at: string }[];
  scriptReviews: { at: string; verdict: string; reviewer: string }[];
  events: { what: string }[];
}

const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

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

const POSTED = "v-2026-11-01-1";
/** The music the posted video played, which its composite keeps. */
const POSTED_MUSIC = [{ fromPly: 0, track: "deja-vus", at: 0 }];
const GAME = "GAME1";

/** The special item's script: the story and the vet's checks. */
const SCRIPT = [
  "SCRIPT special | game GAME1 | the posted video on a billboard",
  "",
  "BEATS",
  "0 s | the square at night | - | -",
  "",
  "VET CHECKS",
  "- the screen's four corners hold on the building in every frame",
  "- the clip reads on the screen: the board and the four pawns",
  '- the reveal card "this never happened" shows 2.4 s',
  "",
  "CHECKLIST",
  "- [x] the credit names the photo",
].join("\n");

const scriptPass = (script = SCRIPT) => ({
  script,
  reviewer: "a fresh Video Script Reviewer",
  verdict: "pass",
  notes: "the story holds\nVERDICT: pass",
});

/** A short real MP4 (ffprobe reads its length): 4 s (a Story takes 3 s at least), 108x192. */
const mp4 = (dir: string, name = "billboard.mp4", seconds = 4) => {
  const path = join(dir, name);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=108x192:rate=30:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  return path;
};

/**
 * A data dir with the posted item POSTED of GAME (a game item, as items
 * before kinds are: no kind field), and the files of a special video.
 */
const withPosted = () => {
  const dir = TEST_TMP.dir("daily-special-test-");
  const store = openStore(dir);
  const path = join(store.dirs.videos, `${POSTED}.mp4`);
  writeFileSync(path, "posted video");
  const video = sha("posted video");
  const posted = {
    version: ITEM_VERSION,
    id: POSTED,
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-02T09:00:00.000Z",
    gameId: GAME,
    source: { report: null, reportCreatedAt: null, gameId: GAME },
    candidate: {
      gameId: GAME,
      seats: [
        { playerOrder: 1, kind: "guest", name: "Guest Tuatara" },
        { playerOrder: 2, kind: "official bot", name: "Ruby" },
      ],
      picks: [{ size: 4, moveNumber: 9 }],
    },
    style: "daily",
    styleVersion: "caption-1",
    edl: { sha256: "edl1", doc: { events: [] }, text: "{}", summary: [] },
    render: {
      jobId: "j1",
      finishedAt: "2026-11-01T09:00:00.000Z",
      error: null,
      video: { path, bytes: 12, sha256: video, durationSeconds: 20 },
      music: POSTED_MUSIC,
    },
    check: { ok: true, verdicts: [] },
    caption: null,
    payoff: null,
    copy: {
      block: COPY,
      sha256: copySha256(COPY),
      forVideoSha256: video,
      storedAt: "2026-11-01T09:10:00.000Z",
    },
    state: "posted",
    reviews: [],
    approval: {
      videoSha256: video,
      copySha256: copySha256(COPY),
      by: "Nil",
      at: "2026-11-01T10:00:00.000Z",
    },
    posts: {},
    events: [],
  };
  writeFileSync(
    join(store.dirs.items, `${POSTED}.json`),
    JSON.stringify(posted),
  );
  const files = TEST_TMP.dir("daily-special-files-");
  const sources = join(files, "sources.txt");
  writeFileSync(
    sources,
    "clip: v-2026-11-01-1's posted video\nphoto: Times Square, CC BY 2.0\n",
  );
  return { dir, store, files, sources, video: mp4(files) };
};

/** A new special item of POSTED (store.pickSpecial). */
const pickSpecial = (store: Store) =>
  store.pickSpecial(POSTED) as unknown as Item;

/** A special item of POSTED whose script passed; its id. */
const scripted = (store: Store) => {
  const id = pickSpecial(store).id;
  store.recordScriptReview(id, scriptPass());
  return id;
};

describe("a special item comes from a posted item", () => {
  test("pickSpecial: a draft of the posted item's game, kind special; a game item has its kind too", () => {
    const { store } = withPosted();
    const it = pickSpecial(store);
    expect(it).toMatchObject({
      kind: "special",
      state: "draft",
      gameId: GAME,
      source: { specialFrom: POSTED },
      candidate: { gameId: GAME },
      render: null,
    });
    expect(isSpecial(it)).toBe(true);
    expect(stage(it)).toBe("picked");
    // An item from before kinds is a game item.
    expect(isSpecial(store.item(POSTED))).toBe(false);
  });

  test("only from an item that is posted", () => {
    const { store } = withPosted();
    const it = store.item(POSTED) as Item;
    for (const state of ["approved", "finished", "discarded", "post-failed"]) {
      writeFileSync(
        join(store.dirs.items, `${POSTED}.json`),
        JSON.stringify({ ...it, state }),
      );
      expect(() => {
        store.pickSpecial(POSTED);
      }).toThrow(
        `${POSTED} is ${state}: a special item shows a posted video, so it comes from an item that is posted`,
      );
    }
    expect(() => {
      store.pickSpecial("v-2026-11-01-9");
    }).toThrow("there is no item v-2026-11-01-9");
  });

  test("a game pick of the posted game is still refused, and a special one is not", () => {
    const { store } = withPosted();
    const candidate = (store.item(POSTED) as Item).candidate;
    expect(() => {
      store.pick({
        candidate,
        style: "daily",
        styleVersion: "caption-1",
        source: { report: null, reportCreatedAt: null, gameId: GAME },
      });
    }).toThrow(`another video of ${GAME} is posted (${POSTED})`);
    expect(pickSpecial(store).kind).toBe("special");
  });
});

describe("its video comes after its script review passes", () => {
  test("no video with no script review, or after a failed one", () => {
    const { store, video, sources } = withPosted();
    const id = pickSpecial(store).id;
    expect(() => {
      store.attachSpecial(id, { video, sources });
    }).toThrow(
      `${id} has no script review: write the script, get it reviewed and record the verdict (crew.mjs script-review) before the video comes in`,
    );
    store.recordScriptReview(id, {
      ...scriptPass(),
      verdict: "fail",
      notes: "the reveal comes too late",
    });
    expect(() => {
      store.attachSpecial(id, { video, sources });
    }).toThrow(`${id}'s latest script review failed`);
    expect((store.item(id) as Item).render).toBeNull();
  });

  test("a script review passes only with a VET CHECKS section; a fail may lack it", () => {
    const { store } = withPosted();
    const id = pickSpecial(store).id;
    const bare = "SCRIPT special\n\nBEATS\n0 s | the square";
    expect(() => {
      store.recordScriptReview(id, scriptPass(bare));
    }).toThrow(
      `${id} is a special item: its script needs a section that starts with the line "VET CHECKS"`,
    );
    store.recordScriptReview(id, {
      ...scriptPass(bare),
      verdict: "fail",
      notes: "no vet checks",
    });
    store.recordScriptReview(id, scriptPass());
    // A text fix keeps the section too.
    expect(() => {
      store.recordScriptFix(id, { script: bare, by: "Director", why: "x" });
    }).toThrow(
      'its script needs a section that starts with the line "VET CHECKS"',
    );
  });

  test("the video: a copy in the app's videos with its sha256, length and sources; the item is finished, attached", () => {
    const { store, video, sources } = withPosted();
    const id = scripted(store);
    const it = store.attachSpecial(id, { video, sources }) as Item;
    const r = it.render!;
    expect(it.state).toBe("finished");
    expect(stage(it)).toBe("attached");
    expect(r.video.path.startsWith(store.dirs.videos)).toBe(true);
    expect(r.video.path).not.toBe(video);
    expect(r.video.sha256).toBe(sha(readFileSync(video)));
    expect(sha(readFileSync(r.video.path))).toBe(r.video.sha256);
    expect(r.video.bytes).toBe(readFileSync(video).length);
    expect(r.video.durationSeconds).toBeCloseTo(4, 1);
    expect(r.sources).toEqual({
      file: sources,
      sha256: sha(readFileSync(sources, "utf8")),
      text: readFileSync(sources, "utf8"),
    });
    // No list or sheet; the posted video's music; the script it came in
    // under.
    expect(r.edlSha256).toBeNull();
    expect(r.sheet).toBeNull();
    expect(r.music).toEqual(POSTED_MUSIC);
    expect(r.scriptReview.at).toBe(it.scriptReviews[0].at);
    expect(it.events.at(-1)?.what).toContain("special video attached");
  });

  test("refused: a missing or empty sources file, a missing video, a file that is no video, a game item", () => {
    const { store, files, video, sources } = withPosted();
    const id = scripted(store);
    const empty = join(files, "empty.txt");
    writeFileSync(empty, " \n");
    expect(() => {
      store.attachSpecial(id, { video, sources: empty });
    }).toThrow(`special --sources: ${empty} is empty`);
    const none = join(files, "none.txt");
    expect(() => {
      store.attachSpecial(id, { video, sources: none });
    }).toThrow(`special --sources: no file ${none}`);
    expect(() => {
      store.attachSpecial(id, { video: join(files, "no.mp4"), sources });
    }).toThrow(`special --video: no file ${join(files, "no.mp4")}`);
    expect(() => {
      store.attachSpecial(id, { video: "billboard.mp4", sources });
    }).toThrow("special needs --video: the absolute path of a file");
    expect(() => {
      store.attachSpecial(id, { video: sources, sources });
    }).toThrow("is not a video that ffprobe reads");
    expect((store.item(id) as Item).render).toBeNull();
    expect(() => {
      store.attachSpecial(POSTED, { video, sources });
    }).toThrow(`${POSTED} is posted; this step needs draft or finished`);
  });
});

describe("the steps of a list and the 4090 refuse a special item", () => {
  test("direct, render, a capture and check", () => {
    const { store } = withPosted();
    const id = scripted(store);
    const no = (step: string) =>
      `a special item has no edit list: ${step} works only on a game item`;
    expect(() => {
      store.direct(id, {
        edl: {},
        text: "{}",
        summary: [],
        needsPawnArt: false,
      });
    }).toThrow(no("direct"));
    expect(() => {
      store.startRender(id, "job-1");
    }).toThrow(no("render"));
    expect(() => {
      store.countCaptureView(id, "lint-1");
    }).toThrow(no("a capture-only job"));
    expect(() => {
      store.recordCheck(id, { sheetSha256: "s", stills: [] });
    }).toThrow(no("check"));
  });
});

describe("then it goes the way of every item: vet, copy, review, post", () => {
  /** The special item with its video, a passed vet and Growth's block. */
  const inReview = () => {
    const env = withPosted();
    const id = scripted(env.store);
    const it = env.store.attachSpecial(id, env) as Item;
    const videoSha256 = it.render!.video.sha256;
    expect(reviewState(it)).toBe("waiting-copy");
    // Growth's block needs the vet of this video first.
    expect(() => {
      env.store.recordCopy(id, COPY);
    }).toThrow(
      `${id}: no passing independent review of video ${videoSha256.slice(0, 12)}`,
    );
    env.store.recordVet(id, {
      videoSha256,
      reviewer: "Video Reviewer 2",
      verdict: "pass",
      notes: "the corners hold; VERDICT: pass",
    });
    env.store.recordCopy(id, COPY);
    return { ...env, id, videoSha256 };
  };

  test("in review after its own vet and a block; Nil approves it though its game posted; a game item of the game is still refused", () => {
    const { store, id, videoSha256 } = inReview();
    expect(reviewState(store.item(id))).toBe("in-review");
    expect(store.approveProblem(store.item(id))).toBeNull();
    // The other side: a game item of the same game may not be approved.
    const game = { ...(store.item(id) as Item), kind: "game", id: "x" };
    expect(store.approveProblem(game)).toContain(
      `another video of this game is posted (${POSTED})`,
    );
    const card = reviewView(store, {
      pacific: "Fri 09:00 PT",
      willPost: true,
      why: null,
    }).items.find((x: { id: string }) => x.id === id);
    expect(card).toMatchObject({
      videoSha256,
      approveProblem: null,
      claimRiskSounds: [],
    });
    const out = store.review(id, {
      action: "approve",
      notes: "",
      videoSha256,
      copySha256: copySha256(COPY),
      by: "Nil",
      memberId: REVIEWER_MEMBER_ID,
    }) as Item;
    expect(out.state).toBe("approved");
    expect(readPostLog(store.feedbackLog).at(-1)).toMatchObject({
      itemId: id,
      gameId: GAME,
      edlSha256: null,
      action: "approve",
    });
    // The post log row reads it as any video.
    const row = logRow(store.item(id), "x", {
      at: "2026-11-27T17:00:00.000Z",
      mode: "dry-run",
      postId: "p1",
      url: null,
    });
    expect(row).toMatchObject({
      itemId: id,
      gameId: GAME,
      music: ["deja-vus"],
      edlSha256: null,
      videoSha256,
    });
  });

  test("the posted video's music goes with it: a track that may not play stops its approval", () => {
    const env = withPosted();
    const posted = env.store.item(POSTED) as Item & {
      render: { music: unknown[] };
    };
    posted.render.music = [{ fromPly: 0, track: "no-such-track", at: 0 }];
    writeFileSync(
      join(env.store.dirs.items, `${POSTED}.json`),
      JSON.stringify(posted),
    );
    const id = scripted(env.store);
    const it = env.store.attachSpecial(id, env) as Item;
    expect(blockedMusic(it)).toEqual([
      { track: "no-such-track", license: "unknown" },
    ]);
    expect(env.store.approveProblem(it)).toBe(
      "the music no-such-track has the license unknown: re-direct with a track that may play",
    );
  });

  test("its post says it is altered where the platform's API has a field; a game item's does not (daily.test.ts)", async () => {
    const { dir, id, videoSha256 } = inReview();
    const store = openStore(dir);
    store.review(id, {
      action: "approve",
      notes: "",
      videoSha256,
      copySha256: copySha256(COPY),
      by: "Nil",
      memberId: REVIEWER_MEMBER_ID,
    });
    const daily = createDaily({
      dataDir: dir,
      env: { PATH: process.env.PATH!, TMPDIR: TEST_TMP.root },
      backupWindow: null,
    });
    DAILIES.push(daily);
    const item = store.item(id) as Item;
    const video = readFileSync(item.render!.video.path);
    const plans: Record<string, { url: string; body: unknown }[]> = {};
    await daily.asThePost(async () => {
      for (const platform of PLATFORMS) {
        const r = (await daily.postPlatform(platform, {
          item,
          video,
          beforeCommit: () => undefined,
        })) as { ok: boolean; error?: string; requestsFile: string };
        expect([platform, r.ok, r.error]).toEqual([platform, true, undefined]);
        plans[platform] = JSON.parse(readFileSync(r.requestsFile, "utf8")) as {
          url: string;
          body: unknown;
        }[];
      }
    });
    const bodyWith = (platform: string, field: string) =>
      plans[platform]
        .map((r) => r.body as Record<string, unknown> | null)
        // A form body (a token request) is a string.
        .find((b) => typeof b === "object" && b !== null && field in b);
    expect(
      (bodyWith("youtube", "status")?.status as Record<string, unknown>)
        .containsSyntheticMedia,
    ).toBe(true);
    expect(bodyWith("x", "made_with_ai")?.made_with_ai).toBe(true);
    expect(bodyWith("instagram", "is_ai_generated")?.is_ai_generated).toBe(
      true,
    );
    expect(
      bodyWith("instagram-story", "is_ai_generated")?.is_ai_generated,
    ).toBe(true);
    expect(bodyWith("facebook", "is_ai_generated")).toMatchObject({
      upload_phase: "finish",
      is_ai_generated: true,
    });
    expect(bodyWith("threads", "is_made_with_ai")?.is_made_with_ai).toBe(true);
    // TikTok's inbox upload and Bluesky have no such field: nothing is sent.
    for (const p of ["tiktok", "bluesky"]) {
      const sent = JSON.stringify(plans[p].map((r) => r.body));
      expect([p, /made_with_ai|is_ai_generated|synthetic/i.test(sent)]).toEqual(
        [p, false],
      );
    }
  });

  test("a vet of another video does not count, and a script review after the video takes it out of review", () => {
    const { store, id, videoSha256 } = inReview();
    expect(() => {
      store.recordVet(id, {
        videoSha256: "b".repeat(64),
        reviewer: "VR1",
        verdict: "pass",
        notes: "ok",
      });
    }).toThrow(`${id}'s current video is ${videoSha256}`);
    store.recordVet(id, {
      videoSha256,
      reviewer: "VR1",
      verdict: "fail",
      notes: "a corner slips at t=3.2",
    });
    expect(reviewState(store.item(id))).toBe("waiting-copy");
  });

  test("a special item has no puzzle link: the copy check refuses one", () => {
    const { store, id } = inReview();
    const it = store.item(id) as Item & { copy: { block: typeof COPY } };
    it.copy.block = {
      ...COPY,
      youtubeDescription: `${COPY.youtubeDescription} ${puzzleLink(7)}`,
    };
    expect(copyHeldReason(it)).toContain(
      `YouTube description names ${puzzleLink(7)}, but this item's video ends on no puzzle`,
    );
  });
});

describe("the vet prompt of a special item takes its checks from the script", () => {
  test("vetChecks: the VET CHECKS section up to the next section", () => {
    expect(vetChecks(SCRIPT)).toEqual([
      "- the screen's four corners hold on the building in every frame",
      "- the clip reads on the screen: the board and the four pawns",
      '- the reveal card "this never happened" shows 2.4 s',
    ]);
    expect(vetChecks("VET CHECKS:\n- the credit\n")).toEqual(["- the credit"]);
    expect(vetChecks("SCRIPT\n\nBEATS\n- x")).toBeNull();
    expect(vetChecks("VET CHECKS\n\nCHECKLIST\n- x")).toBeNull();
  });

  test("specialVetPrompt: the video, the sources, the checks; no list, sheet or game", () => {
    const { store, video, sources } = withPosted();
    const id = scripted(store);
    const it = store.attachSpecial(id, { video, sources }) as Item;
    const text = specialVetPrompt({
      item: it,
      checks: vetChecks(SCRIPT)!,
      scriptFile: "/s/script.txt",
      scriptNotesFile: "/s/script-review.txt",
      sourcesFile: "/s/sources.txt",
      review: it.scriptReviews[0],
      fix: null,
      notesFile: "/s/notes.txt",
      scratch: "/s",
    }).join("\n");
    expect(text).toContain(
      `- VIDEO: ${it.render!.video.path} (sha256 ${it.render!.video.sha256}, ${it.render!.video.durationSeconds} s)`,
    );
    expect(text).toContain("- SOURCES: /s/sources.txt");
    expect(text).toContain(
      "  - the screen's four corners hold on the building in every frame",
    );
    expect(text).toContain("READING TIME");
    expect(text).toContain("- NOTES: /s/notes.txt");
    expect(text).toContain("`VERDICT: pass` or `VERDICT: fail`");
    for (const game of ["EDL", "SHEET", "STORYBOARD", "PLAYERS", "THE GAME"]) {
      expect(text).not.toContain(`- ${game}:`);
    }
  });
});

describe("the routes", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  const serve = async (dir: string) => {
    const daily = createDaily({
      dataDir: dir,
      env: {},
      send: () => Promise.resolve(),
    });
    DAILIES.push(daily);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void daily.handle(req, res, url).then((done: boolean) => {
        if (!done) res.writeHead(404).end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (path: string, body: object) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        json: (await res.json()) as Item & { error?: string },
      };
    };
  };

  test("special makes the item, special/video gives it its video; the list and 4090 routes refuse it before the 4090", async () => {
    const { dir, store, video, sources } = withPosted();
    const post = await serve(dir);
    const made = await post("/api/daily/special", { from: POSTED });
    expect(made.status).toBe(200);
    const id = made.json.id;
    expect(made.json.kind).toBe("special");
    for (const [path, step] of [
      ["/api/daily/render", "render"],
      ["/api/daily/lint", "lint"],
      ["/api/daily/preview", "preview"],
      ["/api/daily/direct", "direct"],
    ]) {
      const r = await post(path, { item: id, edl: {}, plies: "0..1" });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.json.error).toContain(
        `a special item has no edit list: ${step} works only on a game item`,
      );
    }
    const early = await post("/api/daily/special/video", {
      item: id,
      video,
      sources,
    });
    expect(early.json.error).toContain(`${id} has no script review`);
    store.recordScriptReview(id, scriptPass());
    const done = await post("/api/daily/special/video", {
      item: id,
      video,
      sources,
    });
    expect(done.status).toBe(200);
    expect(done.json.state).toBe("finished");
    expect(done.json.render!.video.sha256).toBe(sha(readFileSync(video)));
  });
});
