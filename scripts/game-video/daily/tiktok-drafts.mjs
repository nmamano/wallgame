/**
 * Nil's TikTok inbox (2026-11-03, through Wall Game Growth): "always leave
 * one video in my TikTok inbox". A slot sends its item's video as an inbox
 * draft only when no draft waits (review-post.mjs). Only the LATEST draft
 * counts: the newest tiktok row of the live post log (an older draft that
 * TikTok lost, as v-2026-10-31-2 on 2026-11-02, never blocks).
 *
 * The latest draft waits while TikTok's status of it is SEND_TO_USER_INBOX
 * (or still PROCESSING_*). A draft Nil posted (PUBLISH_COMPLETE), a FAILED
 * one, one marked lost (crew.mjs tiktok --lost), or no draft at all: the
 * slot sends one. A status read that fails is "unknown" and the slot sends
 * none: a second draft in his inbox is worse than a late one (Wall Game PM,
 * 2026-11-03). There is no time-out: a draft TikTok is slow with is not
 * lost. Nil's 48 h rule covers a lost one (Growth asks him, then someone
 * runs tiktok --lost), so status() shows how long it waits and a run of
 * failed reads.
 *
 * The file keeps, per publish_id, when a read first saw PUBLISH_COMPLETE
 * (postedAt) and when someone marked it lost (lostAt, lostBy), and the last
 * read. No token.
 */
import { existsSync, readFileSync } from "node:fs";
import { StepRefused, writeAtomic } from "./store.mjs";

/**
 * @typedef {{ at: string, publishId: string, status: string | null,
 *   error: string | null, failingSince: string | null }} DraftRead
 * @typedef {{ postedAt?: string, lostAt?: string, lostBy?: string }} Draft
 * @typedef {{ drafts: Record<string, Draft>, lastRead: DraftRead | null }} DraftsState
 */

/** @type {DraftsState} */
const EMPTY = { drafts: {}, lastRead: null };
/** TikTok's states of a draft that it will not send again. */
const DONE = ["PUBLISH_COMPLETE", "FAILED"];

/**
 * @param {object} deps
 * @param {string} deps.path the state file
 * @param {() => { publishId: string, sentAt: string } | null} deps.latest
 *   the latest draft (the newest tiktok row of the live post log)
 * @param {(publishId: string) => Promise<{ status?: string }>} deps.readStatus
 *   TikTok's status of one upload (post-tiktok.mjs tiktokPostStatus); the
 *   caller holds the post lock, as it refreshes the token
 * @param {() => number} [deps.now]
 */
export const createTiktokDrafts = ({
  path,
  latest,
  readStatus,
  now = () => Date.now(),
}) => {
  /** @returns {DraftsState} */
  const read = () =>
    existsSync(path)
      ? { ...EMPTY, ...JSON.parse(readFileSync(path, "utf8")) }
      : structuredClone(EMPTY);
  const write = (state) =>
    writeAtomic(path, JSON.stringify(state, null, 2) + "\n");
  const iso = () => new Date(now()).toISOString();

  /** Whether the latest draft is not done: a read may find it waiting. */
  const open = (state, last) => {
    if (!last) return false;
    const d = state.drafts[last.publishId] ?? {};
    if (d.postedAt || d.lostAt) return false;
    const r = state.lastRead;
    return !(r?.publishId === last.publishId && r.status === "FAILED");
  };

  /**
   * Why a slot sends no draft now, or null: one TikTok read of the latest
   * draft when it may wait. The caller holds the post lock.
   */
  const waiting = async () => {
    const last = latest();
    if (!last || !open(read(), last)) return null;
    const at = iso();
    let status = null;
    let error = null;
    try {
      status = (await readStatus(last.publishId)).status ?? null;
    } catch (err) {
      error = String(err?.message ?? err);
    }
    const state = read();
    const failing = error !== null || status === null;
    state.lastRead = {
      at,
      publishId: last.publishId,
      status,
      error,
      // The first failed read of a run of them, so a long run shows.
      failingSince: failing ? (state.lastRead?.failingSince ?? at) : null,
    };
    // The first PUBLISH_COMPLETE: a posted draft is not read again (open).
    if (status === "PUBLISH_COMPLETE") {
      const d = state.drafts[last.publishId] ?? {};
      state.drafts[last.publishId] = { ...d, postedAt: at };
    }
    write(state);
    if (error !== null) return `draft status unknown: ${error}`;
    if (status === null) return "draft status unknown: TikTok gave no status";
    if (DONE.includes(status)) return null;
    return status === "SEND_TO_USER_INBOX"
      ? "a draft is waiting"
      : `a draft is waiting (TikTok: ${status})`;
  };

  /** The latest draft is lost (Nil says it is not in his inbox). */
  const markLost = ({ by }) => {
    if (typeof by !== "string" || !by.trim()) {
      throw new StepRefused("tiktok --lost needs --by <who>");
    }
    const last = latest();
    const state = read();
    if (!last) throw new StepRefused("there is no TikTok draft");
    if (!open(state, last)) {
      throw new StepRefused(
        `the latest draft ${last.publishId} is not waiting: the next slot sends one`,
      );
    }
    state.drafts[last.publishId] = {
      ...(state.drafts[last.publishId] ?? {}),
      lostAt: iso(),
      lostBy: by.trim(),
    };
    write(state);
    return { publishId: last.publishId };
  };

  /**
   * For GET /api/review/status: the draft that waits (or null) and since
   * when, the last time a read saw Nil post a draft, and the last read.
   */
  const status = () => {
    const last = latest();
    const state = read();
    const waits = open(state, last);
    const posted = Object.values(state.drafts)
      .map((d) => d.postedAt)
      .filter(Boolean)
      .sort();
    return {
      waitingPublishId: waits ? last.publishId : null,
      waitingSince: waits ? last.sentAt : null,
      lastPostedAt: posted.at(-1) ?? null,
      lastRead: state.lastRead,
    };
  };

  return {
    waiting,
    markLost,
    status,
    /** Whether an hourly read is worth it: the latest draft may wait. */
    mayWait: () => open(read(), latest()),
  };
};
