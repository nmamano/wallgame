/**
 * The slot rules (slots.mjs): 03:00, 09:00, 15:00 and 21:00 in
 * America/Los_Angeles across daylight saving time, the 6 h gap (a held slot
 * is skipped) and where it counts from, and missed slots that fold into one
 * late post.
 */
import { describe, expect, test } from "bun:test";
import {
  decide,
  gapFrom,
  heldWhy,
  nextSlot,
  notInSlot,
  PLATFORM_SLOTS,
  slotTimeOf,
  pacificDay,
  pacificLabel,
  SLOTS,
  slotsBetween,
  zonedInstant,
} from "./slots.mjs";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

// 2026-10-29 is PDT (UTC-7); daylight saving time ends on 2026-11-01.
const OCT29_0300 = at("2026-10-29T10:00:00Z");
const OCT29_0900 = at("2026-10-29T16:00:00Z");
const OCT29_1500 = at("2026-10-29T22:00:00Z");
const OCT29_2100 = at("2026-10-30T04:00:00Z");
const OCT28_0900 = at("2026-10-28T16:00:00Z");
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

describe("zone", () => {
  test("the four slots move with daylight saving time", () => {
    expect(zonedInstant("2026-10-29", "03:00")).toBe(OCT29_0300);
    expect(zonedInstant("2026-10-29", "09:00")).toBe(OCT29_0900);
    expect(zonedInstant("2026-10-29", "15:00")).toBe(OCT29_1500);
    expect(zonedInstant("2026-10-29", "21:00")).toBe(OCT29_2100);
    // PST (UTC-8) after 2026-11-01 02:00: 03:00 is one hour after the
    // change, and the 21:00 before it is still PDT.
    expect(iso(zonedInstant("2026-10-31", "21:00"))).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(iso(zonedInstant("2026-11-01", "03:00"))).toBe(
      "2026-11-01T11:00:00.000Z",
    );
    expect(iso(zonedInstant("2026-11-01", "09:00"))).toBe(
      "2026-11-01T17:00:00.000Z",
    );
    // PDT again from 2027-03-14 02:00 (03:00 PDT is the hour after it).
    expect(iso(zonedInstant("2027-03-13", "21:00"))).toBe(
      "2027-03-14T05:00:00.000Z",
    );
    expect(iso(zonedInstant("2027-03-14", "03:00"))).toBe(
      "2027-03-14T10:00:00.000Z",
    );
    expect(iso(zonedInstant("2026-03-07", "09:00"))).toBe(
      "2026-03-07T17:00:00.000Z",
    );
    expect(iso(zonedInstant("2026-03-08", "09:00"))).toBe(
      "2026-03-08T16:00:00.000Z",
    );
  });

  test("the Pacific day and label, not the UTC ones", () => {
    // 2026-10-30 02:00 UTC is still 2026-10-29 in Los Angeles.
    expect(pacificDay(at("2026-10-30T02:00:00Z"))).toBe("2026-10-29");
    expect(pacificLabel(OCT29_0900)).toBe("Thu 2026-10-29 09:00 PT");
  });

  test("slotsBetween: from is exclusive, to inclusive, every 6 h", () => {
    const s = slotsBetween(OCT28_0900, OCT29_0900);
    expect(s.map((x) => iso(x.at))).toEqual([
      "2026-10-28T22:00:00.000Z",
      "2026-10-29T04:00:00.000Z",
      "2026-10-29T10:00:00.000Z",
      "2026-10-29T16:00:00.000Z",
    ]);
    expect(s.map((x) => x.time)).toEqual(["15:00", "21:00", "03:00", "09:00"]);
  });

  test("slotsBetween across both clock changes: four slots a day", () => {
    // Fall: 21:00 PDT to 03:00 PST is 7 h.
    expect(
      slotsBetween(at("2026-10-31T16:00:00Z"), at("2026-11-01T17:00:00Z")).map(
        (x) => iso(x.at),
      ),
    ).toEqual([
      "2026-10-31T22:00:00.000Z",
      "2026-11-01T04:00:00.000Z",
      "2026-11-01T11:00:00.000Z",
      "2026-11-01T17:00:00.000Z",
    ]);
    // Spring: 21:00 PST to 03:00 PDT is 5 h.
    expect(
      slotsBetween(at("2027-03-13T17:00:00Z"), at("2027-03-14T16:00:00Z")).map(
        (x) => iso(x.at),
      ),
    ).toEqual([
      "2027-03-13T23:00:00.000Z",
      "2027-03-14T05:00:00.000Z",
      "2027-03-14T10:00:00.000Z",
      "2027-03-14T16:00:00.000Z",
    ]);
  });
});

