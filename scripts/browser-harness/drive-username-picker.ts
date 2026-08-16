/**
 * Does a player who has never named themselves get asked to, exactly once, and
 * does that dialog stay away from everyone else?
 *
 * The dialog blocks the whole app and cannot be dismissed, so the expensive
 * mistake here is not "it fails to appear" but "it appears when it should not".
 * Two of the six scenarios below exist only to prove absence, and one of them -
 * the settings request FAILING - is the case that would otherwise lock every
 * logged-in player out of the site. A stub server is what makes that case
 * testable at all: it can return a 500 on demand, which a real database cannot.
 *
 * The real built bundle is driven; only the answers behind /api are stubbed.
 *
 * THIS SCRIPT ASSERTS. It prints every reading and exits non-zero if any
 * required invariant failed, so running it against a build without the fix is a
 * measurement rather than a formality - and which lines go red is the evidence
 * that it can see anything at all.
 *
 * Run it: bun run harness:username
 *
 * That script is `bun run build && <this file>`, and the chain is the point: a
 * failed build otherwise leaves the previous bundle in `dist`, and this gate
 * then reports a clean verdict on code that was never loaded.
 */

import { mkdirSync } from "node:fs";
import { launchChrome, connect, wait, type Page } from "./cdp";
import { startStubServer, loggedIn, loggedOut } from "./stub-server";

const SHOT_DIR = "/tmp/wallgame-username-picker";
const PORT = 5181;
const DIALOG = '[data-slot="dialog-content"]';
const TITLE = "Choose your name";

const json = async (page: Page, expression: string) => {
  const raw = await page.evaluate(`JSON.stringify(${expression})`);
  return JSON.parse(String(raw)) as unknown;
};

/** The settings payload, with the one field under test parameterised. */
const settingsBody = (hasChosenDisplayName: boolean) => ({
  displayName: "player_qwertyuiop",
  capitalizedDisplayName: "Player_qwertyuiop",
  hasChosenDisplayName,
  boardTheme: "default",
  pawnColor: "default",
  pawnSettings: [],
  defaultVariant: "standard",
  defaultTimeControl: "rapid",
  defaultRatedStatus: false,
  variantSettings: [],
});

/** Is the picker on screen, and what does it say? */
const readPicker = async (page: Page) =>
  (await json(
    page,
    `(() => {
      const el = document.querySelector(${JSON.stringify(DIALOG)});
      if (!el) return { present: false };
      const box = el.getBoundingClientRect();
      const input = el.querySelector("input");
      const button = el.querySelector("button[type=submit]");
      const alert = el.querySelector("[role=alert]");
      return {
        present: true,
        painted: box.width > 0 && box.height > 0,
        title: el.textContent.includes(${JSON.stringify(TITLE)}),
        closeButtons: el.querySelectorAll("[data-slot=dialog-close]").length,
        inputValue: input ? input.value : null,
        submitDisabled: button ? button.disabled : null,
        error: alert ? alert.textContent : null,
      };
    })()`,
  )) as {
    present: boolean;
    painted?: boolean;
    title?: boolean;
    closeButtons?: number;
    inputValue?: string | null;
    submitDisabled?: boolean | null;
    error?: string | null;
  };

/** Types into the React-controlled input the way a person would. */
const typeName = (page: Page, value: string) =>
  page.evaluate(
    `(() => {
      const input = document.querySelector(${JSON.stringify(DIALOG)} + " input");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`,
  );

const submit = (page: Page) =>
  page.evaluate(
    `document.querySelector(${JSON.stringify(DIALOG)} + " button[type=submit]").click()`,
  );

