/**
 * The Social tab (social.mjs): the follower history keeps one row per
 * platform per UTC day and never rewrites a row; the view shows the app's
 * live mode over the file's status, the dry-run reasons, secret names, and
 * links only to https addresses.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFollowerHistory, socialView } from "./social.mjs";

const DAY = Date.parse("2026-10-30T09:00:00Z");

describe("the follower history", () => {
  test("one row per platform per UTC day; the moved rows stay as they were", () => {
    const path = join(mkdtempSync(join(tmpdir(), "social-")), "f.jsonl");
    // As moved from wallgame-social: rows with their own key order.
    const moved =
      '{"day":"2026-10-28","platform":"bluesky","followers":0,"at":"2026-10-28T04:31:25.097Z"}\n';
    writeFileSync(path, moved);
    const h = createFollowerHistory(path);
    const at = "2026-10-30T08:59:00.000Z";
    h.record(
      {
        bluesky: { followers: 3, at, error: null },
        x: { followers: null, at, error: "no key" },
      },
      DAY,
    );
    // Later the same day: no second row, even with a new count.
    h.record({ bluesky: { followers: 4, at, error: null } }, DAY + 3600e3);
    // No counts (a post ran): nothing.
    h.record(null, DAY);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith(moved)).toBe(true);
    expect(h.read()).toEqual([
      {
        day: "2026-10-28",
        platform: "bluesky",
        followers: 0,
        at: "2026-10-28T04:31:25.097Z",
      },
      { day: "2026-10-30", platform: "bluesky", followers: 3, at },
    ]);
    // The next UTC day gets its own row.
    h.record({ bluesky: { followers: 5, at, error: null } }, DAY + 864e5);
    expect(h.read().map((r) => [r.day, r.followers])).toEqual([
      ["2026-10-28", 0],
      ["2026-10-30", 3],
      ["2026-10-31", 5],
    ]);
  });
});

const DATA = {
  updated: "2026-10-30",
  updatedBy: "Wall Game Growth",
  flow: "the flow",
  root: { name: "root", why: "why.", credentials: "Nil", twoFactor: "app" },
  roles: [{ role: "Posts", who: "the game-video app" }],
  later: ["Pinterest"],
  log: [{ at: "2026-10-30", what: "a change" }],
  platforms: [
    {
      id: "bluesky",
      name: "Bluesky",
      status: "ready",
      handle: "@wallgame.io",
      url: "https://bsky.app/profile/wallgame.io",
      keys: ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"],
      owners: { setup: "Growth" },
      next: [{ who: "Nil", what: "add the key", nil: true }],
      asks: ["a1"],
      profile: { bio: "ok", banner: "to do" },
    },
    {
      id: "x",
      name: "X",
      status: "setup",
      handle: "@wallgame",
      url: "javascript:alert(1)",
      keys: [],
    },
    { id: "mastodon", name: "Mastodon", status: "skipped" },
  ],
};

describe("socialView", () => {
  test("the app's mode over the file's status, reasons, secret names, https links only", () => {
    const v = socialView({
      data: DATA,
      modes: { bluesky: "live", x: "dry-run" },
      reasons: { x: ["X_API_KEY is not set"] },
      live: [
        {
          platform: "bluesky",
          utc: "2026-10-30T03:14:00.000Z",
          url: "https://bsky.app/post/1",
        },
      ],
      dry: [],
      followers: {
        bluesky: { followers: 7, at: "", error: null },
        x: { followers: null, at: "", error: "no key" },
      },
      history: [
        { day: "2026-10-23", platform: "bluesky", followers: 1 },
        { day: "2026-10-29", platform: "bluesky", followers: 5 },
      ],
      nowMs: DAY,
    });
    // Skipped platforms do not count.
    expect(v.stats[0]).toEqual({
      value: "1 / 2",
      label: "platforms posting live",
    });
    const [bluesky, x] = v.cards;
    expect(bluesky.status.label).toBe("Live");
    expect(x.status.label).toBe("Setup in progress");
    const row = (c: typeof bluesky, k: string) =>
      c.rows.find((r) => r.k === k)!;
    expect(row(x, "Poster mode now").v).toBe(
      "dry-run (nothing is posted: X_API_KEY is not set)",
    );
    expect(row(bluesky, "Keys (secret names on the game-video app)")).toEqual({
      k: "Keys (secret names on the game-video app)",
      v: "",
      codes: ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"],
    });
    expect(row(bluesky, "Account").href).toBe(
      "https://bsky.app/profile/wallgame.io",
    );
    expect(row(x, "Account").href).toBeNull();
    expect(row(bluesky, "Last post")).toMatchObject({
      v: "2026-10-30 03:14 UTC",
      href: "https://bsky.app/post/1",
    });
    expect(bluesky.profile).toEqual([
      { k: "bio", v: "ok", tone: "ok" },
      { k: "banner", v: "to do", tone: "todo" },
    ]);
    expect(v.nilSteps).toEqual([
      { platform: "Bluesky", what: "add the key", asks: ["a1"] },
    ]);
    // 7 now; 5 a day ago; 1 a week ago.
    expect(v.followers!.rows[0]).toEqual({
      platform: "Bluesky",
      now: 7,
      day: "+2",
      week: "+6",
      note: "",
    });
    expect(v.followers!.rows[1]).toMatchObject({ now: "-", note: "no key" });
    expect(v.followers!.note).toContain("since 2026-10-23");
  });
});
