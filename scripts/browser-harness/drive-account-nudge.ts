/**
 * Does the post-game account nudge appear, and does it stay out of the way of
 * the rematch controls?
 *
 * The nudge is a toast, chosen precisely because a fixed-position overlay
 * cannot displace anything. So the claims worth checking are not "it looks
 * fine" but measurable ones: the toast is outside the endgame panel's subtree,
 * every visible control still answers a click at its own centre, and clicking
 * one still does what it did before. That last one matters most - a hit test
 * proves a button can be reached, not that the game still works.
 *
 * A LOCAL game, driven to a finish in the real bundle. Nothing here touches a
 * server: local play is entirely client-side, and the only API call the page
 * makes is /api/me, which the stub answers as a logged-out visitor.
 *
 * KNOWN LIMIT: a local game's endgame panel carries the local controls, so
 * what is hit tested is those and not the online "Propose Rematch" button.
 * Same component, same column, so the geometry carries over - but this run
 * does not prove the online button and no report of it should say otherwise.
 *
 * UNLIKE ITS NEIGHBOURS, THIS ONE ASSERTS. The other scripts here print what
 * they found and leave the judgement to a reader; this is slice S6's gate, so
 * it measures first, prints everything, and then exits non-zero if any
 * required invariant failed. That also means running it against a build
 * WITHOUT the nudge is a real check rather than a reading: the gate must go
 * red, and which lines go red is the evidence that it can see anything at all.
 *
 * Run it: bun run build && bun scripts/browser-harness/drive-account-nudge.ts
 */

import { mkdirSync } from "node:fs";
import { launchChrome, connect, wait, type Page } from "./cdp";
import { startStubServer, loggedOut } from "./stub-server";

const SHOT_DIR = "/tmp/wallgame-account-nudge";
/** Where a phone's viewport actually lands once Safari's chrome is deducted. */
const PHONE = { width: 393, height: 650 };
const DESKTOP = { width: 1280, height: 800 };
/** Must match NUDGE_DURATION_MS in use-account-nudge.tsx. */
const EXPECTED_DURATION_MS = 20_000;
const NUDGE_TITLE = "Playing as a guest";

const json = async (page: Page, expression: string) => {
  const raw = await page.evaluate(`JSON.stringify(${expression})`);
  return JSON.parse(String(raw)) as unknown;
};

/**
 * Clicks the last ENABLED control with this exact text.
 *
 * Both qualifiers were learned the hard way. The endgame confirm step renders
 * a second "Resign" below the meta-action one, and the meta-action one is
 * disabled while a confirm is open - so clicking the first match clicked a
 * dead button and reported success.
 */
const clickByText = async (page: Page, text: string) =>
  (await json(
    page,
    `(() => {
      const matches = [...document.querySelectorAll("button, a")].filter(
        (e) =>
          (e.textContent || "").trim() === ${JSON.stringify(text)} && !e.disabled,
      );
      const el = matches[matches.length - 1];
      if (!el) return false;
      el.click();
      return true;
    })()`,
  )) as boolean;

/**
 * The board as the page renders it. Cells are the non-absolute direct children
 * of the grid - walls and joints are absolutely positioned over it, which is
 * why the filter matters. `cursor-grab` is the page's own mark for a pawn the
 * player to move is allowed to move, which beats guessing whose turn it is.
 */
const BOARD = `(() => {
  const grid = document.querySelector("div.grid.w-full.relative");
  if (!grid) return null;
  const cells = [...grid.querySelectorAll(":scope > div.aspect-square")];
  return {
    cols: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
    count: cells.length,
    pawnCells: cells.flatMap((c, i) => (c.children.length ? [i] : [])),
    movableCells: cells.flatMap((c, i) =>
      c.querySelector(".cursor-grab") ? [i] : [],
    ),
  };
})()`;

interface Board {
  cols: number;
  count: number;
  pawnCells: number[];
  movableCells: number[];
}

const readBoard = async (page: Page) =>
  (await json(page, BOARD)) as Board | null;

const clickCell = (page: Page, index: number) =>
  page.evaluate(
    `(() => {
      const grid = document.querySelector("div.grid.w-full.relative");
      const cells = [...grid.querySelectorAll(":scope > div.aspect-square")];
      if (!cells[${index}]) return false;
      cells[${index}].click();
      return true;
    })()`,
  );

