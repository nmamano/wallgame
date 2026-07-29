/**
 * The worked example, kept because it is what this harness was built for.
 *
 * Question: after beating a campaign level, does navigating back to the
 * level list INSIDE the app (no page reload) re-read progress and show the
 * new checkmark? Nil reported that it only appears after a refresh.
 *
 * HOW IT ANSWERS CAUSALLY. The stub's completion state starts false and is
 * flipped by the DRIVER, from outside the browser, after the level page has
 * already mounted and read progress. So:
 *
 *   - any read before the flip returns "nothing completed", including the
 *     one the level route makes on mount;
 *   - the browser's query cache is never touched, so the app cannot learn
 *     about the flip except by asking again;
 *   - therefore a checkmark on the list can only come from a read that
 *     happened AFTER the flip, i.e. one caused by the return navigation.
 *
 * The read counter is sampled immediately before and after the return, and
 * success requires BOTH that it increased and that a checkmark rendered.
 * An earlier version of this script flipped the state on the first read,
 * which let a read during level mount produce the same visible result — the
 * checkmark looked like proof of a re-read without being one.
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

const stub = startStubServer({
  routes: {
    "/api/me": loggedIn,
    "/api/campaign/progress": () => {
      progressReads++;
      return { completedLevels: levelOneCompleted ? ["1"] : [] };
    },
    // Acknowledges the app's own completion write if it fires, WITHOUT
    // recording it. A second writer would break the invariant this
    // experiment rests on: that nothing the browser does can change server
    // truth, so a checkmark can only come from a read after the driver's
    // flip.
    "/api/campaign/complete": () => ({ success: true }),
  },
});

/** How many checkmarks the list is currently showing. */
const CHECKMARKS = `document.querySelectorAll('svg[class*="circle-check"]').length`;

const chrome = await launchChrome();
console.log(`chrome pid ${chrome.pid}`);
try {
  const page = await connect();

  // 1. Land on the level list. This full load is the "after a refresh" case,
  //    and with nothing completed it must show no checkmarks.
  await page.navigate(`${stub.url}/solo-campaign`);
  await wait(2500);
  console.log(
    `first load: checkmarks=${await page.evaluate(CHECKMARKS)} (expect 0), progress reads=${progressReads}`,
  );

  // 2. Into a level, the way a player gets there.
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

  // 4. Back to the list through the app's own link, NOT a reload.
  console.log(
    "back to the list:",
    await page.evaluate(`(() => {
      const link = [...document.querySelectorAll('a')].find(
        (a) => a.getAttribute('href') === '/solo-campaign');
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
  page.close();
} finally {
  chrome.stop();
  stub.stop();
}
