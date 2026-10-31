/**
 * The video items: one file per video, and the only state the daily
 * pipeline keeps (Nil's review queue, 2026-10-28). The director picks a
 * game as an item and makes it; Nil reviews finished items on the app's
 * /review page; an approved item posts at a slot (Wall Game Worker 1's
 * review-post.mjs and scheduler.mjs).
 *
 *   draft -> finished -> approved -> posting -> posted
 *     ^         |   \-> discarded           \-> post-failed
 *     \-revise--/
 *
 * - draft: the director's production. Its steps (direct, render, check,
 *   copy) work only in draft, except a new list or block on a finished
 *   item, which a new list sends back to draft. Where production stands is
 *   derived from the item's fields (stage), not stored.
 * - finished: the director's check passed (every still ok). It is IN REVIEW
 *   when Growth's block is for its current video (reviewState); this too is
 *   derived, so a new render leaves review by itself.
 * - approved, discarded, draft again (revise): Nil's review actions; an
 *   approved item that no slot took yet goes back to finished (withdraw).
 * - posting, posted, post-failed and posts{}: the poster's alone.
 *
 * Every step checks the state it starts from. The checks are the point of
 * this file: the steps are run by an agent woken by a schedule, possibly in a
 * different session from the one that started the item, and a post must not
 * be reachable from anything but Nil's approval of THIS video and THIS block.
 *
 * A COPY BLOCK BELONGS TO ONE VIDEO. It is stored with the sha256 of the
 * item's MP4 when it came in (forVideoSha256). A render that makes other
 * bytes leaves it stale; a render of the same list from the capture cache
 * makes the same bytes, so the block stays good.
 *
 * Every write goes to a scratch file first and is renamed into place, so a
 * crash never leaves half a record.
 *
 * THE DAY FILES (cycles/) are history: the daily flow before the review
 * queue kept one file per UTC day with up to three candidates and an ask.
 * At start-up an old day file is brought to version 3 (migrateV1,
 * migrateV2; the old file is kept next to it as <day>.v1.json or
 * <day>.v2.json), and each of its candidates becomes an item
 * (itemFromDay). Nothing writes a day file after that.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { COPY_LINES, copySha256 } from "./copy.mjs";
import { MUSIC_TRACKS, mayPlay } from "../music-tracks.mjs";

/**
 * A day file's format. migrateV1 turns a version 1 file into version 2, and
 * migrateV2 a version 2 file into this one.
 */
export const VERSION = 3;

/** A video item's file format (the review queue; day files are history). */
export const ITEM_VERSION = 4;

/**
 * A video item's states, as stored. "In review" is not one: it is derived
 * on a finished item (reviewState). The poster alone writes posting,
 * posted and post-failed.
 */
export const ITEM_STATES = [
  "draft",
  "finished",
  "approved",
  "discarded",
  "posting",
  "posted",
  "post-failed",
];

/** An item id: v-<UTC day it was picked>-<label or number>. */
export const ITEM_ID = /^v-\d{4}-\d{2}-\d{2}-[A-Za-z0-9]+$/;
export const itemId = (day, label) => `v-${day}-${label}`;

/**
 * Where a finished item stands: "in-review" when the latest independent
 * review of its current video passed (rule R10: a fail recorded later
 * takes the item out of review, Video Reviewer 2, 2026-10-28), Growth's
 * block is for that video and, after a revise, both the render and the
 * block came later than Nil's revise (Growth's rule, 2026-10-28: a revised
 * item is in review again only with a new render AND a new block); else
 * "waiting-copy" (the vet and the copy come before review). Null for any
 * other state.
 */
export const reviewState = (item) => {
  if (item.state !== "finished") return null;
  const vetted = currentVet(item)?.verdict === "pass";
  const fresh =
    item.copy !== null &&
    item.copy.forVideoSha256 === item.render?.video?.sha256;
  const revise = item.reviews.filter((r) => r.action === "revise").at(-1);
  const afterRevise =
    !revise ||
    (item.render?.finishedAt > revise.at && item.copy?.storedAt > revise.at);
  return vetted && fresh && afterRevise && !scriptAfterRender(item)
    ? "in-review"
    : "waiting-copy";
};

/**
 * The states of an item that posts, may post or did post. Only ONE video of
 * a game ever posts (Wall Game Director, 2026-10-28): Nil cannot approve an
 * item, and the director cannot pick a game, while another item of the
 * game is in one of these. Two videos of a game may be in work or in review
 * together (an A/B of edits).
 */
/**
 * Whether an approved item is held from posting (store.hold): its hold
 * names the video its approval binds. A new approved render is not held.
 */
export const isHeld = (item) =>
  item.state === "approved" &&
  !!item.hold &&
  item.hold.videoSha256 === item.approval?.videoSha256;

export const ONE_POST_STATES = ["approved", "posting", "posted", "post-failed"];

/**
 * The tracks of an item's render that may not play now ({track, license};
 * an unknown track has the license "unknown"). `direct` and the renderer
 * refuse such a track for a new list, but a render made before that gate
 * (or a license that changed later) can still carry one (Video Reviewer 2,
 * 2026-10-28), so approve and post check it again.
 */
export const blockedMusic = (item) =>
  (item.render?.music ?? []).flatMap(({ track }) => {
    const known = MUSIC_TRACKS.find((t) => t.slug === track);
    return known && mayPlay(known)
      ? []
      : [{ track, license: known?.license ?? "unknown" }];
  });

const musicProblem = (item) => {
  const [bad] = blockedMusic(item);
  return bad && `the music ${bad.track} has the license ${bad.license}`;
};

/** Item states that a post may come from: the poster's own steps. */
const POSTABLE = ["approved", "posting"];

/**
 * Why `platform` may not post `item` now, or null: the last guard before a
 * public post, which no caller can skip (Video Reviewer 2, 2026-10-28; it
 * was the day store's checkPost). The item must be approved (or posting),
 * the video's bytes and the block must be the ones Nil approved, the block
 * must have every line, and the platform must not have the post already,
 * nor maybe have it (pending: the app stopped during its final request;
 * uncertain: no clear answer to it) unless a person checked the account
 * and says it is not there (`confirmedNotPosted`).
 * @param {any} item
 * @param {string} platform
 * @param {{ videoSha256: string, confirmedNotPosted: boolean }} given
 */
export const postProblem = (
  item,
  platform,
  { videoSha256, confirmedNotPosted },
) => {
  if (!PLATFORMS.includes(platform)) return `${platform} is not a platform`;
  if (!POSTABLE.includes(item.state)) {
    return `${item.id} is ${item.state}; a post needs it ${POSTABLE.join(" or ")}`;
  }
  const a = item.approval;
  if (!a) return `${item.id} has no approval`;
  if (videoSha256 !== a.videoSha256) {
    return `the video is not the one Nil approved for ${item.id}`;
  }
  if (!item.copy || copySha256(item.copy.block) !== a.copySha256) {
    return `the copy block is not the one Nil approved for ${item.id}`;
  }
  const music = musicProblem(item);
  if (music) return `${music}: ${item.id} may not post`;
  const missing = COPY_LINES.filter(
    ([, field]) => typeof item.copy.block[field] !== "string",
  ).map(([label]) => label);
  if (missing.length) {
    return `the approved copy block of ${item.id} has no ${missing.join(", ")} line`;
  }
  const last = item.posts[platform];
  if (last?.ok === true) return `${platform} already has ${item.id}`;
  if ((last?.pending || last?.uncertain) && !confirmedNotPosted) {
    return `${platform} may already have ${item.id} (${last.pending ? "the app stopped during" : "no clear answer to"} its final request at ${last.at}); check the account, then post again with the confirmation that it is not there`;
  }
  return null;
};

