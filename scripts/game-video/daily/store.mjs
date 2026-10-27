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
 * (version 1) is rewritten once at start-up as candidate A, and the old file
 * is kept next to it as <day>.v1.json (migrateV1).
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

/** The record's format; migrateV1 turns a version 1 file into this one. */
export const VERSION = 2;

/** A day's candidates, in the order the ask shows them. */
export const LABELS = ["A", "B", "C"];

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
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

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

  // Once, at start-up: a version 1 file becomes candidate A.
  for (const day of days()) {
    const path = cyclePath(day);
    const old = JSON.parse(readFileSync(path, "utf8"));
    if (old.version === VERSION) continue;
    const kept = join(dirs.cycles, `${day}.v1.json`);
    if (!existsSync(kept)) writeAtomic(kept, readFileSync(path, "utf8"));
    writeAtomic(path, JSON.stringify(migrateV1(old), null, 2));
  }

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
    read,
    days,
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
     * Each render loads the game's replay page once, which adds one view to
     * the real game (GET /api/games/:id). A second render of the same game on
     * the same day is therefore refused unless it is asked for by name.
     */
    startRender(day, label, jobId, { force = false } = {}) {
      const record = need(day);
      expectOpen(record, "render");
      const cand = needCand(record, label);
      const gameId = cand.candidate.gameId;
      const before = record.renders[gameId] ?? 0;
      if (before > 0 && !force) {
        refuse(
          `${gameId} was already rendered ${before} time(s) today, and each render adds one view to the real game; pass force to render it again`,
        );
      }
      expectCand(cand, ["directed", "render-failed"], "render");
      record.renders[gameId] = before + 1;
      cand.state = "rendering";
      cand.render = {
        jobId,
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
      return save(record, `${label}: render ${jobId} queued`);
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
     * only the new id's answer counts.
     * @param {string} day
     * @param {{ askId: any, modes: any, offered: any, currentModes: any,
     *   replacesAskId?: string }} ask
     */
    recordAsk(day, { askId, modes, offered, currentModes, replacesAskId }) {
      const record = need(day);
      if (replacesAskId) {
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
      // After "None today", a new ask must offer something new.
      const rejected = record.state === "rejected" ? record.approval : null;
      if (rejected && offerKey(shown) === offerKey(rejected.offered)) {
        refuse(
          `the ask offers what ask ${rejected.askId} offered, which Nil answered with none: change a candidate, its video or its block first`,
        );
      }
      record.state = "asked";
      // The rejected ask stays on the record.
      if (rejected) record.earlierAsks = [...record.earlierAsks, rejected];
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
      };
      return save(
        record,
        replacesAskId
          ? `ask ${askId} opened again (was ${replacesAskId})`
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
    version: VERSION,
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

/** Read a JSONL log (posts, feedback); a missing file is an empty log. */
export const readPostLog = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
