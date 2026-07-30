/**
 * The worked example, kept because it is what this harness was built for.
 *
 * Question: after beating a campaign level, does navigating back to the level
 * list INSIDE the app (no page reload) re-read progress and show the new
 * checkmark? Nil reported that it only appears after a refresh (board bug
 * cfc6135a, still open).
 *
 * UPDATED FOR S-FOLD. The level list is now the first section of /puzzles, and
 * campaign completion is read from the UNIFIED `/api/puzzles/progress` rather
 * than `/api/campaign/progress`. So this script now counts reads of that
 * endpoint and returns its full shape. Pointing it at the old endpoint would
 * make it observe a read the app no longer performs, and it would report "no
 * re-read" forever while the page worked fine.
 *
 * HOW IT ANSWERS CAUSALLY. The stub's completion state starts false and is
 * flipped by the DRIVER, from outside the browser, once the level page is open.
 * So:
 *
 *   - every progress read that happens before the flip — all of them are on
 *     /puzzles, during the initial load — returns "nothing completed";
 *   - the level route makes NO progress read at all. Since S-FOLD it owns only
 *     `useCampaignCompletion`, which writes; and the stub acknowledges that
 *     write WITHOUT recording it, so nothing the browser does can change server
 *     truth;
 *   - the browser's query cache is never touched by the driver, so the app
 *     cannot learn about the flip except by asking again;
 *   - therefore a checkmark on the list can only come from a read that happened
 *     AFTER the flip, i.e. one caused by the return navigation.
 *
 * The read counter is sampled immediately before and after the return, and
 * success requires BOTH that it increased and that a checkmark rendered. An
 * earlier version of this script flipped the state on the FIRST read, which let
 * an early read produce the same visible result — the checkmark looked like
 * proof of a re-read without being one.
 *
 * Generated and scripted completions are held EMPTY on purpose: the only
 * checkmark the page can possibly draw is the campaign level's, so counting
 * checkmarks stays a direct measurement of the thing under test.
 *
 * Still a manual diagnostic, not an assertion suite: it prints a verdict, it
 * does not fail a build.
 *
 *   bun run build
 *   bun scripts/browser-harness/drive-campaign-progress.ts
 */

import { connect, launchChrome, wait } from "./cdp";
import { loggedIn, startStubServer } from "./stub-server";

/** Server-side truth. Only the driver changes it, never the page. */
let levelOneCompleted = false;
let progressReads = 0;

/** Enough of a generated puzzle for the third section to render. */
const puzzles = [
  {
    id: "pz1",
    displayName: "Puzzle 1",
    sortIndex: 1,
    likes: 0,
    dislikes: 0,
    myVote: null,
    config: {
      variant: "custom-setup-standard",
      boardWidth: 6,
      boardHeight: 6,
      variantConfig: {
        pawns: {
          p1: { cat: [0, 0], mouse: [5, 5] },
          p2: { cat: [5, 0], mouse: [0, 4] },
        },
        walls: [],
        turn: { playerId: 1, actionsTaken: [] },
      },
    },
  },
];

const bots = {
  bots: [
    {
      id: "stub:dw-puzzle",
      clientId: "stub",
      botId: "dw-puzzle",
      name: "PuzzleBot",
      isOfficial: true,
      appearance: { color: "purple" },
      variants: {
        "custom-setup-standard": {
          boardWidth: { min: 4, max: 12 },
          boardHeight: { min: 4, max: 10 },
          recommended: [{ boardWidth: 6, boardHeight: 6 }],
        },
      },
    },
  ],
};

const stub = startStubServer({
  routes: {
    "/api/me": loggedIn,
    "/api/puzzles": () => ({ puzzles }),
    "/api/bots": () => bots,
    // The logged-in page asks for settings; stubbed so it does not fall through
    // to the SPA HTML and spend retries on a request that cannot succeed.
    "/api/settings": () => ({}),
    "/api/puzzles/progress": () => {
      progressReads++;
      return {
        solvedGeneratedIds: [],
        solvedScriptedIds: [],
        completedCampaignLevelIds: levelOneCompleted ? ["1"] : [],
      };
    },
    // Acknowledges the app's own completion write if it fires, WITHOUT
    // recording it. A second writer would break the invariant this experiment
    // rests on: that nothing the browser does can change server truth, so a
    // checkmark can only come from a read after the driver's flip.
    "/api/campaign/complete": () => ({ success: true }),
  },
});

/** How many checkmarks the list is currently showing. */
const CHECKMARKS = `document.querySelectorAll('svg[class*="circle-check"]').length`;

