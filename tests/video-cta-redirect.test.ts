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