describe("gapFrom", () => {
  test("an on-time slot counts from its slot time, a late one from when it fired", () => {
    expect(gapFrom(OCT29_0900, OCT29_0900 + 30_000)).toBe(OCT29_0900);
    expect(gapFrom(OCT29_0900, OCT29_0900 + 5 * MIN)).toBe(OCT29_0900);
    expect(gapFrom(OCT29_0900, OCT29_0900 + 5 * MIN + 1)).toBe(
      OCT29_0900 + 5 * MIN + 1,
    );
  });
});

describe("decide", () => {
  const handled = (ms: number, lastPostMs: number | null = null) => ({
    lastSlotAt: iso(ms),
    lastPostAt: lastPostMs === null ? null : iso(lastPostMs),
    slots: SLOTS,
  });

  test("the first run records now and posts no older slot", () => {
    expect(
      decide({ lastSlotAt: null, lastPostAt: null }, OCT29_0900, 5),
    ).toEqual({
      kind: "start",
    });
  });

  test("a state handled under another slot list starts again from now", () => {
    // The 2026-10-30 ship: handled through the old 16:00 PT slot, and the
    // new list puts 21:00 and 03:00 PT between that and now. They must not
    // post (they did, at 07:24 PT, before this rule).
    const old = {
      lastSlotAt: "2026-10-29T23:00:00.000Z",
      lastPostAt: "2026-10-30T03:12:00.000Z",
    };
    const now = at("2026-10-30T14:24:37Z");
    expect(decide(old, now, 4)).toEqual({ kind: "start" });
    expect(decide({ ...old, slots: ["09:00", "16:00"] }, now, 4)).toEqual({
      kind: "start",
    });
    expect(decide({ ...old, slots: SLOTS }, now, 4)).toMatchObject({
      kind: "fire",
      folded: [{ time: "21:00" }],
    });
    // After the start, the next slot is 09:00 PT, not one from before.
    expect(
      nextSlot({ ...old, lastSlotAt: iso(now), slots: SLOTS }, now, 4),
    ).toMatchObject({ pacific: "Fri 2026-10-30 09:00 PT", willPost: true });
  });

  test("a slot fires with one approved item, and is skipped with none", () => {
    const state = handled(OCT29_0300, OCT29_0300);
    expect(decide(state, OCT29_0900 - 1000, 1).kind).toBe("wait");
    const fire = decide(state, OCT29_0900, 1);
    expect(fire).toMatchObject({
      kind: "fire",
      folded: [],
      through: OCT29_0900,
    });
    expect(fire.slot?.at).toBe(OCT29_0900);
    const skip = decide(state, OCT29_0900 + 30_000, 0);
    expect(skip).toMatchObject({ kind: "skip", through: OCT29_0900 });
  });

  test("each of the four slots posts, whatever the size of the queue", () => {
    for (const [prev, slot] of [
      [OCT29_0300, OCT29_0900],
      [OCT29_0900, OCT29_1500],
      [OCT29_1500, OCT29_2100],
    ]) {
      expect(decide(handled(prev, prev), slot, 1).kind).toBe("fire");
    }
  });

  test("an on-time post 30 s after its slot does not hold the next slot", () => {
    // The timer ticks every 30 s; the gap counts from the slot time.
    const state = handled(OCT29_0900, gapFrom(OCT29_0900, OCT29_0900 + 30_000));
    expect(decide(state, OCT29_1500, 1).kind).toBe("fire");
  });

  test("a slot that the gap holds is skipped, and the next one posts on time", () => {
    // A late post at 05:00 PT (the 03:00 slot, after an outage) holds the
    // 09:00 slot until 11:00 PT: it is skipped, 15:00 posts.
    const lastPost = OCT29_0300 + 2 * HOUR;
    const state = handled(OCT29_0300, lastPost);
    expect(decide(state, OCT29_0900, 1)).toEqual({
      kind: "held",
      slot: { time: "09:00", at: OCT29_0900 },
      folded: [],
      through: OCT29_0900,
      lastPostAt: lastPost,
    });
    expect(decide(handled(OCT29_0900, lastPost), OCT29_1500, 1).kind).toBe(
      "fire",
    );
    // An empty queue is a plain skip, held or not.
    expect(decide(state, OCT29_0900, 0).kind).toBe("skip");
    expect(heldWhy(lastPost)).toBe(
      "held by the gap: 6 h after the Thu 2026-10-29 05:00 PT post",
    );
  });

  test("a slot by hand: the next slot is held, the one after posts on time", () => {
    // slot --now at 12:00 PT: 15:00 is held (skipped), 21:00 posts.
    const byHand = OCT29_0900 + 3 * HOUR;
    expect(decide(handled(OCT29_0900, byHand), OCT29_1500, 1).kind).toBe(
      "held",
    );
    expect(decide(handled(OCT29_1500, byHand), OCT29_2100, 1).kind).toBe(
      "fire",
    );
  });

  test("a hold of 5 min or less waits and fires, as on time", () => {
    // A gap that counted from the fire time (the state before gapFrom):
    // 20 s after 03:00 holds 09:00 for 20 s.
    const lastPost = OCT29_0300 + 20_000;
    const state = handled(OCT29_0300, lastPost);
    expect(decide(state, OCT29_0900, 1)).toMatchObject({
      kind: "wait",
      until: lastPost + 6 * HOUR,
    });
    expect(decide(state, lastPost + 6 * HOUR, 1).kind).toBe("fire");
    expect(gapFrom(OCT29_0900, OCT29_0900 + 50_000)).toBe(OCT29_0900);
  });

  test("a slot that came due while the app was down and is out of the gap now posts late", () => {
    // Last post 05:00 PT; down at 09:00; back at 12:00, after the gap.
    const state = handled(OCT29_0300, OCT29_0300 + 2 * HOUR);
    expect(decide(state, OCT29_0900 + 3 * HOUR, 1).kind).toBe("fire");
  });

  test("spring clock change: 21:00 PST to 03:00 PDT is 5 h, so 03:00 is held and 09:00 posts on time", () => {
    const lastPost = at("2027-03-14T05:00:00Z"); // 21:00 PST, on time
    const held = decide(
      handled(lastPost, lastPost),
      at("2027-03-14T10:00:00Z"),
      1,
    );
    expect(held).toMatchObject({ kind: "held", lastPostAt: lastPost });
    expect(
      decide(
        handled(at("2027-03-14T10:00:00Z"), lastPost),
        at("2027-03-14T16:00:00Z"),
        1,
      ).kind,
    ).toBe("fire");
  });

  test("fall clock change: 21:00 PDT to 03:00 PST is 7 h, so 03:00 posts on time", () => {
    const lastPost = at("2026-11-01T04:00:00Z"); // 21:00 PDT, on time
    const state = handled(lastPost, lastPost);
    expect(decide(state, at("2026-11-01T11:00:00Z"), 1).kind).toBe("fire");
  });

  test("a month of slots fired one tick late: no drift, every slot on time", () => {
    // The timer, as scheduler.mjs runs it, with each slot seen 29 s late.
    const run = (fromIso: string, toIso: string) => {
      let state = handled(at(fromIso), at(fromIso));
      const out: { at: string; kind: string; late: number }[] = [];
      // slotsBetween looks back 2 days at most: list the month a day at a
      // time.
      const slots = [];
      for (let f = at(fromIso); f < at(toIso); f += 24 * HOUR) {
        slots.push(...slotsBetween(f, Math.min(f + 24 * HOUR, at(toIso))));
      }
      for (const slot of slots) {
        const t = slot.at + 29_000;
        // One tick per slot, so the slot it decides on is `slot`.
        const { kind } = decide(state, t, 1);
        out.push({ at: iso(slot.at), kind, late: t - slot.at });
        if (kind === "fire") {
          state = handled(slot.at, gapFrom(slot.at, t));
        } else if (kind === "held") {
          state = { ...state, lastSlotAt: iso(slot.at) };
        }
      }
      return out;
    };
    // 31 days across the fall change (to 09:00 PST = 17:00Z): 124 slots,
    // all posted, none late.
    const fall = run("2026-10-29T16:00:00Z", "2026-11-29T17:00:00Z");
    expect(fall).toHaveLength(124);
    expect(fall.filter((x) => x.kind !== "fire")).toEqual([]);
    expect(Math.max(...fall.map((x) => x.late))).toBe(29_000);
    // Across the spring change: only its 03:00 slot is held.
    const spring = run("2027-03-01T17:00:00Z", "2027-03-31T16:00:00Z");
    expect(spring.filter((x) => x.kind !== "fire")).toEqual([
      { at: "2027-03-14T10:00:00.000Z", kind: "held", late: 29_000 },
    ]);
  });

  test("missed slots fold into one late post", () => {
    // Down from 2026-10-28 09:00 PT to 2026-10-29 11:00 PT.
    const state = handled(OCT28_0900, OCT28_0900);
    const d = decide(state, OCT29_0900 + 2 * HOUR, 1);
    expect(d).toMatchObject({ kind: "fire", through: OCT29_0900 });
    expect(d.slot?.at).toBe(OCT29_0900);
    expect(d.folded?.map((s: { at: number }) => s.at)).toEqual([
      OCT28_0900 + 6 * HOUR,
      OCT28_0900 + 12 * HOUR,
      OCT29_0300,
    ]);
  });

  test("a clock that stepped back across Pacific midnight: nothing due, no hang", () => {
    // Handled through 2026-10-28 01:30 PT; now is 2026-10-27 23:00 PT.
    const state = handled(at("2026-10-28T08:30:00Z"));
    expect(decide(state, at("2026-10-28T06:00:00Z"), 1)).toEqual({
      kind: "wait",
    });
    expect(
      slotsBetween(at("2026-10-28T08:30:00Z"), at("2026-10-28T06:00:00Z")),
    ).toEqual([]);
  });

  test("a long outage gives one post, not one per slot", () => {
    const state = handled(OCT28_0900 - 10 * 24 * HOUR, null);
    const d = decide(state, OCT29_0900 + HOUR, 1);
    expect(d.kind).toBe("fire");
    expect(d.slot?.at).toBe(OCT29_0900);
    expect(d.through).toBe(OCT29_0900);
  });
});

