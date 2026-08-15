/**
 * Drives the real /puzzles bundle to answer three questions that source
 * reading cannot: does the page paint COMPLETE rather than in waves, does a
 * failing endpoint still degrade to the inline error card, and does the nav
 * bar fit once "Puzzles" is added to it.
 *
 * Run it:
 *   bun run harness:puzzles
 *
 * That script is `bun run build && <this file>`. The chain matters: driving a
 * stale `dist` measures the previous commit and reads exactly like a defect.
 *
 * The wave measurement: after navigating, sample the DOM every 50ms and
 * record a signature of what is on screen. A page that arrives in one piece
 * produces ONE non-empty signature; a page that arrives in waves produces a
 * sequence of them, which is exactly what a player perceives as cards
 * appearing a second late.
 */

import { connect, launchChrome, wait } from "./cdp";
import { loggedIn, loggedOut, startStubServer } from "./stub-server";
import { generateCustomSetupCandidates } from "../../shared/domain/generated-custom-setup-candidates";
import { buildSavedPuzzleSeedRows } from "../../shared/domain/saved-puzzles";
import type { CandidateVerdictFile } from "../../shared/domain/custom-setup-verdicts";
import verdicts from "../../shared/domain/generated-custom-setup-verdicts.json";

/**
 * Puzzle fixtures built from the committed seed rows, so display names and
 * launch configs are the real ones rather than hand-written shapes that
 * could drift from the contract.
 */
const seeds = buildSavedPuzzleSeedRows(
  generateCustomSetupCandidates(),
  verdicts as CandidateVerdictFile,
).slice(0, 12);

const puzzles = seeds.map((seed, index) => ({
  id: `pz${index + 1}`,
  displayName: seed.displayName,
  sortIndex: seed.sortIndex,
  config: seed.config,
  likes: index % 3,
  dislikes: 0,
  myVote: null,
}));

const bots = {
  bots: [
    {
      id: "stub:puzzlebot",
      clientId: "stub",
      botId: "puzzlebot",
      name: "PuzzleBot",
      isOfficial: true,
      isAnalysisBot: true,
      appearance: {},
      variants: { standard: {} },
    },
  ],
};

/**
 * How much on-screen state we can see at one instant. Sampling starts
 * during navigation, when there may be no document at all yet, so "blank"
 * is a real state and not an error.
 */
const SIGNATURE = `(() => {
  if (!document.body) return JSON.stringify({ blank: true });
  const text = document.body.innerText;
  return JSON.stringify({
    // Section headings: since S-FOLD there should be THREE (Campaign,
    // Handcrafted Puzzles, Generated Puzzles), and they must appear together
    // rather than the campaign arriving separately.
    sections: document.querySelectorAll('h2').length,
    // Cards now include the two campaign levels and the "More coming soon"
    // placeholder, all of which are h3.
    cards: document.querySelectorAll('h3').length,
    checks: document.querySelectorAll('svg[class*="circle-check"]').length,
    // ONE page-level invitation, not one per section.
    loginPrompts: (text.match(/Log in to keep track/g) ?? []).length,
    loading: /Loading puzzles/.test(text) || /Looking for the official bot/.test(text),
    listError: /Could not load the puzzles/.test(text),
    routeError: /something went wrong|Unexpected error/i.test(text),
  });
})()`;

/**
 * Samples the page for 12s, returning each distinct state WITH the moment it
 * appeared. The timings are the point: "cards at 900ms, checkmarks at
 * 1900ms" is a wave, "everything at 900ms" is not, and only a clock can tell
 * those apart. 12s because a failing query retries with backoff before the
 * component gives up and shows its error.
 */
const observePaint = async (
  page: Awaited<ReturnType<typeof connect>>,
  url: string,
) => {
  const started = performance.now();
  await page.navigate(url);
  const states: { atMs: number; state: string }[] = [];
  for (let i = 0; i < 120; i++) {
    const state = String(await page.evaluate(SIGNATURE));
    if (state !== states[states.length - 1]?.state) {
      states.push({ atMs: Math.round(performance.now() - started), state });
    }
    await wait(100);
  }
  return states;
};

