/**
 * The game-video app's own server (server.mjs): it opens on Nil's review
 * page, the make-by-hand render routes are gone (Nil, 2026-10-28: "you can
 * nuke it"), and it never picks a port. The daily routes themselves are
 * tested in ../daily/.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { POSTING_SECRETS } from "../daily/routes.mjs";

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

/** The environment of a test app: no posting secrets, so no live calls. */
const testEnv = (extra: Record<string, string>) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !POSTING_SECRETS.includes(name),
    ),
  ),
  ...extra,
});

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

/** Start the app on a free port with an empty data dir; its base URL. */
const startApp = async () => {
  const port = await freePort();
  // No live follower read in a test (the hourly follower record).
  const child = Bun.spawn(
    ["node", SERVER, "--daily-no-follower-record", "--daily-no-ask-sync"],
    {
      env: testEnv({
        PORT: String(port),
        ISOMUX_APP_DATA_DIR: mkdtempSync(join(tmpdir(), "game-video-test-")),
      }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  stops.push(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  // Wait for the listener rather than sleeping a guessed amount.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/`)).ok) return base;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("the app did not start");
    await Bun.sleep(50);
  }
};

describe("the app", () => {
  test("/ points to the Growth app's social stats; the review page is at /review", async () => {
    const base = await startApp();
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    const homePage = await home.text();
    expect(homePage).toContain(
      'href="https://office.nilmamano.com/growth/wallgame/social"',
    );
    expect(homePage).not.toContain("<script");
    const review = await fetch(`${base}/review`);
    expect(review.status).toBe(200);
    const reviewPage = await review.text();
    expect(reviewPage).toContain("<title>Wall Game videos</title>");
    expect(reviewPage).toContain('fetch("/api/review/queue")');
  });

  test("the make-by-hand render routes are gone", async () => {
    const base = await startApp();
    const render = await fetch(`${base}/api/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ game: "abcd1234" }),
    });
    expect(render.status).toBe(404);
    for (const path of ["/api/status?game=abcd1234", "/api/video?game=x"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
  });

  test("never picks a port: without PORT it refuses to start", async () => {
    const child = Bun.spawn(["node", SERVER], {
      env: testEnv({ PORT: "" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain(
      "PORT is not set",
    );
  });
});