/**
 * Plays one action: select a movable pawn, then step it to a neighbour.
 *
 * Legality depends on walls, the variant and whose turn it is, so this tries
 * neighbours and lets the board be the judge - a move that did not happen
 * leaves the pawn where it was. Reading legality from the page's own behaviour
 * is the whole reason this runs in a browser.
 */
const stepAnyPawn = async (page: Page): Promise<boolean> => {
  const before = await readBoard(page);
  if (!before) return false;

  for (const from of before.movableCells) {
    const row = Math.floor(from / before.cols);
    const col = from % before.cols;
    const neighbours = [
      [row - 1, col],
      [row + 1, col],
      [row, col - 1],
      [row, col + 1],
    ].filter(
      ([r, c]) =>
        r >= 0 &&
        c >= 0 &&
        c < before.cols &&
        r * before.cols + c < before.count,
    );

    for (const [r, c] of neighbours) {
      await clickCell(page, from);
      await clickCell(page, r * before.cols + c);
      await wait(120);
      const after = await readBoard(page);
      if (after && after.pawnCells.join() !== before.pawnCells.join()) {
        return true;
      }
    }
  }
  return false;
};

/**
 * How many turns the game has actually recorded, read from the move list.
 *
 * The number of clicks a driver made is not evidence: staged actions move a
 * pawn on screen without committing anything, so a run can look like a game
 * and be an empty one.
 */
const committedMoves = async (page: Page): Promise<number> =>
  Number(
    await page.evaluate(
      `(() => {
        const text = document.body.innerText;
        const start = text.indexOf("Moves\\nChat");
        if (start < 0) return 0;
        return (text.slice(start).match(/^\\d+\\./gm) || []).length;
      })()`,
    ),
  );

/**
 * Drives the game in front of us to a resignation that COUNTS, and returns how
 * many turns it recorded.
 *
 * Extracted because the run needs it twice. Clicking the nudge's own Sign up
 * button dismisses the toast - that is Radix doing its job - so the click
 * cannot be tested on the same nudge whose position, coverage and lifetime the
 * rest of the run measures. Testing it on a second game keeps every one of
 * those checks looking at a toast nobody has touched.
 */
const playToCountedFinish = async (
  page: Page,
  say: (line: string) => void,
): Promise<number> => {
  const log: string[] = [];
  for (let turn = 0; turn < 6 && (await committedMoves(page)) < 3; turn++) {
    const stepped = await stepAnyPawn(page);
    await clickByText(page, "Finish move");
    await wait(400);
    log.push(
      `t${turn}:${stepped ? "stepped" : "stuck"}=${await committedMoves(page)}`,
    );
  }
  const moves = await committedMoves(page);
  say(`play: ${log.join(" ")} -> ${moves} committed moves`);
  // Thrown rather than collected: with too few moves nothing downstream means
  // anything, so there is no point gathering further failures.
  if (moves < 2) {
    throw new Error(
      `only ${moves} moves committed; the game would abort and prove nothing`,
    );
  }

  // A half-finished turn disables every meta action, Resign included - the
  // first attempt at this run left one action staged and quietly did nothing
  // at all.
  await clickByText(page, "Clear staged actions");
  await wait(300);
  await clickByText(page, "Resign");
  await wait(400);
  await clickByText(page, "Resign");
  await wait(900);
  return moves;
};

/**
 * Every visible control, and whether the point at its own centre belongs to
 * it. An overlay that covers a button leaves the button perfectly present in
 * the DOM and perfectly unclickable, so presence is not the question.
 */
const HIT_TEST = `(() => {
  const toast = [...document.querySelectorAll("li")].find((li) =>
    (li.textContent || "").includes(${JSON.stringify(NUDGE_TITLE)}),
  );
  const controls = [...document.querySelectorAll("button")].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
  });
  return {
    toastPresent: Boolean(toast),
    toastPosition: toast ? getComputedStyle(toast.parentElement).position : null,
    // Which of the page's controls live INSIDE the toast. Its own Sign up and
    // close buttons are expected; a game control in this list would mean the
    // nudge had been rendered into the panel rather than over the page.
    controlsInsideToast: toast
      ? controls
          .filter((c) => toast.contains(c))
          .map((c) => (c.textContent || "(close)").trim())
      : [],
    controls: controls.map((b) => {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // Three outcomes, and only one of them is this slice's problem. The
      // button itself, or its own descendant: reachable. An ANCESTOR of it:
      // the button is not hit-testable at all, which is what a disabled
      // control looks like and has nothing to do with an overlay. Anything
      // else is genuinely on top of it.
      const own = Boolean(hit && (b === hit || b.contains(hit)));
      const ancestor = Boolean(hit && !own && hit.contains(b));
      return {
        text: (b.textContent || "").trim().slice(0, 24),
        reachable: own,
        disabled: b.disabled || ancestor,
        coveredBy:
          hit && !own && !ancestor
            ? (hit.closest("li[data-state]")
                ? "THE NUDGE TOAST"
                : (hit.textContent || hit.tagName).trim().slice(0, 24))
            : null,
      };
    }),
  };
})()`;

