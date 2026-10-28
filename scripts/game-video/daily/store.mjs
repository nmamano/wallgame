/**
 * The daily video's record: one file per UTC day, and the only state the
 * daily pipeline keeps.
 *
 * A DAY HAS UP TO THREE CANDIDATES, A, B and C (Nil, 2026-10-27: the director
 * offers a few videos and he picks the one to post). Each candidate is its
 * own game, edit list, render, check and copy block, and goes
 *
 *   picked -> directed -> rendering -> rendered -> checked
 *                                  \-> render-failed
 *
 * on its own: one can be directed again while another is checked. The day
 * holds the ask and the posting:
 *
 *   open -> asked -> approved -> posted
 *                \-> rejected  \-> post-failed
 *
 * The production steps (pick, direct, render, check, copy) work only while
 * the day is open or rejected: from the ask on, the ask names the videos and
 * blocks it showed, and nothing may change under it. "None today" leaves the
 * day rejected; a new ask is allowed when it offers something new.
 *
 * Every step checks the state it starts from. The checks are the point of
 * this file: the steps are run by an agent woken by a schedule, possibly in a
 * different session from the one that started the day, and "post" must not
 * be reachable from anything but Nil's pick of THIS video and THIS block.
 *
 * THREE RULES THAT KEEP AN APPROVAL HONEST.
 *
 * 1. The ask records, for each candidate it offered, the video by sha256
 *    and Growth's copy block by its copySha256 (copy.mjs). Nil's pick binds
 *    the picked candidate's two; post refuses any other bytes or text.
 * 2. An approval names the posting mode (dry-run or live, per platform) that
 *    the ask told Nil about. If keys arrive between the ask and the post, the
 *    post refuses, so a "yes" to a dry run never becomes a real post.
 * 3. A platform that is posted is never posted again for the same day. A
 *    retry after a partial failure posts only what is missing. A post whose
 *    last request was SENT but not answered (a lost reply, a 5xx, an app that
 *    died in between) may exist on the platform, so it is marked uncertain
 *    and is not retried until a person has looked at the account and says
 *    it is not there.
 *
 * A COPY BLOCK BELONGS TO ONE VIDEO. It is stored with the sha256 of the
 * candidate's MP4 when it came in (copyFor). A render that makes other bytes
 * leaves the block stale, and the ask refuses it; a render of the same list
 * from the capture cache makes the same bytes, so the block stays good.
 *
 * Every write goes to a scratch file first and is renamed into place, so a
 * crash never leaves half a record. A day file from before the candidates
 * (version 1) is rewritten once at start-up as candidate A (migrateV1), and
 * one from before the music cues (version 2) gets cue lists (migrateV2). The
 * old file is kept next to it as <day>.v1.json or <day>.v2.json.
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
import { copySha256 } from "./copy.mjs";

/**
 * The record's format. migrateV1 turns a version 1 file into version 2, and
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
 * Where a finished item stands: "in-review" when Growth's block is for its
 * current video and, after a revise, both the render and the block came
 * later than Nil's revise (Growth's rule, 2026-10-28: a revised item is in
 * review again only with a new render AND a new block); else
 * "waiting-copy". Null for any other state.
 */
export const reviewState = (item) => {
  if (item.state !== "finished") return null;
  const fresh =
    item.copy !== null &&
    item.copy.forVideoSha256 === item.render?.video?.sha256;
  const revise = item.reviews.filter((r) => r.action === "revise").at(-1);
  const afterRevise =
    !revise ||
    (item.render?.finishedAt > revise.at && item.copy?.storedAt > revise.at);
  return fresh && afterRevise ? "in-review" : "waiting-copy";
};

/** A day's candidates, in the order the ask shows them. */
export const LABELS = ["A", "B", "C"];
/** The longest reason of a recommendation in the ask (one line). */
export const WHY_MAX = 100;

export const CANDIDATE_STATES = [
  "picked",
  "directed",
  "rendering",
  "rendered",
  "render-failed",
  "checked",
];

export const DAY_STATES = [
  "open",
  "asked",
  "approved",
  "rejected",
  "posted",
  "post-failed",
];

