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
 * Worker 1's review-post.mjs and scheduler.mjs, through postPlatform here),
 * to the platforms that are live at that time only:
 *   GET /api/review/status  -> counts, the next slot and the last one
 *   crew.mjs post   -> POST /api/daily/post   Growth's retry of a
 *                       post-failed item (the platforms of its slot)
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
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream";
import {
  openStore,
  readPostLog,
  StepRefused,
  PLATFORMS,
  postProblem,
  stage,
  reviewState,
  currentVet,
  currentScriptReview,
  scriptText,
  fixedApprovalProblem,
} from "./store.mjs";
import { resultProblems } from "./script.mjs";
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
  FRAME,
} from "../edl.mjs";
import { MUSIC_TRACKS, mayPlay } from "../music-tracks.mjs";
import { OVERLAYS, needsNilOk, riskLevel } from "../overlays.mjs";
import { timelineOf } from "./strips.mjs";
import { changedProblem } from "./changed-clip.mjs";
import { siteMove } from "../site-move.mjs";
import { gridOf } from "./tools.mjs";
import { lintNotes, lintRecapture, lintStops } from "./lint.mjs";
import {
  BACKUP_WINDOW,
  createBudgetReader,
  desktopName,
  planJob,
} from "./desktop-budget.mjs";
import {
  REVIEW_ACTION_PATH,
  REVIEW_PAGE,
  REVIEWER_MEMBER_ID,
  ReviewRefused,
  reviewAction,
  reviewView,
} from "./review.mjs";
import { appAsks, appMessenger } from "./office.mjs";
import { askAgain, openAskRecords, syncReviewAsks } from "./review-asks.mjs";
import { createItemPoster } from "./review-post.mjs";
import { createScheduler, GROWTH_AGENT_ID } from "./scheduler.mjs";
import {
  createFollowerHistory,
  PLATFORMS_FILE,
  socialView,
  createPostCheckpoints,
  createPostStatsHistory,
  postStatsView,
} from "./social.mjs";
import {
  STATS_MAX_AGE_MS,
  STATS_PLATFORMS,
  FRESH_WINDOW_MS,
  META_INSIGHTS,
  metaTokenCheck,
  readPostStats,
  keepNumbers,
  mergeReads,
  postsDue,
  refreshDue,
} from "./post-stats.mjs";

import {
  loudnessVerdict,
  safeAreaVerdict,
  captionLinesVerdict,
  silenceVerdict,
} from "./quality.mjs";
import { COPY_VERSION, copyProblems, parseCopy, postTexts } from "./copy.mjs";
import {
  claimRisk,
  retired,
  openSoundPicks,
  soundList,
  soundFile,
  soundUses,
  recentVideoSounds,
  soundRepeatNotes,
  SOUNDS_PAGE,
} from "./sounds.mjs";
import {
  dryRunTransport,
  liveTransport,
  sha256,
  NotPosted,
  PostFailed,
  errorText,
} from "./transport.mjs";
import {
  postToInstagram,
  instagramAuthCheck,
  instagramDryRunReply,
} from "./post-instagram.mjs";
import {
  postToTiktok,
  tiktokDryRunReply,
  tiktokPostStatus,
  DRY_RUN_TIKTOK,
  TIKTOK_SECRETS,
} from "./post-tiktok.mjs";
import { createTiktokDrafts } from "./tiktok-drafts.mjs";
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
  youtubeRecentUploads,
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
  YOUTUBE_READ_SCOPE,
} from "./connect.mjs";
import {
  connectPage,
  connectRefusedPage,
  metaInsightsPage,
} from "./connect-page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RENDER_4090 = resolve(HERE, "render-4090.mjs");

/**
 * How long one 4090 render may take, transfer included. Measured by Worker 2
 * on 2026-10-25: about 25 s to capture a 32-ply game and 10-28 s to compose
 * and encode, by style. Fifteen minutes is over ten times that, and still
 * stops a stuck ssh or a hung page load from holding up the render queue.
 */
const DEFAULT_RENDER_DEADLINE_MS = 15 * 60 * 1000;
/** The Warden's reading of the 4090 (desktop-budget.mjs). */
const DESKTOP_STATUS = [join(homedir(), "nil/infra/bin/desktop-status")];

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

/**
 * A platform that posts to another platform's account: it has no secret, id
 * or Connect of its own, so it is live exactly when that platform is live,
 * for the same reasons (Wall Game PM, 2026-10-29).
 */
const ACCOUNT_OF = { "instagram-story": "instagram" };
const accountOf = (platform) => ACCOUNT_OF[platform] ?? platform;

/** Every secret a poster reads; a test strips them so it cannot post. */
export const POSTING_SECRETS = Object.values(SECRET_GROUPS).flatMap((groups) =>
  groups.flatMap((g) => g.names),
);

/**
 * A platform that must not post live from `from` (included) to `until` (not
 * included), with all its keys: inside the window it is dry-run with `why`
 * as its reason; outside it, the pause has no effect, so it ends by itself.
 * A pause of an account also pauses the platforms that post to it
 * (ACCOUNT_OF).
 * @typedef {{ platform: string, from: string, until: string, why: string }} PlatformPause
 * @type {PlatformPause[]}
 */
export const PLATFORM_PAUSES = [
  // The Facebook test (2026-11-03 to 11-17) is lifted (Wall Game PM,
  // 2026-11-03): the Instagram->Facebook share needs a personal profile in
  // the Accounts Center, so there is no test and no pause.
];

/** The reasons of the pauses of platform `p` at time `now` (ms). */
const pauseReasons = (p, pauses, now) =>
  pauses
    .filter(
      ({ platform, from, until }) =>
        (platform === p || platform === accountOf(p)) &&
        Date.parse(from) <= now &&
        now < Date.parse(until),
    )
    .map(({ until, why }) => `paused until ${until}: ${why}`);

/**
 * Why each platform cannot post live; an empty list means live. A reason
 * names what is missing (secret NAMES, an id not set in code, no Connect),
 * never a value, or a pause that holds at `now`. `env` has the public ids
 * over it (withPublicIds).
 * @param {Set<string>} connected
 * @param {{ pauses?: PlatformPause[], now?: number }} [at]
 * @returns {Record<string, string[]>}
 */
export const modeReasons = (
  env,
  connected = new Set(),
  { pauses = /** @type {PlatformPause[]} */ ([]), now = Date.now() } = {},
) =>
  Object.fromEntries(
    PLATFORMS.map((p) => [
      p,
      [
        ...platformReasons(accountOf(p), env, connected),
        ...pauseReasons(p, pauses, now),
      ],
    ]),
  );

/** Why one platform with its own account cannot post live (modeReasons). */
const platformReasons = (p, env, connected) => [
  ...SECRET_GROUPS[p].flatMap(({ label, names }) => {
    const missing = names.filter((name) => !env[name]);
    return missing.length ? [`${label} missing: ${missing.join(", ")}`] : [];
  }),
  ...idsNotSet(p, env),
  ...(CONNECT_PLATFORMS.includes(p) && !connected.has(p)
    ? ["not connected"]
    : []),
];

/** live when a platform has no reason (modeReasons); else dry-run. */
const modesOf = (reasons) =>
  Object.fromEntries(
    Object.entries(reasons).map(([p, why]) => [
      p,
      why.length ? "dry-run" : "live",
    ]),
  );

/**
 * @param {Set<string>} connected
 * @param {{ pauses?: PlatformPause[], now?: number }} [at]
 */
export const postingModes = (env, connected = new Set(), at = {}) =>
  modesOf(modeReasons(env, connected, at));

