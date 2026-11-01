/**
 * Nil's review in his Isomux Inbox (Nil, 2026-10-31, via Isomux PM: "tell
 * wall game director to move the approval feed to asks"; the Director's
 * spec and Wall Game PM's calls, 2026-10-31). Each item in review gets ONE
 * ask from the app: member Nil, P3, the video played from its path, the
 * texts and the red lines the review page shows, and the options Approve,
 * Revise: and Discard: (his notes after the colon).
 *
 * The ask is in the name of the app's message target, the Wall Game
 * Director, so his answer arrives as a message to the Director. The app
 * never trusts that message. It applies an answer only from the office's
 * own record of the closed ask (GET /api/asks/:askId; the app's token has
 * the reach of its live owner agent, the Director, whose asks it reads),
 * and only when all are true:
 *   - it is the ask the app stored for this item, this video and this block
 *     (and this review round: a withdraw makes a new round);
 *   - it was opened by this app, for Nil (memberUserId REVIEWER_MEMBER_ID),
 *     and it is closed with the outcome "replied" by Nil (closed.by is the
 *     member's name: it must be the ask's own member);
 *   - his words read as one action (parseAnswer).
 * Then store.review applies it with the review page's effects, and checks
 * in the same write that the item is still in review with the same video
 * and block, so an approve never binds a newer render. A dismiss, a filed
 * task, another member's reply, words that are not an action and a refusal
 * change nothing: the Director is told. A new render, a new block, a
 * withdraw or an action on the review page withdraws the open ask; the next
 * sync opens a new one when the item is in review again with another video,
 * block or round. One that closed in another way is not opened again.
 *
 * One batch a day (Nil, 2026-11-01: "let's batch video reviews so I get
 * only one batch a day, at a specific time of your chosing every day. no
 * more notifications throughout the day now that we have a backlog"; the
 * Director chose 09:00 America/Los_Angeles, kept to local time by Wall Game
 * PM). An item that enters review is held: its ask opens at the first
 * REVIEW_BATCH_TIME after it entered, with every other item held by then.
 * A new render or block after that time waits for the next day's batch.
 * An ask the Director asks for again (askAgain) or one the office refused
 * to open is not held.
 *
 * The review page stays: the fallback, and its Approved tab for Undo.
 *
 * The record (review-asks.json in the data dir) keeps the last ask of each
 * item, so a sync is idempotent: an applied, dismissed or refused ask is
 * never read twice, and no second ask opens for the same video, block and
 * round.
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { copySha256 } from "./copy.mjs";
import { writeAtomic, StepRefused, fixedApprovalProblem } from "./store.mjs";
import { REVIEWER_MEMBER_ID, reviewView, directorText } from "./review.mjs";
import { DIRECTOR_AGENT_ID } from "./office.mjs";
import { quoteLines } from "./quote.mjs";
import {
  SLOT_ZONE,
  nextDay,
  pacificDay,
  pacificLabel,
  zonedInstant,
} from "./slots.mjs";

/** The app that opens the asks (its registry name). */
export const APP_NAME = "game-video";
/** Nil's username in the office, for the ask's `member`. */
export const REVIEWER_USERNAME = "nil";
export const ASK_PRIORITY = "P3";
/**
 * The placeholders of the options that need notes: a tap puts the option
 * in Nil's reply field, so they tell him to type his notes (VR1, review
 * 111 N1). parseAnswer removes them: a placeholder is not a note.
 */
const NOTE_PLACEHOLDERS = ["<what to change>", "<why>"];
export const ASK_OPTIONS = [
  "Approve",
  `Revise: ${NOTE_PLACEHOLDERS[0]}`,
  `Discard: ${NOTE_PLACEHOLDERS[1]}`,
];

/** The time of Nil's one review batch a day, in SLOT_ZONE's wall clock. */
export const REVIEW_BATCH_TIME = "09:00";

/**
 * The first batch time at or after `ms` (epoch ms): today's 09:00 in
 * SLOT_ZONE, or tomorrow's once today's has passed.
 * @param {number} ms
 */
export const reviewBatchAfter = (ms) => {
  const day = pacificDay(ms);
  const today = zonedInstant(day, REVIEW_BATCH_TIME);
  return today >= ms ? today : zonedInstant(nextDay(day), REVIEW_BATCH_TIME);
};

