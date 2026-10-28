/**
 * The slot rules (slots.mjs): 09:00 and 16:00 in America/Los_Angeles
 * across daylight saving time, 16:00 only with 3+ approved items, the 6 h
 * gap, and missed slots that fold into one late post.
 */
import { describe, expect, test } from "bun:test";
import {
  decide,
  nextSlot,
  pacificDay,
  pacificLabel,
  slotsBetween,
  zonedInstant,
} from "./slots.mjs";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

// 2026-10-29 is PDT (UTC-7); daylight saving time ends on 2026-11-01.
const OCT29_0900 = at("2026-10-29T16:00:00Z");
const OCT29_1600 = at("2026-10-29T23:00:00Z");
const OCT28_0900 = at("2026-10-28T16:00:00Z");
const HOUR = 60 * 60 * 1000;

describe("zone", () => {
  test("09:00 and 16:00 move with daylight saving time", () => {
    expect(zonedInstant("2026-10-29", "09:00")).toBe(OCT29_0900);
    expect(zonedInstant("2026-10-29", "16:00")).toBe(OCT29_1600);
    // PST (UTC-8) after 2026-11-01 02:00.
    expect(iso(zonedInstant("2026-11-01", "09:00"))).toBe(
      "2026-11-01T17:00:00.000Z",
    );
    // PDT again from 2026-03-08 02:00.
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

  test("slotsBetween: from is exclusive, to inclusive", () => {
    const s = slotsBetween(OCT28_0900, OCT29_0900);
    expect(s.map((x) => iso(x.at))).toEqual([
      "2026-10-28T23:00:00.000Z",
      "2026-10-29T16:00:00.000Z",
    ]);
  });
});

describe("decide", () => {
  const handled = (ms: number, lastPostMs: number | null = null) => ({
    lastSlotAt: iso(ms),
    lastPostAt: lastPostMs === null ? null : iso(lastPostMs),
  });

  test("the first run records now and posts no older slot", () => {
    expect(
      decide({ lastSlotAt: null, lastPostAt: null }, OCT29_0900, 5),
    ).toEqual({
      kind: "start",
    });
  });

  test("09:00 fires with one approved item, and is skipped with none", () => {
    const state = handled(OCT28_0900 + 8 * HOUR, OCT28_0900);
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

  test("16:00 is a slot only with 3 or more approved items", () => {
    const state = handled(OCT29_0900, OCT29_0900);
    expect(decide(state, OCT29_1600, 2)).toEqual({
      kind: "pass",
      through: OCT29_1600,
    });
    // An empty queue at 16:00 is not a skipped slot either.
    expect(decide(state, OCT29_1600, 0).kind).toBe("pass");
    expect(decide(state, OCT29_1600, 3).kind).toBe("fire");
  });

  test("the 6 h gap pushes a slot, and it fires when the gap ends", () => {
    // A late post at 04:00 PT holds the 09:00 slot until 10:00 PT.
    const lastPost = OCT29_0900 - 5 * HOUR;
    const state = handled(OCT28_0900 + 7 * HOUR, lastPost);
    const held = decide(state, OCT29_0900, 1);
    expect(held).toMatchObject({ kind: "wait", until: lastPost + 6 * HOUR });
    expect(held.slot?.at).toBe(OCT29_0900);
    expect(decide(state, lastPost + 6 * HOUR, 1).kind).toBe("fire");
    // A queue that empties while the slot waits gives a skip.
    expect(decide(state, OCT29_0900 + 30 * 60_000, 0).kind).toBe("skip");
  });

  test("a late post pushes the next slot", () => {
    // 09:00 posted at 11:00 PT: 16:00 waits until 17:00 PT.
    const lastPost = OCT29_0900 + 2 * HOUR;
    const state = handled(OCT29_0900, lastPost);
    expect(decide(state, OCT29_1600, 3)).toMatchObject({
      kind: "wait",
      until: lastPost + 6 * HOUR,
    });
  });

  test("missed slots fold into one late post", () => {
    // Down from 2026-10-28 09:00 PT to 2026-10-29 11:00 PT.
    const state = handled(OCT28_0900, OCT28_0900);
    const now = OCT29_0900 + 2 * HOUR;
    const few = decide(state, now, 1);
    expect(few).toMatchObject({ kind: "fire", folded: [] });
    expect(few.slot?.at).toBe(OCT29_0900);
    const many = decide(state, now, 3);
    expect(many.kind).toBe("fire");
    expect(many.slot?.at).toBe(OCT29_0900);
    expect(many.folded?.map((s: { at: number }) => s.at)).toEqual([
      OCT28_0900 + 7 * HOUR,
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

  test("a long outage gives one post, not one per day", () => {
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
  };

  test("16:00 with 3 ready, else the next 09:00", () => {
    const now = OCT29_0900 + HOUR;
    expect(nextSlot(state, now, 3)).toEqual({
      slotAt: iso(OCT29_1600),
      at: iso(OCT29_1600),
      pacific: "Thu 2026-10-29 16:00 PT",
      willPost: true,
      why: null,
    });
    expect(nextSlot(state, now, 2)).toMatchObject({
      slotAt: "2026-10-30T16:00:00.000Z",
      willPost: true,
    });
  });

  test("an empty queue: the next 09:00 does not post", () => {
    expect(nextSlot(state, OCT29_0900 + HOUR, 0)).toMatchObject({
      slotAt: "2026-10-30T16:00:00.000Z",
      willPost: false,
      why: "the approved queue is empty",
    });
  });

  test("a pushed slot shows the time it will fire", () => {
    const late = {
      lastSlotAt: iso(OCT29_0900),
      lastPostAt: iso(OCT29_0900 + 2 * HOUR),
    };
    expect(nextSlot(late, OCT29_0900 + 3 * HOUR, 3)).toMatchObject({
      slotAt: iso(OCT29_1600),
      at: iso(OCT29_0900 + 8 * HOUR),
      pacific: "Thu 2026-10-29 17:00 PT",
      willPost: true,
      why: "pushed: 6 h after the last post",
    });
    // Due and held by the gap.
    expect(nextSlot(late, OCT29_1600 + 1000, 3)).toMatchObject({
      at: iso(OCT29_0900 + 8 * HOUR),
      willPost: true,
    });
  });

  test("before the first run: the coming slot", () => {
    expect(
      nextSlot({ lastSlotAt: null, lastPostAt: null }, OCT29_0900 - HOUR, 1),
    ).toMatchObject({ slotAt: iso(OCT29_0900), willPost: true, why: null });
  });
});
