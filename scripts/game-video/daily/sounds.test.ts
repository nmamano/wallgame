/**
 * The meme sound table and Nil's listening page: every key has a family the
 * director can read, the level the page shows is the level a video plays,
 * and a choice reaches the file the direct step reads.
 */
import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEME_SOUNDS,
  MEME_FAMILIES,
  MEME_SOURCE_NOTES,
  MEME_TARGET_LUFS,
  MEME_TRUE_PEAK_CEILING,
  memeFamily,
  memeGain,
  memeLevel,
} from "../meme-sounds.mjs";
import {
  claimRisk,
  openSoundPicks,
  soundFile,
  soundList,
  defaultSlots,
  MEME_DIR,
  recentVideoSounds,
  soundRepeatNotes,
} from "./sounds.mjs";
import {
  claimRiskLines,
  createDaily,
  dislikedSoundNotes,
  lastMoveSoundNotes,
} from "./routes.mjs";

const tempDir = () => mkdtempSync(join(tmpdir(), "meme-sounds-test-"));
const keys = Object.keys(MEME_SOUNDS) as (keyof typeof MEME_SOUNDS)[];

describe("the sound table", () => {
  test("every key is <family>-<n>, and every family has a moment", () => {
    for (const key of keys) {
      expect(key).toMatch(/^[a-z]+-\d+$/);
      expect(MEME_FAMILIES).toHaveProperty(memeFamily(key));
    }
    expect(new Set(keys.map(memeFamily))).toEqual(
      new Set(Object.keys(MEME_FAMILIES)),
    );
  });

  test("every source note is for a key of the table", () => {
    for (const key of Object.keys(MEME_SOURCE_NOTES)) {
      expect(MEME_SOUNDS).toHaveProperty(key);
    }
  });

  test("the level is the target, or lower where the true peak limits it", () => {
    for (const key of keys) {
      const { truePeak } = MEME_SOUNDS[key];
      const level = memeLevel(key);
      const peak = truePeak + 20 * Math.log10(memeGain(key));
      expect(level).toBeLessThanOrEqual(MEME_TARGET_LUFS + 1e-9);
      expect(peak).toBeLessThanOrEqual(MEME_TRUE_PEAK_CEILING + 1e-9);
      // One of the two limits is reached.
      expect(
        Math.abs(level - MEME_TARGET_LUFS) < 1e-9 ||
          Math.abs(peak - MEME_TRUE_PEAK_CEILING) < 1e-9,
      ).toBe(true);
    }
  });
});

describe("best, ok or disliked", () => {
  test("a choice is saved, cleared by ok, and only for a known sound", () => {
    const root = tempDir();
    const picks = openSoundPicks(root);
    picks.set("boom-1", "best");
    picks.set("oof-2", "disliked");
    expect(picks.disliked()).toEqual(["oof-2"]);
    const saved = JSON.parse(readFileSync(picks.path, "utf8")) as Record<
      string,
      { choice: string }
    >;
    expect(saved["boom-1"].choice).toBe("best");
    picks.set("oof-2", "ok");
    expect(picks.disliked()).toEqual([]);
    expect(picks.read()).not.toHaveProperty("oof-2");
    expect(() => picks.set("boom-99", "best")).toThrow("not known");
    expect(() => picks.set("boom-1", "keep")).toThrow("best, ok, disliked");
    expect(() => picks.set("boom-1", null)).toThrow("best, ok, disliked");
    expect(() => picks.set("toString", "best")).toThrow("not known");
  });

  test("a file of keep and drop is written once as best and disliked", () => {
    const root = tempDir();
    const path = join(root, "sound-picks.json");
    writeFileSync(
      path,
      JSON.stringify({
        "boom-1": { choice: "keep", at: "2026-10-25T10:00:00.000Z" },
        "oof-2": { choice: "drop", at: "2026-10-25T10:01:00.000Z" },
      }),
    );
    const picks = openSoundPicks(root);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      "boom-1": { choice: "best", at: "2026-10-25T10:00:00.000Z" },
      "oof-2": { choice: "disliked", at: "2026-10-25T10:01:00.000Z" },
    });
    expect(picks.disliked()).toEqual(["oof-2"]);
    // A file with the new names is not written again (a write renames a new
    // file over it).
    const before = statSync(path).ino;
    openSoundPicks(root);
    expect(statSync(path).ino).toBe(before);
  });

  test("the VS and finish defaults are labelled, and a dislike of one is allowed", () => {
    const defaults = defaultSlots();
    // Both slots of DEFAULT_SLOT_SOUNDS (edl.mjs), each a table key.
    for (const key of Object.keys(defaults))
      expect(MEME_SOUNDS).toHaveProperty(key);
    const slots = Object.values(defaults).join(" and ").split(" and ").sort();
    expect(slots).toEqual(["the VS card", "the finish"]);

    const picks = openSoundPicks(tempDir());
    const [finish] = Object.entries(defaults).find(([, s]) =>
      s.includes("the finish"),
    )!;
    picks.set(finish, "disliked");
    expect(picks.disliked()).toEqual([finish]);
    const row = soundList(picks.read()).find((s) => s.key === finish);
    expect(row?.defaultFor).toContain("the finish");
  });

  test("the list carries each sound's choice, family and level", () => {
    const list = soundList({ "ding-2": { choice: "best", at: "x" } });
    expect(list.map((s) => s.key)).toEqual(keys);
    const ding = list.find((s) => s.key === "ding-2");
    expect(ding?.choice).toBe("best");
    expect(ding?.family).toBe("ding");
    expect(ding?.moment).toBe(MEME_FAMILIES.ding);
    expect(ding?.level).toBe(memeLevel("ding-2"));
    expect(list.find((s) => s.key === "ding-1")?.choice).toBe("ok");
    expect(list.find((s) => s.key === "bruh-1")?.note).toBe(
      MEME_SOURCE_NOTES["bruh-1"],
    );
    expect(ding?.note).toBeNull();
    expect(ding?.defaultFor).toBeNull();
  });

  test("a file path is only ever a table key's own file", () => {
    expect(soundFile("boom-1")).toBe(join(MEME_DIR, "boom-1.mp3"));
    expect(soundFile("../../etc/passwd")).toBeNull();
    expect(soundFile("boom-1/../../x")).toBeNull();
    expect(soundFile(null)).toBeNull();
  });

  test("the direct step names each event with a disliked sound", () => {
    const edl = {
      events: [
        { ply: 3, kind: "sound", sound: "boom-1" },
        { ply: 4, kind: "zoom", sound: "oof-1" },
        { ply: 5, kind: "laugh" },
      ],
    };
    expect(dislikedSoundNotes(edl, ["oof-1"])).toEqual([
      "ply 4 uses disliked oof-1: Nil's preference, allowed",
    ]);
  });

  test("the direct step names a VS or finish sound Nil disliked, the default too", () => {
    const edl = { vsSound: "boom-1", finishSound: "shotgun-2", events: [] };
    expect(dislikedSoundNotes(edl, ["shotgun-2"])).toEqual([
      "finishSound uses disliked shotgun-2: Nil's preference, allowed",
    ]);
  });
});