/** A day file's candidates, in label order. */
export const LABELS = ["A", "B", "C"];

/** Where an item's production stands, derived from its fields. */
export const STAGES = [
  "picked",
  "directed",
  "rendering",
  "rendered",
  "render-failed",
  "checked",
];
export const stage = (item) =>
  !item.edl
    ? "picked"
    : !item.render
      ? "directed"
      : !item.render.finishedAt
        ? "rendering"
        : item.render.error
          ? "render-failed"
          : item.check?.ok
            ? "checked"
            : "rendered";

/**
 * Every place a video posts to, in the order a slot posts them.
 * "instagram-story" is the same Instagram account as "instagram" and goes
 * right after the Reel (Nil, 2026-10-29, via Wall Game Growth): it is its
 * own result, so a failed Story never fails the Reel.
 */
export const PLATFORMS = [
  "x",
  "youtube",
  "tiktok",
  "instagram",
  "instagram-story",
  "facebook",
  "bluesky",
  "threads",
];

/** The UTC day of an instant, as YYYY-MM-DD. */
export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class StepRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "StepRefused";
  }
}

const refuse = (message) => {
  throw new StepRefused(message);
};

/** Write a file so that a reader sees the old bytes or the new ones. */
export const writeAtomic = (path, text) => {
  const scratch = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(scratch, text);
  renameSync(scratch, path);
};

/** The stages a new list may replace, and an item may be dropped in. */
const SETTLED = ["picked", "directed", "rendered", "render-failed", "checked"];

/** Nil's review actions (review.mjs), and the state each one leaves. */
export const REVIEW_ACTIONS = ["approve", "discard", "revise"];
const AFTER_REVIEW = {
  approve: "approved",
  discard: "discarded",
  revise: "draft",
};
/** Nil's notes on one action, at most. */
const NOTES_MAX = 4000;
/** The review target when queue.json sets none (Growth, 2026-10-28). */
export const DEFAULT_REVIEW_TARGET = 3;
const REVIEW_TARGET_MAX = 50;

/** copy.mjs's hash of a block (review() names its argument copySha256). */
const blockSha256 = copySha256;

/** The sha256 of a file's bytes. */
const fileSha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** A vet's reviewer, at most (one line). */
const VET_REVIEWER_MAX = 100;

/**
 * The latest independent review (`vet`) of the item's current video, or
 * null. An item from before vets has no `vets` field: none.
 */
export const currentVet = (item) =>
  (item.vets ?? []).findLast(
    (v) => v.videoSha256 === item.render?.video?.sha256,
  ) ?? null;

/** A script, at most (about 60 lines of text, with room to spare). */
export const SCRIPT_MAX = 20_000;

/**
 * The script review that lets the item render (Nil, 2026-10-29: "first
 * scripting the video ... make sure it's narratively sound first. then
 * implement"; SCRIPT.md): the latest one recorded since the item's pick or
 * its last revise, or null. A revise asks for a new story, so the reviews
 * before it no longer count.
 */
export const currentScriptReview = (item) => {
  const revisedAt =
    item.reviews?.findLast((r) => r.action === "revise")?.at ?? "";
  return (item.scriptReviews ?? []).findLast((r) => r.at > revisedAt) ?? null;
};

/**
 * The script review that the item's current render passed under (startRender
 * pins it), or null for a render from before phase 1. The render vet checks
 * the video against this script, not against a review recorded later
 * (Video Reviewer 2, 2026-10-29).
 */
export const renderScriptReview = (item) => {
  const pin = item.render?.scriptReview;
  return (
    (pin &&
      // A fail of the same script in the same ms has the same at and
      // hash; the render passed under a pass, the latest such one.
      (item.scriptReviews ?? []).findLast(
        (r) =>
          r.verdict === "pass" &&
          r.at === pin.at &&
          r.scriptSha256 === pin.scriptSha256,
      )) ??
    null
  );
};

/**
 * The script text of `review` as the video tells it: the review's own
 * script, or its latest text fix (recordScriptFix) when a lint-forced
 * change came after the review (Wall Game Director, 2026-10-30: a
 * caption's 7th token). `fix` is that fix, or null.
 * @returns {{ script: string, scriptSha256: string, fix: object | null }}
 */
export const scriptText = (review) => {
  const fix = review.fixes?.at(-1) ?? null;
  return fix
    ? { script: fix.script, scriptSha256: fix.scriptSha256, fix }
    : { script: review.script, scriptSha256: review.scriptSha256, fix: null };
};

/**
 * A script review recorded after the render was asked: the video tells an
 * older story, so it does not go to Nil until it is rendered again. A text
 * fix of a review is not a review: it changes no story.
 */
export const scriptAfterRender = (item) =>
  (item.scriptReviews ?? []).some((r) => r.at > item.render?.requestedAt);

/**
 * The states of an item whose game another item may carry over: a posted
 * game is done (ONE_POST_STATES).
 */
const CARRY_FROM = ["discarded"];