/** "held for the 09:00 PT batch (Sun 2026-11-01 09:00 PT)", for crew.mjs. */
export const heldWords = (batchAt) =>
  `held for the ${REVIEW_BATCH_TIME} PT batch (${pacificLabel(Date.parse(batchAt))}, ${SLOT_ZONE})`;

/** How often the app syncs its asks with no crew call (app/server.mjs). */
export const ASK_SYNC_MS = 60_000;

/** An ISO time as Nil reads it: "2026-10-31 14:52 UTC". */
const utcMinute = (iso) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/**
 * The first lines of an ask for a video that replaces one Nil was sent
 * (Nil, CASES.md C15: tell him when he sees two versions of one game;
 * Wall Game Director, 2026-10-31: asks 6deedba1 and e7458d6d read like new
 * videos). After his Revise: the time of it and his notes word for word,
 * so he can check each note against the video. After an ask of an older
 * video that he did not answer with a Revise (withdrawn, dismissed): the
 * time it was sent.
 * @param {any} item the store item
 * @param {any} previous the item's last ask record (openAskRecords), if any
 * @returns {string[]}
 */
export const revisionLines = (item, previous) => {
  const last = item.reviews.at(-1);
  const revise = last?.action === "revise" ? last : null;
  const lines = revise
    ? [
        `Revision after your Revise of ${utcMinute(revise.at)}:`,
        ...quoteLines(revise.notes),
      ]
    : [];
  const sentAt = previous?.openedAt ?? previous?.adoptedAt;
  if (
    previous?.askId &&
    sentAt &&
    previous.videoSha256 !== item.render.video.sha256 &&
    (!revise || sentAt > revise.at)
  ) {
    lines.push(
      `This video replaces the one sent to you at ${utcMinute(sentAt)}${previous.status === "withdrawn" ? " (that ask was withdrawn before your answer)" : ""}.`,
    );
  }
  return lines;
};

/**
 * The ask's text: what Nil must decide, then what the review page shows
 * him. `card` is one item of reviewView; `previous` is the item's last ask
 * record, if any (revisionLines).
 * @param {any} item the store item
 * @param {ReturnType<typeof reviewView>["items"][number]} card
 * @param {any} [previous]
 */
export const askPrompt = (item, card, previous) =>
  [
    ...revisionLines(item, previous),
    "Post this video?",
    `On the video: "${item.caption}"${item.payoff?.text ? ` then "${item.payoff.text}"` : ""}`,
    `Post: ${card.caption}`,
    ...(card.youtubeTitle ? [`YouTube title: ${card.youtubeTitle}`] : []),
    ...card.claimRiskSounds.map(
      (key) => `**Uses ${key}: a claim is possible.**`,
    ),
    ...(card.noStory ? [`**${card.noStory}**`] : []),
    ...(card.version ? [card.version] : []),
    ...(card.scriptCarried ? [card.scriptCarried] : []),
    ...(card.approveProblem
      ? [`**Approve cannot work now: ${card.approveProblem}**`]
      : []),
    "Answer Approve, or Revise: / Discard: with your notes.",
  ].join("\n");

/**
 * Nil's words as an action: "Approve", "Revise: <notes>" or "Discard:
 * <notes>", any case, with ":" or "-" or nothing after the word, the
 * options' placeholders removed. Approve may carry notes; a revise or
 * discard with no notes comes back with empty notes, and the sync applies
 * nothing (store.review needs them). Null when the words are not one of
 * these.
 * @param {string | undefined} answer
 * @returns {{ action: "approve" | "revise" | "discard", notes: string } | null}
 */
export const parseAnswer = (answer) => {
  const m =
    /^\s*(approve|revise|discard)(?![a-z])\s*[:\-–—]?\s*([\s\S]*)$/i.exec(
      answer ?? "",
    );
  if (!m) return null;
  const action = /** @type {"approve" | "revise" | "discard"} */ (
    m[1].toLowerCase()
  );
  const notes = NOTE_PLACEHOLDERS.reduce(
    (text, placeholder) => text.split(placeholder).join(""),
    m[2],
  ).trim();
  return { action, notes };
};

/**
 * Why the office's closed ask may not be applied to the record's item, or
 * null. Checks only the ask's identity and who answered; the item's state
 * and hashes are store.review's.
 * @param {any} ask GET /api/asks/:askId
 * @param {{ askId: string }} record
 */