const chrome = await launchChrome();
console.log(`chrome pid ${chrome.pid}`);
try {
  const page = await connect();

  // 1. Land on /puzzles, whose FIRST section is now the campaign. This full
  //    load is the "after a refresh" case, and with nothing completed it must
  //    show no checkmarks.
  await page.navigate(`${stub.url}/puzzles`);
  await wait(2500);
  console.log(
    `first load: checkmarks=${await page.evaluate(CHECKMARKS)} (expect 0), progress reads=${progressReads}`,
  );
  console.log(
    `  sections: ${await page.evaluate(
      `JSON.stringify([...document.querySelectorAll('h2')].map(h => h.textContent))`,
    )}`,
  );

  // 2. Into a level, the way a player gets there: the campaign card's button.
  console.log(
    "into the level:",
    await page.evaluate(`(() => {
      const heading = [...document.querySelectorAll('h3')].find((h) =>
        /First Steps/.test(h.textContent || ''));
      if (!heading) return 'no level heading';
      const card = heading.closest('div[class*="rounded"]');
      const play = card && card.querySelector('button');
      if (!play) return 'no button in card';
      play.click();
      return 'clicked ' + play.textContent;
    })()`),
  );
  await wait(1500);
  console.log(`  url: ${await page.evaluate("location.pathname")}`);

  // 3. Beat the level, as far as the server is concerned. Deliberately NOT
  //    through the browser: no request, no cache write, nothing the app can
  //    observe. From here on, only a fresh read can reveal it.
  levelOneCompleted = true;
  const readsBeforeReturn = progressReads;
  console.log(
    `flipped server state to completed; reads so far=${readsBeforeReturn}`,
  );

  // 4. Back to the list through the app's own link, NOT a reload. The link now
  //    points at /puzzles.
  console.log(
    "back to the list:",
    await page.evaluate(`(() => {
      const link = [...document.querySelectorAll('a')].find(
        (a) => a.getAttribute('href') === '/puzzles');
      if (!link) return 'no back link; hrefs: ' + JSON.stringify(
        [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')));
      link.click();
      return 'clicked';
    })()`),
  );
  await wait(2500);

  // 5. TRAP: match the check icon by a class SUBSTRING. This lucide version
  //    emits "lucide-circle-check-big"; guessing an older name like
  //    "lucide-check-circle-2" silently matches nothing and reads as a bug
  //    that is not there.
  const checks = Number(await page.evaluate(CHECKMARKS));
  const readsAfterReturn = progressReads;
  const reReadOnReturn = readsAfterReturn > readsBeforeReturn;

  console.log(`after returning: checkmarks=${checks}`);
  console.log(`progress reads: ${readsBeforeReturn} -> ${readsAfterReturn}`);
  console.log(`requests: ${JSON.stringify(stub.log())}`);
  console.log(
    reReadOnReturn && checks > 0
      ? "VERDICT: returning re-read progress and the checkmark rendered with no reload."
      : `VERDICT: NOT reproduced as a working path — re-read on return=${reReadOnReturn}, checkmarks=${checks}.`,
  );

  // 6. The legacy list URL must land on /puzzles WITHOUT leaving an extra
  //    history entry behind it, or Back would bounce the visitor through the
  //    redirect again.
  //
  //    A history.length delta cannot answer this. Navigating to the URL you are
  //    already on REPLACES rather than pushes, so a naive "control" measured
  //    from /puzzles reads +0 and makes any redirect look like it added an
  //    entry. Measure the user-visible property instead: arrive from a known
  //    page, follow the legacy URL, press Back, and see where you land. If the
  //    redirect left its own entry behind, Back returns to /puzzles (a bounce)
  //    instead of to where the visitor came from.
  await page.navigate(`${stub.url}/about`);
  await wait(1200);
  const cameFrom = String(await page.evaluate("location.pathname"));
  await page.navigate(`${stub.url}/solo-campaign`);
  await wait(2000);
  const landedOn = String(await page.evaluate("location.pathname"));
  await page.evaluate("history.back()");
  await wait(1500);
  const afterBack = String(await page.evaluate("location.pathname"));
  console.log(
    `\nlegacy URL: ${cameFrom} -> /solo-campaign -> landed ${landedOn}; Back -> ${afterBack}`,
  );
  console.log(
    landedOn === "/puzzles" && afterBack === cameFrom
      ? `VERDICT: redirect lands on /puzzles and Back returns to ${cameFrom} — no bounce.`
      : `VERDICT: redirect NOT clean — landed ${landedOn}, Back went to ${afterBack} (wanted ${cameFrom}).`,
  );

  // 7. And the level route itself must still be directly reachable — only the
  //    LIST moved. "A board rendered" is asserted by COUNTING THE CELLS of the
  //    actual board grid, not by finding any svg: lucide icons, the nav and the
  //    theme toggle all emit svg elements on every page, so `querySelector('svg')`
  //    is true on a blank error page too and would prove nothing.
  //
  //    The selector is grounded in components/board.tsx: the grid is
  //    `div.grid.w-full.relative` and each cell is a direct `div.aspect-square`
  //    child (the grid's other children are absolutely-positioned wall hit
  //    areas and pillars, which is why the child selector matters).
  const EXPECTED_CELLS = 36; // level 1 is 6x6 — see buildLevelConfig.
  await page.navigate(`${stub.url}/solo-campaign/1`);
  await wait(2500);
  const level = String(
    await page.evaluate(`(() => {
      const grid = document.querySelector('div.grid.w-full.relative');
      return JSON.stringify({
        path: location.pathname,
        heading: (document.querySelector('h1,h2') || {}).textContent || null,
        boardGrids: document.querySelectorAll('div.grid.w-full.relative').length,
        cells: grid ? grid.querySelectorAll(':scope > div.aspect-square').length : 0,
        notFound: /Level not found/.test(document.body.innerText),
      });
    })()`),
  );
  const cells = Number(JSON.parse(level).cells);
  console.log(`\n/solo-campaign/1 renders: ${level}`);
  console.log(
    cells === EXPECTED_CELLS
      ? `VERDICT: direct level route renders a real ${EXPECTED_CELLS}-cell board.`
      : `VERDICT: board NOT confirmed — counted ${cells} cells, expected ${EXPECTED_CELLS}.`,
  );
  page.close();
} finally {
  chrome.stop();
  stub.stop();
}