export const openStore = (dataDir) => {
  const root = join(dataDir, "daily");
  const dirs = {
    root,
    cycles: join(root, "cycles"),
    videos: join(root, "videos"),
    requests: join(root, "requests"),
    work: join(root, "work"),
    // One file per video item (the review queue).
    items: join(root, "items"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  /** Live captures per UTC day and game: each one is a production view. */
  const rendersFile = join(root, "renders.json");

  /**
   * The post log. Wall Game Growth reads the live file; a dry run writes the
   * same row to the second file, so the two are never mixed and the reader of
   * the live file needs no filter.
   */
  const postLog = {
    live: join(root, "post-log.jsonl"),
    dryRun: join(root, "post-log.dry-run.jsonl"),
  };
  /**
   * Nil's feedback, one line each: his review actions (review()), and
   * before them his answers to the daily asks.
   */
  const feedbackLog = join(root, "feedback.jsonl");

  const cyclePath = (day) => {
    if (!DAY.test(day)) refuse(`not a day: ${day}`);
    return join(dirs.cycles, `${day}.json`);
  };

  const days = () =>
    readdirSync(dirs.cycles)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((d) => DAY.test(d))
      .sort();

  // Once, at start-up: a version 1 file becomes candidate A, and a version
  // 2 file gets music cue lists.
  for (const day of days()) {
    const path = cyclePath(day);
    const old = JSON.parse(readFileSync(path, "utf8"));
    if (old.version === VERSION) continue;
    const from = old.version === 2 ? 2 : 1;
    const kept = join(dirs.cycles, `${day}.v${from}.json`);
    if (!existsSync(kept)) writeAtomic(kept, readFileSync(path, "utf8"));
    const v2 = from === 2 ? old : migrateV1(old);
    writeAtomic(path, JSON.stringify(migrateV2(v2), null, 2));
  }
  // The post log's rows name the tracks the video played, in order; a row
  // from before the cues names one track as a string.
  for (const file of Object.values(postLog)) {
    const rows = readPostLog(file);
    if (!rows.some((r) => typeof r.music === "string")) continue;
    const kept = file.replace(/\.jsonl$/, ".v2.jsonl");
    if (!existsSync(kept)) writeAtomic(kept, readFileSync(file, "utf8"));
    writeAtomic(
      file,
      rows
        .map((r) =>
          JSON.stringify(
            typeof r.music === "string" ? { ...r, music: [r.music] } : r,
          ),
        )
        .join("\n") + "\n",
    );
  }

  const itemPath = (id) => {
    if (!ITEM_ID.test(id)) refuse(`not an item id: ${id}`);
    return join(dirs.items, `${id}.json`);
  };
  const readItem = (id) => {
    const path = itemPath(id);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  };
  const writeItem = (item) =>
    writeAtomic(itemPath(item.id), JSON.stringify(item, null, 2));

  // Once, at start-up: each candidate of each day file becomes a video item
  // (itemFromDay). The day files stay as they are, as history. An item that
  // exists is never written again here, so a second start changes nothing.
  for (const day of days()) {
    const record = JSON.parse(readFileSync(cyclePath(day), "utf8"));
    for (const label of Object.keys(record.cands)) {
      if (!existsSync(itemPath(itemId(day, label)))) {
        writeItem(itemFromDay(record, label));
      }
    }
  }
  // The day files' view counts start the per-day count file.
  {
    const counts = existsSync(rendersFile)
      ? JSON.parse(readFileSync(rendersFile, "utf8"))
      : {};
    const missing = days().filter((d) => counts[d] === undefined);
    for (const day of missing) {
      counts[day] = JSON.parse(readFileSync(cyclePath(day), "utf8")).renders;
    }
    if (missing.length || !existsSync(rendersFile)) {
      writeAtomic(rendersFile, JSON.stringify(counts, null, 2));
    }
  }

  /** Every item, or those in `states`; oldest createdAt first, then id. */
  const items = ({ states } = {}) =>
    readdirSync(dirs.items)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dirs.items, f), "utf8")))
      .filter((it) => !states || states.includes(it.state))
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id < b.id
            ? -1
            : 1
          : a.createdAt < b.createdAt
            ? -1
            : 1,
      );

  const read = (day) => {
    const path = cyclePath(day);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  };

  /** The queue's settings: {reviewTarget}. */
  const queueFile = join(root, "queue.json");
  const readQueue = () => ({
    reviewTarget: DEFAULT_REVIEW_TARGET,
    ...(existsSync(queueFile)
      ? JSON.parse(readFileSync(queueFile, "utf8"))
      : {}),
  });

  const needItem = (id) => readItem(id) ?? refuse(`there is no item ${id}`);

  /** Refuse a step unless the item's production stage is one of `stages`. */
  const expectStage = (item, stages, step) => {
    const now = stage(item);
    if (!stages.includes(now)) {
      refuse(
        `${step} needs ${item.id} ${stages.join(" or ")}, but it is ${now}`,
      );
    }
  };

  /** Live captures of a game today (UTC), over every item. */
  const viewsToday = (gameId) => {
    const counts = JSON.parse(readFileSync(rendersFile, "utf8"));
    return counts[utcDay()]?.[gameId] ?? 0;
  };
  const countView = (gameId) => {
    const counts = JSON.parse(readFileSync(rendersFile, "utf8"));
    const day = utcDay();
    counts[day] = {
      ...counts[day],
      [gameId]: (counts[day]?.[gameId] ?? 0) + 1,
    };
    writeAtomic(rendersFile, JSON.stringify(counts, null, 2));
  };

  /**
   * The one way to change an item: refuses unless its state is one of
   * `expectStates`, then `mutate(item)` changes it in place (and may refuse
   * before anything is written); the change is stamped, logged as the event
   * `what` (a text, or a function of the changed item) and written
   * atomically. The poster's transitions (posting, posted, post-failed,
   * posts{}) use it from their own module; the review routes never write
   * those.
   * @param {string} id
   * @param {string[]} expectStates
   * @param {(item: any) => void} mutate
   * @param {string | ((item: any) => string)} what
   */
  const updateItem = (id, expectStates, mutate, what) => {
    const item = needItem(id);
    const step = typeof what === "string" ? what : "this step";
    if (!expectStates.includes(item.state)) {
      refuse(
        `${id} is ${item.state}; ${step} needs ${expectStates.join(" or ")}`,
      );
    }
    mutate(item);
    // A typo in a state would write an item that no list, count or queue
    // shows, and a changed id would write a second file (Video Reviewer 2,
    // 2026-10-28): refused, and nothing is written.
    if (!ITEM_STATES.includes(item.state)) {
      refuse(`${step} left ${id} in an unknown state: ${item.state}`);
    }
    if (item.id !== id) refuse(`${step} changed the item's id to ${item.id}`);
    const utc = new Date().toISOString();
    item.updatedAt = utc;
    item.events = [
      ...item.events,
      { utc, what: typeof what === "string" ? what : what(item) },
    ];
    writeItem(item);
    return item;
  };

  /** Why the item's block cannot go to review, or null. */
  const staleCopy = (item) => {
    const vet = currentVet(item);
    if (vet?.verdict !== "pass") {
      return vet
        ? `the independent review of ${item.id}'s video by ${vet.reviewer} at ${vet.at} failed; re-direct, or vet the video again`
        : `${item.id}'s video has no independent review (crew.mjs vet --item ${item.id})`;
    }
    if (!item.copy) {
      return `${item.id} has no copy block from Wall Game Growth (crew.mjs copy --item ${item.id})`;
    }
    if (item.copy.forVideoSha256 !== item.render?.video?.sha256) {
      return `${item.id}'s copy block was written for another video (${String(item.copy.forVideoSha256).slice(0, 12)}, now ${String(item.render?.video?.sha256).slice(0, 12)}); get a new block from Wall Game Growth`;
    }
    const revise = item.reviews.filter((r) => r.action === "revise").at(-1);
    if (revise && !(item.copy.storedAt > revise.at)) {
      return `Nil asked for a revision at ${revise.at}; the block must come after it: get a new block from Wall Game Growth`;
    }
    return null;
  };

  /**
   * The other items of `item`'s game that are not discarded: pick refuses
   * a game by it (postOfGame), and the review page names them (review.mjs
   * versionLine). `shown` is the state as the page says it (reviewState
   * for a finished item).
   */
  const sameGame = (item) =>
    items()
      .filter(
        (o) =>
          o.gameId === item.gameId &&
          o.id !== item.id &&
          o.state !== "discarded",
      )
      .map((o) => ({
        id: o.id,
        state: o.state,
        shown: (reviewState(o) ?? o.state).replace("-", " "),
      }));

  /** The other item of the game that posts, may post or did post, or null. */
  const postOfGame = (item) =>
    sameGame(item).find((o) => ONE_POST_STATES.includes(o.state)) ?? null;

  /**
   * Why Nil may not approve the item as it is, or null: another video of
   * its game posts, or its render plays a track that may not play. The
   * review page disables Approve with this text; review() refuses with it.
   */
  const approveProblem = (item) => {
    const other = postOfGame(item);
    if (other) {
      return `another video of this game is ${other.state} (${other.id}): ${other.state === "approved" ? "withdraw it, or discard this one" : "only one video of a game posts; discard this one"}`;
    }
    const music = musicProblem(item);
    if (music) return `${music}: re-direct with a track that may play`;
    return null;
  };

  return {
    dirs,
    postLog,
    feedbackLog,
    rendersFile,
    read,
    days,

    /** One item, or null. */
    item: readItem,
    items,

    /** The one way to change an item (see above). */
    updateItem,

    /**
     * Approved items that are not held (isHeld), oldest approval first (then
     * id): the post queue, which every slot and the poster read.
     */
    approvedQueue: () =>
      items({ states: ["approved"] })
        .filter((it) => !isHeld(it))
        .sort((a, b) =>
          a.approval.at === b.approval.at
            ? a.id < b.id
              ? -1
              : 1
            : a.approval.at < b.approval.at
              ? -1
              : 1,
        ),

    /** Approved items that are held: they stay approved and do not post. */
    held: () => items({ states: ["approved"] }).filter(isHeld),

    /** Items whose post failed; Growth retries them by hand. */
    postFailed: () => items({ states: ["post-failed"] }),

    /** How many items are in each state (and in review), for the status. */
    counts: () => {
      const all = items();
      const n = (pred) => all.filter(pred).length;
      const lastAction = (it) => it.reviews.at(-1)?.action;
      return {
        draft: n((it) => it.state === "draft" && lastAction(it) !== "revise"),
        revise: n((it) => it.state === "draft" && lastAction(it) === "revise"),
        finished: n((it) => it.state === "finished"),
        inReview: n((it) => reviewState(it) === "in-review"),
        waitingCopy: n((it) => reviewState(it) === "waiting-copy"),
        approved: n((it) => it.state === "approved"),
        held: n(isHeld),
        posting: n((it) => it.state === "posting"),
        postFailed: n((it) => it.state === "post-failed"),
        posted: n((it) => it.state === "posted"),
        discarded: n((it) => it.state === "discarded"),
      };
    },
    staleCopy,

    /**
     * The other items of the same game that are not discarded: pick and the
     * review page name them. Only one of them may post (ONE_POST_STATES).
     */
    sameGame,
    approveProblem,

    /** Items in review, oldest first: the order Nil reviews them in. */
    inReview: () =>
      items({ states: ["finished"] }).filter(
        (it) => reviewState(it) === "in-review",
      ),

    /** Nil's newest review action over every item ({...review, itemId}), or null. */
    lastReview: () =>
      items()
        .flatMap((it) => it.reviews.map((r) => ({ ...r, itemId: it.id })))
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
        .at(-1) ?? null,

    /** The queue's settings (queue.json): {reviewTarget}. */
    queue: readQueue,

    /**
     * How many items Growth wants in review (Growth, 2026-10-28: it starts
     * at 3 and grows to 10). Set by Growth or the director with crew.mjs
     * queue --review-target N; no code change retunes it.
     */
    setReviewTarget(n) {
      if (!Number.isInteger(n) || n < 1 || n > REVIEW_TARGET_MAX) {
        refuse(
          `the review target is a whole number from 1 to ${REVIEW_TARGET_MAX}`,
        );
      }
      writeAtomic(
        queueFile,
        JSON.stringify({ ...readQueue(), reviewTarget: n }, null, 2),
      );
      return readQueue();
    },

    /**
     * One of Nil's review actions on an item in review. `videoSha256` and
     * `copySha256` are what his page showed: the action is refused unless
     * they are the item's video and block now, so he never approves a newer
     * render or block than he saw. Discard and revise need notes. Approve
     * binds the content (the video's and the block's hashes), not the
     * posting modes: the platforms are the ones live at its slot. Every
     * action is a feedback row, notes word for word. Only the states
     * approved, discarded and draft are written here; the poster's states
     * and posts{} never are.
     */
    review(
      id,
      { action, notes, videoSha256, copySha256, by, memberId, askId = null },
    ) {
      if (!REVIEW_ACTIONS.includes(action)) {
        refuse(`a review action is ${REVIEW_ACTIONS.join(", ")}`);
      }
      if (typeof notes !== "string" || notes.length > NOTES_MAX) {
        refuse(`the notes are a text of at most ${NOTES_MAX} characters`);
      }
      // The same rule as the review page's card (review.mjs REVIEW_PAGE,
      // b.onclick), which checks it before it sends: change both together.
      if (action !== "approve" && !notes.trim()) {
        refuse(
          `${action} needs notes: tell the director ${action === "revise" ? "what to change" : "why"}`,
        );
      }
      let row = null;
      const item = updateItem(
        id,
        ["finished"],
        (it) => {
          if (reviewState(it) !== "in-review") {
            refuse(`${id} is not in review: ${staleCopy(it)}`);
          }
          if (videoSha256 !== it.render.video.sha256) {
            refuse(
              `${id} has a new video since the page showed it; reload the page`,
            );
          }
          if (copySha256 !== blockSha256(it.copy.block)) {
            refuse(
              `${id} has a new copy block since the page showed it; reload the page`,
            );
          }
          // Only one video of a game posts, and only with music that may
          // play.
          const problem = action === "approve" ? approveProblem(it) : null;
          if (problem) refuse(problem);
          // The bytes Nil approves are the bytes that post: the file must
          // still be the record's video.
          if (
            action === "approve" &&
            fileSha256(it.render.video.path) !== videoSha256
          ) {
            refuse(
              `${id}'s video file is not the one in its record; tell the director`,
            );
          }
          const at = new Date().toISOString();
          it.reviews = [
            ...it.reviews,
            {
              action,
              notes,
              by,
              memberId,
              at,
              videoSha256,
              copySha256,
              // His answer to the app's ask (review-asks.mjs), or null for
              // the review page.
              ...(askId ? { askId } : {}),
            },
          ];
          it.state = AFTER_REVIEW[action];
          if (action === "approve") {
            it.approval = { videoSha256, copySha256, by, at };
          }
          row = {
            utc: at,
            itemId: id,
            gameId: it.gameId,
            edlSha256: it.edl.sha256,
            videoSha256,
            copySha256,
            action,
            notes,
            by,
            ...(askId ? { askId } : {}),
          };
        },
        `${action} by ${by}${askId ? ` (ask ${askId})` : ""}`,
      );
      appendFileSync(feedbackLog, JSON.stringify(row) + "\n");
      return item;
    },

    /**
     * Nil takes back an approval that no slot took yet (Wall Game Director,
     * 2026-10-28: Approve is one tap, so a mis-tap on a phone must be
     * fixable without a confirm dialog). The item is finished again with
     * the same video and block, so it is in review again. Notes are
     * optional. A feedback row like the other actions. Once a slot took
     * the item (posting, posted, post-failed), it is refused.
     */
    withdraw(id, { notes, by, memberId }) {
      if (typeof notes !== "string" || notes.length > NOTES_MAX) {
        refuse(`the notes are a text of at most ${NOTES_MAX} characters`);
      }
      const now = needItem(id).state;
      if (now !== "approved") {
        refuse(
          ["posting", "posted", "post-failed"].includes(now)
            ? `a slot took ${id} already (${now}): it can no longer be withdrawn`
            : `${id} is ${now}; only an approved item is withdrawn`,
        );
      }
      let row = null;
      const item = updateItem(
        id,
        ["approved"],
        (it) => {
          const at = new Date().toISOString();
          const { videoSha256, copySha256 } = it.approval;
          it.reviews = [
            ...it.reviews,
            {
              action: "withdraw",
              notes,
              by,
              memberId,
              at,
              videoSha256,
              copySha256,
            },
          ];
          it.state = "finished";
          it.approval = null;
          row = {
            utc: at,
            itemId: id,
            gameId: it.gameId,
            edlSha256: it.edl.sha256,
            videoSha256,
            copySha256,
            action: "withdraw",
            notes,
            by,
          };
        },
        `withdraw by ${by}`,
      );
      appendFileSync(feedbackLog, JSON.stringify(row) + "\n");
      return item;
    },

    /**
     * A new item for the director: a game from a candidate report, or the
     * game of an earlier item that Nil discarded or that posted (carry-over,
     * `source.carriedFrom`). Its id is v-<UTC day>-<n>, the day's next
     * number (an item migrated from a day file has a letter instead).
     */
    pick({ candidate, style, styleVersion, source }) {
      const posts = postOfGame({ gameId: candidate.gameId, id: null });
      if (posts) {
        refuse(
          `another video of ${candidate.gameId} is ${posts.state} (${posts.id}): only one video of a game posts${posts.state === "approved" ? "; Nil may withdraw it on /review" : ""}`,
        );
      }
      if (source.carriedFrom !== undefined) {
        const old = needItem(source.carriedFrom);
        if (!CARRY_FROM.includes(old.state)) {
          refuse(
            `${old.id} is ${old.state}: carry over only an item that is ${CARRY_FROM.join(" or ")}; work on ${old.id} itself`,
          );
        }
      }
      const now = new Date().toISOString();
      const day = utcDay();
      const taken = readdirSync(dirs.items)
        .map((f) => f.match(/^v-(\d{4}-\d{2}-\d{2})-(\d+)\.json$/))
        .filter((m) => m && m[1] === day)
        .map((m) => Number(m[2]));
      const item = {
        version: ITEM_VERSION,
        id: itemId(day, String(Math.max(0, ...taken) + 1)),
        createdAt: now,
        updatedAt: now,
        gameId: candidate.gameId,
        source,
        candidate,
        style,
        // The on-video caption style at pick time (candidate.mjs).
        styleVersion,
        edl: null,
        render: null,
        check: null,
        caption: null,
        payoff: null,
        copy: null,
        state: "draft",
        reviews: [],
        approval: null,
        posts: {},
        events: [
          {
            utc: now,
            what: `picked ${candidate.gameId}${source.carriedFrom ? ` (carried over from ${source.carriedFrom})` : ""}`,
          },
        ],
      };
      writeItem(item);
      return item;
    },

    /**
     * The director's edit decision list for an item: `edl` is the validated
     * document and `text` the exact bytes the renderer will read. A new list
     * replaces the render made from the old one, and a finished item goes
     * back to draft: its next render and check finish it again.
     */
    /**
     * `needsPawnArt`: the list's lint found that the game's capture has
     * no pawn art, which a reactor of the list shows (routes.mjs lintGate):
     * its render captures live while the 4090's capture has none.
     * @param {string} id
     * @param {{ edl: any, text: string, summary: unknown[], needsPawnArt: boolean }} list
     */
    direct(id, { edl, text, summary, needsPawnArt }) {
      const sha = createHash("sha256").update(text).digest("hex");
      return updateItem(
        id,
        ["draft", "finished"],
        (item) => {
          expectStage(item, SETTLED, "direct");
          item.state = "draft";
          item.edl = {
            doc: edl,
            text,
            sha256: sha,
            summary,
            needsPawnArt,
            directedAt: new Date().toISOString(),
          };
          item.render = null;
          item.check = null;
          item.caption = edl.caption ?? null;
          item.payoff = edl.payoff ?? null;
        },
        `directed (edl ${sha.slice(0, 12)})`,
      );
    },

    /**
     * A live render loads the game's replay page once, which adds one view
     * to the real game (GET /api/games/:id). A second live render of the
     * same game on the same UTC day (renders.json, over every item) is
     * therefore refused unless it is asked for by name. A render
     * `fromCache` reads the capture that a live render saved on the 4090:
     * no view, so no count and no refusal.
     */
    startRender(id, jobId, { force = false, fromCache = false } = {}) {
      return updateItem(
        id,
        ["draft"],
        (item) => {
          expectStage(item, ["directed", "render-failed"], "render");
          // Phase 1 before phase 2 (SCRIPT.md): no render of a story that
          // no fresh reviewer passed. Previews, quick looks and lints may
          // run before it.
          const script = currentScriptReview(item);
          if (script?.verdict !== "pass") {
            refuse(
              script
                ? `${id}'s latest script review failed: fix the script, get a new review and record it (crew.mjs script-review) before you render`
                : `${id} has no script review${item.reviews?.some((r) => r.action === "revise") ? " since Nil's revise" : ""}: write the script (crew.mjs script), get it reviewed (script-review-prompt) and record the verdict (script-review) before you render`,
            );
          }
          const before = viewsToday(item.gameId);
          if (!fromCache && before > 0 && !force) {
            refuse(
              `${item.gameId} was already rendered ${before} time(s) today, and each render adds one view to the real game; pass force to render it again`,
            );
          }
          if (!fromCache) countView(item.gameId);
          item.render = {
            jobId,
            fromCache,
            requestedAt: new Date().toISOString(),
            finishedAt: null,
            error: null,
            // The director's ending (edl.mjs requires one).
            ending: item.edl.doc.ending,
            edlSha256: item.edl.sha256,
            // The story this render tells (renderScriptReview).
            scriptReview: { at: script.at, scriptSha256: script.scriptSha256 },
            video: null,
            sheet: null,
            effect: null,
            sound: null,
            music: null,
            quality: null,
          };
        },
        `render ${jobId} queued (${fromCache ? "from the capture" : "live capture"})`,
      );
    },

    /** The render's result; only for the item's current render. */
    finishRender(id, jobId, outcome) {
      return updateItem(
        id,
        ["draft"],
        (item) => {
          expectStage(item, ["rendering"], "finish render");
          if (item.render.jobId !== jobId) {
            refuse(
              `render ${jobId} is not the current one (${item.render.jobId})`,
            );
          }
          item.render.finishedAt = new Date().toISOString();
          // A render asked from the capture that loaded the replay page
          // after all (`viewed`): its view is counted here.
          if (outcome.viewed && item.render.fromCache) countView(item.gameId);
          if (outcome.error) {
            item.render.error = outcome.error;
            return;
          }
          item.render.video = outcome.video;
          item.render.sheet = outcome.sheet;
          item.render.effect = outcome.effect;
          item.render.sound = outcome.sound;
          item.render.music = outcome.music;
          item.render.quality = outcome.quality;
          // When and what plays (strips.mjs); null from a kit without it.
          item.render.timeline = outcome.timeline ?? null;
          // The board's cells at rest; null in a style other than wallz,
          // or from a kit without it.
          item.render.grid = outcome.grid ?? null;
          // How long each step took; null from an adapter without it.
          item.render.timings = outcome.timings ?? null;
        },
        `render ${jobId} ${outcome.error ? "failed" : "done"}`,
      );
    },

    /**
     * The director looked at the contact sheet: one verdict per still, in
     * the sheet's order, each with what the director saw. Only an item
     * whose every still is ok is finished (Nil, 2026-10-26: each FAHHH and
     * zoom must show the save wall). The measures the app took of the
     * render (quality.mjs) must pass too. A failed check leaves the item a
     * rendered draft; the way on is a new edit list.
     */
    recordCheck(id, { sheetSha256, stills }) {
      let summary = "";
      return updateItem(
        id,
        ["draft"],
        (item) => {
          expectStage(item, ["rendered"], "check");
          const sheet = item.render.sheet;
          if (item.check && !item.check.ok) {
            refuse(
              "this render already failed its check; the way on is a new edit list (direct), not a second check",
            );
          }
          if (sheetSha256 !== sheet.sha256) {
            refuse(
              "the check is about another contact sheet than the current render's",
            );
          }
          if (!Array.isArray(stills) || stills.length !== sheet.stills.length) {
            refuse(
              `the sheet has ${sheet.stills.length} stills; the check must give a verdict on each, in order`,
            );
          }
          const verdicts = sheet.stills.map((still, i) => {
            const v = stills[i];
            if (v?.ply !== still.ply || v?.kind !== still.kind) {
              refuse(
                `verdict ${i + 1} is for ply ${v?.ply} ${v?.kind}, but still ${i + 1} is ply ${still.ply} ${still.kind}`,
              );
            }
            if (typeof v.ok !== "boolean")
              refuse(`verdict ${i + 1} needs ok: true or false`);
            const note = String(v.note ?? "").trim();
            if (!note)
              refuse(`verdict ${i + 1} needs a note: what the still shows`);
            return { ...still, ok: v.ok, note: note.slice(0, 300) };
          });
          const quality = item.render.quality;
          if (!quality) {
            refuse(
              "this render has no measures (it finished before the app took them); render again with force",
            );
          }
          const failedMeasures = Object.entries(quality).filter(
            ([, m]) => !m.ok,
          );
          const badStills = verdicts.filter((v) => !v.ok).length;
          const ok = badStills === 0 && failedMeasures.length === 0;
          item.check = {
            sheetSha256,
            ok,
            verdicts,
            quality,
            checkedAt: new Date().toISOString(),
          };
          if (ok) item.state = "finished";
          const failures = [
            ...(badStills ? [`${badStills} of ${verdicts.length} stills`] : []),
            ...failedMeasures.map(([name, m]) => `${name}: ${m.note}`),
          ];
          summary = ok
            ? `contact sheet checked: ${verdicts.length} stills ok; finished`
            : `check failed: ${failures.join("; ")}`;
        },
        () => summary,
      );
    },

    /**
     * Wall Game Growth's copy block for an item's current video, checked by
     * copy.mjs. A new block replaces the old one until Nil approves the
     * item; a render that makes other bytes leaves it stale (reviewState).
     */
    recordCopy(id, copy) {
      return updateItem(
        id,
        ["draft", "finished"],
        (item) => {
          expectStage(item, ["rendered", "checked"], "copy");
          // The final video passed a fresh reviewer first (Wall Game
          // Director, 2026-10-28, rule R10).
          if (currentVet(item)?.verdict !== "pass") {
            refuse(
              `${id}: no passing independent review of video ${String(item.render.video.sha256).slice(0, 12)}; the director runs crew.mjs vet`,
            );
          }
          item.copy = {
            block: copy,
            sha256: copySha256(copy),
            forVideoSha256: item.render.video.sha256,
            storedAt: new Date().toISOString(),
          };
        },
        `copy block (${copy.version})`,
      );
    },

    /**
     * The independent review of the FINAL video (Wall Game Director,
     * 2026-10-28, rule R10): a fresh reviewer judged the MP4, and the
     * director records who, the verdict and the notes, bound to the video
     * (`copy` needs the latest one for the current video to pass). Only a
     * finished item (its check passed), and only its current video, whose
     * file must still be those bytes. A record, not a message: a fail is
     * the director's working note.
     */
    recordVet(id, { videoSha256, reviewer, verdict, notes }) {
      const who = typeof reviewer === "string" ? reviewer.trim() : "";
      if (!who || /[\r\n]/.test(who) || who.length > VET_REVIEWER_MAX) {
        refuse(
          `vet needs the reviewer: one line of 1 to ${VET_REVIEWER_MAX} characters`,
        );
      }
      if (verdict !== "pass" && verdict !== "fail") {
        refuse("vet needs the verdict: pass or fail");
      }
      if (
        typeof notes !== "string" ||
        !notes.trim() ||
        notes.length > NOTES_MAX
      ) {
        refuse(
          `vet needs notes: what the reviewer checked and found, 1 to ${NOTES_MAX} characters`,
        );
      }
      return updateItem(
        id,
        ["finished"],
        (item) => {
          if (videoSha256 !== item.render.video.sha256) {
            refuse(
              `${id}'s current video is ${item.render.video.sha256.slice(0, 12)}, not ${String(videoSha256).slice(0, 12)}: review the current video`,
            );
          }
          if (fileSha256(item.render.video.path) !== videoSha256) {
            refuse(
              `${id}'s video file is not the one in its record; tell Video Editor (daily app)`,
            );
          }
          // The video must tell the story that passed (renderScriptReview).
          if (scriptAfterRender(item)) {
            refuse(
              `${id}: a script review came after this render, so the video tells an older story: render again from the current script`,
            );
          }
          item.vets = [
            ...(item.vets ?? []),
            {
              at: new Date().toISOString(),
              reviewer: who,
              verdict,
              notes,
              videoSha256,
            },
          ];
        },
        `vet ${verdict} by ${who}`,
      );
    },

    /**
     * The fresh review of the item's script (phase 1, SCRIPT.md): the
     * script's text, the verdict and the notes. A draft only: the story
     * comes before the render. `render` needs the latest one since the
     * pick or the last revise to pass (currentScriptReview).
     */
    recordScriptReview(id, { script, reviewer, verdict, notes }) {
      const who = typeof reviewer === "string" ? reviewer.trim() : "";
      if (!who || /[\r\n]/.test(who) || who.length > VET_REVIEWER_MAX) {
        refuse(
          `script-review needs the reviewer: one line of 1 to ${VET_REVIEWER_MAX} characters`,
        );
      }
      if (verdict !== "pass" && verdict !== "fail") {
        refuse("script-review needs the verdict: pass or fail");
      }
      if (
        typeof script !== "string" ||
        !script.trim() ||
        script.length > SCRIPT_MAX
      ) {
        refuse(`script-review needs the script: 1 to ${SCRIPT_MAX} characters`);
      }
      if (
        typeof notes !== "string" ||
        !notes.trim() ||
        notes.length > NOTES_MAX
      ) {
        refuse(
          `script-review needs notes: what the reviewer checked and found, 1 to ${NOTES_MAX} characters`,
        );
      }
      return updateItem(
        id,
        ["draft"],
        (item) => {
          item.scriptReviews = [
            ...(item.scriptReviews ?? []),
            {
              at: new Date().toISOString(),
              reviewer: who,
              verdict,
              notes,
              script,
              scriptSha256: createHash("sha256").update(script).digest("hex"),
            },
          ];
        },
        `script review ${verdict} by ${who}`,
      );
    },

    /**
     * A text fix of the passed script after its review: the lint forced a
     * text the review saw another way (a caption's 7th token), and the
     * stored script must match the video (Wall Game Director, 2026-10-30).
     * It goes on the current script review, which must have passed, with
     * who made it and the lint line that forced it. It is not a review:
     * the story stays the one the reviewer passed, so a render stays valid
     * (scriptAfterRender) and the render vet reads the fixed text.
     */
    recordScriptFix(id, { script, by, why }) {
      const who = typeof by === "string" ? by.trim() : "";
      if (!who || /[\r\n]/.test(who) || who.length > VET_REVIEWER_MAX) {
        refuse(
          `script-fix needs who made it: one line of 1 to ${VET_REVIEWER_MAX} characters`,
        );
      }
      if (
        typeof script !== "string" ||
        !script.trim() ||
        script.length > SCRIPT_MAX
      ) {
        refuse(`script-fix needs the script: 1 to ${SCRIPT_MAX} characters`);
      }
      if (typeof why !== "string" || !why.trim() || why.length > NOTES_MAX) {
        refuse(
          `script-fix needs why: the lint line that forced the change, 1 to ${NOTES_MAX} characters`,
        );
      }
      return updateItem(
        id,
        ["draft", "finished", "approved"],
        (item) => {
          const review = currentScriptReview(item);
          if (review?.verdict !== "pass") {
            refuse(
              `${id} has no passed script review to fix: a story change needs a new review (crew.mjs script-review)`,
            );
          }
          if (script === scriptText(review).script) {
            refuse(`${id}: the script is the same as the stored one`);
          }
          review.fixes = [
            ...(review.fixes ?? []),
            {
              at: new Date().toISOString(),
              by: who,
              why: why.trim(),
              script,
              scriptSha256: createHash("sha256").update(script).digest("hex"),
            },
          ];
        },
        `script text fix by ${who}`,
      );
    },

    /**
     * Nil's revise asks only for a change of look (a sound, a mark, a
     * place), not of the story: the script that passed before it still
     * tells the video (Wall Game Director, 2026-10-30). Recorded as a pass
     * that carries that review over the revise, with who decided it and
     * why, so `render` and the render vet read the same script, and the
     * director needs no new script review for a look-only revise. A story
     * change still needs one (recordScriptReview). A draft only, after a
     * revise with no script review since.
     */
    recordScriptUnchanged(id, { by, why }) {
      const who = typeof by === "string" ? by.trim() : "";
      if (!who || /[\r\n]/.test(who) || who.length > VET_REVIEWER_MAX) {
        refuse(
          `script-unchanged needs who decided it: one line of 1 to ${VET_REVIEWER_MAX} characters`,
        );
      }
      if (typeof why !== "string" || !why.trim() || why.length > NOTES_MAX) {
        refuse(
          `script-unchanged needs why: why Nil's revise changes no story, 1 to ${NOTES_MAX} characters`,
        );
      }
      return updateItem(
        id,
        ["draft"],
        (item) => {
          const revise = item.reviews?.findLast((r) => r.action === "revise");
          if (!revise) {
            refuse(
              `${id} has no revise from Nil: its script review stands as it is`,
            );
          }
          const since = currentScriptReview(item);
          if (since) {
            refuse(
              `${id} already has a script review since Nil's revise (${since.verdict} by ${since.reviewer}, ${since.at})`,
            );
          }
          // The latest review before the revise, pass or fail: a carry never
          // jumps over a later fail back to an older pass (VR1, review 100
          // N1; Wall Game PM).
          const passed = (item.scriptReviews ?? []).findLast(
            (r) => r.at <= revise.at,
          );
          if (!passed) {
            refuse(
              `${id} has no passed script review before Nil's revise to carry over: write the script and get it reviewed (crew.mjs script-review)`,
            );
          }
          if (passed.verdict !== "pass") {
            refuse(
              `${id}: the last review before the revise failed (${passed.reviewer}, ${passed.at}): write the script and get it reviewed (crew.mjs script-review)`,
            );
          }
          const text = scriptText(passed);
          item.scriptReviews = [
            ...item.scriptReviews,
            {
              at: new Date().toISOString(),
              reviewer: who,
              verdict: "pass",
              notes: `SCRIPT UNCHANGED after Nil's revise of ${revise.at} (${JSON.stringify(revise.notes ?? "")}), decided by ${who}: ${why.trim()}\nIt carries the review ${passed.verdict} by ${passed.reviewer} (${passed.at}); its notes:\n\n${passed.notes}`,
              script: text.script,
              scriptSha256: text.scriptSha256,
              carried: {
                from: passed.at,
                revisedAt: revise.at,
                why: why.trim(),
              },
            },
          ];
        },
        `script unchanged after the revise, by ${who}`,
      );
    },

    /**
     * Keep an approved item from posting, approval kept (Wall Game PM,
     * 2026-10-31: a render fault, a ghost walk through a wall, in 7
     * approved videos; Nil decides about the approvals). The hold binds the
     * approved video: a new render that Nil approves has other bytes, so it
     * is not held (isHeld). A withdraw and a new approval of the same video
     * keep it held.
     */
    hold(id, why, by) {
      const reason = String(why ?? "").trim();
      if (!reason) refuse("hold needs the reason");
      const who = String(by ?? "").trim() || "the director";
      return updateItem(
        id,
        ["approved"],
        (item) => {
          item.hold = {
            videoSha256: item.approval.videoSha256,
            why: reason.slice(0, 300),
            by: who,
            at: new Date().toISOString(),
          };
        },
        `held by ${who}: ${reason.slice(0, 300)}`,
      );
    },

    /** Lift a hold by hand (a new approved video lifts it on its own). */
    release(id, by) {
      const who = String(by ?? "").trim() || "the director";
      return updateItem(
        id,
        ["approved"],
        (item) => {
          if (!isHeld(item)) refuse(`${id} is not held`);
          delete item.hold;
        },
        `hold released by ${who}`,
      );
    },

    /**
     * The director stops work on an item that Nil has not reviewed (a game
     * that does not make a video). It is discarded with the director's
     * reason as an event; Nil's discards are review actions instead.
     */
    drop(id, why) {
      const reason = String(why ?? "").trim();
      if (!reason) refuse("drop needs the reason");
      return updateItem(
        id,
        ["draft", "finished"],
        (item) => {
          expectStage(item, SETTLED, "drop");
          item.state = "discarded";
        },
        `dropped by the director: ${reason.slice(0, 300)}`,
      );
    },
  };
};

