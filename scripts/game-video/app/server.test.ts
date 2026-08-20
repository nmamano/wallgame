/**
 * What the game-video app must refuse, and what it must not lose.
 *
 * Every test here exists because a review on 2026-08-20 got the app to do the
 * thing the test now forbids. The app is a queue of one in front of a child
 * process, so the failures that matter are not about rendering - they are
 * about what a child leaves behind when it goes wrong, and about what the
 * network is allowed to put into a filename or a process argument.
 *
 * THE RENDERER IS A STUB HERE, on purpose. The two failures worth testing are
 * ones the real renderer will not perform on demand: hanging forever, and
 * exiting with a half-written file. The stub is written into a scratch
 * directory by this file, so what each child does is readable next to the
 * assertion about it rather than parked in a fixture.
 *
 * Not covered here: the page's escaping of renderer output, which needs a real
 * browser and lives in scripts/game-video/verify-app-escaping.mjs.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { createServer } from "node:net";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(import.meta.dir, "server.mjs");

/** An unused port. Asking the kernel beats guessing. */
const freePort = (): Promise<number> =>
  new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });

/** What /api/render answers. Every field is optional by route. */
interface RenderReply {
  gameId?: string;
  cached?: boolean;
  alreadyRunning?: boolean;
  error?: string;
}

/** What /api/status answers. */
interface StatusReply {
  state?: string;
  message?: string | null;
  error?: string | null;
  meta?: { bytes: number } | null;
}

interface Answer<T> {
  status: number;
  body: T;
}

interface App {
  port: number;
  dataDir: string;
  render: (body: unknown) => Promise<Answer<RenderReply>>;
  status: (game: string) => Promise<Answer<StatusReply>>;
  video: (game: string) => string;
  stop: () => void;
}

const running: App[] = [];
afterEach(() => {
  while (running.length) running.pop()!.stop();
});

/**
 * Start the app against a stub renderer.
 *
 * `stub` is the body of a small node program. It is given the same argv the
 * real renderer gets, so it can read --out and --game. `dataDir` is for the
 * one test that must restart the app over renders it already made.
 */
async function startApp(
  stub: string,
  deadlineMs = 60_000,
  dataDir?: string,
): Promise<App> {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "game-video-test-"));
  const rendererPath = join(dir, "stub-renderer.mjs");
  writeFileSync(rendererPath, stub);

  const port = await freePort();
  const child = Bun.spawn(
    [
      "node",
      SERVER,
      "--renderer",
      rendererPath,
      "--deadline-ms",
      String(deadlineMs),
    ],
    {
      env: { ...process.env, PORT: String(port), ISOMUX_APP_DATA_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Wait for the listener rather than sleeping a guessed amount.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("the app did not start");
    await Bun.sleep(50);
  }

  const call = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<Answer<T>> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const body = (await r.json().catch(() => ({}))) as T;
    return { status: r.status, body };
  };

  const app: App = {
    port,
    dataDir: dir,
    render: (body) =>
      call<RenderReply>("/api/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    status: (game) =>
      call<StatusReply>(`/api/status?game=${encodeURIComponent(game)}`),
    video: (game) => join(dir, "renders", `${game}.mp4`),
    stop: () => child.kill(),
  };
  running.push(app);
  return app;
}

/** Poll until the job stops moving, or give up. */
async function settle(
  app: App,
  game: string,
  ms = 20_000,
): Promise<StatusReply> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { body } = await app.status(game);
    if (body.state === "done" || body.state === "error") return body;
    if (Date.now() > deadline) {
      throw new Error(
        `${game} never settled; last state ${String(body.state)}`,
      );
    }
    await Bun.sleep(100);
  }
}

/** A renderer that writes a plausible file and succeeds. */
const GOOD_RENDERER = `
import { writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
writeFileSync(out, "a".repeat(2048));
process.exit(0);
`;