const failures: string[] = [];
const check = (ok: boolean, label: string, detail: unknown) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(detail)}`);
  if (!ok) failures.push(label);
};

const run = async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const chrome = await launchChrome();
  const page = await connect();

  /** Boots a stub with these routes, loads the home page, returns the reading. */
  const scenario = async (
    name: string,
    routes: Record<string, (req: Request) => unknown>,
    after?: (page: Page) => Promise<void>,
  ) => {
    const stub = startStubServer({ port: PORT, routes });
    try {
      await page.navigate(stub.url + "/");
      await wait(1200);
      if (after) await after(page);
      const reading = await readPicker(page);
      const requests = stub.log();
      console.log(`\n[${name}] requests: ${JSON.stringify(requests)}`);
      return { reading, requests };
    } finally {
      void stub.stop();
    }
  };

  // 1. The subject: a player who has never chosen. The picker must be there,
  //    painted, undismissable, and empty rather than pre-filled with the
  //    generated name.
  {
    const { reading } = await scenario("fresh account", {
      "/api/me": loggedIn,
      "/api/settings": () => settingsBody(false),
    });
    check(reading.present === true, "picker present", reading.present);
    check(reading.painted === true, "picker painted", reading.painted);
    check(reading.title === true, "asks for a name", reading.title);
    check(
      reading.closeButtons === 0,
      "no dismiss control",
      reading.closeButtons,
    );
    check(reading.inputValue === "", "field starts empty", reading.inputValue);
    check(
      reading.submitDisabled === true,
      "cannot continue with an empty name",
      reading.submitDisabled,
    );
    check(
      reading.error === null,
      "no error before any interaction",
      reading.error,
    );
    await page.screenshot(`${SHOT_DIR}/1-fresh-account.png`);
  }

  // 1b. The length rule still speaks once the player has actually touched the
  //     field - suppressing it on the untouched dialog must not mute it.
  {
    const { reading } = await scenario(
      "touched with a too-short name",
      {
        "/api/me": loggedIn,
        "/api/settings": () => settingsBody(false),
      },
      async (p) => {
        await typeName(p, "ab");
        await wait(200);
      },
    );
    check(
      reading.error?.includes("at least 3 characters") === true,
      "min-length error once touched",
      reading.error,
    );
  }

  // 2. Somebody who already named themselves is never interrupted.
  {
    const { reading } = await scenario("already chose", {
      "/api/me": loggedIn,
      "/api/settings": () => settingsBody(true),
    });
    check(reading.present === false, "picker absent", reading.present);
  }

  // 3. THE ONE THAT MATTERS. When the settings request fails there is no
  //    authoritative answer, and an undismissable dialog on a guess would lock
  //    every logged-in player out of the site.
  {
    const { reading } = await scenario("settings request fails", {
      "/api/me": loggedIn,
      "/api/settings": () =>
        new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    });
    check(
      reading.present === false,
      "picker absent on failure",
      reading.present,
    );
    await page.screenshot(`${SHOT_DIR}/3-settings-failure.png`);
  }

  // 4. Guests play without an account and must never see it.
  {
    const { reading } = await scenario("logged out", {
      "/api/me": loggedOut,
      "/api/settings": () => settingsBody(false),
    });
    check(
      reading.present === false,
      "picker absent for guest",
      reading.present,
    );
  }

  // 5. A taken name must say so, readably, and leave the player in the dialog.
  {
    const { reading } = await scenario(
      "name already taken",
      {
        "/api/me": loggedIn,
        "/api/settings": () => settingsBody(false),
        "/api/settings/display-name": () =>
          new Response(
            JSON.stringify({
              error:
                "This display name is already taken. Please choose another one.",
            }),
            { status: 409 },
          ),
      },
      async (p) => {
        await typeName(p, "takenname");
        await wait(200);
        await submit(p);
        await wait(800);
      },
    );
    check(reading.present === true, "still asking", reading.present);
    check(
      reading.error?.includes("already taken") === true,
      "conflict message shown",
      reading.error,
    );
    await page.screenshot(`${SHOT_DIR}/5-name-taken.png`);
  }

  // 6. Choosing a name closes it, and closes it on the mutation's OWN answer.
  //
  //    The success path invalidates the settings query, so a refetch follows.
  //    The risk the two cases below cover is that the dialog depends on that
  //    refetch: it blocks the whole app, so a refetch that never delivers would
  //    strand the player in it after a write that already succeeded.
  //
  //    NOT TESTED, because it cannot happen: a refetch that SUCCEEDS and
  //    contradicts the write. The same row answers both, so the server cannot
  //    accept a name and then report nobody chose one. An earlier version of
  //    this script asserted that case, and it failed for exactly the reason it
  //    should have - the fresh read wins, by design.
  const choseName = async (p: Page) => {
    await typeName(p, "CoolName");
    await wait(200);
    await submit(p);
    await wait(1400);
  };
  const acceptTheName = () => ({
    success: true,
    displayName: "coolname",
    capitalizedDisplayName: "CoolName",
    hasChosenDisplayName: true,
  });

  // 6a. The refetch FAILS. If the dialog waited for it, it would stay forever.
  {
    let reads = 0;
    const { reading, requests } = await scenario(
      "chosen, then the refetch fails",
      {
        "/api/me": loggedIn,
        "/api/settings": () => {
          reads += 1;
          return reads === 1
            ? settingsBody(false)
            : new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        },
        "/api/settings/display-name": acceptTheName,
      },
      choseName,
    );
    check(
      requests.filter((r) => r === "GET /api/settings").length >= 2,
      "a refetch really was attempted",
      requests.filter((r) => r === "GET /api/settings").length,
    );
    check(
      reading.present === false,
      "picker closes even though the refetch failed",
      reading.present,
    );
    await page.screenshot(`${SHOT_DIR}/6-after-choosing.png`);
  }

  // 6b. The ordinary case: the refetch lands and agrees.
  {
    let reads = 0;
    const { reading } = await scenario(
      "chosen, refetch agrees",
      {
        "/api/me": loggedIn,
        "/api/settings": () => {
          reads += 1;
          return settingsBody(reads > 1);
        },
        "/api/settings/display-name": acceptTheName,
      },
      choseName,
    );
    check(reading.present === false, "picker stays closed", reading.present);
  }

  page.close();
  chrome.stop();

  console.log(`\nscreenshots: ${SHOT_DIR}`);
  if (failures.length) {
    console.log(`\nGATE FAIL (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nGATE PASS");
  process.exit(0);
};

await run();