/** Version 1's day states that were a candidate's production states. */
const V1_PRODUCTION = [
  "picked",
  "directed",
  "rendering",
  "rendered",
  "render-failed",
  "checked",
];
/** Every field a version 1 day file may have, and of its approval. */
const V1_FIELDS = [
  "day",
  "state",
  "createdAt",
  "updatedAt",
  "candidate",
  "style",
  "styleVersion",
  "copy",
  "caption",
  "edl",
  "render",
  "check",
  "approval",
  "earlierAsks",
  "posts",
  "renders",
  "replaced",
  "events",
];
const V1_APPROVAL_FIELDS = [
  "askId",
  "askedAt",
  "modes",
  "videoSha256",
  "copy",
  "caption",
  "decision",
  "approver",
  "answeredAt",
  "reply",
  "replacesAskId",
  "sameVideoAs",
];

/**
 * A version 1 day file (one game, one render, one block) as version 2, with
 * that game as candidate A. Nothing is dropped: a field that version 1 never
 * had stops the migration, so an unknown field is seen, not lost.
 */
export const migrateV1 = (v1) => {
  const unknown = Object.keys(v1).filter((k) => !V1_FIELDS.includes(k));
  if (unknown.length) {
    throw new Error(
      `${v1.day}: version 1 has no field ${unknown.join(", ")}; the migration would lose it`,
    );
  }
  const offeredA = (a) => {
    const extra = Object.keys(a).filter((k) => !V1_APPROVAL_FIELDS.includes(k));
    if (extra.length) {
      throw new Error(
        `${v1.day}: version 1's approval has no field ${extra.join(", ")}; the migration would lose it`,
      );
    }
    const { videoSha256, copy, decision, ...rest } = a;
    return {
      ...rest,
      offered: {
        A: {
          videoSha256,
          copySha256: copy ? copySha256(copy) : null,
          copy: copy ?? null,
          gameId: v1.candidate?.gameId ?? null,
          edlSha256: v1.edl?.sha256 ?? null,
          caption: v1.edl?.doc?.caption ?? null,
        },
      },
      decision:
        decision === "approve" ? "pick" : decision === "reject" ? "none" : null,
      picked: decision === "approve" ? "A" : null,
      videoSha256: decision === "approve" ? videoSha256 : null,
      copy: decision === "approve" ? (copy ?? null) : null,
    };
  };
  const production = V1_PRODUCTION.includes(v1.state);
  return {
    version: 2,
    day: v1.day,
    state: production ? "open" : v1.state,
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
    cands: {
      A: {
        label: "A",
        // From the ask on, version 1's video had passed its check.
        state: production ? v1.state : "checked",
        pickedAt: v1.createdAt,
        candidate: v1.candidate,
        style: v1.style,
        styleVersion: v1.styleVersion,
        edl: v1.edl ?? null,
        render: v1.render ?? null,
        check: v1.check ?? null,
        copy: v1.copy ?? null,
        copyFor: v1.copy ? (v1.render?.video?.sha256 ?? null) : null,
        replaced: v1.replaced ?? [],
        // A cycle from before Growth's block had the director's caption.
        ...(v1.caption !== undefined && { caption: v1.caption }),
      },
    },
    approval: v1.approval ? offeredA(v1.approval) : null,
    earlierAsks: (v1.earlierAsks ?? []).map(offeredA),
    posts: v1.posts ?? {},
    renders: v1.renders ?? {},
    events: v1.events ?? [],
  };
};

