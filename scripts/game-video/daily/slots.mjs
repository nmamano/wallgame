/**
 * When the approved queue posts (Wall Game Growth's cadence, Nil's review
 * workflow, 2026-10-28). Pure: every function takes the time and the number
 * of approved items, so the timer (scheduler.mjs), GET /api/review/status
 * and the tests all ask the same question in the same way.
 *
 * The rules, in America/Los_Angeles:
 * - A slot every 6 h: 03:00, 09:00, 15:00 and 21:00 every day (Nil through
 *   Growth, 2026-10-30: "i think we can post every 6h"). With no approved
 *   item, the slot is skipped (and Growth hears it).
 * - Never two posts within 6 h. A slot that the gap holds is skipped, and
 *   the next slot posts at its own time, so posts stay on the four slot
 *   times (Growth and Wall Game PM, 2026-10-30): after a post by hand
 *   (slot --now) or a late post, and on the day clocks go forward (21:00
 *   PST to 03:00 PDT is 5 h). A hold of LATE_AFTER_MS or less is not a
 *   skip: the slot waits for the gap and still counts as on time.
 * - A slot that fires on time counts the gap from its slot time (gapFrom),
 *   so the timer's tick does not add up from slot to slot.
 * - A slot that came due while the app was down posts late when the app is
 *   back, and older missed slots fold into the newest one: one post, never a
 *   burst (Wall Game PM, 2026-10-28; Nil wants a post at least once per
 *   24 h, so a late post beats a skip).
 *
 * The state that these functions read is { lastSlotAt, lastPostAt, slots }:
 * the newest slot time that was handled (posted or skipped), the time from
 * which the 6 h gap counts (gapFrom), both ISO strings or null, and the
 * slot list that lastSlotAt was handled under.
 */

export const SLOT_ZONE = "America/Los_Angeles";

/** The slot times, Pacific wall clock. */
export const SLOTS = ["03:00", "09:00", "15:00", "21:00"];

/**
 * The SLOTS entry that a slot instant is, or null for an instant at no slot
 * time (a slot fired by hand).
 * @param {string} slotAt
 */
export const slotTimeOf = (slotAt) => {
  const w = wallClock(Date.parse(slotAt));
  return SLOTS.find((t) => t === `${w.hour}:${w.minute}`) ?? null;
};

/**
 * The platforms that post at some SLOTS entries only (Nil through Growth,
 * ask 90e25f57, 2026-10-31: "TikTok once a day (09:00 PT slot only)"). At
 * the other slots, and at a slot fired by hand (slot --now), they leave the
 * slot's platform set as not applicable: no failure and no retry. When the
 * 09:00 slot is skipped, TikTok gets nothing that day. Each time must be a
 * SLOTS entry: a change of SLOTS that drops it fails here at load, never
 * silently stops the platform.
 */
export const PLATFORM_SLOTS = {
  tiktok: { name: "TikTok", times: ["09:00"] },
};
for (const [platform, { times }] of Object.entries(PLATFORM_SLOTS)) {
  const stray = times.filter((t) => !SLOTS.includes(t));
  if (stray.length) {
    throw new Error(`${platform} posts at ${stray.join(", ")}, not in SLOTS`);
  }
}

/**
 * Why `platform` does not post at this slot (PLATFORM_SLOTS), or null. A
 * late slot keeps its own slot time, so a late 09:00 slot still posts.
 * @param {string} platform
 * @param {{ slotAt: string, firedBy?: string }} slot
 */
export const notInSlot = (platform, { slotAt, firedBy }) => {
  const only = PLATFORM_SLOTS[platform];
  if (!only) return null;
  if (!firedBy && only.times.includes(slotTimeOf(slotAt))) return null;
  return `not in this slot; ${only.name} posts at ${only.times.join(", ")} PT only`;
};

/**
 * Whether a state's recorded slot list is SLOTS. It compares the times
 * only: a change of SLOT_ZONE or of the gap rule does not start the timer
 * again, so such a change must reset the recorded list too (VR1, review 98).
 */
