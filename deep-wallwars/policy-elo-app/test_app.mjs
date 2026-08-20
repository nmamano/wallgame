import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

const APP_URL = "http://127.0.0.1:21007";

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`registered app satisfies its data and UI contract on ${viewport.name}`, async () => {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const response = await page.goto(APP_URL, { waitUntil: "networkidle" });
      assert.equal(response?.ok(), true);
      await page.waitForSelector(".line-toggle:nth-child(2)");

      assert.deepEqual(errors, []);
      assert.equal(await page.locator(".line-toggle").count(), 10);
      assert.equal(await page.locator("#plot path.series").count(), 12);
      assert.equal(await page.locator("#clean-games").textContent(), "23,950");
      assert.equal(await page.locator("#excluded-games").textContent(), "26");
      assert.match(await page.locator("#settings").textContent(), /0 short pairings.*0 clean games needed/s);
      assert.match(await page.locator("#weight-note").textContent(), /fixed lines use 2 deterministic.*Random Start lines use 64–65 independently seeded/s);
      assert.match(await page.locator("#plot").textContent(), /37–92 · NO CONNECTED EVIDENCE/);
      assert.equal(await page.locator("body").evaluate(node => node.scrollWidth <= innerWidth), true);
    } finally {
      await browser.close();
    }
  });
}