describe("what may become a game id", () => {
  test("a path is not salvaged for something id-shaped inside it", async () => {
    const app = await startApp(GOOD_RENDERER);

    // The exact string review got accepted as the id "passwd".
    const traversal = await app.render({
      game: "../../etc/passwd",
      secondsPerMove: 0.8,
    });
    expect(traversal.status).toBe(400);
    expect(traversal.body.gameId).toBeUndefined();

    // Nor is any other host's link a source of ids.
    const elsewhere = await app.render({
      game: "https://evil.example.com/game/S8QCD3Z0",
      secondsPerMove: 0.8,
    });
    expect(elsewhere.status).toBe(400);
  });

  test("the two shapes a person actually pastes still work", async () => {
    const app = await startApp(GOOD_RENDERER);

    const bare = await app.render({ game: "S8QCD3Z0", secondsPerMove: 0.8 });
    expect(bare.status).toBe(200);
    expect(bare.body.gameId).toBe("S8QCD3Z0");

    const link = await app.render({
      game: "https://wallgame.io/game/AbC-1234?utm_source=x",
      secondsPerMove: 0.8,
    });
    expect(link.status).toBe(200);
    expect(link.body.gameId).toBe("AbC-1234");
  });
});

describe("what may become a render", () => {
  test("the pace floor is the one the message promises", async () => {
    const app = await startApp(GOOD_RENDERER);

    const tooFast = await app.render({
      game: "S8QCD3Z0",
      secondsPerMove: 0.01,
    });
    expect(tooFast.status).toBe(400);
    expect(tooFast.body.error).toContain("0.05");

    const atFloor = await app.render({
      game: "S8QCD3Z0",
      secondsPerMove: 0.05,
    });
    expect(atFloor.status).toBe(200);
  });

  test("a body far bigger than the form sends is refused", async () => {
    const app = await startApp(GOOD_RENDERER);
    const huge = JSON.stringify({
      game: "S8QCD3Z0",
      secondsPerMove: 0.8,
      padding: "x".repeat(200_000),
    });
    const answer = await app.render(huge);
    expect(answer.status).toBe(413);
  });
});

describe("a child that goes wrong", () => {
  /**
   * The defect: runRender resolved only on close, so a child that never
   * closed held the one-deep queue against every other game for the life of
   * the app. The assertion that matters is not that this job errors - it is
   * that the NEXT game still renders.
   */
  test("a render that never ends is stopped, and the queue moves on", async () => {
    // One stub, two behaviours: the first game hangs, anything after it works.
    // A stub that hung for every game would prove only that the app can error.
    const app = await startApp(
      `
      import { writeFileSync } from "node:fs";
      const game = process.argv[process.argv.indexOf("--game") + 1];
      if (game === "STUCKGAME") setInterval(() => {}, 1000);
      else {
        writeFileSync(process.argv[process.argv.indexOf("--out") + 1], "ok");
        process.exit(0);
      }
      `,
      1_500,
    );

    const stuck = await app.render({ game: "STUCKGAME", secondsPerMove: 0.8 });
    expect(stuck.status).toBe(200);

    const result = await settle(app, "STUCKGAME");
    expect(result.state).toBe("error");
    expect(result.error).toContain("stopped and the queue moved on");
    expect(existsSync(app.video("STUCKGAME"))).toBe(false);

    // The point of the whole fix.
    const next = await app.render({ game: "NEXTGAME", secondsPerMove: 0.8 });
    expect(next.status).toBe(200);
    expect((await settle(app, "NEXTGAME")).state).toBe("done");
  }, 40_000);

  /**
   * The renderer is a node process that spawns Chrome and ffmpeg. Signalling
   * only the child leaves those two holding the memory the single-render queue
   * exists to protect, so the deadline kills the process GROUP. The stub's own
   * child keeps touching a file; after the deadline that file must stop
   * growing.
   */
  test("the deadline reaches the grandchildren too", async () => {
    const beat = join(mkdtempSync(join(tmpdir(), "game-video-beat-")), "beat");
    const app = await startApp(
      `
      import { spawn } from "node:child_process";
      spawn(process.execPath, ["-e", \`
        const { appendFileSync } = require("node:fs");
        setInterval(() => appendFileSync(${JSON.stringify(beat)}, "x"), 100);
      \`], { stdio: "ignore" });
      setInterval(() => {}, 1000);
      `,
      1_500,
    );

    await app.render({ game: "GRANDKID", secondsPerMove: 0.8 });
    expect((await settle(app, "GRANDKID")).state).toBe("error");

    // It was alive before the deadline, or this test proves nothing.
    expect(existsSync(beat)).toBe(true);
    await Bun.sleep(1_000);
    const afterKill = readFileSync(beat, "utf8").length;
    await Bun.sleep(1_000);
    expect(readFileSync(beat, "utf8").length).toBe(afterKill);
  }, 40_000);
});

