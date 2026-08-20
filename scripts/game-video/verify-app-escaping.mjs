/**
 * Prove the app's page shows renderer output as TEXT, in a real browser.
 *
 * Board task f89e649f. The renderer's stdout carries the DISPLAY NAMES of the
 * two players - "seats: top = Ruthless Bot, bottom = Nil" is a real line from a
 * real render - and its stderr is whatever a failure printed. The page shows
 * both. Review found on 2026-08-20 that both went into innerHTML, so a player
 * who named themselves after a script tag wrote markup into Nil's browser.
 *
 * A grep for innerHTML is not proof, and neither is a page that fails to be
 * exploited when nothing hostile reached it. So this script does three things
 * for each variant it drives:
 *
 *   1. Sends a genuinely hostile display name through a stub renderer, on the
 *      progress path (stdout) and then on the failure path (stderr).
 *   2. Checks whether the payload EXECUTED - an <img onerror> that sets a flag.
 *   3. Checks the payload ARRIVED, by looking for its literal text on the page.
 *      Without this a blank page would score as clean, which is the way this
 *      kind of check usually lies.
 *
 * It runs the shipped page and a deliberately broken copy of it. The broken
 * copy MUST be exploited. A probe that cannot exploit the vulnerable version
 * has not shown that it can detect anything, and this script fails if so.
 *
 *   node scripts/game-video/verify-app-escaping.mjs
 *
 * Local only: a stub renderer, a local port, no network and no production.
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "app/server.mjs");

/** A display name a player could actually set. */
const PAYLOAD = '<img src=x onerror="window.__pwned = true">';

/**
 * A renderer that says the hostile thing on both paths a person can see: once
 * as progress while it is still running, and once as the error that ends it.
 */
const HOSTILE_RENDERER = `
console.log(${JSON.stringify(`[video] seats: top = ${PAYLOAD}, bottom = Nil`)});
setTimeout(() => {
  process.stderr.write(${JSON.stringify(`no replay data for ${PAYLOAD}\n`)});
  process.exit(1);
}, 5000);
`;

/**
 * The page as it was before the fix: an untrusted string put on the page as
 * markup. One line, in the one place that decides text or markup.
 */
const BREAK = [
  "if (text !== undefined) node.textContent = text;",
  "if (text !== undefined) node.innerHTML = text;",
];

const freePort = () =>
  new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start one app, attack it, and report what the browser did.
 */
async function attack(browser, label, serverPath) {
  const dir = mkdtempSync(join(tmpdir(), "game-video-escape-"));
  const rendererPath = join(dir, "hostile-renderer.mjs");
  writeFileSync(rendererPath, HOSTILE_RENDERER);

  const port = await freePort();
  const app = spawn(
    "node",
    [serverPath, "--renderer", rendererPath, "--deadline-ms", "60000"],
    {
      env: { ...process.env, PORT: String(port), ISOMUX_APP_DATA_DIR: dir },
      stdio: "ignore",
    },
  );

  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    const until = Date.now() + 10000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`);
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > until)
        throw new Error(`${label}: the app did not start`);
      await sleep(50);
    }

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    await page.fill("#game", "ESCAPE01");
    await page.click("#go");

    /**
     * `marker` is the plain prose either side of the payload in the message
     * being tested. It is deliberately NOT the payload itself: a successful
     * injection turns the payload into an ELEMENT, which removes it from the
     * page's text, so looking for the payload text would score the exploited
     * page as "nothing arrived" - a blindness reading on the one run that is
     * supposed to light up. The surrounding prose survives either outcome.
     */
    const look = async (marker) => ({
      executed: await page.evaluate(() => window.__pwned === true),
      injected: await page.evaluate(
        () => document.querySelectorAll("#out img").length > 0,
      ),
      arrived: (await page.textContent("#out")).includes(marker),
    });

    const waitFor = (marker) =>
      page.waitForFunction(
        (m) => (document.querySelector("#out")?.textContent ?? "").includes(m),
        marker,
        { timeout: 20000 },
      );

    // While it is still rendering: the progress path (stdout).
    await waitFor("seats");
    const progress = await look("seats");

    /*
      Clear the evidence between the two observations.

      window.__pwned survives a poll, so without this the failure reading would
      inherit the progress reading's success and report "executed" whether or
      not the error path is exploitable. The second sink would then be scored
      by the first sink's result - two observations, one piece of evidence.
      Raised by review 2026-08-20.
    */
    await page.evaluate(() => {
      delete window.__pwned;
      document.querySelectorAll("#out img").forEach((node) => node.remove());
    });

    // After it fails: the error path (stderr).
    await waitFor("no replay data");
    const failure = await look("no replay data");

    return { progress, failure };
  } finally {
    await page.close();
    app.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox"],
});

// A copy of the shipped page with the escaping removed, so the probe has to
// prove it can see an injection before its silence on the real page means
// anything.
const brokenPath = join(
  mkdtempSync(join(tmpdir(), "game-video-broken-")),
  "server.mjs",
);
const shipped = readFileSync(SERVER, "utf8");
if (!shipped.includes(BREAK[0])) {
  console.error(
    `FAIL: cannot build the vulnerable copy - ${SERVER} no longer contains\n` +
      `      ${BREAK[0]}\n` +
      "      Update BREAK to the line that now decides text or markup.",
  );
  process.exit(1);
}
writeFileSync(brokenPath, shipped.replace(BREAK[0], BREAK[1]));

const rows = [];
for (const [label, path, mustBeExploited] of [
  ["the page as shipped", SERVER, false],
  ["the same page with the escaping removed", brokenPath, true],
]) {
  const r = await attack(browser, label, path);
  rows.push([label, r, mustBeExploited]);
}
await browser.close();

let ok = true;
for (const [label, r, mustBeExploited] of rows) {
  console.log(`\n${label}`);
  for (const [path, seen] of [
    ["progress (renderer stdout)", r.progress],
    ["failure  (renderer stderr)", r.failure],
  ]) {
    // A "clean" reading only counts if the payload actually got there.
    const blind = !seen.arrived;
    const exploited = seen.executed || seen.injected;
    const good = blind ? false : exploited === mustBeExploited;
    if (!good) ok = false;
    console.log(
      `  ${path}  payload on page: ${seen.arrived ? "yes" : "NO - probe blind"}` +
        `  executed: ${seen.executed}  element injected: ${seen.injected}` +
        `  -> ${good ? "as required" : "UNEXPECTED"}`,
    );
  }
}

rmSync(dirname(brokenPath), { recursive: true, force: true });
console.log(
  ok
    ? "\nPASS: a hostile display name is read as text on the shipped page, and\n" +
        "      the same payload does execute once the escaping is removed - so\n" +
        "      this check can tell the two apart."
    : "\nFAIL: see UNEXPECTED above.",
);
process.exit(ok ? 0 : 1);
