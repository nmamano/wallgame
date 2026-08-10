/**
 * Drives the real /play bundle to answer two questions that source reading
 * cannot (board task 5f302c24).
 *
 * 1. WHAT DOES A PLAYER SEE WHEN NO OFFICIAL BOT IS LISTED? Before this change
 *    the vs-AI panel said "No bots match your current settings." — it blamed
 *    the player's settings for a bot-client outage. Three stubbed listings are
 *    driven, because the condition has three cases and only one of them is
 *    "empty":
 *      S1 no bots at all      -> the availability message
 *      S2 a custom bot only   -> the availability message, WITH the custom row
 *                                still listed and playable
 *      S3 an official bot     -> unchanged; the control that must not move
 *
 * 2. CAN A PLAYER STILL PICK A BOARD HEIGHT NO OFFICIAL BOT PLAYS? Every
 *    official bot caps height at 10 while the picker offered 12, so heights 11
 *    and 12 produced an empty list with nothing wrong. Counted straight off the
 *    DOM: how many size cells exist for those heights.
 *
 *    Counted rather than photographed, deliberately. An earlier version also
 *    screenshotted the open picker, and the file it wrote turned out to be
 *    byte-identical to the empty-panel shot — the popover was queryable in the
 *    DOM but never painted into the capture. A picture that shows the wrong
 *    thing is worse than no picture, and the counts are the actual evidence.
 *
 * Run it:
 *   bun run harness:bots
 *
 * That script is `bun run build && <this file>`. The chain matters: driving a
 * stale `dist` measures the previous commit and reads exactly like a defect.
 */

import { connect, launchChrome, wait } from "./cdp";
import { loggedOut, startStubServer } from "./stub-server";

const DESKTOP = { width: 1280, height: 900 };
const BASE = "http://127.0.0.1:5180";

/** A listing row shaped like the server's ListedBot. */
const listed = (id: string, name: string, isOfficial: boolean) => ({
  id,
  botId: id,
  name,
  isOfficial,
  username: null,
});

const recommended = (id: string, name: string, isOfficial: boolean) => ({
  bot: listed(id, name, isOfficial),
  boardWidth: 8,
  boardHeight: 8,
});

interface Scenario {
  key: string;
  what: string;
  bots: ReturnType<typeof listed>[];
}

const SCENARIOS: Scenario[] = [
  { key: "s1-no-bots", what: "no bots at all", bots: [] },
  {
    key: "s2-custom-only",
    what: "a custom bot, no official one",
    bots: [listed("someones-bot", "Someone's Bot", false)],
  },
  {
    key: "s3-official",
    what: "an official bot present (control)",
    bots: [listed("dw-transformer", "Superhuman Bot", true)],
  },
];

const findings: string[] = [];
const say = (line: string) => {
  findings.push(line);
  console.log(line);
};

const chrome = await launchChrome(DESKTOP);
const page = await connect();

for (const scenario of SCENARIOS) {
  const stub = startStubServer({
    routes: {
      "/api/me": loggedOut,
      "/api/bots": () => ({ bots: scenario.bots }),
      "/api/bots/recommended": () => ({
        bots: scenario.bots.map((b) => recommended(b.id, b.name, b.isOfficial)),
      }),
      "/api/games/matchmaking": () => ({ games: [] }),
      "/api/settings": () => ({ settings: null }),
    },
  });

  await page.navigate(`${BASE}/play?mode=vs-ai`);
  await wait(1200);

  // Read the panel as a player would: the text on screen, and whether the
  // custom row survived.
  const panel = (await page.evaluate(`(() => {
    const text = document.body.innerText;
    const rows = Array.from(document.querySelectorAll("tbody tr"))
      .map((tr) => tr.innerText.replace(/\\s+/g, " ").trim())
      .filter(Boolean);
    return JSON.stringify({
      saysUnavailable: text.includes("No official bot is available right now"),
      saysSettingsBlame:
        text.includes("No bots match your current settings") ||
        text.includes("No recommended bots for these settings"),
      rows,
    });
  })()`)) as string;

  const seen = JSON.parse(panel) as {
    saysUnavailable: boolean;
    saysSettingsBlame: boolean;
    rows: string[];
  };

  say(`\n[${scenario.key}] ${scenario.what}`);
  say(`  availability message shown: ${seen.saysUnavailable}`);
  say(`  settings-blaming text shown: ${seen.saysSettingsBlame}`);
  say(`  rows on screen: ${JSON.stringify(seen.rows)}`);

  await page.screenshot(`ops-private/bots-${scenario.key}.png`);
  void stub.stop();
}

// --- The board-size picker ---------------------------------------------------
// Counted rather than eyeballed: a screenshot of a grid does not tell you which
// sizes are still clickable.
const stub = startStubServer({
  routes: {
    "/api/me": loggedOut,
    "/api/bots": () => ({ bots: [] }),
    "/api/bots/recommended": () => ({ bots: [] }),
    "/api/games/matchmaking": () => ({ games: [] }),
    "/api/settings": () => ({ settings: null }),
  },
});

await page.navigate(`${BASE}/play?mode=vs-ai`);
await wait(1200);

const sizes = (await page.evaluate(`(() => {
  // The picker lives behind a popover; its trigger is the only button showing
  // an NxM label in the settings row.
  const trigger = Array.from(document.querySelectorAll("button"))
    .find((b) => /^\\d+\\s*[x\\u00d7]\\s*\\d+$/.test(b.textContent.trim()));
  if (!trigger) return JSON.stringify({ error: "no size picker trigger found" });
  trigger.click();
  return "opened";
})()`)) as string;

if (sizes !== "opened") {
  say(`\n[picker] ${sizes}`);
} else {
  await wait(400);
  const cells = (await page.evaluate(`(() => {
    const labels = Array.from(document.querySelectorAll("[aria-label]"))
      .map((el) => el.getAttribute("aria-label"))
      .filter((l) => /^\\d+\\u00d7\\d+$/.test(l));
    const heights = labels.map((l) => Number(l.split("\\u00d7")[1]));
    return JSON.stringify({
      total: labels.length,
      maxHeight: heights.length ? Math.max(...heights) : 0,
      aboveTen: heights.filter((h) => h > 10).length,
    });
  })()`)) as string;

  const grid = JSON.parse(cells) as {
    total: number;
    maxHeight: number;
    aboveTen: number;
  };
  say(`\n[picker] selectable size cells: ${grid.total}`);
  say(`[picker] tallest selectable height: ${grid.maxHeight}`);
  say(`[picker] cells taller than 10: ${grid.aboveTen}`);
}

void stub.stop();
page.close();
chrome.stop();

console.log("\n--- summary ---");
console.log(findings.join("\n"));
