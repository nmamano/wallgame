/**
 * The slot timer of the approved queue (Nil's review workflow,
 * 2026-10-28). It runs in the game-video app: a tick at start and then every
 * TICK_MS. Each tick reads the state file, asks slots.mjs `decide` what is
 * due, and posts the oldest approved item, skips the slot, or waits. No time
 * is held only in memory, so an app restart or a box restart loses nothing:
 * the app is a systemd user service and comes back on its own.
 *
 * The state file, <data>/daily/schedule.json:
 *   { lastSlotAt, lastPostAt, lastSlot, outbox }
 * - lastSlotAt: the newest slot time that was handled (slots.mjs).
 * - lastPostAt: when the last slot post started; the 6 h gap counts from it.
 * - lastSlot: { slotAt, firedAt, itemId, outcome, platforms, notApplicable,
 *   folded } of the last slot that posted or was skipped; notApplicable is
 *   {platform: reason} of the live platforms that the video does not suit.
 * - outbox: messages to Wall Game Growth not yet sent; each tick tries them
 *   again, so an office that is down loses no message.
 *
 * A slot is written as handled BEFORE its first request goes out, so a crash
 * during a post never fires the same slot twice. The item that was posting
 * then goes to post-failed (`recover`), with its "may already have this
 * post" marks, and Growth hears of it.
 *
 * Retries are by hand (Growth, POST /api/daily/post): a post-failed item
 * leaves the queue and a retry does not use a slot (Wall Game PM,
 * 2026-10-28). The timer only ever posts approved items.
 *
 * A slot by hand (fireNow; Nil through Growth, 2026-10-30: "one could go
 * out now") is a timed slot fired now: the same fire() step, so the same
 * item, checks, platforms, message and 6 h gap. It leaves lastSlotAt, so
 * the timed slots come as before.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomic } from "./store.mjs";
import {
  decide,
  nextSlot,
  pacificDay,
  pacificLabel,
  LATE_AFTER_MS,
  MIN_GAP_MS,
} from "./slots.mjs";

export const TICK_MS = 30 * 1000;

/** Wall Game Growth: it hears every slot (Nil's review workflow, 2026-10-28). */
export const GROWTH_AGENT_ID = "agent-1792966148239-zvmt";

const EMPTY = {
  lastSlotAt: null,
  lastPostAt: null,
  lastSlot: null,
  outbox: [],
};

const iso = (ms) => new Date(ms).toISOString();

/**
 * One platform's result as a message line. `uncertain` and `pending` both
 * mean the post may exist: a person checks before a retry.
 */
const resultLine = (platform, r) => {
  if (!r) return `- ${platform}: not tried`;
  if (r.ok === true) {
    const where = r.url ?? r.postId ?? "";
    return platform === "tiktok"
      ? `- tiktok: inbox draft${where ? ` ${where}` : ""}`
      : `- ${platform}: posted${where ? ` ${where}` : ""}`;
  }
  if (r.pending || r.uncertain) {
    return `- ${platform}: UNCERTAIN, the post may exist; check the account before a retry${r.error ? ` (${r.error})` : ""}`;
  }
  return `- ${platform}: FAILED (${r.error ?? "no reason"})`;
};

/**
 * The lines of the platforms that do not apply to an item's video
 * (posting.notApplicable, review-post.mjs): not a failure, so no retry.
 * @param {Record<string, string> | null | undefined} notApplicable
 */
const notApplicableLines = (notApplicable) =>
  Object.entries(notApplicable ?? {}).map(
    ([p, why]) => `- ${p}: not applicable, nothing to retry (${why})`,
  );

/**
 * @param {object} deps
 * @param {string} deps.statePath
 * @param {() => number} [deps.now]
 * @param {{ approvedQueue: () => any[], counts: () => object,
 *   items: (q?: { states?: string[] }) => any[] }} deps.store
 * @param {() => string[]} deps.livePlatforms the platforms that post live now
 * @param {() => boolean} deps.busy a manual post or another post-like run
 * @param {(slot: { slotAt: string }) => Promise<{ kind: string,
 *   itemId?: string, platforms?: string[], posts?: object, error?: string }>}
 *   deps.postItem posts the oldest approved item (review-post.mjs postNext):
 *   kind "posted" | "post-failed" | "refused" (the item failed its checks
 *   and went to post-failed) | "no-live" (nothing was touched) | "empty"
 * @param {() => Array<{ id: string, slotAt: string, posts: object,
 *   platforms: string[], notApplicable: Record<string, string> | null }>}
 *   deps.recover items left in "posting" by a stop, now post-failed
 * @param {(text: string) => Promise<void>} deps.send throws when not sent
 * @param {{ warn: (m: string) => void }} [deps.log]
 */
