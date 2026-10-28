/**
 * The daily video's part of the game-video app: the crew dashboard at /daily
 * and the /api/daily/* routes that the crew lead drives with crew.mjs.
 *
 * The app keeps the record (store.mjs: one item per video) and talks to the
 * outside; the crew lead decides. Each production step names its item:
 *
 *   crew.mjs facts   -> what the director writes the on-video caption from
 *   crew.mjs pick    -> POST /api/daily/pick     a new item: a game by rank or
 *                       by id from any day's report, or the game of a
 *                       discarded or posted item (carry-over)
 *   crew.mjs direct  -> POST /api/daily/direct   the director's edit decision
 *                       list (scripts/game-video/edl.mjs); the ending posted
 *                       least recently is its default (nextEnding)
 *   crew.mjs render  -> POST /api/daily/render   the list, rendered on the 4090
 *                       (render-4090.mjs): the MP4 and its contact sheet
 *   crew.mjs check   -> POST /api/daily/check    the director's verdict on each
 *                       still of the sheet; every one ok, and every measure
 *                       the app took of the render (quality.mjs), finishes
 *                       the item
 *   crew.mjs copy    -> POST /api/daily/copy     Wall Game Growth's copy block
 *                       for the item's video (copy.mjs)
 *   crew.mjs drop    -> POST /api/daily/drop     the director stops an item
 *
 * A finished item with a fresh block is in review: Nil approves, discards
 * or revises it on /review. An approved item posts at a slot (Wall Game
 * Worker 1's review-post.mjs and scheduler.mjs, through postPlatform here).
 *
 * POSTING IS DRY-RUN UNTIL THE KEYS EXIST. A platform posts live only when
 * every one of its secrets is in the app's environment (Nil gives them to the
 * app as Isomux secrets on the Integrations page) and its account is
 * connected. Until then the same code runs against a recorder, and the plan
 * of requests is saved under daily/requests/.
 *
 * UNTRUSTED TEXT. Player names, captions and child stderr all reach the
 * dashboard, which builds every node with textContent, as the main page does.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  createReadStream,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openStore,
  readPostLog,
  StepRefused,
  PLATFORMS,
  postProblem,
  stage,
  reviewState,
} from "./store.mjs";
import {
  candidateFromReport,
  CAPTION_STYLE_VERSION,
  playerNames,
  textProblems,
  DEFAULT_STYLE,
  STYLES,
  nextEnding,
  edlSummary,
  musicText,
  saveFrameProblems,
  storyProblems,
} from "./candidate.mjs";
import {
  validateEdl,
  checkEdlAgainstGame,
  parsePlyWindow,
  DEFAULT_SLOT_SOUNDS,
  FRAME,
} from "../edl.mjs";
import { MUSIC_TRACKS, mayPlay } from "../music-tracks.mjs";
import { timelineOf } from "./strips.mjs";
import {
  loudnessVerdict,
  safeAreaVerdict,
  captionLinesVerdict,
} from "./quality.mjs";
import { COPY_VERSION, copyProblems, parseCopy, postTexts } from "./copy.mjs";
import {
  claimRisk,
  openSoundPicks,
  soundList,
  soundFile,
  SOUNDS_PAGE,
} from "./sounds.mjs";
import {
  dryRunTransport,
  liveTransport,
  sha256,
  NotPosted,
  PostFailed,
} from "./transport.mjs";
import {
  postToInstagram,
  instagramAuthCheck,
  instagramDryRunReply,
} from "./post-instagram.mjs";
import {
  postToTiktok,
  tiktokDryRunReply,
  DRY_RUN_TIKTOK,
  TIKTOK_SECRETS,
} from "./post-tiktok.mjs";
import {
  postToX,
  xAppCheck,
  xAuthCheck,
  xCreds,
  xSecretShape,
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
import { postToFacebook, facebookDryRunReply } from "./post-facebook.mjs";
import {
  discoverMeta,
  metaDryRunReply,
  DRY_RUN_META,
  META_SECRETS,
  MetaRefused,
} from "./meta.mjs";
import {
  postToBluesky,
  blueskyDryRunReply,
  mp4VideoSize,
  DRY_RUN_BLUESKY,
  BLUESKY_SECRETS,
} from "./post-bluesky.mjs";
import {
  postToThreads,
  threadsDryRunReply,
  threadsTokens,
  refreshThreadsToken,
  DRY_RUN_THREADS,
  THREADS_SECRETS,
} from "./post-threads.mjs";
import { r2PublicUrl, dryRunPublicUrl, R2_SECRETS } from "./public-url-r2.mjs";
import { idsNotSet, PUBLIC_IDS, withPublicIds } from "./public-ids.mjs";
import {
  FOLLOWER_PLATFORMS,
  followersDue,
  readFollowers,
} from "./followers.mjs";
import { openTokenStore } from "./token-store.mjs";
import { connectStates, ConnectRefused } from "./connect-state.mjs";
import {
  CONNECT_PLATFORMS,
  authorizeUrl,
  exchangeCode,
  xRequestToken,
  missingClientSecrets,
} from "./connect.mjs";
import { connectPage, connectRefusedPage } from "./connect-page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RENDER_4090 = resolve(HERE, "render-4090.mjs");

/**
 * How long one 4090 render may take, transfer included. Measured by Worker 2
 * on 2026-10-25: about 25 s to capture a 32-ply game and 10-28 s to compose
 * and encode, by style. Fifteen minutes is over ten times that, and still
 * stops a stuck ssh or a hung page load from holding up the render queue.
 */
const DEFAULT_RENDER_DEADLINE_MS = 15 * 60 * 1000;

/** How long the capture question may take: two ssh calls of 20 s at most. */
const CAPTURE_PROBE_MS = 60 * 1000;

/** Time the adapter gets to stop the remote render before it is killed. */
const KILL_GRACE_MS = 30 * 1000;

/**
 * The secrets each platform posts with, in named groups, so that a reason can
 * say which part is missing.
 */
const SECRET_GROUPS = {
  x: [{ label: "secrets", names: X_SECRETS }],
  youtube: [{ label: "secrets", names: YOUTUBE_SECRETS }],
  tiktok: [{ label: "secrets", names: TIKTOK_SECRETS }],
  // One system-user token finds the Page and Instagram (meta.mjs).
  // Instagram fetches the video from R2 too, as Threads does (Wall Game
  // PM, 2026-10-28).
  instagram: [
    { label: "secrets", names: META_SECRETS },
    { label: "R2 secrets", names: R2_SECRETS },
  ],
  facebook: [{ label: "secrets", names: META_SECRETS }],
  bluesky: [{ label: "secrets", names: BLUESKY_SECRETS }],
  // Threads fetches the video from R2 (public-url-r2.mjs), so it is live
  // only when the R2 secrets exist too (Wall Game PM, 2026-10-26).
  threads: [
    { label: "secrets", names: THREADS_SECRETS },
    { label: "R2 secrets", names: R2_SECRETS },
  ],
};

/** Every secret a poster reads; a test strips them so it cannot post. */
export const POSTING_SECRETS = Object.values(SECRET_GROUPS).flatMap((groups) =>
  groups.flatMap((g) => g.names),
);

/**
 * Why each platform cannot post live; an empty list means live. A reason
 * names what is missing (secret NAMES, an id not set in code, no Connect),
 * never a value. `env` has the public ids over it (withPublicIds).
 * @param {Set<string>} connected
 * @returns {Record<string, string[]>}
 */
export const modeReasons = (env, connected = new Set()) =>
  Object.fromEntries(
    PLATFORMS.map((p) => [
      p,
      [
        ...SECRET_GROUPS[p].flatMap(({ label, names }) => {
          const missing = names.filter((name) => !env[name]);
          return missing.length
            ? [`${label} missing: ${missing.join(", ")}`]
            : [];
        }),
        ...idsNotSet(p, env),
        ...(CONNECT_PLATFORMS.includes(p) && !connected.has(p)
          ? ["not connected"]
          : []),
      ],
    ]),
  );

/** live when a platform has no reason (modeReasons); else dry-run. */
const modesOf = (reasons) =>
  Object.fromEntries(
    Object.entries(reasons).map(([p, why]) => [
      p,
      why.length ? "dry-run" : "live",
    ]),
  );