describe("nextSlot", () => {
  const state = {
    lastSlotAt: iso(OCT29_0900),
    lastPostAt: iso(OCT29_0900),
    slots: SLOTS,
  };

  test("the next slot is 6 h after the last one, with any queue", () => {
    expect(nextSlot(state, OCT29_0900 + HOUR, 1)).toEqual({
      slotAt: iso(OCT29_1500),
      at: iso(OCT29_1500),
      pacific: "Thu 2026-10-29 15:00 PT",
      willPost: true,
      why: null,
    });
  });

  test("an empty queue: the next slot does not post", () => {
    expect(nextSlot(state, OCT29_0900 + HOUR, 0)).toMatchObject({
      slotAt: iso(OCT29_1500),
      willPost: false,
      why: "the approved queue is empty",
    });
  });

  test("a slot that the gap will hold shows that it will not post", () => {
    const late = {
      lastSlotAt: iso(OCT29_0900),
      lastPostAt: iso(OCT29_0900 + 2 * HOUR),
      slots: SLOTS,
    };
    expect(nextSlot(late, OCT29_0900 + 3 * HOUR, 1)).toEqual({
      slotAt: iso(OCT29_1500),
      at: iso(OCT29_1500),
      pacific: "Thu 2026-10-29 15:00 PT",
      willPost: false,
      why: "held by the gap: 6 h after the Thu 2026-10-29 11:00 PT post",
    });
    // Due and held.
    expect(nextSlot(late, OCT29_1500 + 1000, 1)).toMatchObject({
      slotAt: iso(OCT29_1500),
      willPost: false,
    });
  });

  test("a hold of 5 min or less: the slot posts when the gap ends", () => {
    const close = {
      lastSlotAt: iso(OCT29_0900),
      lastPostAt: iso(OCT29_0900 + 20_000),
      slots: SLOTS,
    };
    expect(nextSlot(close, OCT29_0900 + HOUR, 1)).toMatchObject({
      slotAt: iso(OCT29_1500),
      at: iso(OCT29_1500 + 20_000),
      willPost: true,
      why: "pushed: 6 h after the last post",
    });
  });

  test("before the first run: the coming slot", () => {
    expect(
      nextSlot({ lastSlotAt: null, lastPostAt: null }, OCT29_0900 - HOUR, 1),
    ).toMatchObject({ slotAt: iso(OCT29_0900), willPost: true, why: null });
  });
});