export const askProblem = (ask, record) => {
  if (!ask || ask.id !== record.askId) return "the office returned another ask";
  // An adopted ask is the Director's own: the one cut-over ask of
  // v-2026-10-31-2 (214bf6df), adopted by a one-time route (73352ec5,
  // removed); every other check is the same.
  if (record.status !== "adopted" && ask.app?.name !== APP_NAME) {
    return "the ask was not opened by this app";
  }
  if (ask.memberUserId !== REVIEWER_MEMBER_ID) return "the ask was not for Nil";
  if (!ask.closed) return "the ask is still open";
  return null;
};

/** The key of what an ask is about: the video, the block and the round. */
const keyOf = (item) => ({
  videoSha256: item.render.video.sha256,
  copySha256: copySha256(item.copy.block),
  round: item.reviews.length,
});
const sameKey = (a, b) =>
  a.videoSha256 === b.videoSha256 &&
  a.copySha256 === b.copySha256 &&
  a.round === b.round;

/**
 * The record of each item's last ask, in the data dir.
 * @param {string} root the store's root (store.dirs.root)
 */
export const openAskRecords = (root) => {
  const path = join(root, "review-asks.json");
  /** @returns {Record<string, any>} */
  const all = () =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return {
    path,
    all,
    get: (itemId) => all()[itemId] ?? null,
    put: (itemId, record) =>
      writeAtomic(
        path,
        JSON.stringify({ ...all(), [itemId]: record }, null, 1),
      ),
  };
};

/** The Director's way to ask Nil again in his Inbox (no review page). */
const AGAIN_HINT = (itemId) =>
  `To ask him again in his Inbox: crew.mjs asks --again --item ${itemId}`;

/**
 * Mark an item's last ask so the next sync opens a new ask for the same
 * video and block (crew.mjs asks --again): after an ask that closed with
 * nothing applied (dismissed, unclear words, no notes, ignored, withdrawn
 * by hand). Nil reviews only in his Inbox asks (Nil, 2026-10-31, via Wall
 * Game PM), so such an ask needs a second one, not the review page.
 * Refused for an ask that is open, adopted or applied, or that the app
 * opens again on its own (open-failed).
 * @param {ReturnType<typeof openAskRecords>} records
 * @param {string} itemId
 */
export const askAgain = (records, itemId) => {
  const record = records.get(itemId);
  if (!record) throw new StepRefused(`${itemId} has had no ask`);
  if (
    ["open", "adopted", "applied", "open-failed", "again"].includes(
      record.status,
    )
  ) {
    throw new StepRefused(
      `${itemId}'s last ask ${record.askId ?? "-"} is ${record.status}: no new ask is needed`,
    );
  }
  records.put(itemId, { ...record, status: "again" });
};

/**
 * One sync of the review asks: read the closed ones and apply them, then
 * withdraw the asks that no longer match their item, then open one for each
 * item in review that has none. Any doubt (the office does not answer, a
 * check fails) changes no item; the Director is told once per ask.
 * @param {object} deps
 * @param {ReturnType<import("./store.mjs").openStore>} deps.store
 * @param {ReturnType<typeof openAskRecords>} deps.records
 * @param {ReturnType<import("./office.mjs").appAsks>} deps.office
 * @param {(targetAgentId: string, text: string) => Promise<void>} deps.send
 * @param {{ pacific: string, willPost: boolean, why: string | null }} deps.nextSlot
 * @param {{ warn: (m: string) => void }} [deps.log]
 * @param {() => Date} [deps.now]
 * @returns {Promise<{ opened: string[], applied: string[], withdrawn: string[], told: string[], held: string[] }>}
 */