/** @param {Set<string>} connected */
export const postingModes = (env, connected = new Set()) =>
  modesOf(modeReasons(env, connected));

/** The canned replies of each platform's dry run. */
const DRY_RUN_REPLIES = {
  x: xDryRunReply,
  youtube: youtubeDryRunReply,
  tiktok: tiktokDryRunReply,
  instagram: (req) => metaDryRunReply(req) ?? instagramDryRunReply(req),
  facebook: (req) => metaDryRunReply(req) ?? facebookDryRunReply(req),
  bluesky: blueskyDryRunReply,
  threads: threadsDryRunReply,
};

/** Why a Connect request without an office member is refused. */
const NO_MEMBER =
  "open /daily/connect through the office (the app's address), signed in as a member";

/**
 * The only office member who may connect an account: Nil, whose accounts
 * the daily video posts to (Wall Game PM, 2026-10-26). The office sends this
 * id as X-Isomux-Member-Id (his id in the office's users.json).
 */
export const CONNECT_MEMBER_ID = "6f26107a";
const NOT_NIL = "only Nil can connect accounts";

/** How often the app renews the Threads token; it renews once a day at most. */
const THREADS_REFRESH_EVERY_MS = 6 * 60 * 60 * 1000;

const MUSIC_SLUGS = MUSIC_TRACKS.map((t) => t.slug);

/**
 * The problem when a list's cue names a track whose license does not let a
 * video play it (music-tracks.mjs `license`; the sources are in
 * MUSIC-LICENSES.md). validateEdl already refused a slug that is not a track.
 * @param {string} slug
 * @returns {string[]}
 */
const blockedMusic = (slug) => {
  const track = MUSIC_TRACKS.find((t) => t.slug === slug);
  if (!track || mayPlay(track)) return [];
  const playable = MUSIC_TRACKS.filter(mayPlay).map((t) => t.slug);
  return [
    `music ${slug} may not play in a video (license ${track.license}; see scripts/game-video/MUSIC-LICENSES.md); use ${playable.join(", ") || "none: no track may play, so tell Nil before you render"}`,
  ];
};

/** Item states whose video Nil approved and that have not posted yet. */
const WAITING_STATES = ["approved", "posting", "post-failed"];