const scenario = (
  name: string,
  routes: Record<string, (req: Request) => unknown>,
) => ({ name, routes });

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const SCENARIOS = [
  scenario("logged in, two puzzles already solved", {
    "/api/me": loggedIn,
    "/api/puzzles": () => ({ puzzles }),
    "/api/bots": () => bots,
    "/api/puzzles/progress": () => ({
      verifiedSolvedSavedPuzzleIds: ["pz1", "pz2"],
      assertedCompletedSavedPuzzleIds: ["1"],
      // REQUIRED since S-FOLD: the campaign section reads from this same
      // payload, and the response schema fails closed without the field, so a
      // stub that omits it would render an error rather than the page.
      completedCampaignLevelIds: ["1"],
    }),
  }),
  scenario("logged out", {
    "/api/me": loggedOut,
    "/api/puzzles": () => ({ puzzles }),
    "/api/bots": () => bots,
    "/api/puzzles/progress": () => json({ error: "unauthorized" }, 401),
  }),
  scenario("the puzzle list endpoint fails", {
    "/api/me": loggedIn,
    "/api/puzzles": () => json({ error: "boom" }, 500),
    "/api/bots": () => bots,
    "/api/puzzles/progress": () => ({
      verifiedSolvedSavedPuzzleIds: [],
      assertedCompletedSavedPuzzleIds: [],
      completedCampaignLevelIds: [],
    }),
  }),
];

const chrome = await launchChrome();
console.log(`chrome pid ${chrome.pid}`);
try {
  for (const { name, routes } of SCENARIOS) {
    // 400ms on every call: slow enough that a wave would be unmistakable.
    const stub = startStubServer({ routes, latencyMs: 400 });
    const page = await connect();
    console.log(`\n=== ${name} ===`);
    const states = await observePaint(page, `${stub.url}/puzzles`);
    states.forEach(({ atMs, state }) => console.log(`  ${atMs}ms  ${state}`));
    console.log(`  requests: ${JSON.stringify(stub.log())}`);
    page.close();
    void stub.stop();
  }

  // Nav bar: does it fit once "Puzzles" is a ninth item?
  const stub = startStubServer({
    routes: {
      "/api/me": loggedOut,
      "/api/puzzles": () => ({ puzzles }),
      "/api/bots": () => bots,
      "/api/puzzles/progress": () => json({ error: "unauthorized" }, 401),
    },
  });
  const page = await connect();
  console.log("\n=== nav bar fit ===");
  for (const width of [1024, 1280, 1440, 390]) {
    await page.setViewport(width, 900);
    await page.navigate(`${stub.url}/puzzles`);
    await wait(1200);
    const fit = await page.evaluate(`(() => {
      const bar = document.querySelector('nav');
      const row = bar.querySelector('div > div');
      const desktop = [...row.children].find((el) =>
        el.className.includes('lg:flex'),
      );
      const brand = row.querySelector('a');
      const visible = getComputedStyle(desktop).display !== 'none';
      const labels = [...desktop.querySelectorAll('button')].map((b) =>
        b.textContent.trim(),
      ).filter(Boolean);
      return JSON.stringify({
        desktopRowVisible: visible,
        overflows: row.scrollWidth > row.clientWidth,
        brandRight: Math.round(brand.getBoundingClientRect().right),
        navLeft: Math.round(desktop.getBoundingClientRect().left),
        navRight: Math.round(desktop.getBoundingClientRect().right),
        containerRight: Math.round(row.getBoundingClientRect().right),
        labels,
      });
    })()`);
    console.log(`  ${width}px: ${String(fit)}`);
    await page.screenshot(`/tmp/nav-${width}.png`);
  }
  page.close();
  void stub.stop();
} finally {
  chrome.stop();
}
