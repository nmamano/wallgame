/**
 * When the approved queue posts (Wall Game Growth's cadence, Nil's review
 * workflow, 2026-10-28). Pure: every function takes the time and the number
 * of approved items, so the timer (scheduler.mjs), GET /api/review/status
 * and the tests all ask the same question in the same way.
 *
 * The rules, in America/Los_Angeles:
 * - 09:00 every day. With no approved item, the slot is skipped (and Growth
 *   hears it).
 * - 16:00 only while 3 or more approved items wait at that time. With fewer,
 *   16:00 is not a slot at all: nothing posts and nobody hears of it.
 * - Never two posts within 6 h: a due slot waits until 6 h after the last
 *   post (a late post pushes the next).
 * - A slot that came due while the app was down posts late when the app is
 *   back, and older missed slots fold into the newest one: one post, never a
 *   burst (Wall Game PM, 2026-10-28; Nil wants a post at least once per
 *   24 h, so a late post beats a skip).
 *
 * The state that these functions read is { lastSlotAt, lastPostAt } (ISO
 * strings or null): the newest slot time that was handled (posted, skipped
 * or passed), and the time of the last slot post.
 */

export const SLOT_ZONE = "America/Los_Angeles";

/**
 * `always`: the slot counts with any number of approved items. Otherwise it
 * counts only while `whileReady` or more approved items wait.
 */
export const SLOTS = [
  { time: "09:00", always: true, whileReady: 1 },
  { time: "16:00", always: false, whileReady: 3 },
];

export const MIN_GAP_MS = 6 * 60 * 60 * 1000;

/** A slot that fires later than this after its time is reported as late. */
export const LATE_AFTER_MS = 5 * 60 * 1000;

/**
 * Slots older than this before now are not listed: the 09:00 slot counts
 * always, so a newer one folds them in any case.
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
 * saving time starts or ends gives the right hour (09:00 and 16:00 are far
 * from the 02:00 change).
 */
export const zonedInstant = (day, hhmm) => {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMs(guess);
  return guess - offsetMs(first);
};

const nextDay = (day) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** "Thu 2026-10-29 09:00 PT", for messages and the status route. */
export const pacificLabel = (ms) => {
  const w = wallClock(ms);
  return `${w.weekday} ${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute} PT`;
};

/**
 * Every slot time after `fromMs` (exclusive) up to `toMs` (inclusive),
 * oldest first: [{ at, time, always, whileReady }].
 */
export const slotsBetween = (fromMs, toMs) => {
  const from = Math.max(fromMs, toMs - LOOKBACK_MS);
  // A clock that stepped back (or a restored state file): nothing is due,
  // and the day loop below would never reach `last`.
  if (from >= toMs) return [];
  const out = [];
  const last = pacificDay(toMs);
  for (let day = pacificDay(from); ; day = nextDay(day)) {
    for (const slot of SLOTS) {
      const at = zonedInstant(day, slot.time);
      if (at > from && at <= toMs) out.push({ ...slot, at });
    }
    if (day === last) break;
  }
  return out;
};

const counts = (slot, ready) => slot.always || ready >= slot.whileReady;

const ms = (iso) => (iso ? Date.parse(iso) : null);

/**
 * What the timer does now. One of:
 * - { kind: "start" }: no state yet (first run): record now as handled, so
 *   slots from before the first run never post.
 * - { kind: "wait" }: no slot is due.
 * - { kind: "wait", slot, until }: a slot is due, but the 6 h gap holds it.
 * - { kind: "pass", through }: only 16:00 slots with too few approved items
 *   came due; mark them handled, no post, no message.
 * - { kind: "skip", slot, folded, through }: a slot is due and no item is
 *   approved.
 * - { kind: "fire", slot, folded, through }: post the oldest approved item.
 * `through` is the newest due slot time: all due slots are handled with it.
 * `folded` lists the older due slots that this one replaces.
 */
export const decide = (state, nowMs, ready) => {
  const lastSlotAt = ms(state?.lastSlotAt);
  if (lastSlotAt === null) return { kind: "start" };
  const due = slotsBetween(lastSlotAt, nowMs);
  const counting = due.filter((s) => counts(s, ready));
  if (!counting.length) {
    return due.length
      ? { kind: "pass", through: due.at(-1).at }
      : { kind: "wait" };
  }
  const slot = counting.at(-1);
  const folded = counting.slice(0, -1);
  const through = due.at(-1).at;
  if (ready === 0) return { kind: "skip", slot, folded, through };
  const lastPostAt = ms(state.lastPostAt);
  const until = lastPostAt === null ? 0 : lastPostAt + MIN_GAP_MS;
  if (nowMs < until) return { kind: "wait", slot, until };
  return { kind: "fire", slot, folded, through };
};

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
  if (d.kind === "fire") return describe(d.slot.at, nowMs, true, null);
  if (d.kind === "skip") {
    return describe(d.slot.at, nowMs, false, "the approved queue is empty");
  }
  // Nothing is due: the first coming slot that counts with today's queue.
  const from = Math.max(nowMs, ms(state?.lastSlotAt) ?? nowMs);
  const slot = slotsBetween(from, from + 2 * DAY_MS).find((s) =>
    counts(s, ready),
  );
  const lastPostAt = ms(state?.lastPostAt);
  const at = Math.max(
    slot.at,
    lastPostAt === null ? 0 : lastPostAt + MIN_GAP_MS,
  );
  if (ready === 0) {
    return describe(slot.at, at, false, "the approved queue is empty");
  }
  return describe(
    slot.at,
    at,
    true,
    at > slot.at ? "pushed: 6 h after the last post" : null,
  );
};