export const createScheduler = ({
  statePath,
  now = () => Date.now(),
  store,
  livePlatforms,
  busy,
  postItem,
  recover,
  send,
  log = console,
}) => {
  const read = () => {
    if (!existsSync(statePath)) return { ...EMPTY };
    const text = readFileSync(statePath, "utf8");
    try {
      return { ...EMPTY, ...JSON.parse(text) };
    } catch {
      // Kept for a person to read; the timer starts again from "start"
      // (no older slot posts) and Growth hears of it.
      const aside = `${statePath}.corrupt-${now()}`;
      renameSync(statePath, aside);
      log.warn(`schedule: ${statePath} was not JSON; moved to ${aside}`);
      write({
        ...EMPTY,
        outbox: [
          {
            at: iso(now()),
            text: "The slot timer's state file was damaged; it was moved aside and the timer started again. A slot due now may be missed; the next ones post as usual.",
          },
        ],
      });
      return read();
    }
  };
  const write = (state) => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
    return state;
  };
  const update = (change) => write({ ...read(), ...change });

  /**
   * The status block: counts per state, posted today (Pacific day), the
   * next slot and the last one. Counts and times only: no path, no token.
   */
  const status = (state = read()) => {
    const t = now();
    const ready = store.approvedQueue().length;
    const today = pacificDay(t);
    const postedToday = store
      .items({ states: ["posted"] })
      .filter(
        (i) => i.posting?.at && pacificDay(Date.parse(i.posting.at)) === today,
      ).length;
    const live = livePlatforms();
    const last = state.lastSlot;
    return {
      counts: { ...store.counts(), postedToday },
      livePlatforms: live,
      // For Growth's retry: each post-failed item and how each platform of
      // its slot stands.
      postFailed: store.items({ states: ["post-failed"] }).map((i) => ({
        id: i.id,
        platforms: Object.fromEntries(
          (i.posting?.platforms ?? Object.keys(i.posts ?? {})).map((p) => {
            const r = i.posts?.[p];
            return [
              p,
              r?.ok === true
                ? "posted"
                : r?.pending || r?.uncertain
                  ? "uncertain"
                  : r
                    ? "failed"
                    : "not tried",
            ];
          }),
        ),
      })),
      nextSlot: nextSlot(state, t, ready),
      lastSlot: last && {
        ...last,
        // Platforms that are live now but were not live at that slot: the
        // item keeps its slot's set, so they never get it.
        notInSlot: last.platforms
          ? live.filter(
              (p) =>
                !last.platforms.includes(p) &&
                !(p in (last.notApplicable ?? {})),
            )
          : [],
      },
    };
  };

  const statusText = (s) => {
    const c = s.counts;
    const n = s.nextSlot;
    return [
      `Status: ready (approved) ${c.approved}, in review ${c.inReview}, waiting copy ${c.waitingCopy}, revise ${c.revise}, draft ${c.draft}, post-failed ${c.postFailed}, posted today ${c.postedToday}.`,
      `Next slot: ${n.pacific} (${n.at}): ${n.willPost ? "will post" : "no post"}${n.why ? ` (${n.why})` : ""}.`,
    ].join("\n");
  };

  const queueMessage = (lines) => {
    const state = read();
    const text = [...lines, statusText(status(state))].join("\n");
    write({ ...state, outbox: [...state.outbox, { at: iso(now()), text }] });
  };

  /** Send what waits in the outbox, oldest first; stop at the first failure. */
  const flush = async () => {
    for (;;) {
      const [first] = read().outbox;
      if (!first) return;
      try {
        await send(first.text);
      } catch (err) {
        log.warn(
          `schedule: message to Growth not sent: ${err?.message ?? err}`,
        );
        return;
      }
      const state = read();
      write({ ...state, outbox: state.outbox.slice(1) });
    }
  };

  const slotHead = (slot, firedAt, folded) => {
    const late = firedAt - slot.at > LATE_AFTER_MS;
    return [
      `Slot ${slot.byHand ? "by hand " : ""}${pacificLabel(slot.at)}`,
      late ? `, LATE: fired ${pacificLabel(firedAt)}` : "",
      folded.length
        ? `, ${folded.length} older missed slot${folded.length > 1 ? "s" : ""} folded in`
        : "",
    ].join("");
  };

  const fire = async (d) => {
    const firedAt = now();
    const before = read();
    // Handled first: a crash from here on never fires this slot again. The
    // poster takes the item (it may have been withdrawn since decide).
    write({
      ...before,
      lastSlotAt: iso(d.through),
      lastPostAt: iso(firedAt),
      lastSlot: {
        slotAt: iso(d.slot.at),
        firedAt: iso(firedAt),
        itemId: null,
        outcome: "posting",
        platforms: null,
        folded: d.folded.length,
        // Back in lastPostAt when the slot proves that nothing went out.
        prevPostAt: before.lastPostAt,
      },
    });
    let result;
    try {
      result = await postItem({ slotAt: iso(d.slot.at) });
    } catch (err) {
      result = { kind: "error", error: String(err?.message ?? err) };
    }
    // Only these prove that nothing went out; after an error a platform may
    // have posted, so the gap holds.
    const nothingSent = ["no-live", "empty", "refused"].includes(result.kind);
    update({
      ...(nothingSent && { lastPostAt: before.lastPostAt }),
      lastSlot: {
        ...read().lastSlot,
        itemId: result.itemId ?? null,
        outcome: result.kind,
        platforms: result.platforms ?? null,
        notApplicable: result.notApplicable ?? null,
      },
    });
    const head = slotHead(d.slot, firedAt, d.folded);
    const id = result.itemId;
    const refusedLines = (result.refused ?? []).map(
      (r) =>
        `- ${r.itemId} failed its checks and is post-failed: ${r.error}. It needs a new approval (send it to the Director); a retry fails the same check.`,
    );
    if (result.kind === "no-live") {
      queueMessage([
        `${head}: SKIPPED, no platform is live. The approved items stay approved.`,
      ]);
    } else if (result.kind === "empty") {
      queueMessage([
        `${head}: SKIPPED, the approved queue is empty (withdrawn before the slot took an item).`,
      ]);
    } else if (result.kind === "posted" || result.kind === "post-failed") {
      const skipped = result.notApplicable ?? {};
      const notLive = livePlatforms().filter(
        (p) => !result.platforms.includes(p) && !(p in skipped),
      );
      queueMessage([
        `${head}: ${result.kind === "posted" ? "POSTED" : "POST FAILED"} ${id}.`,
        ...result.platforms.map((p) => resultLine(p, result.posts[p])),
        ...notApplicableLines(skipped),
        ...(refusedLines.length
          ? ["Passed over before it:", ...refusedLines]
          : []),
        ...(notLive.length
          ? [`Live now but not in this slot: ${notLive.join(", ")}.`]
          : []),
        ...(result.kind === "post-failed"
          ? [
              `Retry by hand after the cause is fixed: crew.mjs post --item ${id}.`,
            ]
          : []),
      ]);
    } else if (result.kind === "refused") {
      queueMessage([
        `${head}: SKIPPED, every approved item failed its checks:`,
        ...refusedLines,
      ]);
    } else {
      queueMessage([
        `${head}: SKIPPED, the post could not run: ${result.error}`,
      ]);
    }
  };

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await flush();
      const state = read();
      const t = now();
      const d = decide(state, t, store.approvedQueue().length);
      if (d.kind === "start") {
        write({ ...state, lastSlotAt: iso(t) });
      } else if (d.kind === "pass") {
        write({ ...state, lastSlotAt: iso(d.through) });
      } else if (d.kind === "skip") {
        write({
          ...state,
          lastSlotAt: iso(d.through),
          lastSlot: {
            slotAt: iso(d.slot.at),
            firedAt: iso(t),
            itemId: null,
            outcome: "skipped",
            platforms: null,
            folded: d.folded.length,
          },
        });
        queueMessage([
          `${slotHead(d.slot, t, d.folded)}: SKIPPED, the approved queue is empty.`,
        ]);
      } else if (d.kind === "fire") {
        // A post runs, or a follower read that the post would wait for:
        // the next tick (routes.mjs busy).
        if (busy()) return;
        await fire(d);
      }
      await flush();
    } catch (err) {
      log.warn(`schedule: tick failed: ${err?.stack ?? err}`);
    } finally {
      running = false;
    }
  };

  /**
   * A slot now, by hand: the oldest approved item through the same fire()
   * as a timed slot. It takes the tick's turn (running), and refuses
   * (nothing written, nothing sent) while a slot or a post runs, before
   * the timer's first tick, when no item is approved, or while the 6 h gap
   * since the last post holds. lastSlotAt
   * stays: no timed slot is used up; the gap from this post may push the
   * next one. Returns { ok: true, lastSlot } or { ok: false, reason }.
   */
  const fireNow = async () => {
    if (running || busy()) {
      return {
        ok: false,
        reason: "a slot or a post is running: try again in a minute",
      };
    }
    running = true;
    try {
      await flush();
      const state = read();
      const t = now();
      if (!state.lastSlotAt) {
        return {
          ok: false,
          reason: "the slot timer has not run its first tick yet",
        };
      }
      if (store.approvedQueue().length === 0) {
        return { ok: false, reason: "the approved queue is empty" };
      }
      const lastPostAt = state.lastPostAt ? Date.parse(state.lastPostAt) : null;
      if (lastPostAt !== null && t < lastPostAt + MIN_GAP_MS) {
        return {
          ok: false,
          reason: `the 6 h gap after the last post (${state.lastPostAt}) holds until ${pacificLabel(lastPostAt + MIN_GAP_MS)}`,
        };
      }
      await fire({
        slot: { at: t, byHand: true },
        folded: [],
        through: Date.parse(state.lastSlotAt),
      });
      await flush();
      return { ok: true, lastSlot: read().lastSlot };
    } finally {
      running = false;
    }
  };

  /** Close a post that a stop cut off, then start the ticks. */
  const start = (everyMs = TICK_MS) => {
    for (const item of recover()) {
      const state = read();
      if (
        state.lastSlot?.outcome === "posting" &&
        state.lastSlot.slotAt === item.slotAt
      ) {
        write({
          ...state,
          lastSlot: {
            ...state.lastSlot,
            itemId: item.id,
            outcome: "interrupted",
            platforms: item.platforms,
            notApplicable: item.notApplicable,
          },
        });
      }
      queueMessage([
        `The app stopped while ${item.id} was posting; it is post-failed now.`,
        ...item.platforms.map((p) => resultLine(p, item.posts[p])),
        ...notApplicableLines(item.notApplicable),
        `Check each UNCERTAIN account, then retry by hand: crew.mjs post --item ${item.id} (with --confirm-not-posted for a checked platform).`,
      ]);
    }
    // A stop after the slot was written and before an item was taken (the
    // post waits for a follower read there): nothing posted.
    const state = read();
    // A hard kill after the post ended but before fire() wrote its outcome:
    // the item that this slot took says what happened, and the gap holds.
    const taken =
      state.lastSlot?.outcome === "posting"
        ? store
            .items()
            // An item that the slot passed over (S4) has an error: not it.
            .find(
              (i) =>
                i.posting?.slotAt === state.lastSlot.slotAt && !i.posting.error,
            )
        : undefined;
    if (taken) {
      write({
        ...state,
        lastSlot: {
          ...state.lastSlot,
          itemId: taken.id,
          outcome: taken.state,
          platforms: taken.posting.platforms,
          notApplicable: taken.posting.notApplicable ?? null,
        },
      });
      queueMessage([
        `Slot ${pacificLabel(Date.parse(state.lastSlot.slotAt))}: the app stopped as the post of ${taken.id} ended; it is ${taken.state}.`,
        ...taken.posting.platforms.map((p) => resultLine(p, taken.posts?.[p])),
        ...notApplicableLines(taken.posting.notApplicable),
      ]);
    } else if (state.lastSlot?.outcome === "posting") {
      write({
        ...state,
        lastPostAt: state.lastSlot.prevPostAt ?? null,
        lastSlot: { ...state.lastSlot, outcome: "interrupted" },
      });
      queueMessage([
        `Slot ${pacificLabel(Date.parse(state.lastSlot.slotAt))} stopped before it took an item (the app stopped); nothing posted. The next slot posts as usual.`,
      ]);
    }
    const timer = setInterval(() => void tick(), everyMs);
    timer.unref();
    void tick();
    return () => clearInterval(timer);
  };

  return { tick, fireNow, start, status, read };
};