/** The canned replies of each platform's dry run. */
const DRY_RUN_REPLIES = {
  x: xDryRunReply,
  youtube: youtubeDryRunReply,
  tiktok: tiktokDryRunReply,
  instagram: (req) => metaDryRunReply(req) ?? instagramDryRunReply(req),
  "instagram-story": (req) => DRY_RUN_REPLIES.instagram(req),
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
  // The command that prints desktop-status, and how often the app reads
  // it while it has render work; a test gives a stub and a short time.
  desktopStatus = DESKTOP_STATUS,
  budgetEveryMs = /** @type {number | undefined} */ (undefined),
  // The backup mirror's window (desktop-budget.mjs); a test runs at any
  // time of day, so it gives null.
  backupWindow = /** @type {{ from: number, to: number } | null} */ (
    BACKUP_WINDOW
  ),
  env: rawEnv = process.env,
  // The platform pauses (PLATFORM_PAUSES); a test gives its own, so that
  // it does not depend on the day it runs.
  pauses = PLATFORM_PAUSES,
  // The public ids (public-ids.mjs); a test gives its own.
  ids = PUBLIC_IDS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  dryRunReplies: replyOverrides = {},
  // Every live request goes through this; a test gives canned replies.
  live: makeLiveTransport = /** @type {() => { mode: string, sent: any[], request: (req: any) => Promise<any> }} */ (
    liveTransport
  ),
  // The app's messages to agents (office.mjs); a test gives its own.
  send = /** @type {((targetAgentId: string, text: string) => Promise<void>) | null} */ (
    null
  ),
  // The slot timer (scheduler.mjs); a test that drives it by hand sets false.
  schedule = true,
  // The office's ask routes for Nil's review asks (office.mjs appAsks); a
  // test gives its own.
  asks = /** @type {ReturnType<typeof appAsks> | null} */ (null),
  // How often the review asks sync with no crew call (review-asks.mjs). The
  // app server sets it; null syncs only on POST /api/daily/asks/sync.
  askSyncMs = /** @type {number | null} */ (null),
  // How often the follower history is recorded with no visitor
  // (social.mjs). The app server sets it (app/server.mjs); null records only
  // when the Social tab is opened, so a test reads no live count.
  followerRecordMs = /** @type {number | null} */ (null),
  // Wall Game Growth's platform file, for the Social tab; a test gives its
  // own.
  platformsFile = PLATFORMS_FILE,
}) => {
  // The secrets from the environment, the public ids from code: an env var
  // with a public id's name has no effect (Nil, 2026-10-27).
  const env = withPublicIds(rawEnv, ids);
  const sendMessage = send ?? appMessenger({ env: rawEnv });
  // A test may replace the canned replies of one platform; the rest keep
  // their own.
  const dryRunReplies = { ...DRY_RUN_REPLIES, ...replyOverrides };
  const store = openStore(dataDir);
  const { dirs } = store;
  // The tokens that /daily/connect stores (token-store.mjs).
  const tokens = openTokenStore(join(dirs.root, "tokens"));
  const connectedNow = () =>
    new Set(CONNECT_PLATFORMS.filter((p) => tokens.connected(p)));
  const reasonsNow = () =>
    modeReasons(env, connectedNow(), { pauses, now: Date.now() });
  const modesNow = () => modesOf(reasonsNow());
  const states = connectStates();

  /**
   * What /daily/connect shows for Facebook and Instagram: the Page and the
   * Instagram account that META_SYSTEM_USER_TOKEN finds (a live read of
   * Meta), or why they are not found. Never the Page token.
   */
  const metaStatus = async () => {
    // Facebook and Instagram have the same account reasons (one Meta
    // secret). A pause of Facebook says nothing of the account: not here.
    const why = platformReasons("facebook", env, connectedNow());
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
  /** The jobs on the 4090 now, each with its `workers`. */
  const running = [];
  /** The running render children, so a stopping app can stop them too. */
  const children = new Set();
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
      let child = null;
      const end = (outcome) => {
        progress.delete(jobId);
        children.delete(child);
        done(outcome);
      };

      child = spawn(process.execPath, [renderer, ...args], {
        env: renderEnv,
        detached: true,
      });
      children.add(child);
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

  const runJob = async ({ itemId, jobId, workers }) => {
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
      "--workers",
      String(workers),
      ...(fromCache ? ["--from-cache"] : []),
    ]);
    if (error) return finish({ error });
    // A quick look (renderer --draft) is never an item's video: it is not
    // checked frame by frame, and its 15 fps can miss what the render stops.
    if (result.draft === true) {
      return finish({
        error:
          "the render step gave a quick look (RESULT.draft), not the item's video",
      });
    }
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
    // list's cues (direct requires them). A list with no music ("music":
    // []) gets RESULT music null from the renderer (aa97b78f): no cues.
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
      // Always a list, [] for no music: the post row and the checks read
      // it as one.
      music: played,
      sound: result.sound ?? null,
      timeline: timelineOf(result.timeline),
      // Where the board's cells are at rest (crew.mjs crop --cell).
      grid: gridOf(result.layout?.grid),
      // How long each step took (render-4090.mjs), for the director.
      timings: result.timings ?? null,
      quality: {
        loudness: loudnessVerdict(result.loudness),
        safeArea: safeAreaVerdict(result.layout, FRAME),
        captionLines: captionLinesVerdict(result.layout),
        silence: silenceVerdict(result.silence),
      },
    });
  };

  /* ----------------------------------------------------------- preview -- */

  /**
   * previewId -> {itemId, from, to, draft, edlText, state, video, error}:
   * queued, running, done or failed. A preview is a short look at a few
   * plies (the director's check of a moment's picture); a quick look
   * (draft, renderer R2) is one at 15 fps and 540x960, of a few plies or
   * of the whole list (from and to null). It lives only here and in
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
  const previewOutcome = async (jobId, p, workers) => {
    const work = join(dirs.work, jobId);
    mkdirSync(work, { recursive: true });
    const edlPath = join(work, "edl.json");
    const scratch = join(work, "out.mp4");
    writeFileSync(edlPath, p.edlText);
    const whole = p.from === null;
    const { result, error } = await runAdapter(jobId, [
      "--edl",
      edlPath,
      "--job-id",
      jobId,
      "--out",
      scratch,
      ...(whole ? ["--from-cache"] : ["--plies", `${p.from}..${p.to}`]),
      ...(p.draft ? ["--draft"] : []),
      "--workers",
      String(workers),
    ]);
    const failed = (why) => ({ state: "failed", error: why });
    if (error) return failed(error);
    if ((result.draft === true) !== p.draft) {
      return failed(
        p.draft
          ? "the render step gave a full render, not a quick look"
          : "the render step gave a quick look, not a preview",
      );
    }
    if (
      whole
        ? result.preview != null ||
          result.fromCache !== true ||
          result.edlSha256 !== sha256(p.edlText)
        : result.preview?.from !== p.from ||
          result.preview?.to !== p.to ||
          result.edlSha256 !== null
    ) {
      return failed(
        `the render step did not return the ${p.draft ? "quick look" : "preview"} of ${whole ? "the whole list" : `plies ${p.from}..${p.to}`}`,
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
    return { state: "done", video, timings: result.timings ?? null };
  };

  const runPreview = async ({ jobId, workers }) => {
    const p = previews.get(jobId);
    p.state = "running";
    // A file step that throws ends the preview; it must not stay running.
    try {
      Object.assign(p, await previewOutcome(jobId, p, workers));
    } catch (err) {
      Object.assign(p, {
        state: "failed",
        error: `the preview step failed: ${err.message}`,
      });
    }
  };

  /*
    The lint (Wall Game Director's R1, 2026-10-29; lint.mjs): the app's
    checks of a list and the renderer's --lint from the capture (one worker,
    about 2 s on the 4090, no image, no view), every fault at once. lintId
    -> {itemId, key, state, errors, skipped, lint, timings, error, edlText}.
    direct stores a list only with a done lint of the same text (key) that
    nothing stops, so a list that cannot render is never stored. The app
    forgets lints when it restarts.
  */
  const lints = new Map();
  const LINTS_KEPT = 50;
  let lintCount = 0;
  /** The text direct stores for `edl`, and its hash: the lint's key. */
  const listText = (edl) => JSON.stringify(edl, null, 2) + "\n";

  const runLint = async ({ jobId, workers }) => {
    const rec = lints.get(jobId);
    if (!rec) return;
    rec.state = "running";
    try {
      const work = join(dirs.work, jobId);
      mkdirSync(work, { recursive: true });
      const edlPath = join(work, "edl.json");
      writeFileSync(edlPath, rec.edlText);
      const { result, error } = await runAdapter(jobId, [
        "--lint",
        "--edl",
        edlPath,
        "--job-id",
        jobId,
        "--workers",
        String(workers),
      ]);
      if (error) {
        Object.assign(rec, { state: "failed", error });
      } else if (!Array.isArray(result.lint?.faults)) {
        Object.assign(rec, {
          state: "failed",
          error: "the render step gave no lint",
        });
      } else {
        Object.assign(rec, {
          state: "done",
          lint: result.lint,
          timings: result.timings ?? null,
        });
      }
    } catch (err) {
      Object.assign(rec, {
        state: "failed",
        error: `the lint step failed: ${err.message}`,
      });
    }
  };

  /**
   * The summary lines of a list that direct may store, and whether it
   * needs a capture with the pawn art (a reactor's pawn), or a refusal:
   * the list's lint (`lintId`) must be done, of this text, with nothing
   * that stops it but a fault of the capture (lintRecapture), which a live
   * render mends.
   * `noLint` stores without one, for a 4090 that cannot lint.
   * @returns {{ lines: string[], needsPawnArt: boolean }}
   */
  const lintGate = (item, text, { lint: lintId, noLint }) => {
    if (noLint === true) {
      return {
        lines: [
          "NOT LINTED (direct --no-lint): the render checks the list before its shoot pass",
        ],
        needsPawnArt: false,
      };
    }
    const rec = typeof lintId === "string" ? lints.get(lintId) : undefined;
    if (!rec) {
      throw new StepRefused(
        "direct stores a list only after a lint of it: crew.mjs direct runs one (or give --no-lint when the 4090 cannot lint)",
      );
    }
    if (rec.itemId !== item.id || rec.key !== sha256(text)) {
      throw new StepRefused(
        "the lint was of another list: lint this list (crew.mjs direct does)",
      );
    }
    if (rec.state !== "done") {
      throw new StepRefused(
        `the lint is ${rec.state}${rec.error ? `: ${rec.error}` : ""}`,
      );
    }
    const stops = lintStops(rec);
    if (stops.length) {
      throw new StepRefused(
        `the lint found ${stops.length} fault(s) that stop the list: ${stops.join("; ")}`,
      );
    }
    if (rec.skipped) {
      return {
        lines: [`not linted by the renderer: ${rec.skipped}`],
        needsPawnArt: false,
      };
    }
    const recapture = lintRecapture(rec);
    return {
      lines: [
        `lint: nothing stops the list (${rec.lint.counts?.seconds ?? "?"} s)`,
        ...recapture.map(
          (l) => `LIVE ${l}: the next render captures the game live`,
        ),
        ...lintNotes(rec),
      ],
      needsPawnArt: recapture.length > 0,
    };
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
        // "cached-no-pawn-art": a capture from before the board's pawn art
        // was kept (render-4090.mjs homeAndCapture).
        if (
          code === 0 &&
          ["cached", "cached-no-pawn-art", "none"].includes(answer)
        ) {
          return done({
            cached: answer !== "none",
            pawnArt: answer === "cached",
          });
        }
        done({
          error:
            stderr.trim().split("\n").slice(-3).join("\n") ||
            `could not ask the 4090 for the capture (exit ${code})`,
        });
      });
    });

  /**
   * Forget the oldest finished lints over LINTS_KEPT. A queued or running
   * lint stays: its job in the queue reads its record.
   */
  const pruneLints = () => {
    const finished = [...lints].filter(([, l]) =>
      ["done", "failed"].includes(l.state),
    );
    for (const [id] of finished.slice(0, -LINTS_KEPT)) lints.delete(id);
  };

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

  /**
   * The threads of the other users' jobs on the 4090, from their desktop-run
   * meta files (the adapter's --threads-of), or null when it cannot read.
   */
  const threadsOf = (ids) =>
    new Promise((done) => {
      const child = spawn(
        process.execPath,
        [renderer, "--threads-of", ids.join(",")],
        { env: renderEnv },
      );
      let stdout = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), CAPTURE_PROBE_MS);
      child.stdout.on("data", (c) => (stdout += c));
      child.on("error", () => {
        clearTimeout(timer);
        done(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0 && /^\d+$/.test(stdout.trim()) ? Number(stdout) : null);
      });
    });

  /*
    The 4090's budget (Wall Game Director, 2026-10-29: the Warden's budget,
    desktop-budget.mjs): jobs run side by side while the budget has room,
    each with its share of workers; the head of the queue waits (it does not
    fail) while the 4090 is busy, and every queued job shows why.
  */
  // The app reads the budget while it has render work and for WARM_MS
  // after, so that a director's next preview in a session starts at once:
  // the first job after a long pause waits for one reading (about 10 s).
  const WARM_MS = 30 * 60 * 1000;
  let lastWork = 0;
  const budget = createBudgetReader({
    statusCommand: desktopStatus,
    threadsOf,
    ownNames: () => running.map((job) => desktopName(job.jobId)),
    wanted: () => {
      if (queue.length > 0 || running.length > 0) lastWork = Date.now();
      return Date.now() - lastWork < WARM_MS;
    },
    onReading: () => pump(),
    ...(budgetEveryMs !== undefined && { everyMs: budgetEveryMs }),
  });

  /** Why the head of the queue waits, or null when it may start. */
  const liveClash = (job) => {
    // A live capture writes the game's cache, which every other job of
    // that game reads: they do not run at one time.
    const clash = running.find(
      (r) => r.gameId === job.gameId && (r.live || job.live),
    );
    return clash
      ? `a render of game ${job.gameId} with a live capture runs (${clash.jobId})`
      : null;
  };

  const pump = () => {
    while (queue.length > 0) {
      // A lint goes first: it takes one worker for about 2 s, and direct
      // waits for it (R1).
      const head = queue.find((job) => job.kind === "lint") ?? queue[0];
      const plan = liveClash(head)
        ? { wait: liveClash(head) }
        : planJob({
            reading: budget.latest(),
            ownThreads: running.reduce((sum, r) => sum + r.workers, 0),
            ownJobs: running.length,
            behind: queue.length - 1,
            now: Date.now(),
            backupWindow,
            ...(head.kind === "lint" && { want: 1 }),
          });
      if (plan.wait) {
        for (const job of queue) {
          progress.set(job.jobId, `waiting for the 4090: ${plan.wait}`);
        }
        budget.wake();
        return;
      }
      const job = {
        ...queue.splice(queue.indexOf(head), 1)[0],
        workers: plan.workers,
      };
      progress.delete(job.jobId);
      running.push(job);
      budget.wake();
      void (async () => {
        try {
          await (job.kind === "preview"
            ? runPreview(job)
            : job.kind === "lint"
              ? runLint(job)
              : runJob(job));
        } finally {
          running.splice(running.indexOf(job), 1);
          pump();
        }
      })().catch((err) => {
        // An unhandled rejection stops Bun, and every render with it.
        console.warn(
          `${job.kind ?? "render"} ${job.jobId}: ${err?.message ?? err}`,
        );
      });
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

  /**
   * The follower counts {<platform>: {followers, at, error}}: each
   * platform's last result, kept in the app's data until it is too old
   * (followersDue: an X count after 24 hours, as X reads are paid; any
   * other result after an hour), then only the platforms that are due are
   * read again. While a post runs no read starts: the last result, or null
   * when there is none.
   */
  const followerCounts = async () => {
    const cached = readFollowersCache();
    const due = followersDue(cached, Date.now());
    if (!due.length) return cached;
    if (posting) return cached;
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
    return followersRun;
  };
  /**
   * The follower history (social.mjs): one row per platform per UTC day,
   * moved from the app wallgame-social on 2026-10-30 with its rows.
   */
  const followerHistory = createFollowerHistory(
    join(dirs.root, "followers.jsonl"),
  );
  /**
   * The per-post stats (post-stats.mjs) of the live post log: the last
   * read of each platform and each post's last numbers, in the app's data;
   * the history keeps one row a day per post. Read only on the timer, not
   * when the page opens.
   */
  const postStatsPath = join(dirs.root, "post-stats.json");
  const postStatsHistory = createPostStatsHistory(
    join(dirs.root, "post-stats.jsonl"),
  );
  const postCheckpoints = createPostCheckpoints(
    join(dirs.root, "post-checkpoints.jsonl"),
  );
  /** @returns {{ reads: Record<string, any>, numbers: Record<string, any> }} */
  const readPostStatsCache = () => {
    try {
      const c = JSON.parse(readFileSync(postStatsPath, "utf8"));
      return { reads: c?.reads ?? {}, numbers: c?.numbers ?? {} };
    } catch {
      return { reads: {}, numbers: {} };
    }
  };
  /** The post-stats read under way, if any. */
  let statsRun = null;
  /**
   * Read the posts that are due (postsDue: at 1 h, 24 h, 7 d, then weekly
   * to 4 weeks; a free platform also every 6 h) and keep the result. As the follower read, it never starts
   * while a post runs, and a post waits for it (asThePost): both may
   * refresh the YouTube token.
   */
  const recordPostStats = async () => {
    if (posting || statsRun) return;
    const cached = readPostStatsCache();
    const posts = readPostLog(store.postLog.live);
    const nowMs = Date.now();
    const due = postsDue(posts, cached, nowMs);
    const refreshed = refreshDue(cached.reads, nowMs);
    if (!Object.keys(due).length) return;
    statsRun = (async () => {
      try {
        const fresh = await readPostStats(
          { transport: makeLiveTransport(), env, tokens, keepRefreshToken },
          due,
        );
        const { kept, recorded } = keepNumbers(cached.numbers, fresh.numbers);
        writeFileSync(
          postStatsPath,
          JSON.stringify({
            reads: mergeReads(cached.reads, fresh.reads, refreshed),
            numbers: kept,
          }),
        );
        postStatsHistory.record(recorded);
        postCheckpoints.record(recorded, posts);
      } catch (err) {
        console.warn(`post stats: not recorded: ${err?.message ?? err}`);
      } finally {
        statsRun = null;
      }
    })();
    await statsRun;
  };

  /** Today's counts into the history; a failed read waits for the next. */
  const recordFollowers = async () => {
    try {
      followerHistory.record(await followerCounts());
    } catch (err) {
      console.warn(`followers: not recorded: ${err?.message ?? err}`);
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
      await statsRun;
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
    const instagram = async ({ surface }) => {
      const meta = await discoverMeta({
        transport,
        token: (live ? env : DRY_RUN_META).META_SYSTEM_USER_TOKEN,
        instagram: "id",
      });
      return postToInstagram({
        video,
        surface,
        caption: surface === "reel" ? texts.instagram : undefined,
        durationSeconds: item.render.video.durationSeconds,
        publicUrl: live ? r2PublicUrl({ env }) : dryRunPublicUrl,
        transport,
        creds: { igUserId: meta.igUserId, pageToken: meta.pageToken },
        sleep,
        beforeCommit: markCommit,
      });
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
      instagram: () => instagram({ surface: "reel" }),
      // The same video as a Story: its own R2 copy, no caption.
      "instagram-story": () => instagram({ surface: "story" }),
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
        error: errorText(err),
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

  /**
   * TikTok's status of one upload now (post-tiktok.mjs tiktokPostStatus).
   * It refreshes the TikTok token as a post does, so the caller holds the
   * post lock (asThePost): no post or follower read refreshes it at the same
   * time, and a rotated token is kept.
   */
  const tiktokStatusNow = (publishId) =>
    tiktokPostStatus({
      transport: makeLiveTransport(),
      creds: {
        TIKTOK_CLIENT_KEY: env.TIKTOK_CLIENT_KEY,
        TIKTOK_CLIENT_SECRET: env.TIKTOK_CLIENT_SECRET,
        refreshToken: stored("tiktok", (r) => r.refreshToken),
      },
      onRefreshToken: (refreshToken, expiresInSeconds) =>
        keepRefreshToken("tiktok", refreshToken, expiresInSeconds),
      publishId,
    });

  /**
   * The channel's last 5 uploads in every state (post-youtube.mjs
   * youtubeRecentUploads). It refreshes the YouTube token as a post does,
   * so the caller holds the post lock (asThePost). Refused when the Connect
   * has no youtube.readonly scope.
   */
  const youtubeRecentNow = () => {
    const record = tokens.read("youtube");
    if (!record?.scopes?.includes(YOUTUBE_READ_SCOPE)) {
      throw new StepRefused(
        "youtube: the Connect has no youtube.readonly scope: connect again (/daily/connect)",
      );
    }
    return youtubeRecentUploads({
      transport: makeLiveTransport(),
      creds: {
        YOUTUBE_CLIENT_ID: env.YOUTUBE_CLIENT_ID,
        YOUTUBE_CLIENT_SECRET: env.YOUTUBE_CLIENT_SECRET,
        refreshToken: record.refreshToken,
      },
      onRefreshToken: (token) => keepRefreshToken("youtube", token),
    });
  };

  // Nil's TikTok inbox holds one draft (tiktok-drafts.mjs): the latest
  // draft is the newest tiktok row of the live post log.
  const tiktokDrafts = createTiktokDrafts({
    path: join(dirs.root, "tiktok-drafts.json"),
    latest: () => {
      const row = readPostLog(store.postLog.live)
        .filter((r) => r.platform === "tiktok" && r.postId)
        .at(-1);
      return row ? { publishId: row.postId, sentAt: row.utc } : null;
    },
    readStatus: tiktokStatusNow,
  });
  /** The tiktok block of the status; a damaged file is its error only. */
  const tiktokStatusBlock = () => {
    try {
      return tiktokDrafts.status();
    } catch (err) {
      return { error: String(err?.message ?? err) };
    }
  };
  /**
   * The hourly read of a draft that may wait, so that lastPostedAt is
   * within an hour of Nil's post. Only while TikTok's account works, and
   * as THE post (asThePost): a running post skips this hour.
   */
  const checkTiktokDraft = async () => {
    try {
      if (platformReasons("tiktok", env, connectedNow()).length) return;
      if (posting || !tiktokDrafts.mayWait()) return;
      await asThePost(() => tiktokDrafts.waiting());
    } catch (err) {
      console.warn(`tiktok draft: not read: ${err?.message ?? err}`);
    }
  };

  // The slot post and Growth's retry (review-post.mjs), and the slot timer
  // (scheduler.mjs), whose state is <data>/daily/schedule.json. Every post
  // runs as THE post (asThePost); the timer waits a tick while one runs.
  const itemPoster = createItemPoster({
    store,
    modeReasons: reasonsNow,
    readVideo: (path) => readFileSync(path),
    postPlatform,
    logPost,
    tiktokWaiting: tiktokDrafts.waiting,
    // An async wrapper: a scope refusal is a failed read, as is a 4xx.
    youtubeRecent: async () => youtubeRecentNow(),
  });
  const scheduler = createScheduler({
    statePath: join(dirs.root, "schedule.json"),
    store,
    livePlatforms,
    // A post, or a follower read that a post would wait for (asThePost).
    busy: () => posting || followersRun !== null || statsRun !== null,
    postItem: (slot) => asThePost(() => itemPoster.postNext(slot)),
    recover: itemPoster.recover,
    send: (text) => sendMessage(GROWTH_AGENT_ID, text),
  });
  const stopSchedule = schedule ? scheduler.start() : () => {};
  // The follower history and the post stats are recorded with nobody on
  // the page (as wallgame-social did): at start, then every
  // followerRecordMs; each platform is read only when it is due.
  const recordStats = () => {
    void recordFollowers();
    void recordPostStats();
    void checkTiktokDraft();
  };
  const followerTimer = followerRecordMs
    ? setInterval(recordStats, followerRecordMs)
    : null;
  followerTimer?.unref();
  if (followerTimer) recordStats();

  // Nil's review asks (review-asks.mjs): one sync at a time, so a crew call
  // and the timer never apply one answer twice or open two asks.
  const askRecords = openAskRecords(dirs.root);
  const askOffice = asks ?? appAsks({ env: rawEnv });
  let askSync = null;
  const syncAsks = () => {
    askSync ??= syncReviewAsks({
      store,
      records: askRecords,
      office: askOffice,
      send: sendMessage,
      nextSlot: scheduler.status().nextSlot,
    }).finally(() => {
      askSync = null;
    });
    return askSync;
  };
  const askTimer = askSyncMs
    ? setInterval(
        () =>
          void syncAsks().catch((err) =>
            console.warn(`review asks: the sync failed: ${err.message}`),
          ),
        askSyncMs,
      )
    : null;
  askTimer?.unref();

  /* ------------------------------------------------------------ routes -- */

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  /**
   * A file, with byte ranges: iPhone Safari plays a <video> only from a
   * server that answers a Range request with 206 (and "#t=0.5" seeks).
   */
  const sendFile = (req, res, path, type) => {
    const size = statSync(path).size;
    const range = byteRange(req.headers.range, size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    res.writeHead(range ? 206 : 200, {
      "content-type": type,
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      ...(range && { "content-range": `bytes ${start}-${end}/${size}` }),
    });
    if (size === 0) return res.end();
    // pipeline, not pipe: a browser aborts a ranged request at each seek,
    // and pipe would keep the file open; a read error would crash the app.
    pipeline(createReadStream(path, { start, end }), res, () => {});
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
      // How many items Growth wants in review (crew.mjs queue).
      reviewTarget: store.queue().reviewTarget,
      // Each item that is not over, oldest first, with what is derived.
      items: active.map((it) => ({
        ...it,
        stage: stage(it),
        reviewState: reviewState(it),
        // Why its copy block cannot go to review, or null.
        staleCopy: it.render?.video ? store.staleCopy(it) : null,
        // The latest independent review of its current video, or null.
        vet: currentVet(it),
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

  /** A new item, with the other live items of its game (store.sameGame). */
  const picked = (res, item) =>
    json(res, 200, { ...item, sameGame: store.sameGame(item) });

  /**
   * Every check of a list for `item` before it is stored, the same for
   * direct and lint: {edl, risk, errors}. A list that is not a list at all
   * (validateEdl, another game) is refused at once.
   */
  /** The text of the item's script review if it passed, or null. */
  const passedScript = (item) => {
    const review = currentScriptReview(item);
    return review?.verdict === "pass" ? scriptText(review).script : null;
  };
  /** The list's sound repeats over the last videos made (sounds.mjs). */
  const repeatNotes = (item, edl) =>
    soundRepeatNotes(
      edl,
      recentVideoSounds(
        store.items(),
        item.id,
        (it) => reviewState(it) === "in-review",
      ),
    );

  const listChecks = (item, rawEdl, claimRiskOk) => {
    const checked = validateEdl(rawEdl);
    if (!checked.ok) throw new StepRefused(checked.errors.join("; "));
    const { edl } = checked;
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
      ...resultProblems(item.candidate, passedScript(item)),
      // Every new video ends on a call to action (Nil, 2026-10-31): the
      // director writes one per script (edl.mjs cta).
      ...(edl.cta
        ? []
        : [
            'name a call to action ("cta", e.g. "play free at wallgame.io"): every video shows one under the board and on the GG card',
          ]),
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
      // A daily video is posted: a MEDIUM or HIGH picture needs Nil's OK
      // for it (overlays.mjs needsNilOk; Wall Game PM's risk rule,
      // 2026-10-30). A preview is never posted and may show it.
      ...[
        ...new Set(
          edl.events
            .filter((e) => e.kind === "overlay")
            .map((e) => e.asset)
            .filter((name) => needsNilOk(OVERLAYS[name])),
        ),
      ].map(
        (name) =>
          `the ${name} overlay has ${["claim", "likeness"]
            .filter(
              (k) =>
                riskLevel(OVERLAYS[name][k]) !== "LOW" &&
                riskLevel(OVERLAYS[name][k]) !== "None",
            )
            .map((k) => `a ${riskLevel(OVERLAYS[name][k])} ${k} risk`)
            .join(
              " and ",
            )}, and Nil has not OKed it for a posted video (overlays.mjs nilOk): ask Nil through the Director, or pick a LOW one`,
      ),
      // The daily video has no cold open; edl.mjs keeps the field for a
      // hand render.
      ...(edl.coldOpenPly === null
        ? []
        : [
            `coldOpenPly is cut from the daily video (Nil, 2026-10-26: "the initial 1s hook doesn't work for me, it's too confusing. cut it"); remove it`,
          ]),
    ];
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
    return { edl, risk, errors: [...errors, ...problems] };
  };

  const routes = {
    "GET /daily": (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD);
    },

    "GET /api/daily/state": (req, res) => json(res, 200, state()),
    // Each item's last review ask, or its hold for the day's batch
    // (review-asks.mjs), for crew.mjs status.
    "GET /api/daily/asks": (req, res) => json(res, 200, askRecords.all()),

    // The app's own address: one line to the social stats, which moved to
    // the Growth app (Nil, 2026-11-04: "Seen it: remove the old page").
    // Nil reviews in his Isomux inbox; the review page stays at /review.
    "GET /": (req, res) => html(res, 200, HOME_PAGE),
    "GET /review": (req, res) => html(res, 200, REVIEW_PAGE),

    /** Every item in review (what the page shows), and who may act. */
    "GET /api/review/queue": (req, res) => {
      const member = memberOf(req);
      json(res, 200, {
        ...reviewView(store, scheduler.status().nextSlot),
        canReview: member?.id === REVIEWER_MEMBER_ID,
      });
    },

    /**
     * The review page's Social tab (social.mjs): Growth's platforms.json,
     * read on each request, with this app's modes, post logs and follower
     * counts. Secret names only. Opening it also records today's counts.
     */
    "GET /api/review/social": async (req, res) => {
      let data;
      try {
        data = JSON.parse(readFileSync(platformsFile, "utf8"));
      } catch (err) {
        // Loud, with the reason on the tab (VR1, review 89 N3).
        json(res, 500, {
          error: `Wall Game Growth's platforms.json cannot be read: ${err?.message ?? err}`,
        });
        return;
      }
      const followers = await followerCounts().catch(() => null);
      followerHistory.record(followers);
      const { modes, modeReasons: reasons } = state();
      const live = readPostLog(store.postLog.live);
      const { reads, numbers } = readPostStatsCache();
      json(res, 200, {
        ...socialView({
          data,
          modes,
          reasons,
          live,
          dry: readPostLog(store.postLog.dryRun),
          followers,
          history: followerHistory.read(),
          nowMs: Date.now(),
        }),
        postStats: postStatsView({
          posts: live,
          numbers,
          reads,
          history: postStatsHistory.read(),
          checkpoints: postCheckpoints.read(),
          names: {
            ...Object.fromEntries(data.platforms.map((p) => [p.id, p.name])),
            "instagram-story": "Instagram Story",
          },
          nowMs: Date.now(),
          platforms: STATS_PLATFORMS,
          note: `Each post is read at 1 h, 24 h, 7 days, then weekly to 4 weeks (each up to an hour late: the timer runs hourly, so "~1 h"); on every platform but X (paid per read) also every ${STATS_MAX_AGE_MS / 36e5} h for ${FRESH_WINDOW_MS / 864e5} days. A Story is read for 1 day. Then a post keeps its last numbers.`,
        }),
      });
    },

    /** {reviewTarget}: how many items Growth wants in review. */
    "POST /api/daily/queue": async (req, res) => {
      const body = await readJson(req);
      json(res, 200, store.setReviewTarget(body.reviewTarget));
    },

    /** ?id=<item>: one item, whatever its state. */
    "GET /api/daily/item": (req, res, url) =>
      json(res, 200, itemOf(url.searchParams.get("id"))),

    /** Counts, the next slot and the last one (scheduler.mjs status). */
    "GET /api/review/status": (req, res) =>
      json(res, 200, { ...scheduler.status(), tiktok: tiktokStatusBlock() }),

    /**
     * {by}: the latest TikTok draft is lost (Nil says it is not in his
     * inbox), so the next slot sends one (crew.mjs tiktok --lost).
     */
    /** READ-ONLY: the tiktok block of /api/review/status, for crew.mjs. */
    "GET /api/daily/tiktok": (req, res) => json(res, 200, tiktokStatusBlock()),

    "POST /api/daily/tiktok/lost": async (req, res) => {
      const body = await readJson(req);
      json(res, 200, tiktokDrafts.markLost({ by: body.by }));
    },

    /**
     * {itemId, confirmNotPosted?: [platform]}: Growth's retry of a
     * post-failed item, after the cause is fixed. It posts only the
     * platforms of the item's slot that did not post, and uses no slot.
     */
    "POST /api/daily/post": async (req, res) => {
      const body = await readJson(req);
      if (typeof body.itemId !== "string") {
        throw new StepRefused("post needs the itemId of a post-failed item");
      }
      const confirmNotPosted = Array.isArray(body.confirmNotPosted)
        ? body.confirmNotPosted.filter((p) => PLATFORMS.includes(p))
        : [];
      json(
        res,
        200,
        await asThePost(() =>
          itemPoster.retry(body.itemId, { confirmNotPosted }),
        ),
      );
    },

    /**
     * A slot now, by hand (Growth, `crew.mjs slot --now`): the scheduler's
     * own slot step (scheduler.mjs fireNow), so the oldest approved item,
     * its checks and platforms, the slot message and the 6 h gap are a
     * timed slot's. {by}: who fires it, recorded in the slot message and the
     * post log. A refusal (no by, a post runs, no item approved, the gap
     * holds) is a 409 with its reason; nothing was written or sent.
     */
    "POST /api/daily/slot-now": async (req, res) => {
      const body = await readJson(req);
      const r = await scheduler.fireNow({ by: body.by });
      if (!r.ok) throw new StepRefused(`slot --now: ${r.reason}`);
      json(res, 200, r.lastSlot);
    },

    /**
     * What a restart would cut: every render queued or running (on the 4090)
     * and a post in flight. `crew.mjs ship` refuses to restart while any is
     * busy.
     */
    "GET /api/daily/busy": (req, res) =>
      json(res, 200, {
        renders: [
          ...running.map((job) => ({ ...job, state: "running" })),
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
        return picked(
          res,
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
      picked(
        res,
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
      const { edl, risk, errors } = listChecks(
        item,
        body.edl,
        body.claimRiskOk ?? [],
      );
      if (errors.length) throw new StepRefused(errors.join("; "));
      const text = listText(edl);
      const linted = lintGate(item, text, body);
      // After Nil's Revise, the list names what it changed, so his next
      // ask shows only that moment (Nil, 2026-11-01, CASES C54).
      const revised = item.reviews.at(-1)?.action === "revise";
      if (revised) {
        const problem = changedProblem(
          body.changed,
          item.candidate.movesCount - 1,
          edl.events,
        );
        if (problem) {
          throw new StepRefused(
            `${item.id} follows Nil's Revise, so its list names what changed (direct --changed <plies|end|all> --what "<one line>"): ${problem}`,
          );
        }
      } else if (body.changed) {
        throw new StepRefused(
          `${item.id} has no Revise from Nil to answer: a first review shows the whole video, so direct takes no --changed`,
        );
      }
      json(
        res,
        200,
        store.direct(item.id, {
          edl,
          text,
          changed: revised ? body.changed : null,
          needsPawnArt: linted.needsPawnArt,
          summary: [
            ...edlSummary(edl),
            ...dislikedSoundNotes(edl, soundPicks.disliked()),
            ...risk.notes,
            ...lastMoveSoundNotes(edl, item.candidate.movesCount),
            ...repeatNotes(item, edl),
            ...linted.lines,
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

    /**
     * {item, videoSha256, reviewer, verdict, notes}: the independent review
     * of the item's final video (store.recordVet). It sends no message.
     */
    /**
     * One sync of Nil's review asks now (review-asks.mjs): crew.mjs asks,
     * for the Director after Nil answers. The app also syncs on its timer.
     * With {again: itemId} (crew.mjs asks --again), the item's last ask,
     * closed with nothing applied, gets a new one in this sync (askAgain).
     * Returns what it did and each item's last ask.
     */
    "POST /api/daily/asks/sync": async (req, res) => {
      const body = await readJson(req);
      if (body.again) {
        // After a sync in flight, so its record writes come first.
        await askSync?.catch(() => undefined);
        askAgain(askRecords, itemOf(body.again).id);
      }
      const did = await syncAsks();
      json(res, 200, { ...did, asks: askRecords.all() });
    },

    "POST /api/daily/vet": async (req, res) => {
      const body = await readJson(req);
      json(
        res,
        200,
        store.recordVet(itemOf(body.item).id, {
          videoSha256: body.videoSha256,
          reviewer: body.reviewer,
          verdict: body.verdict,
          notes: body.notes,
        }),
      );
    },

    /**
     * {item, script, reviewer, verdict, notes}: the fresh review of the
     * item's script (store.recordScriptReview). It sends no message.
     */
    "POST /api/daily/script-review": async (req, res) => {
      const body = await readJson(req);
      json(
        res,
        200,
        store.recordScriptReview(itemOf(body.item).id, {
          script: body.script,
          reviewer: body.reviewer,
          verdict: body.verdict,
          notes: body.notes,
        }),
      );
    },

    /**
     * {item, script, by, why}: a lint-forced text fix of the passed script
     * (store.recordScriptFix). It sends no message.
     */
    "POST /api/daily/script-fix": async (req, res) => {
      const body = await readJson(req);
      json(
        res,
        200,
        store.recordScriptFix(itemOf(body.item).id, {
          script: body.script,
          by: body.by,
          why: body.why,
        }),
      );
    },

    /**
     * {item, by, why}: Nil's revise changes no story, so the passed script
     * carries over (store.recordScriptUnchanged). It sends no message.
     */
    "POST /api/daily/script-unchanged": async (req, res) => {
      const body = await readJson(req);
      json(
        res,
        200,
        store.recordScriptUnchanged(itemOf(body.item).id, {
          by: body.by,
          why: body.why,
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

    /**
     * {item, why, by?} keeps an approved item from posting, its approval
     * kept; {item, release: true, by?} lifts the hold (store.hold).
     */
    "POST /api/daily/hold": async (req, res) => {
      const body = await readJson(req);
      const id = itemOf(body.item).id;
      json(
        res,
        200,
        body.release === true
          ? store.release(id, body.by)
          : store.hold(id, body.why, body.by),
      );
    },

    /**
     * {item, ask, by?}: arm the approval of the fixed render from Nil's
     * revise on `ask` (store.armFixedApproval). An item already in review
     * is approved now; else the next ask sync approves it when it is in
     * review, and opens no ask for it.
     */
    "POST /api/daily/approve-fixed": async (req, res) => {
      const body = await readJson(req);
      const id = itemOf(body.item).id;
      const armed = store.armFixedApproval(id, {
        askId: body.ask,
        by: body.by,
      });
      json(
        res,
        200,
        fixedApprovalProblem(armed)
          ? { item: armed, approved: false, waits: fixedApprovalProblem(armed) }
          : { item: store.approveFixed(id), approved: true, waits: null },
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
      // the renderer cannot use the cached capture. A list that needs the
      // pawn art (edl.needsPawnArt, lintGate) captures live, without being
      // asked, while the capture has none; a live render of it saves one,
      // so the next render reads that (the 4090's capture decides, not the
      // list: VR1, review 81).
      let fromCache = false;
      if (body.live !== true) {
        const capture = await captureOf(item.candidate.gameId);
        if (capture.error) {
          throw new StepRefused(
            `${capture.error}; the app must know whether the 4090 has the game's capture before it renders, so try again`,
          );
        }
        fromCache =
          capture.cached &&
          (capture.pawnArt || item.edl?.needsPawnArt !== true);
      }
      store.startRender(item.id, jobId, {
        force: body.force === true,
        fromCache,
      });
      queue.push({
        itemId: item.id,
        jobId,
        gameId: item.gameId,
        live: !fromCache,
      });
      pump();
      json(res, 200, { itemId: item.id, jobId });
    },

    /**
     * {item, plies: "FROM..TO", edl?, draft?}: a preview of those plies of
     * the item's list, or of `edl` (a list for the item's game that is not
     * directed yet), from the game's capture on the 4090. draft: true makes
     * it a quick look, and then plies may be left out for the whole list.
     * It waits in the render queue and changes nothing in the item.
     */
    "POST /api/daily/preview": async (req, res) => {
      const body = await readJson(req);
      const item = itemOf(body.item);
      if (body.draft !== undefined && typeof body.draft !== "boolean") {
        throw new StepRefused("draft is true or false");
      }
      const draft = body.draft === true;
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
      const whole = draft && body.plies === undefined;
      const span = whole
        ? { ok: true, from: null, to: null }
        : parsePlyWindow(body.plies, edl.startPly ?? 0);
      if (!span.ok) throw new StepRefused(span.error);
      const lastPly = item.candidate.movesCount - 1;
      if (!whole && span.to > lastPly) {
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
        draft,
        edlText,
        state: "queued",
        video: null,
        error: null,
      });
      prunePreviews();
      queue.push({
        itemId: item.id,
        jobId,
        kind: "preview",
        gameId: item.gameId,
        live: false,
      });
      pump();
      json(res, 200, { itemId: item.id, previewId: jobId });
    },

    /**
     * {item, edl?, claimRiskOk?}: lint the list (or the item's stored one):
     * the app's checks now, the renderer's from the capture in the queue.
     * {lintId}; GET /api/daily/lint?id= gives the record. A game with no
     * capture yet gets only the app's checks (skipped says so).
     */
    "POST /api/daily/lint": async (req, res) => {
      const body = await readJson(req);
      const item = itemOf(body.item);
      const raw = body.edl ?? item.edl?.doc;
      if (!raw) {
        throw new StepRefused(
          `${item.id} has no edit list yet: give lint an --edl`,
        );
      }
      const { edl, errors } = listChecks(item, raw, body.claimRiskOk ?? []);
      const capture = await captureOf(edl.gameId);
      if (capture.error) throw new StepRefused(capture.error);
      lintCount += 1;
      const lintId = `${item.id}-${item.gameId}-l${Date.now().toString(36)}${lintCount}`;
      const text = listText(edl);
      lints.set(lintId, {
        itemId: item.id,
        key: sha256(text),
        state: capture.cached ? "queued" : "done",
        errors,
        warnings: repeatNotes(item, edl),
        skipped: capture.cached
          ? null
          : `the 4090 has no capture of game ${edl.gameId} yet; the first render checks the list before its shoot pass`,
        lint: null,
        timings: null,
        error: null,
        edlText: text,
      });
      pruneLints();
      if (capture.cached) {
        queue.push({
          itemId: item.id,
          jobId: lintId,
          kind: "lint",
          gameId: item.gameId,
          live: false,
        });
        pump();
      }
      json(res, 200, { itemId: item.id, lintId });
    },

    "GET /api/daily/lint": (req, res, url) => {
      const id = url.searchParams.get("id") ?? "";
      const rec = lints.get(id);
      if (!rec) {
        return json(res, 404, {
          error: `no lint ${id} (the app forgets lints when it restarts)`,
        });
      }
      json(res, 200, {
        lintId: id,
        itemId: rec.itemId,
        state: rec.state,
        progress: progress.get(id) ?? null,
        errors: rec.errors,
        warnings: rec.warnings,
        skipped: rec.skipped,
        lint: rec.lint,
        timings: rec.timings,
        error: rec.error,
      });
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
        plies: p.from === null ? null : `${p.from}..${p.to}`,
        draft: p.draft,
        state: p.state,
        progress: progress.get(id) ?? null,
        video: p.video,
        timings: p.timings ?? null,
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
      sendFile(req, res, path, "video/mp4");
    },

    "GET /api/daily/sheet": (req, res, url) => {
      const path = itemOf(url.searchParams.get("item")).render?.sheet?.path;
      if (!path || !existsSync(path))
        return json(res, 404, { error: "no contact sheet for that item" });
      sendFile(req, res, path, "image/png");
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
      sendFile(req, res, path, "audio/mpeg");
    },

    // One-click Connect (connect.mjs). The office sends the member's id and
    // name with each request through the app's URL; a request without them
    // did not come through the office and may not connect anything. Only
    // Nil (CONNECT_MEMBER_ID) may start or finish a Connect.
    /**
     * The Meta insights token's landing page (Wall Game PM, 2026-10-31):
     * Wall Game PM's browser pastes it from Meta's Copy button, so no
     * agent reads it. Only Nil (the office's member header) may save; the
     * token goes to the token store (0600) and is never shown or echoed.
     */
    "GET /daily/connect/meta-insights": async (req, res) => {
      html(
        res,
        200,
        metaInsightsPage({ status: tokens.status(META_INSIGHTS) }),
      );
    },

    "POST /daily/connect/meta-insights": async (req, res) => {
      const member = memberOf(req);
      const refusal = connectRefusal(member);
      if (refusal) {
        return html(res, 403, connectRefusedPage(META_INSIGHTS, refusal));
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 16 * 1024) {
          return html(
            res,
            413,
            connectRefusedPage(META_INSIGHTS, "that request is too large"),
          );
        }
      }
      const token = new URLSearchParams(raw).get("token")?.trim() ?? "";
      if (!token) {
        return html(
          res,
          400,
          metaInsightsPage({
            status: tokens.status(META_INSIGHTS),
            result: { ok: false, text: "No token given: paste it, then Save." },
          }),
        );
      }
      tokens.write(META_INSIGHTS, {
        connectedAt: new Date().toISOString(),
        connectedBy: "browser",
        scopes: [],
        account: { id: null, name: null },
        accessToken: token,
      });
      const result = await metaTokenCheck(makeLiveTransport(), token);
      html(
        res,
        200,
        metaInsightsPage({ status: tokens.status(META_INSIGHTS), result }),
      );
    },

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
     * READ-ONLY: the channel's last 5 uploads in every state (post-youtube.mjs
     * youtubeRecentNow), for a person who looks at an UNCERTAIN upload; a
     * YouTube retry reads them itself (review-post.mjs). It refreshes the
     * YouTube token as a post does, so it runs as THE post (asThePost). The
     * reply has no token.
     */
    "GET /api/daily/youtube-recent": async (req, res) => {
      const why = platformReasons("youtube", env, connectedNow());
      if (why.length) throw new StepRefused(`youtube: ${why.join("; ")}`);
      const videos = await asThePost(youtubeRecentNow);
      json(res, 200, { at: new Date().toISOString(), videos });
    },

    /**
     * READ-ONLY: TikTok's status of one upload now (post-tiktok.mjs
     * tiktokPostStatus), for a draft that is not in the app. It refreshes
     * the TikTok token as a post does, so it runs as THE post (asThePost):
     * no post and no follower read refreshes the token at the same time,
     * and a rotated token is kept. The reply has no token.
     */
    "GET /api/daily/tiktok-status": async (req, res, url) => {
      const publishId = url.searchParams.get("publishId") ?? "";
      if (!/^[\w.~-]{1,128}$/.test(publishId)) {
        throw new StepRefused(
          "tiktok-status takes publishId=<the publish_id of the post>",
        );
      }
      // The account's reasons: a pause does not stop a read.
      const why = platformReasons("tiktok", env, connectedNow());
      if (why.length) throw new StepRefused(`tiktok: ${why.join("; ")}`);
      const result = await asThePost(() => tiktokStatusNow(publishId));
      json(res, 200, { at: new Date().toISOString(), ...result });
    },

    /**
     * READ-ONLY: {<platform>: {followers, at, error}} (followers.mjs,
     * followerCounts): while a post runs with no last result, a refusal.
     */
    "GET /api/daily/followers": async (req, res) => {
      const counts = await followerCounts();
      if (!counts) {
        throw new StepRefused("a post is running: ask again in a few minutes");
      }
      json(res, 200, counts);
    },

    // `swingSiteMove`: the row's swingMove (ply + 1) as wallgame.io's move
    // list names it, for the page (site-move.mjs).
    "GET /api/daily/post-log": (req, res, url) =>
      json(
        res,
        200,
        readPostLog(
          url.searchParams.get("dryRun") === "1"
            ? store.postLog.dryRun
            : store.postLog.live,
        ).map((r) => ({
          ...r,
          swingSiteMove: Number.isInteger(r.swingMove)
            ? siteMove(r.swingMove - 1)
            : null,
        })),
      ),
  };

  /** True when the request was a daily one and has been answered. */
  /** POST /api/review/<id>/<action>: Nil's review (review.mjs). */
  const review = async (req, res, [, id, action]) => {
    const body = await readJson(req);
    const { item, directorTold } = await reviewAction({
      store,
      member: memberOf(req),
      id,
      action,
      body,
      send: sendMessage,
    });
    json(res, 200, { id: item.id, state: item.state, directorTold });
    // His ask for this item no longer matches it: withdraw it now.
    void syncAsks().catch((err) =>
      console.warn(`review asks: the sync failed: ${err.message}`),
    );
  };

  const handle = async (req, res, url) => {
    const action =
      req.method === "POST" ? REVIEW_ACTION_PATH.exec(url.pathname) : null;
    const route = action
      ? (rq, rs) => review(rq, rs, action)
      : routes[`${req.method} ${url.pathname}`];
    if (!route) return false;
    try {
      await route(req, res, url);
    } catch (err) {
      if (err instanceof ReviewRefused) {
        json(res, err.status, { error: err.message });
      } else if (err instanceof StepRefused) {
        json(res, 409, { error: err.message });
      } else json(res, 500, { error: String(err?.message ?? err) });
    }
    return true;
  };

  /** Stop a running render (and so its 4090 unit) when the app stops. */
  const stop = () => {
    if (threadsTimer) clearInterval(threadsTimer);
    if (followerTimer) clearInterval(followerTimer);
    if (askTimer) clearInterval(askTimer);
    stopSchedule();
    budget.stop();
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* gone */
      }
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
    scheduler,
  };
};

/**
 * The one byte range that a Range header asks for in a file of `size`
 * bytes: {start, end} (both inclusive), null to send the whole file (no
 * header, a header this does not read, or several ranges), or
 * "unsatisfiable" (416). Forms: "bytes=a-b", "bytes=a-", "bytes=-n".
 */
export const byteRange = (header, size) => {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n === 0 || size === 0
      ? "unsatisfiable"
      : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || end < start ? "unsatisfiable" : { start, end };
};

/**
 * The uses of a sound with a high claim risk. A use is a problem unless its
 * key is in `ok` (the director accepted it on purpose); then it is a note
 * for the summary. A key in `ok` that the list does not use is a problem.
 */
export const claimRiskLines = (edl, ok) => {
  const uses = soundUses(edl).filter(([, key]) => claimRisk(key));
  return {
    problems: [
      // A retired sound has no "on purpose": Nil took it out.
      ...soundUses(edl)
        .filter(([, key]) => retired(key))
        .map(
          ([where, key]) =>
            `${where}: ${key} is ${retired(key)}; name another sound (crew.mjs sounds)`,
        ),
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
export const dislikedSoundNotes = (edl, disliked) =>
  soundUses(edl)
    .filter(([, key]) => disliked.includes(key))
    .map(
      ([where, key]) =>
        `${where} uses disliked ${key}: Nil's preference, allowed`,
    );

/**
 * A warning when no event on the last move carries a sound (Nil,
 * 2026-10-28, on the capture: "there could be some sound effect right
 * before or as the mouse is captured, it feels a bit anticlimactic"). Any
 * event's sound counts (a lead zoom, a `sound` event, a freeze's just
 * before the move, an overlay's), except the ending's caption bar's: the
 * bar opens on the ending's impact, as the finish sound plays, after the
 * capture (Video Reviewer 2, 2026-10-28). A warning
 * in the list's summary, not a refusal (Wall Game Director, 2026-10-28).
 */
export const lastMoveSoundNotes = (edl, movesCount) => {
  const last = movesCount - 1;
  return edl.events.some(
    (e) => e.ply === last && e.sound !== undefined && e.form !== "bar",
  )
    ? []
    : [
        `WARNING: no sound lands on the last move (ply ${last}): give it a lead zoom with its sound, or a sound event`,
      ];
};

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
  // through the API: Nil pastes its line in the inbox draft. A Story has
  // no caption.
  caption: ((t) =>
    platform === "youtube"
      ? `${t.youtubeTitle}\n\n${t.youtubeDescription}`
      : platform === "instagram-story"
        ? null
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
  // ply + 1, as the candidate stores it; the page shows the site's count.
  swingMove: item.candidate.picks[0].moveNumber,
  approver: item.approval.by,
  // Who fired the slot by hand (crew.mjs slot --now), also on a retry of
  // that slot's item; null for a timed slot.
  firedBy: item.posting?.firedBy ?? null,
  videoSha256: item.approval.videoSha256,
  youtubePrivacyStatus:
    platform === "youtube" ? (result.privacyStatus ?? null) : null,
  // SEND_TO_USER_INBOX: a draft that Nil still has to post in the app.
  tiktokStatus: platform === "tiktok" ? result.tiktokStatus : null,
});

/**
 * Where the social stats are: the Growth app's page, which reads GET
 * /api/review/social from this app. Its office short link, as Nil gets
 * links (Wall Game Director, 2026-10-30).
 */
const GROWTH_SOCIAL_URL = "https://office.nilmamano.com/growth/wallgame/social";

/** The app's "/": the app's short link opens it, so it answers. */
const HOME_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wall Game videos</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f1c; color: #e2e8f0;
         margin: 0; padding: 40px 16px; text-align: center; font-size: 16px; }
  a { color: #ff8c42; }
</style></head>
<body><p>The social stats are in the Growth app: <a href="${GROWTH_SOCIAL_URL}">Wall Game social</a>.</p></body></html>`;

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
  <p class="sub">Videos to X, YouTube, TikTok, Instagram, Facebook, Bluesky and Threads. The director makes each video as an item, Wall Game Growth writes its post text, Nil reviews it in his Isomux Inbox, and an approved video posts at the next slot. This page shows where each item is.
    <a href="${GROWTH_SOCIAL_URL}">Social stats</a> · <a href="/daily/sounds">Meme sounds</a> · <a href="/daily/connect">Connect platforms</a></p>
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
      for (const v of [r.utc, r.platform, r.gameId, r.postId, r.swingSize + " steps @ move " + r.swingSiteMove,
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