/** A track played from the video's first ply (startPly) to its end. */
const oneCue = (track, startPly) => [{ fromPly: startPly, track }];

/**
 * A version 2 day file as version 3: a list's "music" and a render's music
 * become cue lists (edl.mjs). A version 2 string named the one track the
 * whole video played, so it becomes one cue from the video's first ply, and
 * a render's cue starts at second 0. The list's text is rewritten with it,
 * because a render sends the text to the 4090, and its sha256 follows the
 * text. What a render or an ask recorded (render.edlSha256, the offers'
 * edlSha256) stays: it is what the renderer read. Approvals and copy blocks
 * bind the video's sha256, which does not change.
 */
export const migrateV2 = (v2) => {
  const cand = (c) => {
    const music = c.edl?.doc?.music;
    if (typeof music !== "string" && typeof c.render?.music !== "string") {
      return c;
    }
    const startPly = c.edl?.doc?.startPly ?? 0;
    const edl =
      typeof music === "string"
        ? (() => {
            // As direct writes it (routes.mjs).
            const text =
              JSON.stringify(
                { ...JSON.parse(c.edl.text), music: oneCue(music, startPly) },
                null,
                2,
              ) + "\n";
            return {
              ...c.edl,
              doc: { ...c.edl.doc, music: oneCue(music, startPly) },
              text,
              sha256: createHash("sha256").update(text).digest("hex"),
            };
          })()
        : c.edl;
    const render =
      typeof c.render?.music === "string"
        ? {
            ...c.render,
            music: [{ fromPly: startPly, track: c.render.music, at: 0 }],
          }
        : c.render;
    return { ...c, edl, render };
  };
  return {
    ...v2,
    version: VERSION,
    cands: Object.fromEntries(
      Object.entries(v2.cands).map(([label, c]) => [label, cand(c)]),
    ),
  };
};

