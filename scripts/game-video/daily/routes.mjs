/**
 * The daily video's part of the game-video app: the crew dashboard at /daily
 * and the /api/daily/* routes that the crew lead drives with crew.mjs.
 *
 * Board task e8d26610, step 3. The app keeps the record and talks to the
 * outside; the crew lead decides. One cycle a day:
 *
 *   crew.mjs facts   -> what the crew lead writes the caption from
 *   crew.mjs pick    -> POST /api/daily/pick     today's candidate + caption
 *   crew.mjs direct  -> POST /api/daily/direct   the director's edit decision
 *                       list (scripts/game-video/edl.mjs); the ending posted
 *                       least recently is its default (nextEnding)
 *   crew.mjs render  -> POST /api/daily/render   the list, rendered on the 4090
 *                       (render-4090.mjs): the MP4 and its contact sheet
 *   crew.mjs check   -> POST /api/daily/check    the director's verdict on each
 *                       still of the sheet; the ask needs every one ok
 *   crew.mjs ask     -> the crew lead opens an Isomux ask with the MP4,
 *                       then POST /api/daily/ask records its id
 *   crew.mjs answer  -> POST /api/daily/answer   the member's reply
 *   crew.mjs post    -> POST /api/daily/post     X then YouTube, and the log
 *
 * THE APP CANNOT OPEN THE ASK ITSELF: an Isomux app token is refused on the
 * asks routes. So the agent opens it and hands the id and, later, the answer
 * to the app, and store.mjs makes sure an answer only counts for the ask and
 * the video it belongs to.
 *
 * POSTING IS DRY-RUN UNTIL THE KEYS EXIST. A platform posts live only when
 * every one of its secrets is in the app's environment (Nil gives them to the
 * app as Isomux secrets on the Integrations page). Until then the same code
 * runs against a recorder, and the plan of requests is saved under
 * daily/requests/. The mode is fixed at ask time; see store.mjs.
 *
 * UNTRUSTED TEXT. Player names, captions and child stderr all reach the
 * dashboard, which builds every node with textContent, as the main page does.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  createReadStream,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openStore,
  readPostLog,
  utcDay,
  StepRefused,
  PLATFORMS,
} from "./store.mjs";
import {
  candidateFromReport,
  captionFrom,
  captionProblems,
  textProblems,
  DEFAULT_STYLE,
  STYLES,
  nextEnding,
  edlSummary,
  saveFrameProblems,
} from "./candidate.mjs";
import { validateEdl, checkEdlAgainstGame } from "../edl.mjs";
import { MUSIC_TRACKS } from "../music-tracks.mjs";
import {
  dryRunTransport,
  liveTransport,
  sha256,
  PostFailed,
} from "./transport.mjs";
import {
  postToX,
  oauth1Header,
  dryRunSigner,
  xDryRunReply,
  X_SECRETS,
} from "./post-x.mjs";
import {
  postToYoutube,
  youtubeDryRunReply,
  DRY_RUN_CREDS,
  YOUTUBE_SECRETS,
} from "./post-youtube.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RENDER_4090 = resolve(HERE, "render-4090.mjs");

/**
 * How long one 4090 render may take, transfer included. Measured by Worker 2
 * on 2026-10-25: about 25 s to capture a 32-ply game and 10-28 s to compose
 * and encode, by style. Fifteen minutes is over ten times that, and still
 * stops a stuck ssh or a hung page load from holding the day's cycle.
 */
const DEFAULT_RENDER_DEADLINE_MS = 15 * 60 * 1000;

/** Time the adapter gets to stop the remote render before it is killed. */
const KILL_GRACE_MS = 30 * 1000;

const SECRETS = { x: X_SECRETS, youtube: YOUTUBE_SECRETS };

/** live when every secret of the platform is set, else dry-run. */
export const postingModes = (env) =>
  Object.fromEntries(
    PLATFORMS.map((p) => [
      p,
      SECRETS[p].every((name) => Boolean(env[name])) ? "live" : "dry-run",
    ]),
  );

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const MUSIC_SLUGS = MUSIC_TRACKS.map((t) => t.slug);