export const syncReviewAsks = async ({
  store,
  records,
  office,
  send,
  nextSlot,
  log = console,
  now = () => new Date(),
}) => {
  const out = { opened: [], applied: [], withdrawn: [], told: [], held: [] };
  const tell = async (itemId, text) => {
    try {
      await send(DIRECTOR_AGENT_ID, text);
      out.told.push(itemId);
    } catch (err) {
      log.warn(
        `review ask ${itemId}: the director was not told: ${err.message}`,
      );
    }
  };
  const close = (itemId, record, status, note = null) =>
    records.put(itemId, {
      ...record,
      status,
      closedAt: now().toISOString(),
      ...(note ? { note } : {}),
    });

  let openIds;
  try {
    openIds = new Set((await office.listOpen()).map((a) => a.id));
  } catch (err) {
    log.warn(
      `review asks: the office did not list the open asks: ${err.message}`,
    );
    return out;
  }

  // 1. The asks that closed since the last sync. An adopted ask is not in
  // the app's open list: it is read each sync until it closes.
  for (const [itemId, record] of Object.entries(records.all())) {
    if (!["open", "adopted"].includes(record.status)) continue;
    if (openIds.has(record.askId)) continue;
    let ask;
    try {
      ask = await office.read(record.askId);
    } catch (err) {
      log.warn(`review ask ${record.askId}: not read: ${err.message}`);
      if (!record.readFailTold) {
        records.put(itemId, { ...record, readFailTold: true });
        await tell(
          itemId,
          `ASK: the app cannot read Nil's answer to ask ${record.askId} (${itemId}) from the office: ${err.message}. Nothing changed; it tries again each minute.`,
        );
      }
      continue;
    }
    if (
      record.status === "adopted" &&
      ask?.id === record.askId &&
      !ask.closed
    ) {
      continue;
    }
    const problem = askProblem(ask, record);
    if (problem) {
      close(itemId, record, "ignored", problem);
      await tell(
        itemId,
        `ASK: ask ${record.askId} (${itemId}) is not applied: ${problem}. Nothing changed.`,
      );
      continue;
    }
    const { outcome, by, answer } = ask.closed;
    if (outcome === "withdrawn" || outcome === "agent_removed") {
      close(itemId, record, "withdrawn");
      continue;
    }
    if (outcome !== "replied") {
      close(itemId, record, outcome);
      await tell(
        itemId,
        [
          `ASK: Nil's ask ${record.askId} for ${itemId} closed as ${outcome}${by ? ` by ${by}` : ""}: nothing changed. ${AGAIN_HINT(itemId)}`,
          ...(answer ? ["Words, verbatim:", ...quoteLines(answer)] : []),
        ].join("\n"),
      );
      continue;
    }
    if (by === null || by !== ask.member) {
      close(itemId, record, "ignored", `answered by ${by ?? "nobody"}`);
      await tell(
        itemId,
        `ASK: ask ${record.askId} for ${itemId} was answered by ${by ?? "an unknown member"}, not Nil: nothing changed.`,
      );
      continue;
    }
    const chosen = parseAnswer(answer);
    if (!chosen) {
      close(itemId, record, "unclear");
      await tell(
        itemId,
        [
          `ASK: Nil answered ask ${record.askId} for ${itemId}, but his words are not Approve, Revise: <notes> or Discard: <notes>. Nothing changed. His words, verbatim:`,
          ...quoteLines(answer ?? ""),
          AGAIN_HINT(itemId),
        ].join("\n"),
      );
      continue;
    }
    if (chosen.action !== "approve" && !chosen.notes) {
      const action = chosen.action === "revise" ? "Revise" : "Discard";
      close(itemId, record, "no-notes", chosen.action);
      await tell(
        itemId,
        `ASK: Nil chose ${action} with no notes on ask ${record.askId} (${itemId}); nothing done. Ask him what to ${chosen.action === "revise" ? "change" : "say"}. ${AGAIN_HINT(itemId)}`,
      );
      continue;
    }
    let item;
    try {
      // store.review checks, in the same write, that the item is in review
      // with this video and this block: an old ask never binds a new render.
      item = store.review(itemId, {
        ...chosen,
        videoSha256: record.videoSha256,
        copySha256: record.copySha256,
        by: "Nil",
        memberId: REVIEWER_MEMBER_ID,
        askId: record.askId,
      });
    } catch (err) {
      if (!(err instanceof StepRefused)) throw err;
      close(itemId, record, "refused", err.message);
      await tell(
        itemId,
        `ASK: Nil chose ${chosen.action.toUpperCase()} on ask ${record.askId} for ${itemId}, but it is not applied: ${err.message}. Nothing changed.`,
      );
      continue;
    }
    close(itemId, record, "applied", chosen.action);
    out.applied.push(itemId);
    await tell(
      itemId,
      `${directorText(item, chosen.action, chosen.notes)}\n(Nil answered in his Inbox: ask ${record.askId}.)`,
    );
  }

  // 2. Open asks that no longer match their item: withdraw them.
  const view = reviewView(store, nextSlot);
  const cards = new Map(view.items.map((c) => [c.id, c]));
  for (const [itemId, record] of Object.entries(records.all())) {
    if (record.status !== "open") continue;
    const item = cards.has(itemId) ? store.item(itemId) : null;
    if (item && sameKey(record, keyOf(item))) continue;
    try {
      await office.remove(record.askId);
    } catch (err) {
      // A 404 is an ask that closed meanwhile: the next sync reads it.
      log.warn(`review ask ${record.askId}: not withdrawn: ${err.message}`);
      continue;
    }
    close(itemId, record, "withdrawn");
    out.withdrawn.push(itemId);
  }

  // 3. One ask for each item in review that has none for its key.
  for (const card of view.items) {
    const item = store.item(card.id);
    const key = keyOf(item);
    const record = records.get(card.id);
    // Once per video, block and round: an ask that closed in any way
    // (answered, dismissed, withdrawn by hand) is not opened again, unless
    // the Director asks for it (askAgain).
    if (
      record &&
      sameKey(record, key) &&
      !["open-failed", "again", "held"].includes(record.status)
    ) {
      continue;
    }
    // Nil's revise said the fixed render needs no second look, and the
    // director armed it (store.armFixedApproval): approve it, and open no
    // ask. A refusal (one video of a game, the file's bytes) opens the
    // ask after all, so Nil decides.
    // Held for this key: its armed approval was refused once already.
    const heldNow =
      record?.status === "held" && sameKey(record, key) ? record : null;
    if (item.fixedApproval && !fixedApprovalProblem(item) && !heldNow) {
      try {
        const done = store.approveFixed(card.id);
        out.applied.push(card.id);
        await tell(
          card.id,
          `${directorText(done, "approve", "")}\n(No ask: Nil's revise on ask ${item.fixedApproval.askId} said the fixed render needs no second look, and ${item.fixedApproval.armedBy} armed it. His words, verbatim:)\n${quoteLines(item.fixedApproval.words).join("\n")}`,
        );
        continue;
      } catch (err) {
        if (!(err instanceof StepRefused)) throw err;
        await tell(
          card.id,
          `ASK: the armed approval of ${card.id} (Nil's revise, ask ${item.fixedApproval.askId}) is refused: ${err.message}. The app opens his ask instead.`,
        );
      }
    }
    // Held until the day's batch: a new key starts its hold now. The
    // item's last ask stays in it, for the ask's "replaces" line.
    const previous = heldNow ? (heldNow.previous ?? null) : (record ?? null);
    if (!record || !sameKey(record, key) || heldNow) {
      const held = heldNow ?? {
        ...key,
        status: "held",
        heldAt: now().toISOString(),
        batchAt: new Date(reviewBatchAfter(now().getTime())).toISOString(),
        previous,
      };
      if (now().getTime() < Date.parse(held.batchAt)) {
        if (held !== record) records.put(card.id, held);
        out.held.push(card.id);
        continue;
      }
    }
    let ask;
    try {
      ask = await office.open({
        text: askPrompt(item, card, previous),
        member: REVIEWER_USERNAME,
        priority: ASK_PRIORITY,
        options: ASK_OPTIONS,
        ...(card.approveProblem ? {} : { recommended: "Approve" }),
        readFiles: [item.render.video.path],
      });
    } catch (err) {
      // Never again without `member`: that ask would go to the app's owner
      // member, whose Inbox nobody reads (Wall Game Director, 2026-10-31).
      log.warn(`review ask ${card.id}: not opened: ${err.message}`);
      const told =
        record?.status === "open-failed" && sameKey(record, key) && record.told;
      records.put(card.id, { ...key, status: "open-failed", told: true });
      if (!told) {
        await tell(
          card.id,
          `ASK: the app could not open Nil's review ask for ${card.id}: ${err.message}. It tries again each minute.`,
        );
      }
      continue;
    }
    records.put(card.id, {
      ...key,
      askId: ask.id,
      status: "open",
      openedAt: now().toISOString(),
    });
    out.opened.push(card.id);
  }
  return out;
};