export const sameSlots = (slots) =>
  Array.isArray(slots) && slots.join(",") === SLOTS.join(",");

export const MIN_GAP_MS = 6 * 60 * 60 * 1000;

/** A slot that fires later than this after its time is reported as late. */
export const LATE_AFTER_MS = 5 * 60 * 1000;

/**
 * Slots older than this before now are not listed: a newer one folds them
 * in any case.
 */
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: SLOT_ZONE,
  hourCycle: "h23",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const wallClock = (ms) =>
  Object.fromEntries(
    parts.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );

/** How far the zone's wall clock is ahead of UTC at `ms` (negative in LA). */
const offsetMs = (ms) => {
  const w = wallClock(ms);
  const asUtc = Date.UTC(
    Number(w.year),
    Number(w.month) - 1,
    Number(w.day),
    Number(w.hour),
    Number(w.minute),
    Number(w.second),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
};

/** The calendar day in the zone at `ms`, as YYYY-MM-DD. */
export const pacificDay = (ms) => {
  const w = wallClock(ms);
  return `${w.year}-${w.month}-${w.day}`;
};

/**
 * The instant of the wall-clock time `hhmm` on `day` in the zone. The offset
 * is read twice, at the guess and at the result, so a day on which daylight
 * saving time starts or ends gives the right hour. 03:00 is one hour after
 * the 02:00 change: on 2026-11-01 it is 03:00 PST, on 2027-03-14 03:00 PDT
 * (slots.test.ts).
 */
export const zonedInstant = (day, hhmm) => {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMs(guess);
  return guess - offsetMs(first);
};

/** The calendar day after `day` (YYYY-MM-DD). */
export const nextDay = (day) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** "Thu 2026-10-29 09:00 PT", for messages and the status route. */
export const pacificLabel = (ms) => {
  const w = wallClock(ms);
  return `${w.weekday} ${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute} PT`;
};

/**
 * Every slot time after `fromMs` (exclusive) up to `toMs` (inclusive),
 * oldest first: [{ at, time }].
 */
export const slotsBetween = (fromMs, toMs) => {
  const from = Math.max(fromMs, toMs - LOOKBACK_MS);
  // A clock that stepped back (or a restored state file): nothing is due,
  // and the day loop below would never reach `last`.
  if (from >= toMs) return [];
  const out = [];
  const last = pacificDay(toMs);
  for (let day = pacificDay(from); ; day = nextDay(day)) {
    for (const time of SLOTS) {
      const at = zonedInstant(day, time);
      if (at > from && at <= toMs) out.push({ time, at });
    }
    if (day === last) break;
  }
  return out;
};

const ms = (iso) => (iso ? Date.parse(iso) : null);

/**
 * What the timer does now. One of:
 * - { kind: "start" }: no state yet (first run), or a state handled under
 *   another slot list (a change of SLOTS, or a state from before the list
 *   was recorded): record now as handled, under SLOTS, so slots from before
 *   now never post. Without this, the slot times that a new list puts
 *   between lastSlotAt and now count as missed and post late: the 03:00 PT
 *   slot fired at 07:24 PT when the 6 h list shipped (2026-10-30).
 * - { kind: "wait" }: no slot is due.
 * - { kind: "wait", slot, until }: a slot is due, and the 6 h gap holds it
 *   for LATE_AFTER_MS or less: it fires at `until`.
 * - { kind: "held", slot, folded, through, lastPostAt }: a slot is due, and
 *   the gap holds it longer: it is skipped (the gap counts from
 *   `lastPostAt`).
 * - { kind: "skip", slot, folded, through }: a slot is due and no item is
 *   approved.
 * - { kind: "fire", slot, folded, through }: post the oldest approved item.
 * `through` is the newest due slot time: all due slots are handled with it.
 * `folded` lists the older due slots that this one replaces.
 */
export const decide = (state, nowMs, ready) => {
  const lastSlotAt = ms(state?.lastSlotAt);
  if (lastSlotAt === null || !sameSlots(state.slots)) return { kind: "start" };
  const due = slotsBetween(lastSlotAt, nowMs);
  if (!due.length) return { kind: "wait" };
  const slot = due.at(-1);
  const folded = due.slice(0, -1);
  const through = slot.at;
  if (ready === 0) return { kind: "skip", slot, folded, through };
  const lastPostAt = ms(state.lastPostAt);
  const until = lastPostAt === null ? 0 : lastPostAt + MIN_GAP_MS;
  // A slot that came due while the app was down and is out of the gap now
  // posts late (a late post beats a skip).
  if (nowMs >= until) return { kind: "fire", slot, folded, through };
  return until - slot.at <= LATE_AFTER_MS
    ? { kind: "wait", slot, until }
    : { kind: "held", slot, folded, through, lastPostAt };
};

/** Why a held slot does not post, for the slot message and the status. */
export const heldWhy = (lastPostAt) =>
  `held by the gap: 6 h after the ${pacificLabel(lastPostAt)} post`;

/**
 * The time from which the 6 h gap after a slot post counts: the slot time
 * when the slot fired on time (within LATE_AFTER_MS), else the time it
 * fired. The timer fires up to one tick after a slot; with slots exactly
 * 6 h apart, a gap from the fire time would hold each next slot for that
 * tick, and the delay would add up (about 1 min a day). A late slot (after
 * an outage) counts from when it fired, so the next slot is held if it
 * comes within 6 h of that post.
 * @param {number} slotAtMs
 * @param {number} firedAtMs
 * @returns {number}
 */
export const gapFrom = (slotAtMs, firedAtMs) =>
  firedAtMs - slotAtMs <= LATE_AFTER_MS ? slotAtMs : firedAtMs;

/**
 * The next thing the timer will do, for GET /api/review/status and the
 * slot messages: { slotAt, at, pacific, willPost, why }. `slotAt` is the
 * slot time, `at` the time it will fire (later when the 6 h gap pushes it).
 * `why` says why it will not post, or why it is late; else null.
 */
export const nextSlot = (state, nowMs, ready) => {
  // Before the first run nothing is due (decide says "start").
  const d = state?.lastSlotAt ? decide(state, nowMs, ready) : { kind: "wait" };
  const describe = (slotAt, at, willPost, why) => ({
    slotAt: new Date(slotAt).toISOString(),
    at: new Date(at).toISOString(),
    pacific: pacificLabel(at),
    willPost,
    why,
  });
  if (d.kind === "wait" && d.slot) {
    return describe(
      d.slot.at,
      d.until,
      true,
      "pushed: 6 h after the last post",
    );
  }
  if (d.kind === "held") {
    return describe(d.slot.at, nowMs, false, heldWhy(d.lastPostAt));
  }
  if (d.kind === "fire") return describe(d.slot.at, nowMs, true, null);
  if (d.kind === "skip") {
    return describe(d.slot.at, nowMs, false, "the approved queue is empty");
  }
  // Nothing is due: the first coming slot.
  const from = Math.max(nowMs, ms(state?.lastSlotAt) ?? nowMs);
  const [slot] = slotsBetween(from, from + DAY_MS);
  const lastPostAt = ms(state?.lastPostAt);
  const at = Math.max(
    slot.at,
    lastPostAt === null ? 0 : lastPostAt + MIN_GAP_MS,
  );
  if (ready === 0) {
    return describe(slot.at, at, false, "the approved queue is empty");
  }
  if (lastPostAt !== null && at - slot.at > LATE_AFTER_MS) {
    return describe(slot.at, slot.at, false, heldWhy(lastPostAt));
  }
  return describe(
    slot.at,
    at,
    true,
    at > slot.at ? "pushed: 6 h after the last post" : null,
  );
};