/** Cycle states whose video may still be posted. */
const OPEN_STATES = [
  "rendering",
  "rendered",
  "checked",
  "asked",
  "approved",
  "post-failed",
];

export const createDaily = ({
  dataDir,
  renderer = RENDER_4090,
  deadlineMs = DEFAULT_RENDER_DEADLINE_MS,
  env = process.env,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  dryRunReplies = { x: xDryRunReply, youtube: youtubeDryRunReply },
}) => {
  const store = openStore(dataDir);
  const { dirs } = store;

  // The render queue lives in memory. A cycle that was rendering when the app
  // stopped has no child any more, and no step leaves "rendering" except the
  // child's result, so it is closed here or it would be stuck for the day.
  for (const day of store.days()) {
    const cycle = store.read(day);
    if (cycle.state === "rendering") {
      store.finishRender(day, cycle.render.jobId, {
        error:
          "the app restarted during this render; render again with --force (one more view of the game)",
      });
    }
  }

  /* ------------------------------------------------------------ render -- */

  const queue = [];
  let running = null;
  /** The running render child, so a stopping app can stop it too. */
  let currentChild = null;
  /** jobId -> latest progress line, for the dashboard. */
  const progress = new Map();

  const runJob = ({ day, jobId }) =>
    new Promise((done) => {
      const cycle = store.read(day);
      const work = join(dirs.work, jobId);
      mkdirSync(work, { recursive: true });
      // The exact bytes the director's list was approved as; the renderer
      // reports their hash back.
      const edlPath = join(work, "edl.json");
      const scratch = join(work, "out.mp4");
      writeFileSync(edlPath, cycle.edl.text);

      const finish = (outcome) => {
        try {
          store.finishRender(day, jobId, outcome);
        } catch (err) {
          // A newer pick or render replaced this one; its result is dropped.
          console.warn(`render ${jobId}: ${err.message}`);
        }
        progress.delete(jobId);
        currentChild = null;
        done();
      };

      // Only what the render step needs. Once the posting keys exist they are
      // in the app's env, and the render path has no use for them.
      const renderEnv = Object.fromEntries(
        ["PATH", "HOME", "USER", "SSH_AUTH_SOCK", "WALLGAME_GPU_HOST"]
          .filter((k) => env[k] !== undefined)
          .map((k) => [k, env[k]]),
      );
      const child = spawn(
        process.execPath,
        [renderer, "--edl", edlPath, "--job-id", jobId, "--out", scratch],
        { env: renderEnv, detached: true },
      );
      currentChild = child;
      let stdout = "";
      let stderr = "";
      let expired = false;
      // SIGTERM first: render-4090.mjs then stops the render on the 4090.
      const stopGroup = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* gone */
        }
      };
      let insist = null;
      const timer = setTimeout(() => {
        expired = true;
        stopGroup("SIGTERM");
        insist = setTimeout(() => stopGroup("SIGKILL"), KILL_GRACE_MS);
      }, deadlineMs);
      child.stdout.on("data", (c) => {
        stdout += c;
        const last = String(c).trim().split("\n").filter(Boolean).at(-1);
        if (last) progress.set(jobId, last.replace(/^\[render\]\s*/, ""));
      });
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", (err) => {
        clearTimeout(timer);
        finish({ error: `the render step could not start: ${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (insist) clearTimeout(insist);
        if (expired) {
          return finish({
            error: `the render took over ${Math.round(deadlineMs / 60000)} minutes and was stopped`,
          });
        }
        const line = stdout
          .trim()
          .split("\n")
          .reverse()
          .find((l) => l.startsWith("RESULT "));
        let result = null;
        try {
          result = line ? JSON.parse(line.slice(7)) : null;
        } catch {
          /* handled below */
        }
        if (code !== 0 || !result) {
          return finish({
            error:
              stderr.trim().split("\n").slice(-10).join("\n") ||
              `the render step exited with code ${code} and no RESULT line`,
          });
        }
        // The video must be the one the list asked for, or the post log and
        // the ask would describe a video nobody made.
        if (result.edlSha256 !== cycle.edl.sha256) {
          return finish({
            error: `the render read another edit list (${String(result.edlSha256).slice(0, 12)}, not ${cycle.edl.sha256.slice(0, 12)})`,
          });
        }
        const music = cycle.edl.doc.music ?? null;
        if (
          !MUSIC_SLUGS.includes(result.music) ||
          (music && result.music !== music)
        ) {
          return finish({
            error: `the render played the music ${result.music}, not ${music ?? "a named track"}`,
          });
        }
        if (result.ending !== cycle.render.ending) {
          return finish({
            error: `the render played the ${result.ending} ending, not ${cycle.render.ending}`,
          });
        }
        if (!existsSync(scratch) || statSync(scratch).size === 0) {
          return finish({
            error: "the render step reported success but left no video",
          });
        }
        // Only the path the adapter writes: the app moves this file.
        const sheetPath = `${scratch}-sheet.png`;
        if (
          result.sheet?.png !== sheetPath ||
          !existsSync(sheetPath) ||
          !Array.isArray(result.sheet.stills)
        ) {
          return finish({
            error: "the render step left no contact sheet",
          });
        }
        const sheetBytes = readFileSync(sheetPath);
        const sheet = {
          path: join(dirs.videos, `${jobId}-sheet.png`),
          sha256: sha256(sheetBytes),
          stills: result.sheet.stills.map((x) => ({
            ply: x.ply,
            kind: x.kind,
            sound: x.sound ?? null,
          })),
        };
        renameSync(sheetPath, sheet.path);
        // The app trusts its own hash, not the child's.
        const bytes = readFileSync(scratch);
        const video = {
          path: join(dirs.videos, `${jobId}.mp4`),
          bytes: bytes.length,
          sha256: sha256(bytes),
          durationSeconds: result.durationSeconds ?? null,
        };
        renameSync(scratch, video.path);
        finish({
          video,
          sheet,
          effect: result.effect ?? null,
          music: result.music,
          sound: result.sound ?? null,
        });
      });
    });

  const pump = async () => {
    if (running || queue.length === 0) return;
    running = queue.shift();
    try {
      await runJob(running);
    } finally {
      running = null;
      pump();
    }
  };

  /**
   * Other days' videos that may still post, as post-log rows dated at their
   * render. Nil can answer a day's ask after the next day renders, and the
   * two must not get the same ending. A rejected day is not here.
   */
  const openRenders = (day) =>
    store
      .days()
      .filter((d) => d !== day)
      .map((d) => store.read(d))
      .filter((c) => OPEN_STATES.includes(c.state) && c.render);
  const openEndings = (day) =>
    openRenders(day)
      .filter((c) => c.render.ending)
      .map((c) => ({ utc: c.render.requestedAt, ending: c.render.ending }));

  /** The latest track posted or waiting to post on another day. */
  const lastMusic = (day) =>
    [
      ...readPostLog(store.postLog.live),
      ...readPostLog(store.postLog.dryRun),
      ...openRenders(day).map((c) => ({
        utc: c.render.requestedAt,
        music: c.render.music,
      })),
    ]
      .filter((r) => r.music)
      .sort((a, b) => (a.utc < b.utc ? -1 : 1))
      .at(-1)?.music ?? null;

  const suggestedEnding = (day) =>
    nextEnding([
      ...readPostLog(store.postLog.live),
      ...readPostLog(store.postLog.dryRun),
      ...openEndings(day),
    ]);

  /* -------------------------------------------------------------- post -- */

  let posting = false;

  const post = async (day, confirmedNotPosted = []) => {
    const cycle = store.read(day);
    if (!cycle) throw new StepRefused(`there is no cycle for ${day}`);
    if (!cycle.render?.video) throw new StepRefused(`${day} has no video`);
    const modes = postingModes(env);
    const video = readFileSync(cycle.render.video.path);
    const todo = store.checkPost(day, {
      modes,
      videoSha256: sha256(video),
      confirmedNotPosted,
    });

    for (const platform of todo) {
      const transport =
        modes[platform] === "live"
          ? liveTransport()
          : dryRunTransport(dryRunReplies[platform]);
      const at = new Date().toISOString();
      // Set once the final, public request is about to go out. A failure
      // after that point may still have made the post.
      let committing = false;
      const beforeCommit = () => {
        committing = true;
        store.markPending(day, platform, modes[platform]);
      };
      let result;
      try {
        const posted =
          platform === "x"
            ? await postToX({
                video,
                text: cycle.approval.caption.x,
                transport,
                sign:
                  modes.x === "live"
                    ? (req) => oauth1Header(req, env)
                    : dryRunSigner,
                sleep,
                beforeCommit,
              })
            : await postToYoutube({
                video,
                caption: cycle.approval.caption,
                transport,
                creds: modes.youtube === "live" ? env : DRY_RUN_CREDS,
                beforeCommit,
              });
        result = { ok: true, mode: modes[platform], at, ...posted };
      } catch (err) {
        // A 4xx to the final request is a clear "not created"; anything else
        // after it (a 5xx, a lost reply) leaves the post unknown.
        const refused =
          err instanceof PostFailed && err.status >= 400 && err.status < 500;
        result = {
          ok: false,
          uncertain: committing && !refused,
          mode: modes[platform],
          at,
          error: String(err?.message ?? err),
        };
      }
      if (confirmedNotPosted.includes(platform))
        result.confirmedNotPosted = true;
      // One file per attempt, so a retry never overwrites the evidence that
      // a person checks after an uncertain attempt.
      const requestsFile = join(
        dirs.requests,
        `${day}.${platform}.${transport.mode}.${at.replace(/[:.]/g, "")}.json`,
      );
      writeFileSync(requestsFile, JSON.stringify(transport.sent, null, 2));
      result.requestsFile = requestsFile;
      store.recordPost(
        day,
        platform,
        result,
        result.ok ? logRow(cycle, platform, result) : null,
      );
    }
    return store.read(day);
  };

  /* ------------------------------------------------------------ routes -- */

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readJson = async (req, limit = 256 * 1024) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > limit)
        throw new StepRefused("that request is too large");
    }
    try {
      return JSON.parse(raw || "{}");
    } catch {
      throw new StepRefused("that request was not valid JSON");
    }
  };

  const dayOf = (value) => {
    const day = value ?? utcDay();
    if (!DAY.test(day)) throw new StepRefused(`not a day: ${day}`);
    return day;
  };

  const state = (day) => {
    const cycle = store.read(day);
    return {
      day,
      today: utcDay(),
      modes: postingModes(env),
      cycle,
      renderProgress: cycle?.render
        ? (progress.get(cycle.render.jobId) ?? null)
        : null,
      days: store.days().slice(-14),
      postLog: store.postLog,
      // The director's default: the ending posted least recently.
      suggestedEnding: suggestedEnding(day),
      // The last posted day's track: the director picks another one.
      lastMusic: lastMusic(day),
    };
  };

  const routes = {
    "GET /daily": (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD);
    },

    "GET /api/daily/state": (req, res, url) =>
      json(res, 200, state(dayOf(url.searchParams.get("day")))),

    /** {day?, report: {kind, createdAt, ranked}, rank?, style?, caption?, replace?} */
    "POST /api/daily/pick": async (req, res) => {
      const body = await readJson(req, 4 * 1024 * 1024);
      const day = dayOf(body.day);
      let candidate;
      try {
        candidate = candidateFromReport(body.report, body.rank ?? 1);
      } catch (err) {
        throw new StepRefused(err.message);
      }
      if (typeof body.caption !== "string" || !body.caption.trim()) {
        throw new StepRefused("pick needs the crew lead's caption");
      }
      const caption = captionFrom(body.caption, body.title);
      const problems = captionProblems(caption, candidate.gameId);
      if (problems.length) throw new StepRefused(problems.join("; "));
      const style = body.style ?? DEFAULT_STYLE;
      if (!STYLES.includes(style)) {
        throw new StepRefused(`style is one of ${STYLES.join(", ")}`);
      }
      json(
        res,
        200,
        store.pick(day, {
          candidate,
          caption,
          style,
          replace: body.replace === true,
        }),
      );
    },

    /**
     * {day?, edl}: the director's edit decision list for the picked game.
     * edl.mjs is Worker 2's contract with the renderer; the moves come from
     * the candidate report, so a bad ply or wall is refused before the 4090
     * spends a view of the game on it.
     */
    "POST /api/daily/direct": async (req, res) => {
      const body = await readJson(req);
      const day = dayOf(body.day);
      const cycle = store.read(day);
      if (!cycle) throw new StepRefused(`there is no cycle for ${day}`);
      const checked = validateEdl(body.edl);
      if (!checked.ok) throw new StepRefused(checked.errors.join("; "));
      const { edl } = checked;
      if (edl.gameId !== cycle.candidate.gameId) {
        throw new StepRefused(
          `the list is for ${edl.gameId}, but the day's game is ${cycle.candidate.gameId}`,
        );
      }
      if (!cycle.candidate.moves) {
        throw new StepRefused(
          "the candidate report has no move list, so the list cannot be checked; pick from a newer report",
        );
      }
      // The contact sheet has one still per event; with no event there is no
      // sheet, and the render would fail after it spent its view.
      if (edl.events.length === 0) {
        throw new StepRefused(
          "the list needs at least one event, or the render has no contact sheet to check",
        );
      }
      const errors = [
        ...checkEdlAgainstGame(edl, {
          notations: cycle.candidate.moves,
          cols: cycle.candidate.boardWidth,
          rows: cycle.candidate.boardHeight,
        }),
        ...saveFrameProblems(edl, cycle.candidate.beats),
      ];
      if (errors.length) throw new StepRefused(errors.join("; "));
      // The caption and stamps are burned into the video, which is posted.
      const shown = Object.fromEntries(
        [
          ["video caption", edl.caption ?? ""],
          ...edl.events
            .filter((e) => e.text)
            .map((e, i) => [`stamp ${i + 1}`, e.text]),
        ].filter(([, t]) => t),
      );
      const problems = textProblems(shown, cycle.candidate.gameId);
      if (problems.length) throw new StepRefused(problems.join("; "));
      const text = JSON.stringify(edl, null, 2) + "\n";
      json(
        res,
        200,
        store.direct(day, { edl, text, summary: edlSummary(edl) }),
      );
    },

    /** {day?, sheetSha256, stills: [{ply, kind, ok, note}]} */
    "POST /api/daily/check": async (req, res) => {
      const body = await readJson(req);
      json(
        res,
        200,
        store.recordCheck(dayOf(body.day), {
          sheetSha256: body.sheetSha256,
          stills: body.stills,
        }),
      );
    },

    /** {day?, force?} */
    "POST /api/daily/render": async (req, res) => {
      const body = await readJson(req);
      const day = dayOf(body.day);
      const cycle = store.read(day);
      if (!cycle) throw new StepRefused(`there is no cycle for ${day}`);
      const jobId = `${day}-${cycle.candidate.gameId}-${Date.now().toString(36)}`;
      store.startRender(day, jobId, { force: body.force === true });
      queue.push({ day, jobId });
      pump();
      json(res, 200, { day, jobId });
    },

    /** {day?, askId} - the crew lead opened the ask. */
    /** {day?, askId, modes, videoSha256} - what the ask showed. */
    "POST /api/daily/ask": async (req, res) => {
      const body = await readJson(req);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(body.askId ?? "")) {
        throw new StepRefused("an ask id is needed");
      }
      const day = dayOf(body.day);
      json(
        res,
        200,
        store.recordAsk(day, {
          askId: body.askId,
          modes: body.modes,
          videoSha256: body.videoSha256,
          currentModes: postingModes(env),
        }),
      );
    },

    /**
     * {askId, decision, approver, reply}. The cycle is found by its ask: an
     * answer often comes on a later UTC day (UTC midnight is 5 pm in
     * California). An approval must carry the member's reply as evidence.
     */
    "POST /api/daily/answer": async (req, res) => {
      const body = await readJson(req);
      const day = store.dayOfAsk(String(body.askId ?? ""));
      if (!day) throw new StepRefused(`no cycle has ask ${body.askId}`);
      if (body.decision === "approve" && !body.reply) {
        throw new StepRefused("an approval needs the member's reply text");
      }
      json(
        res,
        200,
        store.recordAnswer(day, {
          askId: body.askId,
          decision: body.decision,
          approver: body.approver,
          reply:
            typeof body.reply === "string" ? body.reply.slice(0, 2000) : null,
        }),
      );
    },

    /** {day, confirmNotPosted?: ["x"|"youtube"]} - the day is required. */
    "POST /api/daily/post": async (req, res) => {
      const body = await readJson(req);
      if (!body.day) throw new StepRefused("post needs the day of the cycle");
      const day = dayOf(body.day);
      const confirmed = Array.isArray(body.confirmNotPosted)
        ? body.confirmNotPosted.filter((p) => PLATFORMS.includes(p))
        : [];
      if (posting) throw new StepRefused("a post is already running");
      posting = true;
      try {
        json(res, 200, await post(day, confirmed));
      } finally {
        posting = false;
      }
    },

    "GET /api/daily/video": (req, res, url) => {
      const cycle = store.read(dayOf(url.searchParams.get("day")));
      const path = cycle?.render?.video?.path;
      if (!path || !existsSync(path))
        return json(res, 404, { error: "no video for that day" });
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": statSync(path).size,
      });
      createReadStream(path).pipe(res);
    },

    "GET /api/daily/sheet": (req, res, url) => {
      const cycle = store.read(dayOf(url.searchParams.get("day")));
      const path = cycle?.render?.sheet?.path;
      if (!path || !existsSync(path))
        return json(res, 404, { error: "no contact sheet for that day" });
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": statSync(path).size,
      });
      createReadStream(path).pipe(res);
    },

    "GET /api/daily/post-log": (req, res, url) =>
      json(
        res,
        200,
        readPostLog(
          url.searchParams.get("dryRun") === "1"
            ? store.postLog.dryRun
            : store.postLog.live,
        ),
      ),
  };

  /** True when the request was a daily one and has been answered. */
  const handle = async (req, res, url) => {
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return false;
    try {
      await route(req, res, url);
    } catch (err) {
      if (err instanceof StepRefused) json(res, 409, { error: err.message });
      else json(res, 500, { error: String(err?.message ?? err) });
    }
    return true;
  };

  /** Stop a running render (and so its 4090 unit) when the app stops. */
  const stop = () => {
    if (!currentChild) return;
    try {
      process.kill(-currentChild.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  };

  return { handle, store, post, stop };
};

/**
 * One post-log row (measurement plan, Wall Game Growth proposal 1, accepted
 * 2026-10-25): UTC time, game id, platform, post id + URL, caption,
 * effect/sound variant, swing size, approver. The variant includes the
 * ending since 2026-10-26, and the next render reads it to rotate them.
 */
export const logRow = (cycle, platform, result) => ({
  utc: result.at,
  day: cycle.day,
  gameId: cycle.candidate.gameId,
  platform,
  mode: result.mode,
  postId: result.postId,
  url: result.url,
  caption:
    platform === "x"
      ? cycle.approval.caption.x
      : `${cycle.approval.caption.youtubeTitle}\n\n${cycle.approval.caption.youtubeDescription}`,
  style: cycle.style,
  effect: cycle.render.effect,
  ending: cycle.render.ending,
  sound: cycle.render.sound,
  music: cycle.render.music,
  edlSha256: cycle.render.edlSha256,
  // Since 2026-10-26 the swing is the largest walking-distance jump, in steps.
  swingSize: cycle.candidate.picks[0].size,
  swingMove: cycle.candidate.picks[0].moveNumber,
  approver: cycle.approval.approver,
  videoSha256: cycle.approval.videoSha256,
  youtubePrivacyStatus:
    platform === "youtube" ? (result.privacyStatus ?? null) : null,
});

const DASHBOARD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wall Game daily video</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f1c; color: #e2e8f0;
         margin: 0; padding: 28px 16px; display: flex; justify-content: center; }
  main { width: 100%; max-width: 760px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 22px 0 8px; color: #cbd5e1; }
  .sub { color: #94a3b8; font-size: 13px; margin: 0 0 16px; }
  .box { padding: 12px 14px; border-radius: 8px; background: #121a2e; border: 1px solid #334155;
         font-size: 14px; line-height: 1.5; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px;
          font-weight: 700; background: #334155; margin-right: 6px; }
  .live { background: #7f1d1d; } .dry { background: #1e3a5f; }
  .state { background: #ff8c42; color: #1a1005; }
  .cap { white-space: pre-wrap; background: #0b1222; padding: 8px; border-radius: 6px; margin: 4px 0 10px; }
  .err { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; color: #fca5a5; }
  video { width: 100%; max-width: 320px; border-radius: 8px; background: #000; display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { text-align: left; padding: 4px 6px; border-bottom: 1px solid #1e293b; vertical-align: top; }
  a { color: #ff8c42; } select { background: #121a2e; color: #e2e8f0; border: 1px solid #334155; padding: 4px; }
  .muted { color: #64748b; font-size: 12px; }
</style></head>
<body><main>
  <h1>Wall Game daily video</h1>
  <p class="sub">One game a day to X and YouTube. The crew lead runs each step; this page shows where it is.
    <a href="/">Make a video by hand</a></p>
  <div id="top"></div>
  <h2>Candidate</h2><div id="cand" class="box"></div>
  <h2>Video</h2><div id="vid" class="box"></div>
  <h2>Approval</h2><div id="appr" class="box"></div>
  <h2>Posts</h2><div id="posts" class="box"></div>
  <h2>Post log</h2><div id="log" class="box"></div>
<script>
  // NOTHING HERE MAY USE innerHTML: player names, captions and errors are untrusted.
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag);
    if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };
  const line = (...parts) => { const p = el("div"); p.append(...parts); return p; };
  let day = new URLSearchParams(location.search).get("day");

  const render = (s) => {
    const top = $("top"); top.replaceChildren();
    const pick = el("select");
    for (const d of [...new Set([...s.days, s.today])].reverse()) {
      const o = el("option", null, d); o.value = d; if (d === s.day) o.selected = true; pick.append(o);
    }
    pick.onchange = () => { day = pick.value; history.replaceState(null, "", "?day=" + day); load(); };
    const modes = el("span");
    for (const [p, m] of Object.entries(s.modes))
      modes.append(el("span", "pill " + (m === "live" ? "live" : "dry"), p + ": " + m));
    top.append(line(pick, el("span", null, "  "), el("span", "pill state", s.cycle ? s.cycle.state : "no cycle yet"), modes));

    const c = s.cycle;
    $("cand").replaceChildren(); $("vid").replaceChildren(); $("appr").replaceChildren(); $("posts").replaceChildren();
    if (!c) { $("cand").append(el("span", "muted", "Nothing picked for this day.")); }
    else {
      const k = c.candidate;
      const game = el("a", null, k.gameId); game.href = "https://wallgame.io/game/" + encodeURIComponent(k.gameId);
      game.target = "_blank"; game.rel = "noopener";
      $("cand").append(
        line(el("b", null, k.seats.map((x) => x.name).join(" vs ")), el("span", null, "  "), game,
             el("span", "muted", "  " + k.variant + ", " + k.movesCount + " plies")),
        ...k.facts.map((f) => el("div", null, f)),
        el("div", "muted", "X text"), el("div", "cap", c.caption.x),
        el("div", "muted", "YouTube title"), el("div", "cap", c.caption.youtubeTitle),
        el("div", "muted", "YouTube description"), el("div", "cap", c.caption.youtubeDescription),
        el("div", "muted", "style: " + c.style),
        el("div", "muted", c.edl ? "Director's edit list" : "No edit list yet; default ending " + s.suggestedEnding),
        ...(c.edl ? c.edl.summary.map((l) => el("div", null, l)) : []));
      const r = c.render;
      if (!r) $("vid").append(el("span", "muted", "No render requested."));
      else if (r.error) $("vid").append(el("div", "err", r.error));
      else if (!r.video) $("vid").append(el("span", null, "Rendering on the 4090 - " + (s.renderProgress || "queued")));
      else {
        const v = el("video"); v.controls = true; v.playsInline = true;
        v.src = "/api/daily/video?day=" + encodeURIComponent(c.day);
        $("vid").append(v, el("div", "muted", (r.video.bytes / 1e6).toFixed(1) + " MB, effect " + (r.effect || "-") + ", ending " + (r.ending || "-") +
          ", sound " + (r.sound || "-") + ", sha256 " + r.video.sha256.slice(0, 12)));
        if (r.sheet) {
          const img = el("img"); img.src = "/api/daily/sheet?day=" + encodeURIComponent(c.day); img.style.maxWidth = "100%";
          $("vid").append(el("div", "muted", "Contact sheet"), img);
        }
        if (c.check) {
          $("vid").append(el("div", c.check.ok ? "muted" : "err", "Director's check: " + (c.check.ok ? "all stills ok" : "failed")),
            ...c.check.verdicts.map((v) => el("div", null, "ply " + v.ply + " " + v.kind + ": " + (v.ok ? "ok" : "BAD") + " - " + v.note)));
        }
      }
      const a = c.approval;
      if (!a) $("appr").append(el("span", "muted", "No ask open."));
      else {
        $("appr").append(line(el("span", null, "Ask " + a.askId + " opened " + a.askedAt)),
          line(el("span", null, "Modes at ask time: x " + a.modes.x + ", youtube " + a.modes.youtube)),
          line(el("b", null, a.decision ? (a.decision === "approve" ? "approved" : "rejected") + " by " + a.approver + " at " + a.answeredAt : "Waiting for the answer")));
        if (a.reply) $("appr").append(el("div", "cap", a.reply));
      }
      const ps = Object.entries(c.posts);
      if (!ps.length) $("posts").append(el("span", "muted", "Not posted."));
      for (const [p, r2] of ps) {
        const row = line(el("span", "pill " + (r2.mode === "live" ? "live" : "dry"), p + " " + r2.mode));
        if (!r2.ok) row.append(el("span", "err", r2.error));
        else if (r2.mode === "live") { const l = el("a", null, r2.url); l.href = r2.url; l.target = "_blank"; row.append(l); }
        else row.append(el("span", null, "planned " + r2.postId + " - requests in " + r2.requestsFile));
        $("posts").append(row);
      }
    }
  };

  const renderLog = (rows, dry) => {
    const box = $("log"); box.replaceChildren();
    box.append(el("div", "muted", (dry ? "Dry-run log (no live posts yet): " : "Live log: ") + rows.length + " rows"));
    if (!rows.length) return;
    const t = el("table"); const h = el("tr");
    for (const k of ["utc", "platform", "gameId", "postId", "swing", "effect:ending/sound", "approver"]) h.append(el("th", null, k));
    t.append(h);
    for (const r of rows.slice(-30).reverse()) {
      const tr = el("tr");
      for (const v of [r.utc, r.platform, r.gameId, r.postId, r.swingSize + " steps @ move " + r.swingMove,
                       (r.effect || "-") + ":" + (r.ending || "-") + "/" + (r.sound || "-"), r.approver]) tr.append(el("td", null, v));
      t.append(tr);
    }
    box.append(t);
  };

  // Rebuild only on a change, or the video would restart at every refresh.
  let shown = "";
  const load = async () => {
    const s = await (await fetch("/api/daily/state" + (day ? "?day=" + encodeURIComponent(day) : ""))).json();
    const key = JSON.stringify(s);
    if (key !== shown) { shown = key; render(s); }
    let rows = await (await fetch("/api/daily/post-log")).json(), dry = false;
    if (!rows.length) { rows = await (await fetch("/api/daily/post-log?dryRun=1")).json(); dry = true; }
    renderLog(rows, dry);
  };
  load(); setInterval(load, 5000);
</script></main></body></html>`;
