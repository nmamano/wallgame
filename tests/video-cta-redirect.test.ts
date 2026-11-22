/**
 * wallgame.io/go, the call to action in the daily videos, answers a 302 to
 * the home page with the video's UTM tags (task 08d6e4ff).
 *
 * Like tests/canonical-host.test.ts, this starts no Postgres and binds no
 * port. Importing the server still reads DATABASE_URL, so an inert one is
 * set below.
 */

import { beforeAll, describe, expect, it } from "bun:test";

let createApp: typeof import("../server/app").createApp;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://inert:inert@127.0.0.1:5432/inert";
  ({ createApp } = await import("../server/app"));
});

const TARGET = "/?utm_source=video&utm_medium=cta&utm_campaign=video-cta";

describe("GET /go", () => {
  for (const path of ["/go", "/go/", "/go?ref=yt", "/go/?utm_source=x"]) {
    it(`${path} answers 302 to the tagged home page`, async () => {
      const res = await createApp().app.request(`https://wallgame.io${path}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(TARGET);
    });
  }

  it("a longer path is not the call to action", async () => {
    const res = await createApp().app.request(
      "https://wallgame.io/go/elsewhere",
    );
    expect(res.status).not.toBe(302);
  });
});

describe("GET /go/<n> (a puzzle video's link)", () => {
  it("an unknown number answers 302 to the tagged home page", async () => {
    const res = await createApp().app.request("https://wallgame.io/go/99999");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TARGET);
  });

  it("a known number opens its puzzle, tagged with the video's item", async () => {
    const { videoPuzzleTarget } =
      await import("../shared/domain/video-puzzles");
    const table = [
      { n: 7, itemId: "v-2026-11-27-1", gameId: "Lnd-f_42", ply: 19 },
    ];
    expect(videoPuzzleTarget(7, table)).toBe(
      `/puzzle/game/Lnd-f_42/19?${TARGET.slice(2)}&utm_content=v-2026-11-27-1`,
    );
    expect(videoPuzzleTarget(8, table)).toBe(TARGET);
  });

  it("every entry of the table is well formed and has its own number", async () => {
    const { VIDEO_PUZZLES } = await import("../shared/domain/video-puzzles");
    const numbers = VIDEO_PUZZLES.map((entry) => entry.n);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const entry of VIDEO_PUZZLES) {
      expect(Number.isInteger(entry.n) && entry.n >= 1).toBe(true);
      expect(Number.isInteger(entry.ply) && entry.ply >= 0).toBe(true);
      expect(entry.gameId).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      expect(entry.itemId).toMatch(/^v-\d{4}-\d{2}-\d{2}-\d+$/);
      // The call to action is at most 30 characters.
      expect(`solve it: wallgame.io/go/${entry.n}`.length).toBeLessThanOrEqual(
        30,
      );
    }
  });
});
