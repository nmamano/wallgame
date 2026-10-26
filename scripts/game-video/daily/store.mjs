/**
 * The daily video's record: one file per UTC day, and the only state the
 * daily pipeline keeps.
 *
 * Board task e8d26610, step 3. A cycle goes
 *
 *   picked -> rendering -> rendered -> asked -> approved -> posted
 *                       \-> render-failed      \-> rejected  \-> post-failed
 *
 * and every step checks the state it starts from. The checks are the point of
 * this file: the steps are run by an agent woken by a schedule, possibly in a
 * different session from the one that started the cycle, and "post" must not
 * be reachable from anything but an approval of THIS video.
 *
 * THREE RULES THAT KEEP AN APPROVAL HONEST.
 *
 * 1. An approval names the video by sha256. A re-render after the ask makes a
 *    different file, and post refuses it: Nil approved the bytes he saw.
 * 2. An approval names the posting mode (dry-run or live, per platform) that
 *    the ask told Nil about. If keys arrive between the ask and the post, the
 *    post refuses, so a "yes" to a dry run never becomes a real post.
 * 3. A platform that is posted is never posted again for the same cycle. A
 *    retry after a partial failure posts only what is missing. A post whose
 *    last request was SENT but not answered (a lost reply, a 5xx, an app that
 *    died in between) may exist on the platform, so it is marked uncertain
 *    and is not retried until a person has looked at the account and says
 *    it is not there.
 *
 * Every write goes to a scratch file first and is renamed into place, so a
 * crash never leaves half a record.
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

export const STATES = [
  "picked",
  "directed",
  "rendering",
  "rendered",
  "checked",
  "render-failed",
  "asked",
  "approved",
  "rejected",
  "posted",
  "post-failed",
];

export const PLATFORMS = ["x", "youtube", "tiktok", "instagram"];

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

  const cyclePath = (day) => {
    if (!DAY.test(day)) refuse(`not a day: ${day}`);
    return join(dirs.cycles, `${day}.json`);
  };

  const read = (day) => {
    const path = cyclePath(day);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  };

  const save = (cycle, what) => {
    cycle.updatedAt = new Date().toISOString();
    cycle.events.push({ at: cycle.updatedAt, state: cycle.state, what });
    writeAtomic(cyclePath(cycle.day), JSON.stringify(cycle, null, 2));
    return cycle;
  };

  const need = (day) => read(day) ?? refuse(`there is no cycle for ${day}`);

  const expect = (cycle, allowed, step) => {
    if (!allowed.includes(cycle.state)) {
      refuse(
        `${step} needs the cycle in ${allowed.join(" or ")}, but ${cycle.day} is ${cycle.state}`,
      );
    }
  };

  const days = () =>
    readdirSync(dirs.cycles)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((d) => DAY.test(d))
      .sort();

  return {
    dirs,
    postLog,
    read,
    days,

    /**
     * Start or replace the day's cycle. A day has one cycle: replacing it
     * needs `replace`, so a scheduled start cannot redo a day by mistake
     * (Wall Game PM, 2026-10-26). Replacing is allowed until the ask is open:
     * after that the ask names this video, and the way out is an answer.
     */
    pick(day, { candidate, caption, style, replace = false }) {
      const old = read(day);
      if (old && !replace) {
        refuse(
          `${day} already has a cycle (${old.state}, ${old.candidate.gameId}); the day is taken. Use replace only to redo today's video on purpose`,
        );
      }
      if (old) {
        expect(
          old,
          [
            "picked",
            "directed",
            "rendered",
            "render-failed",
            "checked",
            "rejected",
          ],
          "pick",
        );
      }
      const now = new Date().toISOString();
      const cycle = {
        day,
        state: "picked",
        createdAt: now,
        updatedAt: now,
        candidate,
        caption,
        style,
        edl: null,
        render: null,
        check: null,
        approval: null,
        posts: {},
        // Renders per game today, kept across a re-pick: each one is a view.
        renders: old?.renders ?? {},
        replaced: old ? [...(old.replaced ?? []), summarize(old)] : [],
        events: [],
      };
      return save(cycle, `picked ${candidate.gameId}`);
    },

    /**
     * The director's edit decision list for the candidate: `edl` is the
     * validated document and `text` the exact bytes the renderer will read.
     * A new list replaces the render made from the old one.
     */
    direct(day, { edl, text, summary }) {
      const cycle = need(day);
      expect(
        cycle,
        [
          "picked",
          "directed",
          "rendered",
          "render-failed",
          "checked",
          "rejected",
        ],
        "direct",
      );
      cycle.state = "directed";
      cycle.edl = {
        doc: edl,
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
        summary,
        directedAt: new Date().toISOString(),
      };
      cycle.render = null;
      cycle.check = null;
      cycle.approval = null;
      return save(cycle, `directed (edl ${cycle.edl.sha256.slice(0, 12)})`);
    },

    /**
     * Each render loads the game's replay page once, which adds one view to
     * the real game (GET /api/games/:id). A second render of the same game on
     * the same day is therefore refused unless it is asked for by name.
     */
    startRender(day, jobId, { force = false } = {}) {
      const cycle = need(day);
      const gameId = cycle.candidate.gameId;
      const before = cycle.renders[gameId] ?? 0;
      if (before > 0 && !force) {
        refuse(
          `${gameId} was already rendered ${before} time(s) today, and each render adds one view to the real game; pass force to render it again`,
        );
      }
      expect(cycle, ["directed", "render-failed"], "render");
      cycle.renders[gameId] = before + 1;
      cycle.state = "rendering";
      cycle.render = {
        jobId,
        requestedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        // The director's ending (edl.mjs requires one).
        ending: cycle.edl.doc.ending,
        edlSha256: cycle.edl.sha256,
        video: null,
        sheet: null,
        effect: null,
        sound: null,
        music: null,
        quality: null,
      };
      cycle.approval = null;
      return save(cycle, `render ${jobId} queued`);
    },

    finishRender(day, jobId, outcome) {
      const cycle = need(day);
      expect(cycle, ["rendering"], "finish render");
      if (cycle.render.jobId !== jobId) {
        refuse(
          `render ${jobId} is not the current one (${cycle.render.jobId})`,
        );
      }
      cycle.render.finishedAt = new Date().toISOString();
      if (outcome.error) {
        cycle.state = "render-failed";
        cycle.render.error = outcome.error;
        return save(cycle, `render ${jobId} failed`);
      }
      cycle.state = "rendered";
      cycle.render.video = outcome.video;
      cycle.render.sheet = outcome.sheet;
      cycle.render.effect = outcome.effect;
      cycle.render.sound = outcome.sound;
      cycle.render.music = outcome.music;
      cycle.render.quality = outcome.quality;
      return save(cycle, `render ${jobId} done`);
    },

    /**
     * The director looked at the contact sheet: one verdict per still, in the
     * sheet's order, each with what the director saw. Only when every still
     * is ok can the ask open (Nil, 2026-10-26: each FAHHH and zoom must show
     * the save wall). The measures the app took of the render (quality.mjs)
     * must pass too. A failed check leaves the cycle at rendered; the way on
     * is a new edit list.
     */
    recordCheck(day, { sheetSha256, stills }) {
      const cycle = need(day);
      expect(cycle, ["rendered"], "check");
      const sheet = cycle.render.sheet;
      if (cycle.check && !cycle.check.ok) {
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
      const quality = cycle.render.quality;
      if (!quality) {
        refuse(
          "this render has no measures (it finished before the app took them); render again with force",
        );
      }
      const failedMeasures = Object.entries(quality).filter(([, m]) => !m.ok);
      const badStills = verdicts.filter((v) => !v.ok).length;
      const ok = badStills === 0 && failedMeasures.length === 0;
      cycle.check = {
        sheetSha256,
        ok,
        verdicts,
        quality,
        checkedAt: new Date().toISOString(),
      };
      if (ok) cycle.state = "checked";
      const failures = [
        ...(badStills ? [`${badStills} of ${verdicts.length} stills`] : []),
        ...failedMeasures.map(([name, m]) => `${name}: ${m.note}`),
      ];
      return save(
        cycle,
        ok
          ? `contact sheet checked: ${verdicts.length} stills ok`
          : `check failed: ${failures.join("; ")}`,
      );
    },

    /**
     * The crew lead opened an Isomux ask about this video. `modes` and
     * `videoSha256` are what the ask SHOWED; `currentModes` is what the app
     * would post with now. They must agree, or the approval would name bytes
     * or a mode that the member did not see.
     */
    recordAsk(day, { askId, modes, videoSha256, currentModes }) {
      const cycle = need(day);
      expect(cycle, ["checked"], "ask");
      if (videoSha256 !== cycle.render.video.sha256) {
        refuse("the ask shows another video than the current render");
      }
      for (const platform of PLATFORMS) {
        if (modes?.[platform] !== currentModes[platform]) {
          refuse(
            `the ask says ${platform} ${modes?.[platform]}, but the app would post ${currentModes[platform]}`,
          );
        }
      }
      cycle.state = "asked";
      cycle.approval = {
        askId,
        askedAt: new Date().toISOString(),
        modes,
        videoSha256,
        caption: cycle.caption,
        decision: null,
        approver: null,
        answeredAt: null,
        reply: null,
      };
      return save(cycle, `ask ${askId} opened`);
    },

    /** The member answered the ask; the crew lead passes the answer on. */
    recordAnswer(day, { askId, decision, approver, reply }) {
      const cycle = need(day);
      expect(cycle, ["asked"], "answer");
      if (cycle.approval.askId !== askId) {
        refuse(
          `ask ${askId} is not this cycle's ask (${cycle.approval.askId})`,
        );
      }
      if (decision !== "approve" && decision !== "reject") {
        refuse(`decision must be approve or reject, not ${decision}`);
      }
      if (!approver) refuse("an answer needs the approver's name");
      cycle.state = decision === "approve" ? "approved" : "rejected";
      Object.assign(cycle.approval, {
        decision,
        approver,
        reply: reply ?? null,
        answeredAt: new Date().toISOString(),
      });
      return save(
        cycle,
        `${decision === "approve" ? "approved" : "rejected"} by ${approver}`,
      );
    },

    /** The day whose cycle carries this ask, or null. */
    dayOfAsk(askId) {
      return days().find((d) => read(d)?.approval?.askId === askId) ?? null;
    },

    /**
     * Check that the cycle may post now, with these modes and this video.
     * Returns the platforms still to post. `confirmedNotPosted` names the
     * platforms that a person checked after an uncertain attempt.
     */
    checkPost(day, { modes, videoSha256, confirmedNotPosted = [] }) {
      const cycle = need(day);
      expect(cycle, ["approved", "post-failed"], "post");
      if (videoSha256 !== cycle.approval.videoSha256) {
        refuse(
          "the video on disk is not the one that was approved; render and ask again",
        );
      }
      for (const platform of PLATFORMS) {
        if (modes[platform] !== cycle.approval.modes[platform]) {
          refuse(
            `${platform} would post ${modes[platform]}, but the approval was for ${cycle.approval.modes[platform]}; ask again`,
          );
        }
      }
      const todo = PLATFORMS.filter((p) => cycle.posts[p]?.ok !== true);
      for (const p of todo) {
        const last = cycle.posts[p];
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
      const cycle = need(day);
      expect(cycle, ["approved", "post-failed"], "post");
      cycle.posts[platform] = {
        ok: null,
        pending: true,
        mode,
        at: new Date().toISOString(),
      };
      return save(cycle, `${platform} final request sent`);
    },

    /** Record one platform's result, and the log row when it posted. */
    recordPost(day, platform, result, logRow) {
      const cycle = need(day);
      expect(cycle, ["approved", "post-failed"], "record post");
      cycle.posts[platform] = result;
      if (result.ok && logRow) {
        const file = result.mode === "live" ? postLog.live : postLog.dryRun;
        appendFileSync(file, JSON.stringify(logRow) + "\n");
      }
      const done = PLATFORMS.every((p) => cycle.posts[p]?.ok === true);
      const failed = PLATFORMS.some((p) => cycle.posts[p]?.ok === false);
      if (done) cycle.state = "posted";
      else if (failed) cycle.state = "post-failed";
      return save(
        cycle,
        `${platform} ${result.ok ? `posted (${result.mode})` : `failed: ${result.error}`}`,
      );
    },
  };
};

/** What is kept of a replaced cycle: enough to see that it existed. */
const summarize = (cycle) => ({
  gameId: cycle.candidate?.gameId ?? null,
  state: cycle.state,
  updatedAt: cycle.updatedAt,
});

/** Read a JSONL post log; a missing file is an empty log. */
export const readPostLog = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