describe("a sound on the last move (the capture)", () => {
  test("a warning, not a refusal, when no event on the last move has a sound", () => {
    const warning =
      "WARNING: no sound lands on the last move (ply 40): give it a lead zoom with its sound, or a sound event";
    // 41 moves: the last is ply 40. A sound on ply 39 does not count, and
    // neither does a sound-less event on ply 40.
    expect(
      lastMoveSoundNotes(
        {
          finishSound: "win-1",
          events: [
            { ply: 39, kind: "sound", sound: "boom-1" },
            { ply: 40, kind: "laugh" },
          ],
        },
        41,
      ),
    ).toEqual([warning]);
    // The ending's caption bar opens on the impact, after the capture: its
    // sound does not count.
    expect(
      lastMoveSoundNotes(
        {
          events: [
            {
              ply: 40,
              kind: "overlay",
              form: "bar",
              asset: "ending-caption",
              text: "gg",
              sound: "boom-2",
            },
          ],
        },
        41,
      ),
    ).toEqual([warning]);
    for (const ev of [
      { ply: 40, kind: "zoom", lead: true, sound: "seeya-3" },
      { ply: 40, kind: "sound", sound: "boom-1" },
      { ply: 40, kind: "overlay", form: "clip", sound: "ooh-1" },
      { ply: 40, kind: "freeze", sound: "scratch-1" },
    ]) {
      expect(lastMoveSoundNotes({ events: [ev] }, 41)).toEqual([]);
    }
  });
});