/** Every field a version 3 candidate may have. */
const CAND_FIELDS = [
  "label",
  "state",
  "pickedAt",
  "candidate",
  "style",
  "styleVersion",
  "edl",
  "render",
  "check",
  "copy",
  "copyFor",
  "replaced",
  "caption",
];

/**
 * One candidate of a version 3 day file as a video item (the review queue,
 * 2026-10-28). The day file stays as history; the item names it. Its state:
 * - the picked candidate of an approved day: approved, posted or
 *   post-failed as the day was, with the day's posts and the approval's
 *   video and block (no modes: an item posts where it is live at its slot);
 * - a candidate an answered ask offered and Nil did not pick: discarded,
 *   with that answer's words as its note;
 * - any other: finished when its check passed, else draft.
 * Nil's answers become review rows marked with their ask. A field that a
 * candidate never had stops the migration, so it is seen, not lost.
 */
export const itemFromDay = (record, label) => {
  const cand = record.cands[label];
  const unknown = Object.keys(cand).filter((k) => !CAND_FIELDS.includes(k));
  if (unknown.length) {
    throw new Error(
      `${record.day} ${label}: a candidate has no field ${unknown.join(", ")}; the migration would lose it`,
    );
  }
  const answered = [
    ...(record.earlierAsks ?? []),
    ...(record.approval ? [record.approval] : []),
  ].filter((a) => a.decision !== null);
  const review = (a, action) => ({
    action,
    notes: a.reply ?? "",
    by: a.approver,
    memberId: null,
    at: a.answeredAt,
    videoSha256: a.offered[label].videoSha256,
    copySha256: a.offered[label].copySha256,
    migratedFromAsk: a.askId,
  });
  const approval = record.approval;
  const approved =
    approval?.decision === "pick" && approval.picked === label
      ? approval
      : null;
  const passed = answered.filter((a) => a.offered[label] && a.picked !== label);
  const state = approved
    ? record.state === "posted" || record.state === "post-failed"
      ? record.state
      : "approved"
    : passed.length
      ? "discarded"
      : cand.state === "checked"
        ? "finished"
        : "draft";
  // The block: Growth's, or (before Growth) the one the approval bound.
  const copy = cand.copy
    ? {
        block: cand.copy,
        sha256: copySha256(cand.copy),
        forVideoSha256: cand.copyFor,
        storedAt: null,
      }
    : approved?.copy
      ? {
          block: approved.copy,
          sha256: approved.offered[label].copySha256,
          forVideoSha256: approved.videoSha256,
          storedAt: null,
        }
      : null;
  // An approval that still has to post must bind the block and the video
  // the item carries, or the poster would refuse it for ever (Video
  // Reviewer 2, 2026-10-28): a day like that stops the start-up.
  if (state === "approved" || state === "post-failed") {
    const a = approved.offered[label];
    if (
      copy?.sha256 !== a.copySha256 ||
      copy.forVideoSha256 !== a.videoSha256
    ) {
      throw new Error(
        `${record.day} candidate ${label}: the approval binds video ${String(a.videoSha256).slice(0, 12)} and block ${String(a.copySha256).slice(0, 12)}, but the candidate carries video ${String(copy?.forVideoSha256).slice(0, 12)} and block ${String(copy?.sha256).slice(0, 12)}`,
      );
    }
  }
  return {
    version: ITEM_VERSION,
    id: itemId(record.day, label),
    createdAt: cand.pickedAt ?? record.createdAt,
    updatedAt: record.updatedAt,
    gameId: cand.candidate?.gameId ?? null,
    source: {
      migratedFrom: {
        day: record.day,
        label,
        replaced: cand.replaced ?? [],
        ...(cand.caption !== undefined && { postCaption: cand.caption }),
      },
    },
    candidate: cand.candidate,
    style: cand.style ?? null,
    styleVersion: cand.styleVersion ?? null,
    edl: cand.edl ?? null,
    render: cand.render ?? null,
    check: cand.check ?? null,
    caption: cand.edl?.doc?.caption ?? null,
    payoff: cand.edl?.doc?.payoff ?? null,
    copy,
    state,
    reviews: approved
      ? [review(approved, "approve")]
      : passed.length
        ? [review(passed.at(-1), "discard")]
        : [],
    approval: approved && {
      videoSha256: approved.videoSha256,
      copySha256: approved.offered[label].copySha256,
      by: approved.approver,
      at: approved.answeredAt,
    },
    posts: approved ? (record.posts ?? {}) : {},
    events: [
      {
        utc: record.updatedAt,
        what: `migrated from day ${record.day}, candidate ${label} (${cand.state})`,
      },
    ],
  };
};

/** Read a JSONL log (posts, feedback); a missing file is an empty log. */
export const readPostLog = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