describe("platforms that post at some slots only", () => {
  const why = "not in this slot; TikTok posts at 09:00 PT only";
  const slotAt = (day: string, hhmm: string) =>
    new Date(zonedInstant(day, hhmm)).toISOString();
  // PDT, the day clocks go back, PST, and the day clocks go forward.
  const DAYS = ["2026-10-31", "2026-11-01", "2026-11-02", "2027-03-14"];

  test("each platform's times are SLOTS entries", () => {
    for (const { times } of Object.values(PLATFORM_SLOTS)) {
      for (const t of times) expect(SLOTS).toContain(t);
    }
  });

  test("a slot instant is its SLOTS entry, across daylight saving time", () => {
    for (const day of DAYS) {
      for (const t of SLOTS) expect(slotTimeOf(slotAt(day, t))).toBe(t);
    }
    expect(slotTimeOf("2026-10-31T16:07:00.000Z")).toBe(null);
    // 09:00 PDT and 09:00 PST are different UTC hours.
    expect(slotAt("2026-10-31", "09:00")).toBe("2026-10-31T16:00:00.000Z");
    expect(slotAt("2026-11-01", "09:00")).toBe("2026-11-01T17:00:00.000Z");
    expect(slotAt("2027-03-14", "09:00")).toBe("2027-03-14T16:00:00.000Z");
  });

  test("TikTok posts at 09:00 PT only, on every day incl. the DST days", () => {
    for (const day of DAYS) {
      for (const t of SLOTS) {
        expect(notInSlot("tiktok", { slotAt: slotAt(day, t) })).toBe(
          t === "09:00" ? null : why,
        );
      }
    }
  });

  test("TikTok leaves a slot fired by hand, even at 09:00", () => {
    expect(
      notInSlot("tiktok", {
        slotAt: slotAt("2026-10-31", "09:00"),
        firedBy: "Nil",
      }),
    ).toBe(why);
  });

  test("other platforms post at every slot", () => {
    for (const p of ["x", "bluesky", "youtube", "instagram", "facebook"]) {
      for (const t of SLOTS) {
        expect(notInSlot(p, { slotAt: slotAt("2026-11-01", t) })).toBe(null);
      }
    }
  });
});