describe("sound repeats across videos (Nil, CASES C33)", () => {
  const made = (
    id: string,
    finishedAt: string,
    sounds: string[],
    state = "approved",
  ) => ({
    id,
    state,
    render: { finishedAt },
    edl: {
      doc: {
        finishSound: "trombone-1",
        events: sounds.map((sound, ply) => ({ ply, kind: "sound", sound })),
      },
    },
  });
  const items = [
    made("v-1", "2026-10-31T10:00:00Z", ["boom-3", "laugh-2"]),
    made("v-2", "2026-10-31T11:00:00Z", ["boom-3", "airhorn-1"], "posted"),
    made("v-3", "2026-10-31T12:00:00Z", ["boom-3", "ooh-1"], "finished"),
    made("v-4", "2026-10-31T13:00:00Z", ["scared-1"], "draft"),
    made("v-5", "2026-10-31T14:00:00Z", ["airhorn-1"]),
    made("v-6", "2026-10-31T15:00:00Z", ["scared-1"], "discarded"),
  ];
  const inReview = (it: { id: string }) => it.id === "v-3";
  const list = (sounds: string[]) => ({
    events: sounds.map((sound) => ({ sound })),
  });

  test("the last 3 made, newest first: in review, approved or posted, not the item itself", () => {
    expect(recentVideoSounds(items, "v-5", inReview).map((r) => r.id)).toEqual([
      "v-3",
      "v-2",
      "v-1",
    ]);
    expect(recentVideoSounds(items, "v-9", inReview).map((r) => r.id)).toEqual([
      "v-5",
      "v-3",
      "v-2",
    ]);
  });

  test("a sound in 2 of the last 3 warns; laugh-2 or scared-1 warns in any of the last 2; the slots never", () => {
    const recent = recentVideoSounds(items, "v-9", inReview);
    const notes = soundRepeatNotes(
      list(["airhorn-1", "ooh-1", "trombone-1", "laugh-2"]),
      recent,
    );
    expect(notes).toEqual([
      "WARNING: airhorn-1 is also in 2 of the last 3 videos (v-5, v-2): Nil hears the repeat (C33); pick another sound",
    ]);
    // boom-3 in v-3 and v-2 (2 of the last 3).
    expect(soundRepeatNotes(list(["boom-3"]), recent)[0]).toContain(
      "boom-3 is also in 2 of the last 3 videos (v-3, v-2)",
    );
    // laugh-2 only in v-1: older than the last 2, so no warning above;
    // with v-1 among the last 2, it warns.
    const older = recentVideoSounds(items.slice(0, 2), "v-9", inReview);
    expect(soundRepeatNotes(list(["laugh-2"]), older)).toEqual([
      "WARNING: laugh-2 is an overused sound, and it is in 1 of the last 2 videos (v-1): Nil hears the repeat (C33); pick another sound",
    ]);
  });
});

describe("claim risk", () => {
  test("only the notes that say high claim risk count, and the list shows it", () => {
    const risky = Object.keys(MEME_SOUNDS).filter((k) => claimRisk(k));
    expect(risky.sort()).toEqual([
      "alert-1",
      "bell-1",
      "bell-2",
      "eternity-1",
      "fail-1",
      "horn-1",
      "laugh-1",
      "pointing-1",
      "pointing-2",
      "reveal-1",
      "shotgun-1",
      "shotgun-4",
      "violin-1",
      "win-2",
      "wow-1",
      "wow-2",
    ]);
    expect(claimRisk("shotgun-1")).toBe(MEME_SOURCE_NOTES["shotgun-1"]);
    expect(claimRisk("boom-2")).toBeNull();
    expect(claimRisk("toString")).toBeNull();
    expect(claimRisk(undefined)).toBeNull();
    // The level is Nil's taste and stays as it is.
    const list = soundList({ "laugh-1": { choice: "best", at: "x" } });
    const laugh = list.find((s) => s.key === "laugh-1");
    expect([laugh?.choice, laugh?.claimRisk]).toEqual(["best", true]);
    expect(list.find((s) => s.key === "laugh-2")?.claimRisk).toBe(false);
  });

  test("a use is refused unless accepted on purpose, then it is a note", () => {
    const edl = {
      vsSound: "shotgun-1",
      finishSound: "shotgun-2",
      events: [
        { ply: 3, kind: "sound", sound: "laugh-1" },
        { ply: 5, kind: "laugh" },
      ],
    };
    expect(claimRiskLines(edl, [])).toEqual({
      problems: [
        "vsSound: shotgun-1: high claim risk: names Fortnite (Epic Games); name another sound (crew.mjs sounds)",
        "ply 3: laugh-1: high claim risk: a clip of The Simpsons; name another sound (crew.mjs sounds)",
      ],
      notes: [],
    });
    expect(claimRiskLines(edl, ["laugh-1", "win-2"])).toEqual({
      problems: [
        "vsSound: shotgun-1: high claim risk: names Fortnite (Epic Games); name another sound (crew.mjs sounds)",
        "claimRiskOk names win-2, but the list does not use it",
      ],
      notes: [
        "ply 3 uses laugh-1 on purpose: high claim risk: a clip of The Simpsons",
      ],
    });
  });
});

describe("the page's routes", () => {
  test("list, choose and refuse through the app", async () => {
    const dir = tempDir();
    const daily = createDaily({ dataDir: dir, env: {} });
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void daily.handle(req, res, url).then((done) => {
        if (!done) res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(`${base}/daily/sounds`);
      expect(page.status).toBe(200);
      expect(await page.text()).not.toContain("innerHTML");

      const post = (body: unknown) =>
        fetch(`${base}/api/daily/sounds`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await post({ key: "sting-2", choice: "best" })).status).toBe(200);
      expect((await post({ key: "nope-1", choice: "best" })).status).toBe(409);
      // A missing choice is refused, not read as a clear.
      expect((await post({ key: "sting-2" })).status).toBe(409);
      const list = (await (await fetch(`${base}/api/daily/sounds`)).json()) as {
        key: string;
        choice: string;
      }[];
      expect(list.find((s) => s.key === "sting-2")?.choice).toBe("best");
      expect(
        JSON.parse(readFileSync(join(dir, "daily/sound-picks.json"), "utf8")),
      ).toHaveProperty("sting-2");

      const missing = await fetch(
        `${base}/api/daily/sounds/file?key=${encodeURIComponent("../x")}`,
      );
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