interface HitTest {
  toastPresent: boolean;
  toastPosition: string | null;
  controlsInsideToast: string[];
  controls: {
    text: string;
    reachable: boolean;
    disabled: boolean;
    coveredBy: string | null;
  }[];
}

/**
 * A required invariant. Recorded rather than thrown on the spot, so one run
 * reports every failure instead of only the first - and then the run fails.
 */
interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

/** The controls Nil's constraint is actually about. */
const ENDGAME_CONTROL =
  /^(accept|decline|no|exit|rematch|retry|play again|propose rematch)$/i;

const main = async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const stub = startStubServer({
    routes: {
      "/api/me": loggedOut,
      // 204 on purpose. In production this redirects to the identity provider;
      // here a No Content answer makes the browser ABANDON the navigation and
      // leave the document standing, so the click can be checked without
      // ending the run. What is asserted is that the app tried to go there and
      // counted the click, not what the real endpoint answers.
      "/api/register": () => new Response(null, { status: 204 }),
    },
  });
  const chrome = await launchChrome(DESKTOP);
  const page = await connect();
  const findings: string[] = [];
  const checks: Check[] = [];
  const say = (line: string) => findings.push(line);
  const must = (label: string, ok: boolean, detail = "") => {
    checks.push({ label, ok, detail });
    return ok;
  };
  const coveredEndgame = (t: HitTest) =>
    t.controls.filter(
      (c) => c.coveredBy !== null && ENDGAME_CONTROL.test(c.text),
    );

  try {
    await page.setViewport(DESKTOP.width, DESKTOP.height);
    await page.navigate(`${stub.url}/play`);
    await wait(900);

    // Stand in for Google's tag, which only exists on the production hostname
    // (see the guard in index.html), and record into sessionStorage rather
    // than a variable so the log survives a navigation. `browserSendEvent`
    // looks `window.gtag` up at call time, so installing it after load is
    // enough and does not require a page reload.
    await page.evaluate(`
      window.gtag = function () {
        const seen = JSON.parse(sessionStorage.getItem("__events") || "[]");
        seen.push(Array.from(arguments));
        sessionStorage.setItem("__events", JSON.stringify(seen));
      };
      sessionStorage.removeItem("__events");
    `);
    const eventNames = async (): Promise<string[]> =>
      (
        (await json(
          page,
          `JSON.parse(sessionStorage.getItem("__events") || "[]")`,
        )) as unknown[][]
      )
        .filter((call) => call[0] === "event")
        .map((call) => String(call[1]));

    // The app's own path to a local game, so the config is the one it builds.
    if (!(await clickByText(page, "Play Locally"))) {
      throw new Error("no 'Play Locally' tab on /play");
    }
    await wait(400);
    if (!(await clickByText(page, "Start game"))) {
      throw new Error("no 'Start game' button on /play");
    }
    await wait(1200);
    const firstGame = String(await page.evaluate("location.pathname"));
    const firstGameId = firstGame.replace("/game/", "");

    // Enough COMMITTED turns that the result counts. A game that ends before
    // both players have moved is an abort worth nothing, and the nudge
    // deliberately ignores those - so a run that skipped this would prove the
    // opposite of what it claimed. Staging moves is not enough: a turn is only
    // committed when the action budget fills or "Finish move" is pressed, and
    // the first attempt at this run staged six moves and committed none.
    const moves = await playToCountedFinish(page, say);
    const appearedAt = Date.now();

    const finished = Boolean(
      await json(page, `document.body.innerText.includes("Exit")`),
    );
    must("the endgame panel is showing", finished);

    // A 501 here would mean the nudge was suppressed by an unsettled sign-in
    // check rather than by anything about the game, and from the outside those
    // two look identical.
    const api = stub.log();
    say(`api calls: ${JSON.stringify(api)}`);
    must(
      "the sign-in check was asked and answered",
      api.includes("GET /api/me"),
    );

    const result = (await json(
      page,
      `(() => {
        const h = document.querySelector("h3");
        return {
          headline: h ? h.textContent : null,
          detail: h && h.nextElementSibling ? h.nextElementSibling.textContent : null,
        };
      })()`,
    )) as { headline: string | null; detail: string | null };
    say(`result: ${JSON.stringify(result)}`);
    // Read this one for what it is: the regex alone proves nothing, it only
    // rejects a headline that SAYS aborted. What actually establishes a
    // counted result is the two-committed-moves gate above plus the fact that
    // this run deterministically resigns, with the storage marker below as
    // independent confirmation. Quoting the regex as the proof would be
    // exactly the kind of claim this file exists to stop making.
    must(
      "the game ended in a COUNTED result, not an abort",
      !/abort/i.test(`${result.headline} ${result.detail}`),
      JSON.stringify(result),
    );

    const stored = (await json(
      page,
      `({
        first: localStorage.getItem("wall-game-first-finished-game"),
        shown: sessionStorage.getItem("wall-game-account-nudge-shown"),
      })`,
    )) as { first: string | null; shown: string | null };
    say(`storage after finish: ${JSON.stringify(stored)}`);
    must(
      "the finish was recorded as this browser's first game",
      stored.first === firstGameId,
      `marker=${stored.first} game=${firstGameId}`,
    );
    must("the session's one nudge was claimed", stored.shown === "1");

    const desktop = (await json(page, HIT_TEST)) as HitTest;
    say(
      `desktop ${DESKTOP.width}x${DESKTOP.height}: present=${desktop.toastPresent} ` +
        `overlay=${desktop.toastPosition} inside-it=${JSON.stringify(desktop.controlsInsideToast)} ` +
        `covered=${JSON.stringify(desktop.controls.filter((c) => c.coveredBy !== null))}`,
    );
    must("the nudge is on screen at 1280x800", desktop.toastPresent);
    must(
      "the nudge is an overlay rather than layout",
      desktop.toastPosition === "fixed",
      String(desktop.toastPosition),
    );
    must(
      "only the nudge's own Sign up and close sit inside it",
      desktop.controlsInsideToast.length === 2 &&
        desktop.controlsInsideToast.includes("Sign up"),
      JSON.stringify(desktop.controlsInsideToast),
    );
    must(
      "no endgame control is covered at 1280x800",
      coveredEndgame(desktop).length === 0,
      JSON.stringify(coveredEndgame(desktop)),
    );
    await page.screenshot(`${SHOT_DIR}/desktop.png`);

    // Half the instrumentation. Without the pair, "no signups" cannot be told
    // apart from "no offers shown" - different problems with different fixes.
    // The click half is at the very end of the run, on a nudge of its own,
    // because clicking the offer dismisses the toast and would blind every
    // check below that reads it.
    const shownEvents = await eventNames();
    say(`analytics after the nudge appeared: ${JSON.stringify(shownEvents)}`);
    must(
      "showing the nudge counted exactly one account_nudge_shown",
      shownEvents.filter((n) => n === "account_nudge_shown").length === 1,
      JSON.stringify(shownEvents),
    );

    await page.setViewport(PHONE.width, PHONE.height);
    await wait(700);
    const phone = (await json(page, HIT_TEST)) as HitTest;
    say(
      `phone ${PHONE.width}x${PHONE.height}: present=${phone.toastPresent} ` +
        `overlay=${phone.toastPosition} ` +
        `covered=${JSON.stringify(phone.controls.filter((c) => c.coveredBy !== null))}`,
    );
    must("the nudge is on screen at 393x650", phone.toastPresent);
    must(
      "the nudge is an overlay rather than layout, on a phone too",
      phone.toastPosition === "fixed",
      String(phone.toastPosition),
    );
    must(
      "no endgame control is covered at 393x650",
      coveredEndgame(phone).length === 0,
      JSON.stringify(coveredEndgame(phone)),
    );
    await page.screenshot(`${SHOT_DIR}/phone.png`);

    // Reachable is not the same as working. Click the endgame control while
    // the nudge is still up and watch the game actually respond.
    await page.setViewport(DESKTOP.width, DESKTOP.height);
    await wait(500);
    // A local game's rematch offer is Accept/Decline rather than a "Propose
    // Rematch" button - the offer is standing, because the other player is
    // this browser too.
    const offered = desktop.controls
      .map((c) => c.text)
      .filter((t) => ENDGAME_CONTROL.test(t) && !/^exit$/i.test(t));
    say(`endgame controls offered: ${JSON.stringify(offered)}`);
    const target = offered.find((t) => /accept/i.test(t)) ?? "";
    const clicked = target ? await clickByText(page, target) : false;
    must("a rematch control was found and clicked", clicked, target);
    await wait(1800);
    const afterClick = String(await page.evaluate("location.pathname"));
    say(`clicked "${target}" with the nudge up: ${firstGame} -> ${afterClick}`);
    must(
      "clicking it started a DIFFERENT game",
      afterClick.startsWith("/game/") && afterClick !== firstGame,
      afterClick,
    );

    const after = (await json(
      page,
      `({
        nudges: [...document.querySelectorAll("li")].filter((li) => (li.textContent || "").includes(${JSON.stringify(NUDGE_TITLE)})).length,
        first: localStorage.getItem("wall-game-first-finished-game"),
      })`,
    )) as { nudges: number; first: string | null };
    // Note what this does and does not say: game two has STARTED, not
    // finished, so this is not evidence about a second nudge. It is evidence
    // that navigating did not add one and did not move the marker. Once per
    // session is proven by the unit tests.
    must(
      "exactly the one original nudge remains after the rematch navigation",
      after.nudges === 1,
      String(after.nudges),
    );
    must(
      "the first-game marker still names game one",
      after.first === firstGameId,
      `${after.first} vs ${firstGameId}`,
    );

    // Radix's own dismissal, not the toast hook's removal delay.
    await wait(
      Math.max(0, EXPECTED_DURATION_MS + 2000 - (Date.now() - appearedAt)),
    );
    const stillThere = Boolean(
      await json(
        page,
        `[...document.querySelectorAll("li")].some((li) => (li.textContent || "").includes(${JSON.stringify(NUDGE_TITLE)}))`,
      ),
    );
    must(
      `the nudge is gone ${Math.round(EXPECTED_DURATION_MS / 1000)}s after it appeared`,
      !stillThere,
    );

    // --- The click half, on a nudge of its own. ---
    //
    // Everything above has finished with nudge one, so the markers can be
    // cleared and game two - already running, started by the rematch - can
    // earn a fresh one. Clearing both is what the component's own rules
    // require: `wall-game-first-finished-game` is the once-ever gate and
    // `wall-game-account-nudge-shown` the once-per-session one.
    await page.evaluate(`
      localStorage.removeItem("wall-game-first-finished-game");
      sessionStorage.removeItem("wall-game-account-nudge-shown");
    `);
    await playToCountedFinish(page, say);
    await wait(600);
    const secondNudge = Boolean(
      await json(
        page,
        `[...document.querySelectorAll("li")].some((li) => (li.textContent || "").includes(${JSON.stringify(NUDGE_TITLE)}))`,
      ),
    );
    // If this fails the click checks below prove nothing, so it is stated
    // rather than assumed.
    must("a second nudge was earned for the click test", secondNudge);

    const clickedSignUp = await clickByText(page, "Sign up");
    await wait(900);
    const afterSignUp = await eventNames();
    const registerCalls = stub
      .log()
      .filter((line) => line === "GET /api/register");
    say(
      `sign up: clicked=${clickedSignUp} events=${JSON.stringify(afterSignUp)} ` +
        `register=${JSON.stringify(registerCalls)}`,
    );
    must("the nudge's Sign up control was clickable", clickedSignUp);
    must(
      "clicking Sign up counted exactly one account_nudge_signup_click",
      afterSignUp.filter((n) => n === "account_nudge_signup_click").length ===
        1,
      JSON.stringify(afterSignUp),
    );
    // Independent of the analytics stub: the browser really did head for the
    // register endpoint, so the event is not being counted for a click that
    // goes nowhere.
    must(
      "clicking Sign up really requested /api/register",
      registerCalls.length === 1,
      JSON.stringify(stub.log()),
    );

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} of ${checks.length} required invariants failed:\n` +
          failed
            .map((c) => `  - ${c.label}${c.detail ? ` [${c.detail}]` : ""}`)
            .join("\n"),
      );
    }
  } finally {
    page.close();
    chrome.stop();
    stub.stop();
    console.log("\n--- measurements ---");
    findings.forEach((f) => console.log(f));
    console.log("\n--- required invariants ---");
    checks.forEach((c) =>
      console.log(
        `${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.detail ? `  [${c.detail}]` : ""}`,
      ),
    );
    console.log(`screenshots in ${SHOT_DIR}`);
  }
};

await main();