export const createDaily = ({
  dataDir,
  renderer = RENDER_4090,
  deadlineMs = DEFAULT_RENDER_DEADLINE_MS,
  env: rawEnv = process.env,
  // The public ids (public-ids.mjs); a test gives its own.
  ids = PUBLIC_IDS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  dryRunReplies: replyOverrides = {},
  // Every live request goes through this; a test gives canned replies.
  live: makeLiveTransport = /** @type {() => { mode: string, sent: any[], request: (req: any) => Promise<any> }} */ (
    liveTransport
  ),
}) => {
  // The secrets from the environment, the public ids from code: an env var
  // with a public id's name has no effect (Nil, 2026-10-27).
  const env = withPublicIds(rawEnv, ids);
  // A test may replace the canned replies of one platform; the rest keep
  // their own.
  const dryRunReplies = { ...DRY_RUN_REPLIES, ...replyOverrides };
  const store = openStore(dataDir);
  const { dirs } = store;
  // The tokens that /daily/connect stores (token-store.mjs).
  const tokens = openTokenStore(join(dirs.root, "tokens"));
  const connectedNow = () =>
    new Set(CONNECT_PLATFORMS.filter((p) => tokens.connected(p)));
  const reasonsNow = () => modeReasons(env, connectedNow());
  const modesNow = () => modesOf(reasonsNow());
  const states = connectStates();

  /**
   * What /daily/connect shows for Facebook and Instagram: the Page and the
   * Instagram account that META_SYSTEM_USER_TOKEN finds (a live read of
   * Meta), or why they are not found. Never the Page token.
   */
  const metaStatus = async () => {
    // Facebook and Instagram have the same reasons (one Meta secret).
    const why = reasonsNow().facebook;
    if (why.length) {
      return { ok: false, lines: [`Posts are dry runs: ${why.join("; ")}`] };
    }
    try {
      const found = await discoverMeta({
        transport: makeLiveTransport(),
        token: env.META_SYSTEM_USER_TOKEN,
        instagram: "handle",
      });
      return {
        ok: true,
        lines: [
          `Meta: Page ${found.pageName}, Instagram @${found.igUsername ?? found.igUserId}`,
        ],
      };
    } catch (err) {
      return {
        ok: false,
        lines: [
          err instanceof MetaRefused
            ? err.message
            : `Meta could not be reached (${err?.name ?? "error"})`,
        ],
      };
    }
  };

  /** A stored field of a connected platform, for a live post. */
  /**
   * Keep a refresh token that a platform rotated (YouTube, TikTok), for
   * the posters and the follower counts alike.
   */
  const keepRefreshToken = (platform, refreshToken, expiresInSeconds) =>
    tokens.update(platform, {
      refreshToken,
      ...(platform === "tiktok" && {
        refreshExpiresAt: Number.isFinite(expiresInSeconds)
          ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
          : null,
      }),
    });

  const stored = (platform, pick) => {
    const record = tokens.read(platform);
    if (!record) {
      throw new NotPosted(`${platform} is not connected (/daily/connect)`);
    }
    return pick(record);
  };

  // A Threads token lapses after 60 days without a refresh, so the app
  // renews it on its own, also in a week with no post (post-threads.mjs).
  // Only while Threads is connected: this is a live call to Threads.
  // It must never throw: a rejection in the timer would end the app.
  const renew = async () => {
    try {
      if (!tokens.connected("threads")) return;
      const outcome = await refreshThreadsToken({
        transport: makeLiveTransport(),
        tokens: threadsTokens(tokens),
      });
      if (outcome.error) {
        console.warn(`threads token refresh failed: ${outcome.error}`);
      }
    } catch (err) {
      console.warn(`threads token refresh failed: ${err?.message ?? err}`);
    }
  };
  const threadsTimer = setInterval(
    () => void renew(),
    THREADS_REFRESH_EVERY_MS,
  );
  threadsTimer.unref();
  void renew();
  // Nil's preference for each meme sound (/daily/sounds).
  const soundPicks = openSoundPicks(dirs.root);

  // The render queue lives in memory. An item that was rendering when the
  // app stopped has no child any more, and no step leaves "rendering"
  // except the child's result, so it is closed here or it would be stuck.
  for (const item of store.items({ states: ["draft"] })) {
    if (stage(item) === "rendering") {
      store.finishRender(item.id, item.render.jobId, {
        error: "the app restarted during this render; render again",
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

  // Only what the render step needs. Once the posting keys exist they are
  // in the app's env, and the render path has no use for them.
  const renderEnv = Object.fromEntries(
    ["PATH", "HOME", "USER", "SSH_AUTH_SOCK", "WALLGAME_GPU_HOST"]
      .filter((k) => env[k] !== undefined)
      .map((k) => [k, env[k]]),
  );

  /**
   * Run the 4090 adapter (render-4090.mjs) for one job of the queue, the
   * app's only child, so a stopping app can stop it. Resolves {result}, the
   * adapter's RESULT line, or {error}.
   */
  const runAdapter = (jobId, args) =>
    new Promise((done) => {
      const end = (outcome) => {
        progress.delete(jobId);
        currentChild = null;
        done(outcome);
      };

      const child = spawn(process.execPath, [renderer, ...args], {
        env: renderEnv,
        detached: true,
      });
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
        end({ error: `the render step could not start: ${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (insist) clearTimeout(insist);
        if (expired) {
          return end({
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
          return end({
            error:
              stderr.trim().split("\n").slice(-10).join("\n") ||
              `the render step exited with code ${code} and no RESULT line`,
          });
        }
        end({ result });
      });
    });

  const runJob = async ({ itemId, jobId }) => {
    const item = store.item(itemId);
    const work = join(dirs.work, jobId);
    mkdirSync(work, { recursive: true });
    // The exact bytes the director's list was approved as; the renderer
    // reports their hash back.
    const edlPath = join(work, "edl.json");
    const scratch = join(work, "out.mp4");
    writeFileSync(edlPath, item.edl.text);

    const finish = (outcome) => {
      try {
        store.finishRender(itemId, jobId, outcome);
      } catch (err) {
        // A newer pick or render replaced this one; its result is dropped.
        console.warn(`render ${jobId}: ${err.message}`);
      }
    };

    const fromCache = item.render.fromCache;
    const { result, error } = await runAdapter(jobId, [
      "--edl",
      edlPath,
      "--job-id",
      jobId,
      "--out",
      scratch,
      ...(fromCache ? ["--from-cache"] : []),
    ]);
    if (error) return finish({ error });
    // The render must be what the app counted. A renderer older than
    // --from-cache ignores it and captures live, which is a view: it is
    // counted now. A counted render that read the capture is an overcount,
    // which is safe.
    if ((result.fromCache === true) !== fromCache) {
      return finish({
        error: fromCache
          ? "the renderer captured the game live, but the app asked for its capture: one view of the game, now counted; the 4090 kit may be older than --from-cache, so sync it"
          : "the render was from the capture, but the app asked for a live capture",
        viewed: fromCache,
      });
    }
    // The video must be the one the list asked for, or the post log and
    // the review would describe a video nobody made.
    if (result.edlSha256 !== item.edl.sha256) {
      return finish({
        error: `the render read another edit list (${String(result.edlSha256).slice(0, 12)}, not ${item.edl.sha256.slice(0, 12)})`,
      });
    }
    // The tracks the video played, and from which plies, must be the
    // list's cues (direct requires them).
    const music = item.edl.doc.music;
    const played = Array.isArray(result.music) ? result.music : [];
    if (
      played.length !== music.length ||
      played.some(
        (c, i) =>
          !MUSIC_SLUGS.includes(c.track) ||
          c.track !== music[i].track ||
          c.fromPly !== music[i].fromPly,
      )
    ) {
      return finish({
        error: `the render played the music ${played.length ? musicText(played) : JSON.stringify(result.music)}, not ${musicText(music)}`,
      });
    }
    if (result.ending !== item.render.ending) {
      return finish({
        error: `the render played the ${result.ending} ending, not ${item.render.ending}`,
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
    // The app judges the measures the renderer reported (quality.mjs);
    // the check step does not finish the item when one fails. A render
    // that did not measure fails too, so no unmeasured video is reviewed.
    finish({
      video,
      sheet,
      effect: result.effect ?? null,
      music: result.music,
      sound: result.sound ?? null,
      timeline: timelineOf(result.timeline),
      quality: {
        loudness: loudnessVerdict(result.loudness),
        safeArea: safeAreaVerdict(result.layout, FRAME),
        captionLines: captionLinesVerdict(result.layout),
      },
    });
  };

  /* ----------------------------------------------------------- preview -- */

  /**
   * previewId -> {itemId, from, to, edlText, state, video, error}: queued,
   * running, done or failed. A preview is a short look at a few plies (the
   * director's check of a moment's picture). It lives only here and in
   * previews/, and no step of an item reads either, so a preview can never
   * be checked, reviewed or posted. The app forgets it when it restarts.
   */
  const previews = new Map();
  // The app forgets every preview when it restarts, so their MP4s go too.
  const previewDir = join(dirs.root, "previews");
  rmSync(previewDir, { recursive: true, force: true });
  mkdirSync(previewDir, { recursive: true });
  /** How many finished previews (and their MP4s) the app keeps. */
  const PREVIEWS_KEPT = 20;

  /** One preview on the 4090: {state: "done", video} or {state: "failed", error}. */
  const previewOutcome = async (jobId, p) => {
    const work = join(dirs.work, jobId);
    mkdirSync(work, { recursive: true });
    const edlPath = join(work, "edl.json");
    const scratch = join(work, "out.mp4");
    writeFileSync(edlPath, p.edlText);
    const { result, error } = await runAdapter(jobId, [
      "--edl",
      edlPath,
      "--job-id",
      jobId,
      "--out",
      scratch,
      "--plies",
      `${p.from}..${p.to}`,
    ]);
    const failed = (why) => ({ state: "failed", error: why });
    if (error) return failed(error);
    if (
      result.preview?.from !== p.from ||
      result.preview?.to !== p.to ||
      result.edlSha256 !== null
    ) {
      return failed(
        `the render step did not return the preview of plies ${p.from}..${p.to}`,
      );
    }
    if (!existsSync(scratch) || statSync(scratch).size === 0) {
      return failed("the render step reported success but left no video");
    }
    const bytes = readFileSync(scratch);
    const video = {
      path: join(previewDir, `${jobId}.mp4`),
      bytes: bytes.length,
      sha256: sha256(bytes),
      durationSeconds: result.durationSeconds ?? null,
    };
    renameSync(scratch, video.path);
    return { state: "done", video };
  };

  const runPreview = async ({ jobId }) => {
    const p = previews.get(jobId);
    p.state = "running";
    // A file step that throws ends the preview; it must not stay running.
    try {
      Object.assign(p, await previewOutcome(jobId, p));
    } catch (err) {
      Object.assign(p, {
        state: "failed",
        error: `the preview step failed: ${err.message}`,
      });
    }
  };

  /**
   * {cached: true|false}, or {error} when the app could not ask: the
   * adapter's --has-capture, one ssh line. A preview without a capture is
   * refused before it is queued, and a full render reads the capture when
   * there is one, so it adds no view.
   */
  const captureOf = (gameId) =>
    new Promise((done) => {
      const child = spawn(
        process.execPath,
        [renderer, "--has-capture", gameId],
        { env: renderEnv },
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), CAPTURE_PROBE_MS);
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", (err) => {
        clearTimeout(timer);
        done({
          error: `could not ask the 4090 for the capture: ${err.message}`,
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const answer = stdout.trim();
        if (code === 0 && (answer === "cached" || answer === "none")) {
          return done({ cached: answer === "cached" });
        }
        done({
          error:
            stderr.trim().split("\n").slice(-3).join("\n") ||
            `could not ask the 4090 for the capture (exit ${code})`,
        });
      });
    });

  /** Forget the oldest finished previews over PREVIEWS_KEPT, with their MP4s. */
  const prunePreviews = () => {
    const finished = [...previews].filter(([, p]) =>
      ["done", "failed"].includes(p.state),
    );
    for (const [id, p] of finished.slice(0, -PREVIEWS_KEPT)) {
      if (p.video) rmSync(p.video.path, { force: true });
      previews.delete(id);
    }
  };

  const pump = async () => {
    if (running || queue.length === 0) return;
    running = queue.shift();
    try {
      await (running.kind === "preview"
        ? runPreview(running)
        : runJob(running));
    } finally {
      running = null;
      pump();
    }
  };

  /** The renders of the videos Nil approved that have not posted yet. */
  const openRenders = () =>
    store
      .items({ states: WAITING_STATES })
      .filter((it) => it.render)
      .map((it) => it.render);

  /**
   * The tracks of the latest video posted or waiting to post, in the order
   * it played them.
   */
  const lastMusic = () =>
    [
      ...readPostLog(store.postLog.live),
      ...readPostLog(store.postLog.dryRun),
      ...openRenders().map((r) => ({
        utc: r.requestedAt,
        music: r.music?.map((cue) => cue.track) ?? null,
      })),
    ]
      .filter((r) => r.music)
      .sort((a, b) => (a.utc < b.utc ? -1 : 1))
      .at(-1)?.music ?? null;

  const suggestedEnding = () =>
    nextEnding([
      ...readPostLog(store.postLog.live),
      ...readPostLog(store.postLog.dryRun),
      ...openRenders()
        .filter((r) => r.ending)
        .map((r) => ({ utc: r.requestedAt, ending: r.ending })),
    ]);

  /* -------------------------------------------------------------- post -- */

  let posting = false;
  /** The follower read under way, if any (GET /api/daily/followers). */
  let followersRun = null;
  const followersCachePath = join(dirs.root, "followers.json");
  /** The last result of each platform {followers, at, error}, or null. */
  const readFollowersCache = () => {
    try {
      const c = JSON.parse(readFileSync(followersCachePath, "utf8"));
      return c?.counts && typeof c.counts === "object" ? c.counts : null;
    } catch {
      return null;
    }
  };

  /** The platforms that post live now (every secret set, connected). */
  const livePlatforms = () =>
    Object.entries(modesNow())
      .filter(([, mode]) => mode === "live")
      .map(([platform]) => platform);

  /**
   * Run `fn` as THE post: one at a time, and never while a follower read
   * may refresh the TikTok or YouTube token (the post refreshes it too, so
   * it waits for that read to end; no new read starts while `posting` is
   * set). GET /api/daily/busy reports it, so a ship does not restart the
   * app under a post.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const asThePost = async (fn) => {
    // Checked and set before the first await, so a caller that read
    // isPosting() in the same step cannot race another post.
    if (posting) throw new StepRefused("a post is already running");
    posting = true;
    try {
      await followersRun?.catch(() => {});
      return await fn();
    } finally {
      posting = false;
    }
  };

  /**
   * Post an approved item's video and block on one platform, in its mode
   * now. `beforeCommit` runs just before the final, public request: a
   * failure after it may still have made the post. Never throws for the
   * platform's failure: the result is {ok: true, mode, at, ...the
   * platform's reply} or {ok: false, uncertain, mode, at, error}, with the
   * requests file of this attempt. It REFUSES (throws StepRefused, before
   * any request) what store.mjs postProblem names: not approved, other
   * bytes or another block than Nil approved, a missing line, a platform
   * that has the post or may have it. `confirmedNotPosted` (this platform)
   * is a person's word that an uncertain post is not on the account. Wall
   * Game Worker 1's poster (review-post.mjs) records the result.
   */
  const postPlatform = async (
    platform,
    { item: given, video, beforeCommit, confirmedNotPosted = false },
  ) => {
    // The item as stored now (the caller's pending marks and earlier
    // results count), checked before any request: a refusal throws, as it
    // is not a platform's failure (nothing was sent).
    const item = store.item(given.id) ?? fail(`there is no item ${given.id}`);
    const problem = postProblem(item, platform, {
      videoSha256: sha256(video),
      confirmedNotPosted: confirmedNotPosted === true,
    });
    if (problem) throw new StepRefused(problem);
    const modes = modesNow();
    const live = modes[platform] === "live";
    const transport = live
      ? makeLiveTransport()
      : dryRunTransport(dryRunReplies[platform]);
    const texts = postTexts(item.copy.block);
    const at = new Date().toISOString();
    // Set once the final, public request is about to go out.
    let committing = false;
    const markCommit = () => {
      committing = true;
      beforeCommit();
    };
    const posters = {
      x: () => {
        // The key pair from the env, the token from Connect, read once.
        const creds = live
          ? xCreds(
              env,
              stored("x", (r) => r),
            )
          : null;
        return postToX({
          video,
          text: texts.x,
          transport,
          sign: creds ? (req) => oauth1Header(req, creds) : dryRunSigner,
          sleep,
          beforeCommit: markCommit,
        });
      },
      youtube: () =>
        postToYoutube({
          video,
          caption: texts,
          transport,
          creds: live
            ? {
                YOUTUBE_CLIENT_ID: env.YOUTUBE_CLIENT_ID,
                YOUTUBE_CLIENT_SECRET: env.YOUTUBE_CLIENT_SECRET,
                refreshToken: stored("youtube", (r) => r.refreshToken),
              }
            : DRY_RUN_CREDS,
          onRefreshToken: (refreshToken) =>
            keepRefreshToken("youtube", refreshToken),
          beforeCommit: markCommit,
        }),
      tiktok: () =>
        postToTiktok({
          video,
          transport,
          creds: live
            ? {
                TIKTOK_CLIENT_KEY: env.TIKTOK_CLIENT_KEY,
                TIKTOK_CLIENT_SECRET: env.TIKTOK_CLIENT_SECRET,
                refreshToken: stored("tiktok", (r) => r.refreshToken),
              }
            : DRY_RUN_TIKTOK,
          // TikTok rotates refresh tokens: the newest one is kept.
          onRefreshToken: (refreshToken, expiresInSeconds) =>
            keepRefreshToken("tiktok", refreshToken, expiresInSeconds),
          sleep,
          beforeCommit: markCommit,
        }),
      instagram: async () => {
        const meta = await discoverMeta({
          transport,
          token: (live ? env : DRY_RUN_META).META_SYSTEM_USER_TOKEN,
          instagram: "id",
        });
        return postToInstagram({
          video,
          caption: texts.instagram,
          publicUrl: live ? r2PublicUrl({ env }) : dryRunPublicUrl,
          transport,
          creds: { igUserId: meta.igUserId, pageToken: meta.pageToken },
          sleep,
          beforeCommit: markCommit,
        });
      },
      facebook: async () => {
        const meta = await discoverMeta({
          transport,
          token: (live ? env : DRY_RUN_META).META_SYSTEM_USER_TOKEN,
        });
        return postToFacebook({
          video,
          durationSeconds: item.render.video.durationSeconds,
          description: texts.facebook,
          transport,
          creds: { pageId: meta.pageId, pageToken: meta.pageToken },
          sleep,
          beforeCommit: markCommit,
        });
      },
      bluesky: () =>
        postToBluesky({
          video,
          text: texts.bluesky,
          size: mp4VideoSize(video),
          transport,
          creds: live ? env : DRY_RUN_BLUESKY,
          sleep,
          beforeCommit: markCommit,
        }),
      threads: () =>
        postToThreads({
          video,
          text: texts.threads,
          publicUrl: live ? r2PublicUrl({ env }) : dryRunPublicUrl,
          tokens: threadsTokens(tokens),
          transport,
          creds: live
            ? { userId: stored("threads", (r) => r.account.id) }
            : DRY_RUN_THREADS,
          sleep,
          beforeCommit: markCommit,
        }),
    };
    let result;
    try {
      const posted = await posters[platform]();
      result = { ok: true, mode: modes[platform], at, ...posted };
    } catch (err) {
      // A 4xx to the final request is a clear "not created"; anything else
      // after it (a 5xx, a lost reply) leaves the post unknown.
      const refused =
        err instanceof NotPosted ||
        (err instanceof PostFailed && err.status >= 400 && err.status < 500);
      result = {
        ok: false,
        uncertain: committing && !refused,
        mode: modes[platform],
        at,
        error: String(err?.message ?? err),
      };
    }
    // One file per attempt, so a retry never overwrites the evidence that
    // a person checks after an uncertain attempt.
    const requestsFile = join(
      dirs.requests,
      `${item.id}.${platform}.${transport.mode}.${at.replace(/[:.]/g, "")}.json`,
    );
    writeFileSync(requestsFile, JSON.stringify(transport.sent, null, 2));
    result.requestsFile = requestsFile;
    return result;
  };

  /** Append the post-log row of a platform that posted (logRow). */
  const logPost = (item, platform, result) =>
    appendFileSync(
      result.mode === "live" ? store.postLog.live : store.postLog.dryRun,
      JSON.stringify(logRow(item, platform, result)) + "\n",
    );

  /* ------------------------------------------------------------ routes -- */

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const html = (res, code, body) => {
    res.writeHead(code, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  };

  /** The member the office says sent `req`, or null. */
  const memberOf = (req) => {
    const id = req.headers["x-isomux-member-id"];
    if (typeof id !== "string" || !id) return null;
    let name = id;
    try {
      name = decodeURIComponent(
        String(req.headers["x-isomux-member-name"] ?? id),
      );
    } catch {
      /* keep the id */
    }
    return { id, name };
  };

  /** Why `member` may not start or finish a Connect, or null if it may. */
  const connectRefusal = (member) => {
    if (!member) return NO_MEMBER;
    if (member.id !== CONNECT_MEMBER_ID) return NOT_NIL;
    return null;
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

  const fail = (message) => {
    throw new StepRefused(message);
  };
  /** The item a request names; every production step needs one. */
  const itemOf = (id) => {
    if (typeof id !== "string" || !id) {
      fail("name the item: item is its id (v-<day>-<n>)");
    }
    return store.item(id) ?? fail(`there is no item ${id}`);
  };

  /** Items that are not over: neither posted nor discarded. */
  const OVER = ["posted", "discarded"];
  /** How many posted or discarded items the state lists, newest first. */
  const RECENT_OVER = 10;

  const state = () => {
    const all = store.items();
    const active = all.filter((it) => !OVER.includes(it.state));
    const reasons = reasonsNow();
    return {
      today: new Date().toISOString().slice(0, 10),
      modes: modesOf(reasons),
      // Why each dry-run platform is not live: names only, never a value.
      modeReasons: Object.fromEntries(
        Object.entries(reasons).filter(([, why]) => why.length),
      ),
      counts: store.counts(),
      // Each item that is not over, oldest first, with what is derived.
      items: active.map((it) => ({
        ...it,
        stage: stage(it),
        reviewState: reviewState(it),
        // Why its copy block cannot go to review, or null.
        staleCopy: it.render?.video ? store.staleCopy(it) : null,
        renderProgress: it.render
          ? (progress.get(it.render.jobId) ?? null)
          : null,
      })),
      // The last items that posted or were discarded, newest first.
      over: all
        .filter((it) => OVER.includes(it.state))
        .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1))
        .slice(0, RECENT_OVER)
        .map((it) => ({
          id: it.id,
          gameId: it.gameId,
          state: it.state,
          updatedAt: it.updatedAt,
          caption: it.caption,
        })),
      postLog: store.postLog,
      // The director's default: the ending posted least recently.
      suggestedEnding: suggestedEnding(),
      // The last posted (or approved) video's tracks: the director picks
      // others.
      lastMusic: lastMusic(),
    };
  };

  const routes = {
    "GET /daily": (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD);
    },

    "GET /api/daily/state": (req, res) => json(res, 200, state()),

    /** ?id=<item>: one item, whatever its state. */
    "GET /api/daily/item": (req, res, url) =>
      json(res, 200, itemOf(url.searchParams.get("id"))),

    /**
     * What a restart would cut: every render queued or running (on the 4090)
     * and a post in flight. `crew.mjs ship` refuses to restart while any is
     * busy.
     */
    "GET /api/daily/busy": (req, res) =>
      json(res, 200, {
        renders: [
          ...(running ? [{ ...running, state: "running" }] : []),
          ...queue.map((job) => ({ ...job, state: "queued" })),
        ],
        posting,
      }),

    /**
     * {report: {kind, createdAt, ranked}, reportFile?, rank? | gameId?,
     * style?} or {carriedFrom: <item id>, style?}: a new item.
     */
    "POST /api/daily/pick": async (req, res) => {
      const body = await readJson(req, 4 * 1024 * 1024);
      // Post text is Growth's copy block (POST /api/daily/copy).
      if ("caption" in body || "title" in body) {
        throw new StepRefused(
          "pick takes no caption or title: Wall Game Growth writes the post text (crew.mjs copy)",
        );
      }
      const style = body.style ?? DEFAULT_STYLE;
      if (!STYLES.includes(style)) {
        throw new StepRefused(`style is one of ${STYLES.join(", ")}`);
      }
      if (body.carriedFrom !== undefined) {
        if (body.report !== undefined) {
          throw new StepRefused("pick takes a report or carriedFrom, not both");
        }
        const old = itemOf(body.carriedFrom);
        return json(
          res,
          200,
          store.pick({
            candidate: old.candidate,
            style,
            styleVersion: CAPTION_STYLE_VERSION,
            source: { carriedFrom: old.id },
          }),
        );
      }
      // A game by id from any day's report, or by rank.
      let rank = body.rank ?? 1;
      if (body.gameId !== undefined) {
        const at = (body.report?.ranked ?? []).findIndex(
          (e) => e?.gameId === body.gameId,
        );
        if (at === -1) {
          throw new StepRefused(
            `the report has no game ${body.gameId}; take a report that ranks it`,
          );
        }
        rank = at + 1;
      }
      let candidate;
      try {
        candidate = candidateFromReport(body.report, rank);
      } catch (err) {
        throw new StepRefused(err.message);
      }
      json(
        res,
        200,
        store.pick({
          candidate,
          style,
          styleVersion: CAPTION_STYLE_VERSION,
          source: {
            report:
              typeof body.reportFile === "string" ? body.reportFile : null,
            reportCreatedAt: body.report?.createdAt ?? null,
            gameId: candidate.gameId,
          },
        }),
      );
    },

    /**
     * {item, edl, claimRiskOk?}: the director's edit decision list for the
     * item's game.
     * edl.mjs is Worker 2's contract with the renderer; the moves come from
     * the candidate report, so a bad ply or wall is refused before the 4090
     * spends a view of the game on it.
     */
    "POST /api/daily/direct": async (req, res) => {
      const body = await readJson(req);
      const item = itemOf(body.item);
      const checked = validateEdl(body.edl);
      if (!checked.ok) throw new StepRefused(checked.errors.join("; "));
      const { edl } = checked;
      const claimRiskOk = body.claimRiskOk ?? [];
      if (!Array.isArray(claimRiskOk) || !claimRiskOk.every(claimRisk)) {
        throw new StepRefused(
          "claimRiskOk is a list of sounds with a high claim risk",
        );
      }
      const risk = claimRiskLines(edl, claimRiskOk);
      if (edl.gameId !== item.candidate.gameId) {
        throw new StepRefused(
          `the list is for ${edl.gameId}, but ${item.id}'s game is ${item.candidate.gameId}`,
        );
      }
      if (!item.candidate.moves) {
        throw new StepRefused(
          "the candidate report has no move list, so the list cannot be checked; pick from a newer report",
        );
      }
      if (!item.candidate.distances) {
        throw new StepRefused(
          "the candidate has no race counts, so the captions cannot be checked against the counter; drop the item and pick its game from a newer report",
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
          notations: item.candidate.moves,
          cols: item.candidate.boardWidth,
          rows: item.candidate.boardHeight,
          initialState: item.candidate.initialState,
        }),
        ...saveFrameProblems(edl, item.candidate.beats),
        ...storyProblems(edl, item.candidate),
        ...risk.problems,
        // Without a named track the renderer picks one at random, so a
        // second render of the list (from the capture) could play another
        // song.
        ...(edl.music
          ? []
          : [
              `name a music track ("music"): a list without one gets a random track, so a second render of it can play another song`,
            ]),
        // The renderer refuses the track too; direct says it while the list
        // is still being written.
        ...(edl.music ?? []).flatMap((cue) => blockedMusic(cue.track)),
        // The daily video has no cold open; edl.mjs keeps the field for a
        // hand render.
        ...(edl.coldOpenPly === null
          ? []
          : [
              `coldOpenPly is cut from the daily video (Nil, 2026-10-26: "the initial 1s hook doesn't work for me, it's too confusing. cut it"); remove it`,
            ]),
      ];
      if (errors.length) throw new StepRefused(errors.join("; "));
      // The caption and stamps are burned into the video, which is posted.
      const shown = Object.fromEntries(
        [
          ["video caption", edl.caption ?? ""],
          ["video payoff", edl.payoff?.text ?? ""],
          ...edl.events
            .filter((e) => e.text)
            .map((e, i) => [`stamp ${i + 1}`, e.text]),
        ].filter(([, t]) => t),
      );
      const problems = textProblems(
        shown,
        item.candidate.gameId,
        playerNames(item.candidate),
      );
      if (problems.length) throw new StepRefused(problems.join("; "));
      const text = JSON.stringify(edl, null, 2) + "\n";
      json(
        res,
        200,
        store.direct(item.id, {
          edl,
          text,
          summary: [
            ...edlSummary(edl),
            ...dislikedSoundNotes(edl, soundPicks.disliked()),
            ...risk.notes,
          ],
        }),
      );
    },

    /**
     * {item, text, copyVersion}: Wall Game Growth's copy block, one line per
     * platform (copy.mjs). Every limit is checked here, so Nil never
     * reviews a text that cannot post.
     */
    "POST /api/daily/copy": async (req, res) => {
      const body = await readJson(req);
      const item = itemOf(body.item);
      if (!COPY_VERSION.test(body.copyVersion ?? "")) {
        throw new StepRefused(
          "copy needs copyVersion, the name of Growth's copy style (e.g. growth-copy-1)",
        );
      }
      const { copy, problems } = parseCopy(body.text);
      if (!copy) throw new StepRefused(problems.join("; "));
      const bad = copyProblems(
        copy,
        item.candidate.gameId,
        playerNames(item.candidate),
      );
      if (bad.length) throw new StepRefused(bad.join("; "));
      json(
        res,
        200,
        store.recordCopy(item.id, {
          ...copy,
          version: body.copyVersion,
        }),
      );
    },

    /** {item, sheetSha256, stills: [{ply, kind, ok, note}]} */
    "POST /api/daily/check": async (req, res) => {
      const body = await readJson(req);
      json(
        res,
        200,
        store.recordCheck(itemOf(body.item).id, {
          sheetSha256: body.sheetSha256,
          stills: body.stills,
        }),
      );
    },

    /** {item, why}: the director stops an item Nil has not reviewed. */
    "POST /api/daily/drop": async (req, res) => {
      const body = await readJson(req);
      json(res, 200, store.drop(itemOf(body.item).id, body.why));
    },

    /** {item, force?, live?} */
    "POST /api/daily/render": async (req, res) => {
      const body = await readJson(req);
      const item = itemOf(body.item);
      const jobId = `${item.id}-${item.gameId}-${Date.now().toString(36)}`;
      // With the game's capture on the 4090 the render reads it and adds no
      // view; `live` captures again on purpose (one view), for example when
      // the renderer cannot use the cached capture.
      let fromCache = false;
      if (body.live !== true) {
        const capture = await captureOf(item.candidate.gameId);
        if (capture.error) {
          throw new StepRefused(
            `${capture.error}; the app must know whether the 4090 has the game's capture before it renders, so try again`,
          );
        }
        fromCache = capture.cached;
      }
      store.startRender(item.id, jobId, {
        force: body.force === true,
        fromCache,
      });
      queue.push({ itemId: item.id, jobId });
      pump();
      json(res, 200, { itemId: item.id, jobId });
    },

    /**
     * {item, plies: "FROM..TO", edl?}: a preview of those plies of the
     * item's list, or of `edl` (a list for the item's game that is not
     * directed yet), from the game's capture on the 4090. It waits in the
     * render queue and changes nothing in the item.
     */
    "POST /api/daily/preview": async (req, res) => {
      const body = await readJson(req);
      const item = itemOf(body.item);
      let edl;
      let edlText;
      if (body.edl === undefined) {
        if (!item.edl) {
          throw new StepRefused(
            `${item.id} has no edit list yet: run direct, or give preview an --edl`,
          );
        }
        edl = item.edl.doc;
        edlText = item.edl.text;
      } else {
        const checked = validateEdl(body.edl);
        if (!checked.ok) throw new StepRefused(checked.errors.join("; "));
        edl = checked.edl;
        if (edl.gameId !== item.candidate.gameId) {
          throw new StepRefused(
            `the list is for ${edl.gameId}, but ${item.id}'s game is ${item.candidate.gameId}`,
          );
        }
        // A list that does not fit the game would fail on the 4090.
        const errors = item.candidate.moves
          ? checkEdlAgainstGame(edl, {
              notations: item.candidate.moves,
              cols: item.candidate.boardWidth,
              rows: item.candidate.boardHeight,
              initialState: item.candidate.initialState,
            })
          : [];
        if (errors.length) throw new StepRefused(errors.join("; "));
        edlText = JSON.stringify(edl, null, 2) + "\n";
      }
      const span = parsePlyWindow(body.plies, edl.startPly ?? 0);
      if (!span.ok) throw new StepRefused(span.error);
      const lastPly = item.candidate.movesCount - 1;
      if (span.to > lastPly) {
        throw new StepRefused(
          `the preview ends at ply ${span.to}, after the game's last ply ${lastPly}`,
        );
      }
      const capture = await captureOf(edl.gameId);
      if (capture.error) throw new StepRefused(capture.error);
      if (!capture.cached) {
        throw new StepRefused(
          `the 4090 has no capture of game ${edl.gameId} yet: a preview reads the capture that the game's full render saves, so render the item's video first`,
        );
      }
      const jobId = `${item.id}-${item.gameId}-p${Date.now().toString(36)}`;
      previews.set(jobId, {
        itemId: item.id,
        from: span.from,
        to: span.to,
        edlText,
        state: "queued",
        video: null,
        error: null,
      });
      prunePreviews();
      queue.push({ itemId: item.id, jobId, kind: "preview" });
      pump();
      json(res, 200, { itemId: item.id, previewId: jobId });
    },

    "GET /api/daily/preview": (req, res, url) => {
      const id = url.searchParams.get("id") ?? "";
      const p = previews.get(id);
      if (!p) {
        return json(res, 404, {
          error: `no preview ${id} (the app forgets previews when it restarts)`,
        });
      }
      json(res, 200, {
        previewId: id,
        itemId: p.itemId,
        plies: `${p.from}..${p.to}`,
        state: p.state,
        progress: progress.get(id) ?? null,
        video: p.video,
        error: p.error,
      });
    },

    /**
     * The last `last` rows of Nil's feedback (default 10), oldest first: his
     * review actions, and before them his answers to the daily asks.
     */
    "GET /api/daily/feedback": (req, res, url) => {
      const last = Number(url.searchParams.get("last") ?? 10);
      if (!Number.isInteger(last) || last < 1 || last > 1000) {
        throw new StepRefused("last is a whole number from 1 to 1000");
      }
      json(res, 200, readPostLog(store.feedbackLog).slice(-last));
    },

    "GET /api/daily/video": (req, res, url) => {
      const path = itemOf(url.searchParams.get("item")).render?.video?.path;
      if (!path || !existsSync(path))
        return json(res, 404, { error: "no video for that item" });
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": statSync(path).size,
      });
      createReadStream(path).pipe(res);
    },

    "GET /api/daily/sheet": (req, res, url) => {
      const path = itemOf(url.searchParams.get("item")).render?.sheet?.path;
      if (!path || !existsSync(path))
        return json(res, 404, { error: "no contact sheet for that item" });
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": statSync(path).size,
      });
      createReadStream(path).pipe(res);
    },

    "GET /daily/sounds": (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SOUNDS_PAGE);
    },

    "GET /api/daily/sounds": (req, res) =>
      json(res, 200, soundList(soundPicks.read())),

    /** {key, choice: "best" | "ok" | "disliked"} - "ok" clears a choice. */
    "POST /api/daily/sounds": async (req, res) => {
      const body = await readJson(req);
      // A missing choice is a mistake, not an "ok".
      if (!("choice" in body)) throw new StepRefused("a choice is needed");
      soundPicks.set(body.key, body.choice);
      json(res, 200, soundList(soundPicks.read()));
    },

    "GET /api/daily/sounds/file": (req, res, url) => {
      const path = soundFile(url.searchParams.get("key"));
      if (!path || !existsSync(path))
        return json(res, 404, { error: "no such sound file" });
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": statSync(path).size,
      });
      createReadStream(path).pipe(res);
    },

    // One-click Connect (connect.mjs). The office sends the member's id and
    // name with each request through the app's URL; a request without them
    // did not come through the office and may not connect anything. Only
    // Nil (CONNECT_MEMBER_ID) may start or finish a Connect.
    "GET /daily/connect": async (req, res, url) => {
      const connected = url.searchParams.get("connected");
      const meta = await metaStatus();
      const reasons = reasonsNow();
      html(
        res,
        200,
        connectPage(
          CONNECT_PLATFORMS.map((platform) => ({
            platform,
            status: tokens.status(platform),
            reasons: reasons[platform],
            // Connect needs the client secrets and the public ids (for
            // Threads also R2_ACCOUNT_ID, set in code), not the R2 secrets.
            canConnect:
              !missingClientSecrets(platform, env).length &&
              !idsNotSet(platform, env).length,
          })),
          {
            connected: CONNECT_PLATFORMS.includes(connected) ? connected : null,
            meta,
          },
        ),
      );
    },

    ...Object.fromEntries(
      CONNECT_PLATFORMS.flatMap((platform) => [
        [
          `POST /daily/connect/${platform}/start`,
          async (req, res) => {
            const member = memberOf(req);
            const refusal = connectRefusal(member);
            if (refusal) {
              return html(res, 403, connectRefusedPage(platform, refusal));
            }
            const missing = missingClientSecrets(platform, env);
            if (missing.length) {
              return html(
                res,
                409,
                connectRefusedPage(
                  platform,
                  `the app needs the secrets ${missing.join(", ")} first`,
                ),
              );
            }
            const notInCode = idsNotSet(platform, env);
            if (notInCode.length) {
              return html(
                res,
                409,
                connectRefusedPage(platform, notInCode.join("; ")),
              );
            }
            // X (OAuth 1.0a) asks for a request token first; it is the
            // state, and its secret waits in memory for the callback.
            let given;
            if (platform === "x") {
              try {
                const rt = await xRequestToken({
                  transport: makeLiveTransport(),
                  env,
                });
                given = { state: rt.token, verifier: rt.secret };
              } catch (err) {
                const message =
                  err instanceof ConnectRefused
                    ? err.message
                    : `x did not answer the request token step (${err?.name ?? "error"}); click Connect again`;
                return html(res, 502, connectRefusedPage(platform, message));
              }
            }
            const { state, verifier } = states.create(
              platform,
              member.id,
              given,
            );
            res.writeHead(303, {
              location: authorizeUrl(platform, env, { state, verifier }),
              "cache-control": "no-store",
            });
            res.end();
          },
        ],
        [
          `GET /daily/connect/${platform}/callback`,
          async (req, res, url) => {
            const member = memberOf(req);
            const refusal = connectRefusal(member);
            if (refusal) {
              return html(res, 403, connectRefusedPage(platform, refusal));
            }
            const q = url.searchParams;
            try {
              // The state is checked first, also when the platform reports
              // an error, so a stray callback cannot show a message here.
              // X sends its request token back (or, on Cancel, `denied`
              // with it) instead of a state, and oauth_verifier as the code.
              const x = platform === "x";
              const state = x
                ? (q.get("oauth_token") ?? q.get("denied"))
                : q.get("state");
              const { verifier } = states.take(state, platform, member.id);
              if (x && q.has("denied")) {
                throw new ConnectRefused(
                  "x: the authorization was cancelled: nothing was connected",
                );
              }
              const error = q.get("error");
              if (error) {
                throw new ConnectRefused(
                  `${platform} answered ${/^[\w.-]{1,64}$/.test(error) ? error : "with an error"}: nothing was connected`,
                );
              }
              const code = q.get(x ? "oauth_verifier" : "code");
              if (!code) throw new ConnectRefused(`${platform} sent no code`);
              const record = await exchangeCode(platform, {
                transport: makeLiveTransport(),
                env,
                code,
                verifier,
                state,
              });
              tokens.write(platform, {
                ...record,
                connectedAt: new Date().toISOString(),
                connectedBy: member.name,
              });
              res.writeHead(303, {
                location: `/daily/connect?connected=${platform}`,
                "cache-control": "no-store",
              });
              res.end();
            } catch (err) {
              // Only a ConnectRefused message is shown: it names no code
              // and no token. Anything else (a lost connection) gets a
              // plain sentence; its message could quote a request.
              const message =
                err instanceof ConnectRefused
                  ? err.message
                  : `the token exchange with ${platform} did not finish (${err?.name ?? "error"}); click Connect again`;
              html(res, 400, connectRefusedPage(platform, message));
            }
          },
        ],
      ]),
    ),

    /**
     * READ-ONLY: does the platform accept the app's credentials? ?platform=x
     * checks the consumer key pair alone (oauth2/token, status only), then
     * reads GET /2/users/me with the connected account's token;
     * ?platform=instagram finds the account as a post does and reads its
     * username. Nothing is posted and no file is written.
     * The reply names secrets, never a value: for X also yes/no shape facts.
     * A platform whose own secrets are missing is not called.
     */
    "GET /api/daily/auth-check": async (req, res, url) => {
      const platform = url.searchParams.get("platform");
      if (platform !== "x" && platform !== "instagram") {
        throw new StepRefused("auth-check takes platform=x or instagram");
      }
      const missing = SECRET_GROUPS[platform]
        .flatMap((g) => g.names)
        .filter((name) => !env[name]);
      const shape = platform === "x" ? { shape: xSecretShape(env) } : {};
      // The call needs the platform's own secrets; R2 is only for a post.
      const own = SECRET_GROUPS[platform].find((g) => g.label === "secrets");
      if (own.names.some((name) => !env[name])) {
        return json(res, 200, { platform, missing, ...shape, result: null });
      }
      const transport = makeLiveTransport();
      let result;
      if (platform === "x") {
        // The key pair alone, then the connected account's token.
        const app = await xAppCheck({ transport, env });
        const record = tokens.connected("x") ? tokens.read("x") : null;
        const user = record
          ? await xAuthCheck({
              transport,
              sign: (r) => oauth1Header(r, xCreds(env, record)),
            })
          : { ok: false, error: "not connected (/daily/connect)" };
        return json(res, 200, {
          platform,
          missing,
          ...shape,
          app,
          result: user,
        });
      } else {
        try {
          const meta = await discoverMeta({
            transport,
            token: env.META_SYSTEM_USER_TOKEN,
            instagram: "id",
          });
          result = await instagramAuthCheck({ transport, creds: meta });
        } catch (err) {
          // A MetaRefused message holds only codes; any other is not shown.
          result = {
            ok: false,
            error:
              err instanceof MetaRefused ? err.message : (err?.name ?? "error"),
          };
        }
      }
      json(res, 200, { platform, missing, ...shape, result });
    },

    /**
     * READ-ONLY: {<platform>: {followers, at, error}} for Growth's
     * dashboard (followers.mjs). Each platform's last result is kept in the
     * app's data and comes back until it is too old (followersDue: an X
     * count after 24 hours, as X reads are paid; any other result after an
     * hour); then only the platforms that are due are read again. While a
     * post runs no read starts: the last result comes back, or a refusal.
     */
    "GET /api/daily/followers": async (req, res) => {
      const cached = readFollowersCache();
      const due = followersDue(cached, Date.now());
      if (!due.length) return json(res, 200, cached);
      if (posting) {
        if (cached) return json(res, 200, cached);
        throw new StepRefused("a post is running: ask again in a few minutes");
      }
      followersRun ??= (async () => {
        try {
          const fresh = await readFollowers(
            { transport: makeLiveTransport(), env, tokens, keepRefreshToken },
            due,
          );
          const counts = Object.fromEntries(
            FOLLOWER_PLATFORMS.map((p) => [p, fresh[p] ?? cached[p]]),
          );
          // A read where no platform gave a count (a short network loss)
          // is not kept, so the next request tries again (Reviewer 1).
          if (Object.values(fresh).some((c) => c.followers !== null)) {
            writeFileSync(followersCachePath, JSON.stringify({ counts }));
          }
          return counts;
        } finally {
          followersRun = null;
        }
      })();
      json(res, 200, await followersRun);
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
    if (threadsTimer) clearInterval(threadsTimer);
    if (!currentChild) return;
    try {
      process.kill(-currentChild.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  };

  // The poster's parts (Wall Game Worker 1's review-post.mjs and
  // scheduler.mjs build on them).
  return {
    handle,
    store,
    stop,
    postPlatform,
    livePlatforms,
    logPost,
    asThePost,
    /** Whether a post runs now: a caller checks it in the same step as asThePost. */
    isPosting: () => posting,
  };
};

/**
 * The uses of a sound with a high claim risk. A use is a problem unless its
 * key is in `ok` (the director accepted it on purpose); then it is a note
 * for the summary. A key in `ok` that the list does not use is a problem.
 */
export const claimRiskLines = (edl, ok) => {
  const uses = [
    ...Object.keys(DEFAULT_SLOT_SOUNDS).map((slot) => [slot, edl[slot]]),
    ...edl.events
      .filter((e) => e.sound !== undefined)
      .map((e) => [`ply ${e.ply}`, e.sound]),
  ].filter(([, key]) => claimRisk(key));
  return {
    problems: [
      ...uses
        .filter(([, key]) => !ok.includes(key))
        .map(
          ([where, key]) =>
            `${where}: ${key}: ${claimRisk(key)}; name another sound (crew.mjs sounds)`,
        ),
      ...ok
        .filter((key) => !uses.some(([, k]) => k === key))
        .map((key) => `claimRiskOk names ${key}, but the list does not use it`),
    ],
    notes: uses
      .filter(([, key]) => ok.includes(key))
      .map(
        ([where, key]) => `${where} uses ${key} on purpose: ${claimRisk(key)}`,
      ),
  };
};

/**
 * One line for each use of a sound Nil disliked on /daily/sounds. It is
 * allowed; the line goes in the list's summary, so the director and the review page
 * show it.
 */
export const dislikedSoundNotes = (edl, disliked) => [
  ...Object.keys(DEFAULT_SLOT_SOUNDS)
    .filter((slot) => disliked.includes(edl[slot]))
    .map(
      (slot) => `${slot} uses disliked ${edl[slot]}: Nil's preference, allowed`,
    ),
  ...edl.events
    .filter((e) => e.sound !== undefined && disliked.includes(e.sound))
    .map(
      (e) => `ply ${e.ply} uses disliked ${e.sound}: Nil's preference, allowed`,
    ),
];

/**
 * One post-log row (measurement plan, Wall Game Growth proposal 1, accepted
 * 2026-10-25): UTC time, game id, platform, post id + URL, the text it
 * posted, effect/sound variant, swing size, approver. The variant includes the
 * ending since 2026-10-26, and the next render reads it to rotate them.
 */
export const logRow = (item, platform, result) => ({
  utc: result.at,
  // The UTC day of the post (before the review queue: the cycle's day).
  day: result.at.slice(0, 10),
  itemId: item.id,
  gameId: item.gameId,
  platform,
  mode: result.mode,
  postId: result.postId,
  url: result.url,
  // The approved block's text for the platform. TikTok takes no caption
  // through the API: Nil pastes its line in the inbox draft.
  caption: ((t) =>
    platform === "youtube"
      ? `${t.youtubeTitle}\n\n${t.youtubeDescription}`
      : t[platform])(postTexts(item.copy.block)),
  // Growth's copy style for the block (copy.mjs).
  copyVersion: item.copy.block.version,
  style: item.style,
  // The on-video caption style (candidate.mjs CAPTION_STYLE_VERSION) at pick
  // time; null for an item picked before the field existed.
  styleVersion: item.styleVersion ?? null,
  effect: item.render.effect,
  ending: item.render.ending,
  sound: item.render.sound,
  // The tracks the video played, in order.
  music: item.render.music.map((cue) => cue.track),
  edlSha256: item.render.edlSha256,
  // Since 2026-10-26 the swing is the largest walking-distance jump, in steps.
  swingSize: item.candidate.picks[0].size,
  swingMove: item.candidate.picks[0].moveNumber,
  approver: item.approval.by,
  videoSha256: item.approval.videoSha256,
  youtubePrivacyStatus:
    platform === "youtube" ? (result.privacyStatus ?? null) : null,
  // SEND_TO_USER_INBOX: a draft that Nil still has to post in the app.
  tiktokStatus: platform === "tiktok" ? result.tiktokStatus : null,
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
  <p class="sub">Videos to X, YouTube, TikTok, Instagram, Facebook, Bluesky and Threads. The director makes each video as an item, Wall Game Growth writes its post text, Nil reviews it on the review page, and an approved video posts at the next slot. This page shows where each item is.
    <a href="/">Make a video by hand</a> · <a href="/daily/sounds">Meme sounds</a> · <a href="/daily/connect">Connect platforms</a></p>
  <div id="top"></div>
  <h2>Items</h2><div id="items"></div>
  <h2>Posted or discarded</h2><div id="over" class="box"></div>
  <h2>Post log</h2><div id="log" class="box"></div>
<script>
  // NOTHING HERE MAY USE innerHTML: player names, captions and errors are untrusted.
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag);
    if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };
  const line = (...parts) => { const p = el("div"); p.append(...parts); return p; };
  const COPY = [["X", "x"], ["YouTube title (the app adds #Shorts)", "youtubeTitle"], ["YouTube description", "youtubeDescription"],
                ["TikTok", "tiktok"], ["Instagram", "instagram"], ["Facebook", "facebook"],
                ["Bluesky", "bluesky"], ["Threads", "threads"]];

  const render = (s) => {
    const top = $("top"); top.replaceChildren();
    const modes = el("span");
    for (const [p, m] of Object.entries(s.modes))
      modes.append(el("span", "pill " + (m === "live" ? "live" : "dry"), p + ": " + m));
    const c = s.counts;
    top.append(line(modes), line(el("span", "muted",
      "draft " + c.draft + ", revise " + c.revise + ", in review " + c.inReview + ", waiting for copy " + c.waitingCopy +
      ", approved " + c.approved + ", posting " + c.posting + ", post failed " + c.postFailed +
      ", posted " + c.posted + ", discarded " + c.discarded)));

    $("items").replaceChildren();
    if (!s.items.length) $("items").append(el("div", "box muted", "No item in work."));
    for (const k of s.items) {
      const box = el("div", "box");
      const g = k.candidate;
      const game = el("a", null, g.gameId); game.href = "https://wallgame.io/game/" + encodeURIComponent(g.gameId);
      game.target = "_blank"; game.rel = "noopener";
      box.append(
        line(el("b", null, k.id + "  "), el("span", "pill state", k.reviewState || k.state), el("span", "muted", k.stage + "  "),
             el("b", null, g.seats.map((x) => x.name).join(" vs ")), el("span", null, "  "), game,
             el("span", "muted", "  " + g.variant + ", " + g.movesCount + " plies")),
        ...g.facts.map((f) => el("div", null, f)),
        ...k.reviews.map((r) => el("div", r.action === "approve" ? "muted" : "err",
          "Nil, " + r.at + ": " + r.action + (r.notes ? ": " + r.notes : ""))),
        ...(k.copy
          ? [el("div", k.staleCopy ? "err" : "muted",
                "Post text by Wall Game Growth (" + k.copy.block.version + ")" + (k.staleCopy ? ": " + k.staleCopy : "")),
             ...COPY.flatMap(([label, f]) => [el("div", "muted", label), el("div", "cap", k.copy.block[f])])]
          : [el("div", "muted", "No copy block from Wall Game Growth yet.")]),
        el("div", "muted", "style: " + k.style),
        el("div", "muted", k.edl ? "Director's edit list" : "No edit list yet; default ending " + s.suggestedEnding),
        ...(k.edl ? k.edl.summary.map((l) => el("div", null, l)) : []));
      const r = k.render;
      const q = "?item=" + encodeURIComponent(k.id);
      if (!r) box.append(el("div", "muted", "No render requested."));
      else if (r.error) box.append(el("div", "err", r.error));
      else if (!r.video) box.append(el("div", null, "Rendering on the 4090 - " + (k.renderProgress || "queued")));
      else {
        const v = el("video"); v.controls = true; v.playsInline = true;
        v.src = "/api/daily/video" + q;
        box.append(v, el("div", "muted", (r.video.bytes / 1e6).toFixed(1) + " MB, effect " + (r.effect || "-") + ", ending " + (r.ending || "-") +
          ", sound " + (r.sound || "-") + ", sha256 " + r.video.sha256.slice(0, 12)));
        if (r.sheet) {
          const img = el("img"); img.src = "/api/daily/sheet" + q; img.style.maxWidth = "100%";
          box.append(el("div", "muted", "Contact sheet"), img);
        }
        if (k.check) {
          box.append(el("div", k.check.ok ? "muted" : "err", "Director's check: " + (k.check.ok ? "all stills ok" : "failed")),
            ...k.check.verdicts.map((v) => el("div", null, "ply " + v.ply + " " + v.kind + ": " + (v.ok ? "ok" : "BAD") + " - " + v.note)));
        }
      }
      for (const [p, r2] of Object.entries(k.posts)) {
        const row = line(el("span", "pill " + (r2.mode === "live" ? "live" : "dry"), p + " " + r2.mode));
        if (!r2.ok) row.append(el("span", "err", r2.error || "pending"));
        else if (r2.mode === "live") { const l = el("a", null, r2.url); l.href = r2.url; l.target = "_blank"; row.append(l); }
        else row.append(el("span", null, "planned " + r2.postId + " - requests in " + r2.requestsFile));
        box.append(row);
      }
      $("items").append(box);
    }
    $("over").replaceChildren();
    if (!s.over.length) $("over").append(el("span", "muted", "None yet."));
    for (const o of s.over)
      $("over").append(line(el("b", null, o.id + "  "), el("span", "pill", o.state), el("span", null, o.gameId + "  "),
        el("span", "muted", (o.caption || "") + "  " + o.updatedAt)));
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
    const s = await (await fetch("/api/daily/state")).json();
    const key = JSON.stringify(s);
    if (key !== shown) { shown = key; render(s); }
    let rows = await (await fetch("/api/daily/post-log")).json(), dry = false;
    if (!rows.length) { rows = await (await fetch("/api/daily/post-log?dryRun=1")).json(); dry = true; }
    renderLog(rows, dry);
  };
  load(); setInterval(load, 5000);
</script></main></body></html>`;