export const PLATFORMS = [
  "x",
  "youtube",
  "tiktok",
  "instagram",
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

/** The candidate states a new pick, a new list or a new block may replace. */
const SETTLED = ["picked", "directed", "rendered", "render-failed", "checked"];

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
  /** One line per answer: what Nil picked and what he said (readFeedback). */
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

  const save = (record, what) => {
    record.updatedAt = new Date().toISOString();
    record.events.push({ at: record.updatedAt, state: record.state, what });
    writeAtomic(cyclePath(record.day), JSON.stringify(record, null, 2));
    return record;
  };

  const need = (day) => read(day) ?? refuse(`there is no cycle for ${day}`);

  const expect = (record, allowed, step) => {
    if (!allowed.includes(record.state)) {
      refuse(
        `${step} needs the day ${allowed.join(" or ")}, but ${record.day} is ${record.state}`,
      );
    }
  };

  /** Production steps change a candidate; the ask must not see it move. */
  const expectOpen = (record, step) => {
    if (!["open", "rejected"].includes(record.state)) {
      refuse(
        `${step} needs the day open, but ${record.day} is ${record.state}: the ask names its videos and blocks, so nothing changes until it is answered`,
      );
    }
  };

  const labelOf = (label) =>
    LABELS.includes(label)
      ? label
      : refuse(`a candidate is ${LABELS.join(", ")}, not ${label}`);

  const needCand = (record, label) =>
    record.cands[labelOf(label)] ??
    refuse(`${record.day} has no candidate ${label}`);

  const expectCand = (cand, allowed, step) => {
    if (!allowed.includes(cand.state)) {
      refuse(
        `${step} needs candidate ${cand.label} ${allowed.join(" or ")}, but it is ${cand.state}`,
      );
    }
  };

  /** Why the candidate's block cannot go in an ask, or null. */
  const staleCopy = (cand) =>
    !cand.copy
      ? `candidate ${cand.label} has no copy block from Wall Game Growth (crew.mjs copy --cand ${cand.label})`
      : cand.copyFor !== cand.render?.video?.sha256
        ? `candidate ${cand.label}'s copy block was written for another video (${String(cand.copyFor).slice(0, 12)}, now ${String(cand.render?.video?.sha256).slice(0, 12)}); get a new block from Wall Game Growth`
        : null;

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

    /**
     * The one way to change an item: refuses unless its state is one of
     * `expectStates`, then `mutate(item)` changes it in place; the change is
     * stamped, logged as the event `what` and written atomically. The
     * poster's transitions (posting, posted, post-failed, posts{}) use it
     * from their own module; the review routes never write those.
     * @param {string} id
     * @param {string[]} expectStates
     * @param {(item: any) => void} mutate
     * @param {string} what
     */
    updateItem(id, expectStates, mutate, what) {
      const item = readItem(id);
      if (!item) refuse(`no item ${id}`);
      if (!expectStates.includes(item.state)) {
        refuse(
          `${id} is ${item.state}; ${what} needs ${expectStates.join(" or ")}`,
        );
      }
      mutate(item);
      // A typo in a state would write an item that no list, count or queue
      // shows, and a changed id would write a second file (Video Reviewer
      // 2, 2026-10-28): refused, and nothing is written.
      if (!ITEM_STATES.includes(item.state)) {
        refuse(`${what} left ${id} in an unknown state: ${item.state}`);
      }
      if (item.id !== id) refuse(`${what} changed the item's id to ${item.id}`);
      const utc = new Date().toISOString();
      item.updatedAt = utc;
      item.events = [...item.events, { utc, what }];
      writeItem(item);
      return item;
    },

    /** Approved items, oldest approval first (then id): the post queue. */
    approvedQueue: () =>
      items({ states: ["approved"] }).sort((a, b) =>
        a.approval.at === b.approval.at
          ? a.id < b.id
            ? -1
            : 1
          : a.approval.at < b.approval.at
            ? -1
            : 1,
      ),

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
        posting: n((it) => it.state === "posting"),
        postFailed: n((it) => it.state === "post-failed"),
        posted: n((it) => it.state === "posted"),
        discarded: n((it) => it.state === "discarded"),
      };
    },
    staleCopy,

    /**
     * Start or replace one candidate of the day. A label that is taken needs
     * `replace`, so a scheduled start cannot redo a candidate by mistake
     * (Wall Game PM, 2026-10-26). The candidate's game may come from any
     * day's report: an unpicked candidate can be offered again later.
     */
    pick(day, label, { candidate, style, styleVersion, replace = false }) {
      const now = new Date().toISOString();
      const record = read(day) ?? {
        version: VERSION,
        day,
        state: "open",
        createdAt: now,
        updatedAt: now,
        cands: {},
        approval: null,
        earlierAsks: [],
        posts: {},
        // Renders per game today, kept across a re-pick: each one is a view.
        renders: {},
        events: [],
      };
      expectOpen(record, "pick");
      const old = record.cands[labelOf(label)];
      if (old && !replace) {
        refuse(
          `${day} already has candidate ${label} (${old.state}, ${old.candidate.gameId}); use replace only to redo it on purpose`,
        );
      }
      if (old) expectCand(old, SETTLED, "pick");
      record.cands[label] = {
        label,
        state: "picked",
        pickedAt: now,
        candidate,
        style,
        // The on-video caption style at pick time (candidate.mjs).
        styleVersion,
        edl: null,
        render: null,
        check: null,
        // Wall Game Growth's post text (copy.mjs) and the video it is for.
        copy: null,
        copyFor: null,
        replaced: old ? [...(old.replaced ?? []), summarize(old)] : [],
      };
      return save(record, `${label}: picked ${candidate.gameId}`);
    },

    /**
     * The director's edit decision list for a candidate: `edl` is the
     * validated document and `text` the exact bytes the renderer will read.
     * A new list replaces the render made from the old one.
     */
    direct(day, label, { edl, text, summary }) {
      const record = need(day);
      expectOpen(record, "direct");
      const cand = needCand(record, label);
      expectCand(cand, SETTLED, "direct");
      cand.state = "directed";
      cand.edl = {
        doc: edl,
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
        summary,
        directedAt: new Date().toISOString(),
      };
      cand.render = null;
      cand.check = null;
      return save(
        record,
        `${label}: directed (edl ${cand.edl.sha256.slice(0, 12)})`,
      );
    },

    /**
     * A live render loads the game's replay page once, which adds one view
     * to the real game (GET /api/games/:id). A second live render of the
     * same game on the same day is therefore refused unless it is asked for
     * by name. A render `fromCache` reads the capture that a live render
     * saved on the 4090: no view, so no count and no refusal.
     */
    startRender(day, label, jobId, { force = false, fromCache = false } = {}) {
      const record = need(day);
      expectOpen(record, "render");
      const cand = needCand(record, label);
      const gameId = cand.candidate.gameId;
      const before = record.renders[gameId] ?? 0;
      if (!fromCache && before > 0 && !force) {
        refuse(
          `${gameId} was already rendered ${before} time(s) today, and each render adds one view to the real game; pass force to render it again`,
        );
      }
      expectCand(cand, ["directed", "render-failed"], "render");
      if (!fromCache) record.renders[gameId] = before + 1;
      cand.state = "rendering";
      cand.render = {
        jobId,
        fromCache,
        requestedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        // The director's ending (edl.mjs requires one).
        ending: cand.edl.doc.ending,
        edlSha256: cand.edl.sha256,
        video: null,
        sheet: null,
        effect: null,
        sound: null,
        music: null,
        quality: null,
      };
      return save(
        record,
        `${label}: render ${jobId} queued (${fromCache ? "from the capture" : "live capture"})`,
      );
    },

    /**
     * The render's result. It may arrive after the day's ask opened (a
     * candidate that the ask did not offer): it changes only that candidate.
     */
    finishRender(day, label, jobId, outcome) {
      const record = need(day);
      const cand = needCand(record, label);
      expectCand(cand, ["rendering"], "finish render");
      if (cand.render.jobId !== jobId) {
        refuse(`render ${jobId} is not the current one (${cand.render.jobId})`);
      }
      cand.render.finishedAt = new Date().toISOString();
      // A render asked from the capture that loaded the replay page after
      // all (`viewed`): its view is counted here.
      if (outcome.viewed && cand.render.fromCache) {
        const gameId = cand.candidate.gameId;
        record.renders[gameId] = (record.renders[gameId] ?? 0) + 1;
      }
      if (outcome.error) {
        cand.state = "render-failed";
        cand.render.error = outcome.error;
        return save(record, `${label}: render ${jobId} failed`);
      }
      cand.state = "rendered";
      cand.render.video = outcome.video;
      cand.render.sheet = outcome.sheet;
      cand.render.effect = outcome.effect;
      cand.render.sound = outcome.sound;
      cand.render.music = outcome.music;
      cand.render.quality = outcome.quality;
      // When and what plays (strips.mjs); null from a kit without it.
      cand.render.timeline = outcome.timeline ?? null;
      return save(record, `${label}: render ${jobId} done`);
    },

    /**
     * The director looked at the contact sheet: one verdict per still, in the
     * sheet's order, each with what the director saw. Only a candidate whose
     * every still is ok can be offered (Nil, 2026-10-26: each FAHHH and zoom
     * must show the save wall). The measures the app took of the render
     * (quality.mjs) must pass too. A failed check leaves the candidate at
     * rendered; the way on is a new edit list.
     */
    recordCheck(day, label, { sheetSha256, stills }) {
      const record = need(day);
      expectOpen(record, "check");
      const cand = needCand(record, label);
      expectCand(cand, ["rendered"], "check");
      const sheet = cand.render.sheet;
      if (cand.check && !cand.check.ok) {
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
      const quality = cand.render.quality;
      if (!quality) {
        refuse(
          "this render has no measures (it finished before the app took them); render again with force",
        );
      }
      const failedMeasures = Object.entries(quality).filter(([, m]) => !m.ok);
      const badStills = verdicts.filter((v) => !v.ok).length;
      const ok = badStills === 0 && failedMeasures.length === 0;
      cand.check = {
        sheetSha256,
        ok,
        verdicts,
        quality,
        checkedAt: new Date().toISOString(),
      };
      if (ok) cand.state = "checked";
      const failures = [
        ...(badStills ? [`${badStills} of ${verdicts.length} stills`] : []),
        ...failedMeasures.map(([name, m]) => `${name}: ${m.note}`),
      ];
      return save(
        record,
        ok
          ? `${label}: contact sheet checked: ${verdicts.length} stills ok`
          : `${label}: check failed: ${failures.join("; ")}`,
      );
    },

    /**
     * Wall Game Growth's copy block for one candidate, checked by copy.mjs,
     * for the candidate's current video. A new block replaces the old one
     * until the ask opens; from then on the ask names the block.
     */
    recordCopy(day, label, copy) {
      const record = need(day);
      expectOpen(record, "copy");
      const cand = needCand(record, label);
      expectCand(cand, ["rendered", "checked"], "copy");
      const replaced = Boolean(cand.copy);
      cand.copy = copy;
      cand.copyFor = cand.render.video.sha256;
      return save(
        record,
        `${label}: ${replaced ? "copy block replaced" : "copy block"} (${copy.version}, for video ${cand.copyFor.slice(0, 12)})`,
      );
    },

    /**
     * The crew lead opened the day's Isomux ask. `offered` is what the ask
     * SHOWED, per label: {videoSha256, copySha256}; `modes` its posting
     * modes and `currentModes` what the app would post with now. They must
     * agree, or the approval would name bytes, text or a mode that the
     * member did not see. `replacesAskId`: the same ask opened again
     * (crew.mjs ask --reopen) while the old one is unanswered; from then on
     * only the new id's answer counts. `modeChange`: the app's posting modes
     * changed after the approval (e.g. a platform went live), so the
     * approval no longer covers a post; the same video and block are asked
     * again with the new modes, before any platform posts. `recommended`:
     * the crew lead's pick, {label, why}, as the ask showed it, or null.
     * @param {string} day
     * @param {{ askId: any, modes: any, offered: any, currentModes: any,
     *   replacesAskId?: string, modeChange?: boolean,
     *   recommended?: { label: string, why: string } | null }} ask
     */
    recordAsk(
      day,
      {
        askId,
        modes,
        offered,
        currentModes,
        replacesAskId,
        modeChange,
        recommended = null,
      },
    ) {
      const record = need(day);
      if (replacesAskId && modeChange) {
        refuse("an ask is opened again or asked for a mode change, not both");
      }
      if (modeChange) {
        expect(record, ["approved", "post-failed"], "ask for a mode change");
        // An ok, pending or uncertain post is (or may be) public already.
        const out = PLATFORMS.filter((p) => {
          const post = record.posts[p];
          return post?.ok === true || post?.pending || post?.uncertain;
        });
        if (out.length) {
          refuse(
            `${out.join(", ")} posted (or may have): a mode change is asked only before any platform posts`,
          );
        }
        if (!record.approval.copy) {
          refuse("the approval has no copy block; ask with Growth's block");
        }
      } else if (replacesAskId) {
        expect(record, ["asked"], "reopen the ask");
        if (record.approval.askId !== replacesAskId) {
          refuse(
            `ask ${replacesAskId} is not this day's ask (${record.approval.askId})`,
          );
        }
      } else {
        expect(record, ["open", "rejected"], "ask");
      }
      const labels = Object.keys(offered ?? {});
      if (labels.length === 0) refuse("the ask offers no candidate");
      labels.forEach(labelOf);
      const shown = {};
      for (const label of LABELS.filter((l) => labels.includes(l))) {
        const cand = needCand(record, label);
        expectCand(cand, ["checked"], "ask");
        const stale = staleCopy(cand);
        if (stale) refuse(stale);
        if (offered[label]?.videoSha256 !== cand.render.video.sha256) {
          refuse(`the ask shows another video for ${label} than its render`);
        }
        if (offered[label]?.copySha256 !== copySha256(cand.copy)) {
          refuse(
            `the ask shows another copy block for ${label} than the stored one`,
          );
        }
        shown[label] = {
          videoSha256: cand.render.video.sha256,
          copySha256: copySha256(cand.copy),
          copy: cand.copy,
          gameId: cand.candidate.gameId,
          edlSha256: cand.edl.sha256,
          caption: cand.edl.doc.caption ?? null,
        };
      }
      if (recommended !== null) {
        const label = recommended?.label;
        // Own labels only: a plain object also "has" constructor.
        if (!LABELS.includes(label) || !Object.hasOwn(shown, label)) {
          refuse(`the ask recommends ${label}, which it does not offer`);
        }
        const why = recommended.why;
        if (
          typeof why !== "string" ||
          !why.trim() ||
          why.length > WHY_MAX ||
          /[\r\n]/.test(why)
        ) {
          refuse(
            `a recommendation needs a reason of 1 to ${WHY_MAX} characters on one line`,
          );
        }
      }
      for (const platform of PLATFORMS) {
        if (modes?.[platform] !== currentModes[platform]) {
          refuse(
            `the ask says ${platform} ${modes?.[platform]}, but the app would post ${currentModes[platform]}`,
          );
        }
      }
      if (
        replacesAskId &&
        offerKey(shown) !== offerKey(record.approval.offered)
      ) {
        refuse("a reopened ask must offer what the open ask offered");
      }
      // After "None today", a new ask must offer at least one video and
      // block that Nil has not refused today: "None" refuses every pair
      // that its ask offered (Director, 2026-10-27).
      const rejected = record.state === "rejected" ? record.approval : null;
      if (rejected) {
        const refusals = [...record.earlierAsks, rejected].filter(
          (a) => a.decision === "none",
        );
        const refusedIn = (o) =>
          refusals
            .filter((a) =>
              Object.values(a.offered ?? {}).some(
                (r) =>
                  r.videoSha256 === o.videoSha256 &&
                  r.copySha256 === o.copySha256,
              ),
            )
            .map((a) => a.askId);
        const found = Object.values(shown).map(refusedIn);
        if (found.every((ids) => ids.length > 0)) {
          refuse(
            `every candidate in this ask was offered in ask ${[...new Set(found.flat())].join(" or ")}, which Nil answered with none: change a candidate, its video or its block first`,
          );
        }
      }
      // A mode change asks again for exactly what was approved.
      const approvedAsk = modeChange ? record.approval : null;
      // A reopened mode-change ask is still one.
      const modeChangeOf =
        approvedAsk?.askId ??
        (replacesAskId ? record.approval.modeChangeOf : undefined);
      if (approvedAsk) {
        const was = approvedAsk.picked;
        const key = offerKey({
          [was]: {
            videoSha256: approvedAsk.videoSha256,
            copySha256: copySha256(approvedAsk.copy),
          },
        });
        if (offerKey(shown) !== key) {
          refuse(
            `a mode-change ask offers only ${was}, with the video and the block of ask ${approvedAsk.askId}`,
          );
        }
        if (PLATFORMS.every((p) => modes[p] === approvedAsk.modes[p])) {
          refuse(
            `the posting modes are the ones of ask ${approvedAsk.askId}: no mode change to ask for`,
          );
        }
      }
      record.state = "asked";
      // The rejected or approved ask stays on the record.
      const earlier = rejected ?? approvedAsk;
      if (earlier) record.earlierAsks = [...record.earlierAsks, earlier];
      record.approval = {
        askId,
        askedAt: new Date().toISOString(),
        modes,
        offered: shown,
        decision: null,
        picked: null,
        // The picked candidate's video and block, set by the answer.
        videoSha256: null,
        copy: null,
        approver: null,
        answeredAt: null,
        reply: null,
        ...(replacesAskId && { replacesAskId }),
        ...(modeChangeOf && { modeChangeOf }),
        recommended: recommended && {
          label: recommended.label,
          why: recommended.why,
        },
      };
      return save(
        record,
        replacesAskId
          ? `ask ${askId} opened again (was ${replacesAskId})`
          : approvedAsk
            ? `ask ${askId} opened for a mode change (was ${approvedAsk.askId}): ${Object.keys(shown).join(", ")}`
            : `ask ${askId} opened: ${Object.keys(shown).join(", ")}`,
      );
    },

    /**
     * Nil answered the ask; the crew lead passes the answer on. `pick` is
     * the label Nil chose, or null for "None today". Every answer goes to
     * the feedback log with Nil's reply, word for word.
     */
    recordAnswer(day, { askId, pick, approver, reply }) {
      const record = need(day);
      expect(record, ["asked"], "answer");
      const a = record.approval;
      if (a.askId !== askId) {
        refuse(`ask ${askId} is not this day's ask (${a.askId})`);
      }
      if (pick !== null && !a.offered[pick]) {
        refuse(
          `the ask offered ${Object.keys(a.offered).join(", ")}, not ${pick}`,
        );
      }
      if (!approver) refuse("an answer needs the approver's name");
      Object.assign(a, {
        decision: pick === null ? "none" : "pick",
        picked: pick,
        videoSha256: pick === null ? null : a.offered[pick].videoSha256,
        copy: pick === null ? null : a.offered[pick].copy,
        approver,
        reply: reply ?? null,
        answeredAt: new Date().toISOString(),
      });
      record.state = pick === null ? "rejected" : "approved";
      appendFileSync(
        feedbackLog,
        JSON.stringify({
          utc: a.answeredAt,
          day,
          askId,
          approver,
          picked: pick,
          recommended: a.recommended ?? null,
          reply: a.reply,
          offered: Object.entries(a.offered).map(([label, o]) => ({
            label,
            gameId: o.gameId,
            edlSha256: o.edlSha256,
            videoSha256: o.videoSha256,
            caption: o.caption,
          })),
        }) + "\n",
      );
      return save(
        record,
        pick === null
          ? `none picked by ${approver}`
          : `${pick} picked by ${approver}`,
      );
    },

    /** The day whose record carries this ask, or null. */
    dayOfAsk(askId) {
      return days().find((d) => read(d)?.approval?.askId === askId) ?? null;
    },

    /**
     * The picked candidate as one flat cycle (the day's approval and posts
     * with the candidate's game, render and block), which is all that
     * posting reads; null before a pick.
     */
    picked(day) {
      const record = read(day);
      const label = record?.approval?.picked;
      if (!label) return null;
      const { candidate, style, styleVersion, edl, render, check, copy } =
        record.cands[label];
      return {
        day,
        state: record.state,
        label,
        approval: record.approval,
        posts: record.posts,
        candidate,
        style,
        styleVersion,
        edl,
        render,
        check,
        copy,
      };
    },

    /**
     * Check that the day may post now, with these modes and this video.
     * Returns the platforms still to post. `confirmedNotPosted` names the
     * platforms that a person checked after an uncertain attempt.
     */
    checkPost(day, { modes, videoSha256, confirmedNotPosted = [] }) {
      const record = need(day);
      expect(record, ["approved", "post-failed"], "post");
      const a = record.approval;
      const cand = record.cands[a.picked];
      if (videoSha256 !== a.videoSha256) {
        refuse(
          "the video on disk is not the one that was approved; render and ask again",
        );
      }
      if (!a.copy) {
        refuse(
          "this approval has no copy block (an ask from before Growth wrote the post text); ask again with Growth's block",
        );
      }
      if (!cand.copy || copySha256(cand.copy) !== copySha256(a.copy)) {
        refuse(
          "the copy block is not the one that was approved; ask again with it",
        );
      }
      for (const platform of PLATFORMS) {
        if (modes[platform] !== a.modes[platform]) {
          refuse(
            `${platform} would post ${modes[platform]}, but the approval was for ${a.modes[platform]}; ask again`,
          );
        }
      }
      const todo = PLATFORMS.filter((p) => record.posts[p]?.ok !== true);
      for (const p of todo) {
        const last = record.posts[p];
        if (
          (last?.pending || last?.uncertain) &&
          !confirmedNotPosted.includes(p)
        ) {
          refuse(
            `${p} may already have this post (${last.pending ? "the app stopped during" : "no clear answer to"} its final request at ${last.at}); check the account, then post again with --confirm-not-posted ${p}`,
          );
        }
      }
      return todo;
    },

    /** Mark the moment before a platform's final, public request. */
    markPending(day, platform, mode) {
      const record = need(day);
      expect(record, ["approved", "post-failed"], "post");
      record.posts[platform] = {
        ok: null,
        pending: true,
        mode,
        at: new Date().toISOString(),
      };
      return save(record, `${platform} final request sent`);
    },

    /** Record one platform's result, and the log row when it posted. */
    recordPost(day, platform, result, logRow) {
      const record = need(day);
      expect(record, ["approved", "post-failed"], "record post");
      record.posts[platform] = result;
      if (result.ok && logRow) {
        const file = result.mode === "live" ? postLog.live : postLog.dryRun;
        appendFileSync(file, JSON.stringify(logRow) + "\n");
      }
      const done = PLATFORMS.every((p) => record.posts[p]?.ok === true);
      const failed = PLATFORMS.some((p) => record.posts[p]?.ok === false);
      if (done) record.state = "posted";
      else if (failed) record.state = "post-failed";
      return save(
        record,
        `${platform} ${result.ok ? `posted (${result.mode})` : `failed: ${result.error}`}`,
      );
    },
  };
};

/** What the ask offered, as one comparable string: labels, videos, blocks. */
const offerKey = (offered) =>
  JSON.stringify(
    Object.entries(offered ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([label, o]) => [label, o.videoSha256, o.copySha256]),
  );

/** What is kept of a replaced candidate: enough to see that it existed. */
const summarize = (cand) => ({
  gameId: cand.candidate?.gameId ?? null,
  state: cand.state,
  edlSha256: cand.edl?.sha256 ?? null,
});

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