describe("what reaches the cache", () => {
  /**
   * The defect: the renderer wrote straight to the cached path, so an ffmpeg
   * that died part way left a truncated mp4 there, and the next request served
   * it as a finished video on the strength of the file existing.
   */
  test("a half-written file from a failed render is never cached", async () => {
    const app = await startApp(`
      import { writeFileSync } from "node:fs";
      const out = process.argv[process.argv.indexOf("--out") + 1];
      writeFileSync(out, "half an mp4");
      process.stderr.write("ffmpeg died\\n");
      process.exit(1);
    `);

    await app.render({ game: "PARTIAL1", secondsPerMove: 0.8 });
    const result = await settle(app, "PARTIAL1");
    expect(result.state).toBe("error");
    expect(existsSync(app.video("PARTIAL1"))).toBe(false);

    // And it is not resurrected as a cache hit by the next request either.
    const again = await app.render({ game: "PARTIAL1", secondsPerMove: 0.8 });
    expect(again.body.cached).toBeUndefined();
  }, 30_000);

  test("a renderer that exits 0 having written nothing is a failure", async () => {
    const app = await startApp(`process.exit(0);`);
    await app.render({ game: "EMPTYOUT", secondsPerMove: 0.8 });
    const result = await settle(app, "EMPTYOUT");
    expect(result.state).toBe("error");
    expect(existsSync(app.video("EMPTYOUT"))).toBe(false);
  }, 30_000);

  /**
   * The other half of the same defect: force used to delete the good file
   * before the replacement existed, so a failed re-render cost the video.
   */
  test("a failed re-render leaves the previous video untouched", async () => {
    // First, a good render to have something worth losing.
    const good = await startApp(GOOD_RENDERER);
    await good.render({ game: "KEEPMINE", secondsPerMove: 0.8 });
    expect((await settle(good, "KEEPMINE")).state).toBe("done");
    const original = readFileSync(good.video("KEEPMINE"));
    expect(original.length).toBe(2048);
    good.stop();
    running.pop();

    // The same renders directory, now served by an app whose renderer fails
    // after writing a short file - the shape of an ffmpeg that dies part way.
    const app = await startApp(
      `
      import { writeFileSync } from "node:fs";
      const out = process.argv[process.argv.indexOf("--out") + 1];
      writeFileSync(out, "truncated");
      process.stderr.write("ffmpeg died\\n");
      process.exit(1);
      `,
      60_000,
      good.dataDir,
    );

    const forced = await app.render({
      game: "KEEPMINE",
      secondsPerMove: 0.8,
      force: true,
    });
    expect(forced.status).toBe(200);
    expect((await settle(app, "KEEPMINE")).state).toBe("error");

    // The video Nil already had is still exactly the video Nil already had.
    expect(existsSync(app.video("KEEPMINE"))).toBe(true);
    expect(readFileSync(app.video("KEEPMINE"))).toEqual(original);
  }, 40_000);

  /**
   * The same failure one step later: the renderer works, and PUBLISHING is
   * what fails. The old app wrote the new metadata to its final path before
   * renaming the video, so a rename that failed left the video Nil still had
   * described by the size, options and timestamp of a render that never
   * landed.
   *
   * The controlled failure is a read-only renders directory, chosen because it
   * separates the two writes the way a full disk would. On Linux, rewriting an
   * EXISTING file needs permission on the file; creating or replacing a
   * directory entry - which is what rename does - needs permission on the
   * DIRECTORY. So the old code's metadata write still succeeds here while the
   * video rename fails, which is exactly the pair that tells the old ordering
   * from the new one. A failure that blocked both writes would pass either
   * way and prove nothing.
   */
  test("a failed publish leaves the previous video AND its metadata untouched", async () => {
    const good = await startApp(GOOD_RENDERER);
    await good.render({ game: "PUBFAIL1", secondsPerMove: 0.8 });
    expect((await settle(good, "PUBFAIL1")).state).toBe("done");
    const video = readFileSync(good.video("PUBFAIL1"));
    const metaFile = join(good.dataDir, "renders", "PUBFAIL1.json");
    const meta = readFileSync(metaFile);
    good.stop();
    running.pop();

    const renders = join(good.dataDir, "renders");
    // A renderer that succeeds, with different bytes and options, so anything
    // written from this generation is recognisable.
    const app = await startApp(
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[process.argv.indexOf("--out") + 1], "z".repeat(9999));
      process.exit(0);
      `,
      60_000,
      good.dataDir,
    );

    try {
      chmodSync(renders, 0o555);
      const forced = await app.render({
        game: "PUBFAIL1",
        secondsPerMove: 0.25,
        aspect: "square",
        force: true,
      });
      expect(forced.status).toBe(200);

      const result = await settle(app, "PUBFAIL1");
      expect(result.state).toBe("error");
      expect(result.error).toContain("could not be saved");
    } finally {
      chmodSync(renders, 0o755);
    }

    // Neither file describes the render that did not happen.
    expect(readFileSync(app.video("PUBFAIL1"))).toEqual(video);
    expect(readFileSync(metaFile)).toEqual(meta);
  }, 40_000);

  /**
   * A plain request during a forced re-render used to find the old video,
   * install a fresh "done" entry over the live job, and leave the page saying
   * "already rendered" for the rest of the render and after it finished.
   */
  test("a cache request during a re-render cannot bury the running job", async () => {
    const good = await startApp(GOOD_RENDERER);
    await good.render({ game: "OVERLAP1", secondsPerMove: 0.8 });
    expect((await settle(good, "OVERLAP1")).state).toBe("done");
    expect(readFileSync(good.video("OVERLAP1")).length).toBe(2048);
    good.stop();
    running.pop();

    // Slow enough to send a second request while it is still going, and it
    // writes a different length so the generations are distinguishable.
    const app = await startApp(
      `
      import { writeFileSync } from "node:fs";
      const out = process.argv[process.argv.indexOf("--out") + 1];
      setTimeout(() => {
        writeFileSync(out, "b".repeat(4096));
        process.exit(0);
      }, 4000);
      `,
      60_000,
      good.dataDir,
    );

    const forced = await app.render({
      game: "OVERLAP1",
      secondsPerMove: 0.8,
      force: true,
    });
    expect(forced.status).toBe(200);
    await Bun.sleep(600);
    expect((await app.status("OVERLAP1")).body.state).toBe("rendering");

    // The plain request that used to bury it.
    const plain = await app.render({ game: "OVERLAP1", secondsPerMove: 0.8 });
    expect(plain.status).toBe(200);
    expect(plain.body.cached).toBeUndefined();
    expect(plain.body.alreadyRunning).toBe(true);
    expect((await app.status("OVERLAP1")).body.state).toBe("rendering");

    // And the finish is the NEW render, reported as such.
    const result = await settle(app, "OVERLAP1", 30_000);
    expect(result.state).toBe("done");
    expect(result.meta?.bytes).toBe(4096);
    expect(readFileSync(app.video("OVERLAP1")).length).toBe(4096);
  }, 60_000);
});

describe("the page", () => {
  /**
   * A structural guard, not the proof. The proof that renderer output is shown
   * as text is verify-app-escaping.mjs, which drives a real browser. This
   * catches the cheap regression: someone reaching for a string-to-markup sink
   * again. It names the sinks rather than the word "innerHTML", because the
   * first version of this test failed on the comment warning against it.
   */
  test("turns no string into markup", async () => {
    const app = await startApp(GOOD_RENDERER);
    const page = await (await fetch(`http://127.0.0.1:${app.port}/`)).text();
    for (const sink of [
      /\.innerHTML\s*=/,
      /\.outerHTML\s*=/,
      /insertAdjacentHTML\s*\(/,
      /document\.write\s*\(/,
      /\bon\w+\s*=\s*["']/, // an inline handler in the markup
    ]) {
      expect(page).not.toMatch(sink);
    }
    expect(page).toContain("textContent");
  });
});
