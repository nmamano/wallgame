/**
 * Turn a finished Wall Game into a video you can post.
 *
 * Board task f89e649f. Takes a past-game URL, plays the game back through the
 * real replay page in real Chrome, and writes an mp4 sized for a phone feed:
 * a VS screen, the moves at a chosen pace, and a winner card.
 *
 *   bun scripts/game-video/render-game-video.mjs --game https://wallgame.io/game/v5P09s6K
 *   bun scripts/game-video/render-game-video.mjs --game v5P09s6K --seconds-per-move 0.5
 *   bun scripts/game-video/render-game-video.mjs --game v5P09s6K --aspect square
 *   bun scripts/game-video/render-game-video.mjs --game v5P09s6K --music a-legend
 *
 * Bun, not Node: the race counter imports race-replay.ts and shared/domain,
 * which are TypeScript.
 *
 * IT IS NOT READ-ONLY, AND AN EARLIER VERSION OF THIS COMMENT CLAIMED IT WAS.
 * GET /api/games/:id runs `UPDATE games SET views = views + 1`
 * (server/db/game-queries.ts:429), so every look at a replay is a production
 * write. This tool loads the replay page exactly ONCE per render, so it costs
 * exactly ONE view - the same one any person opening that link would cost.
 *
 * It used to cost three: a separate API fetch of its own, the page's fetch, and
 * a second page load to raise the capture resolution. Measured on 2026-08-20,
 * that put 38 views on one of Nil's own games in a single session. The fetch is
 * gone - the renderer now reads the response the PAGE already made - and the
 * capture scale is fixed so there is no second load.
 *
 * It still creates nothing and joins nothing. It renders finished games only.
 *
 * WHY IT DRIVES THE REAL PAGE. Every pixel of board, pawn and wall in the
 * output is a screenshot of the shipped replay page. Nothing here re-draws the
 * game, so the video cannot disagree with the product - a new variant, a new
 * theme or a new pawn arrives in the video for free. This file owns only what
 * the product has no opinion about: the aspect ratio, the VS screen, the name
 * plates, the end card and the pace.
 *
 * The same rule covers the portraits. The player card resolves art and colour
 * through one resolver (frontend/src/lib/pawn-style.ts, and the colour map in
 * lib/player-colors.ts); this script reads the RESOLVED layer srcs and the
 * RESOLVED css filter straight off that rendered element and re-composes them
 * larger. It does not keep its own table of skins or colours, because a second
 * table is the mechanism Nil ruled out on 2026-08-16.
 *
 * The three sounds that are not the site's own live in one table, SOUNDS,
 * further down. That is the only place to change them.
 *
 * THE MIX IS SETTLED AND IS NOT A PER-RENDER CHOICE. The levels, the fades,
 * the frame rate and the capture scale were arrived at over about eight rounds
 * with Nil's ear and are NAMED CONSTANTS, not flags. A flag is a promise that
 * the value is the caller's to move; these are not, and a future reader who
 * saw --win-gain would reasonably assume otherwise. Change the constant if the
 * sound is wrong, and expect to justify it to the person who tuned it.
 *
 * Needs: playwright-core with Playwright's Chromium (or Chrome, with
 * --browser chrome), and ffmpeg. The wallz caption also needs the TikTok Sans
 * and Noto Color Emoji fonts. Renders run on the 4090 (Nil, 2026-10-25): see
 * sync-render-kit.sh, which sets that box up.
 */
import { chromium } from "playwright-core";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
  linkSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  assertCompleteCapture,
  captureReplayFrames,
} from "./capture-replay-frames.mjs";
import { captureFeedbackPlan } from "./capture-feedback.mjs";
import {
  validateEdl,
  checkEdlAgainstGame,
  DEFAULT_CTA,
  DEFAULT_SECONDS_PER_MOVE,
  fastForwardTag,
  areaOf,
  dailySeatColors,
  dailySeatNames,
  DEFAULT_SLOT_SOUNDS,
  edlSoundUses,
  EDL_LIMITS,
  LINT_KINDS,
  MAX_VIDEO_SECONDS,
  FRAME as DAILY_FRAME,
  REACTIONS,
  SAFE_AREA,
  STRIP_AREA,
  parsePlyWindow,
} from "./edl.mjs";
import {
  firstBlockedStep,
  huntPath,
  huntsFor,
  pawnCellsOn,
  preyTypeOf,
  raceFromWalks,
  replayDistances,
  walksOn,
} from "./race-replay.ts";
import {
  OVERLAYS,
  OFF_BOARD,
  PORTRAIT_DRAWS,
  VISUAL_MEME_DIR,
  boxOnScreen,
  offBoardPlace,
  placesOf,
  reactorRole,
  loadingPercent,
  NO_REACH,
  COVER_HIDE_SHARE,
  COVER_PLACE,
  overlayPlaces,
  placeName,
  placeOverlay,
  placeNear,
  parsePawn,
  DEATH_CARDS,
  nearFaults,
  tailOf,
  takesPawn,
  READ_BASE_SECONDS,
  READ_WORD_SECONDS,
  TEXT_TIMING,
  overlayWords,
  readingSeconds,
} from "./overlays.mjs";
import { boardPawns, pawnCell } from "../../shared/domain/pawns.ts";
import { Grid } from "../../shared/domain/grid.ts";
import {
  wallFromStandardNotation,
  wallToStandardNotation,
} from "../../shared/domain/standard-notation.ts";
import {
  helpRulesFor,
  helpVariantFor,
} from "../../shared/domain/variant-rules.ts";
import { MEME_SOUNDS, isVoice, levelGain, memeGain } from "./meme-sounds.mjs";
import {
  boardToCover,
  clipCoverage,
  clipFrameIndex,
  clipSoundName,
  coverOver,
  loadClip,
} from "./overlay-clips.mjs";
import {
  MUSIC_TRACKS,
  creditLine,
  creditLines,
  mayPlay,
  musicGain,
} from "./music-tracks.mjs";
import { verifyEncodedVideo } from "./verify-encoded-video.mjs";
import { stampSpot } from "./stamp-spot.mjs";
import {
  masterFault,
  masterFilters,
  OPENING_SILENCE_SECONDS,
  SILENCE_FLOOR_DBFS,
  SILENCE_SECONDS,
  measureMaster,
  measureSilences,
  memeLoudness,
  mixGraph,
  mixIntegrated,
  runMaster,
  silencesOverRules,
} from "./mix-loudness.mjs";
import { boardGrid, onSiteWall } from "./board-grid.mjs";
import {
  allocateFrameRanges,
  movesUnderOverlay,
  restAfterEvents,
  videoTimeline,
} from "./timeline-frames.mjs";
import { fileUrlsIn, isRestShot, partsOf } from "./shoot-workers.mjs";
import {
  pruneCaptureCaches,
  readCaptureCache,
  writeCaptureCache,
} from "./capture-cache.mjs";

/** When the run started, for RESULT.timings. */
const RUN_STARTED = Date.now();
/** Seconds since `from` (a Date.now()), to a tenth, for RESULT.timings. */
const secondsSince = (from) => Number(((Date.now() - from) / 1000).toFixed(1));
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
/** The meme sounds' files, by key (meme-sounds.mjs). */
const MEME_DIR = join(REPO, "assets/meme-sounds");

/* ------------------------------------------------------------------ args -- */

/**
 * The first line is a contract: ship.mjs (step "help") and the release
 * runbook check that `--help` prints a line that starts with it.
 */
const USAGE =
  "usage: render-game-video.mjs --game <wallgame.io game url or id>\n" +
  "       [--seconds-per-move S] [--aspect fit|square|9x16]\n" +
  "   or: render-game-video.mjs --edl FILE   (the daily look; see edl.mjs)\n" +
  "       [--music deja-vus|tea-for-two|a-legend|skippy] [--no-music]\n" +
  "       [--sounds vsMeme=shotgun-2,finish=shotgun-4] [--board-theme crisp|default] [--out FILE]\n" +
  "  plumbing, for the app rather than for a person:\n" +
  "       [--log FILE] [--work DIR] [--ffmpeg PATH]\n" +
  "       [--browser chromium|chrome] [--encoder x264|nvenc] [--workers N]\n" +
  "       [--from-cache] [--cache DIR] [--plies FROM..TO] [--lint] [--draft]";

/**
 * Every flag the renderer takes: "value" (--name VALUE) or "switch". The
 * readers below (cliArg, arg, flag) ask for these names only, and any other
 * word on the command line stops the render here, before the browser
 * starts. Without it a kit older than a flag ignores the flag: a kit
 * without --from-cache captured the game live, which counts a real view
 * (Video Reviewer 1, 2026-10-27).
 */
const FLAGS = {
  help: "switch",
  aspect: "value",
  "board-theme": "value",
  browser: "value",
  cache: "value",
  draft: "switch",
  edl: "value",
  encoder: "value",
  ffmpeg: "value",
  "from-cache": "switch",
  game: "value",
  lint: "switch",
  log: "value",
  music: "value",
  "no-music": "switch",
  out: "value",
  plies: "value",
  "seconds-per-move": "value",
  sounds: "value",
  style: "value",
  work: "value",
  workers: "value",
};
const argv = process.argv.slice(2);
{
  const problems = [];
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].startsWith("--") ? argv[i].slice(2) : null;
    if (name === null || !Object.hasOwn(FLAGS, name)) {
      problems.push(`${argv[i]} is not a flag of this renderer`);
    } else if (FLAGS[name] === "value") {
      if (i + 1 === argv.length || argv[i + 1].startsWith("--")) {
        problems.push(`--${name} needs a value`);
      } else {
        i += 1;
      }
    }
  }
  if (problems.length > 0) {
    console.error(
      `${problems.join("\n")}\nKnown: ${Object.keys(FLAGS)
        .map((f) => `--${f}`)
        .join(" ")}`,
    );
    process.exit(2);
  }
}
/** A reader's name must be in FLAGS, or the check above would refuse it. */
const listed = (name) => {
  if (!Object.hasOwn(FLAGS, name)) {
    throw new Error(`the renderer reads --${name}, which FLAGS does not list`);
  }
  return name;
};
const cliArg = (name) => {
  const i = argv.indexOf(`--${listed(name)}`);
  return i === -1 ? undefined : argv[i + 1];
};
const flag = (name) => argv.includes(`--${listed(name)}`);
/**
 * Compose only, and report the list's faults (R1): no image, no MP4. The
 * RESULT line is {lint: {faults, notes, counts, loudness, timeline},
 * timings}.
 */
const LINT = flag("lint");
/**
 * A draft (R2, Wall Game Director, 2026-10-29: quick tries of timing and
 * story): the same composition, sound and seconds, shot at DRAFT_FPS and
 * DRAFT_SCALE of the frame's size, and not checked frame by frame against
 * its images. RESULT.draft says so; a draft is never a video to post.
 */
const DRAFT = flag("draft");
const DRAFT_FPS = 15;
const DRAFT_SCALE = 0.5;
// A lint reads the capture, so it never costs a view (Video Editor (daily
// app), 2026-10-29).
if (LINT && !flag("from-cache")) {
  console.error("--lint reads the capture cache: add --from-cache");
  process.exit(2);
}
if (flag("help")) {
  console.log(USAGE);
  process.exit(0);
}

/**
 * The edit decision list of a daily video (edl.mjs), written by the director
 * and validated by the daily app before Nil sees it.
 *
 * It travels as a FILE, not on a command line, because its caption is
 * untrusted text and a shell must never parse it. It is the only input of a
 * daily render: game, caption, pace, every effect and sound cue, and the
 * ending all come from it. Its sha256, of the bytes as read, goes into the
 * RESULT line, so the app can prove the video plays the EDL it approved.
 */
const EDL_PATH = cliArg("edl");
const EDL_BYTES = EDL_PATH ? readFileSync(resolve(EDL_PATH)) : null;
const EDL = (() => {
  if (!EDL_BYTES) return null;
  let raw;
  try {
    raw = JSON.parse(EDL_BYTES.toString("utf8"));
  } catch (err) {
    console.error(`--edl ${EDL_PATH} is not JSON: ${err.message}`);
    process.exit(2);
  }
  const checked = validateEdl(raw);
  if (!checked.ok) {
    console.error(
      `--edl ${EDL_PATH} is not valid:\n  ${checked.errors.join("\n  ")}`,
    );
    process.exit(2);
  }
  return checked.edl;
})();
const EDL_SHA256 = EDL_BYTES
  ? createHash("sha256").update(EDL_BYTES).digest("hex")
  : null;
const fromEdl = {
  game: EDL?.gameId,
  style: EDL ? "daily" : undefined,
};
const arg = (name, fallback) => cliArg(name) ?? fromEdl[name] ?? fallback;

/**
 * With --log, every progress line goes to that file and stdout carries only
 * the RESULT lines. The dashboard reads this box over ssh, and ssh to the 4090
 * stalls above about 1 KB of output.
 */
const LOG_FILE = cliArg("log") ? resolve(cliArg("log")) : null;
if (LOG_FILE) {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const toFile =
    (prefix = "") =>
    (...m) =>
      appendFileSync(LOG_FILE, prefix + m.map(String).join(" ") + "\n");
  console.log = toFile();
  const errorToFile = toFile("ERROR ");
  console.error = (...m) => {
    errorToFile(...m);
    process.stderr.write(String(m[0]).slice(0, 300) + "\n");
  };
  const die = (err) => {
    // The message first: a Bun stack can leave it out (2026-10-30, the
    // v-2026-10-30-5 master fault logged as a bare "Error").
    errorToFile(String(err?.message ?? err));
    if (err?.stack) errorToFile(err.stack);
    process.stderr.write(
      `render failed: ${String(err?.message ?? err).slice(0, 300)}\n`,
    );
    process.exit(1);
  };
  process.on("uncaughtException", die);
  process.on("unhandledRejection", die);
}

const rawGame = arg("game");
if (!rawGame) {
  console.error(USAGE);
  process.exit(2);
}
/** Accepts a full share URL or a bare id, because a person will paste either. */
const GAME_ID = rawGame
  .replace(/[?#].*$/, "")
  .split("/")
  .filter(Boolean)
  .at(-1);

const ORIGIN = "https://wallgame.io";

/**
 * The looks a render can take. Board task e8d26610 step 2: Nil picks one after
 * he watches the same game in each.
 *
 *   current  the look shipped since 2026-08: VS screen, name plates, a shake
 *            on the winning capture, a winner card.
 *   daily    the daily Short (Nil, 2026-10-25 and 2026-10-26): a 9:16
 *            frame with every key element inside the Reels safe area
 *            (SAFE_AREA in edl.mjs), one meme caption, the race counter, the
 *            punch-ins, mouse beats, stamps and meme sounds the director's
 *            EDL places, "Bot" vs "Human" in their colours as an OVERLAY over
 *            the first seconds of play (an intro screen loses viewers), and
 *            one of our own endings. No plates, no winner card.
 *
 * A daily render takes everything that varies from its EDL (`--edl`), the
 * ending too: Nil, 2026-10-26, the three endings (stage.html describes each)
 * ROTATE for variety, and the daily app picks one per video.
 *
 * `--style current,daily` composes both from ONE capture: the replay page
 * loads once, so a comparison costs the game one view, not one per style.
 */
const STYLES = {
  current: {
    look: "current",
    vsSeconds: 3.8,
    vsSound: "vsStamp",
    secondsPerMove: 0.8,
  },
  daily: {
    look: "wallz",
    vsSeconds: 0,
    vsOverlay: true,
    vsSound: "vsMeme",
    secondsPerMove: DEFAULT_SECONDS_PER_MOVE,
  },
};
const STYLE_NAMES = String(arg("style", "current"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const name of STYLE_NAMES) {
  if (!STYLES[name]) {
    console.error(`--style ${name} is not known. Known: current, daily`);
    process.exit(2);
  }
}
// An explain plays only in the daily look; the current look would drop it
// with no word (Video Reviewer 1, review 75).
const notDaily = STYLE_NAMES.filter((n) => STYLES[n].look !== "wallz");
if (EDL?.events.some((e) => e.kind === "explain") && notDaily.length > 0) {
  console.error(
    `the EDL has an explain, which only the daily look plays; --style ${notDaily.join(",")} would drop it`,
  );
  process.exit(2);
}
if (STYLE_NAMES.includes("daily") && !EDL) {
  console.error("the daily look plays an EDL: give --edl FILE (see edl.mjs)");
  process.exit(2);
}
/*
  Every meme sound the list plays must have its file here, checked before a
  live capture spends a view. The files are gitignored and reach the 4090
  only with the kit sync, and the mix leaves a missing file out (Video
  Reviewer 1, review 38; Wall Game Director, 2026-10-28: a sound missing
  with no error could reach Nil unseen). It runs after the checks that
  need only the list and the flags, so those answer with no kit here.
*/
if (EDL) {
  const missing = edlSoundUses(EDL)
    .map(([where, key]) => [where, join(MEME_DIR, `${key}.mp3`)])
    .filter(([, file]) => !existsSync(file));
  if (missing.length > 0) {
    console.error(
      `--edl ${EDL_PATH} plays meme sounds whose files are not here (sync the render kit):\n  ${missing.map(([where, file]) => `${where}: ${file}`).join("\n  ")}`,
    );
    process.exit(2);
  }
}
for (const [flagName, field] of [
  ["seconds-per-move", "pace"],
  ["music", "music"],
  ["no-music", "music"],
  ["sounds", "vsSound and finishSound"],
]) {
  if (EDL && flag(flagName)) {
    console.error(`--${flagName} does not apply to an EDL; set its ${field}`);
    process.exit(2);
  }
}
/** What the daily look plays: the EDL's, or nothing in a current-only render. */
const CAPTION = EDL?.caption ?? "";
/** The caption's second beat (edl.mjs payoff), or null for one caption. */
const PAYOFF = EDL?.payoff ?? null;
/** Every caption the video shows, setup first; empty without a caption. */
const CAPTIONS = CAPTION ? [CAPTION, ...(PAYOFF ? [PAYOFF.text] : [])] : [];
/** The caption over the position after `boardIndex` plies. */
const captionAt = (boardIndex) =>
  PAYOFF && boardIndex > PAYOFF.ply ? PAYOFF.text : CAPTION;
const EVENTS = EDL?.events ?? [];
const eventsAt = (plyIndex) => EVENTS.filter((e) => e.ply === plyIndex);
/**
 * The EDL's opening clip (edl.mjs `opening`) as an overlay event: it opens
 * with the VS overlay, not on a move, and plays muted. Its ply is the first
 * the video plays, for the messages. Not in EVENTS: no move opens it.
 */
const OPENING = EDL?.opening
  ? {
      kind: "overlay",
      form: "cover",
      asset: EDL.opening,
      ply: EDL.startPly,
      // The whole clip: it closes on its own (null would never close it).
      seconds: OVERLAYS[EDL.opening].seconds,
      opening: true,
    }
  : null;
/**
 * --plies FROM..TO previews only those plies of an EDL, from the capture
 * cache, so the director can look at one moment in seconds. The board, the
 * captions and every effect are as in the full video; the opening (cold
 * open, VS) plays only when the window starts at the video's first ply, and
 * the ending only when it reaches the last. Its RESULT names the window and
 * carries no EDL hash, so the daily app cannot take it for the approved
 * render. Null for a full render.
 */
const PLY_WINDOW = (() => {
  if (!flag("plies")) return null;
  if (!EDL || !flag("from-cache")) {
    console.error(
      "--plies previews an EDL from the capture cache: give --edl and --from-cache",
    );
    process.exit(2);
  }
  const w = parsePlyWindow(cliArg("plies"), EDL.startPly);
  if (!w.ok) {
    console.error(w.error);
    process.exit(2);
  }
  return { from: w.from, to: w.to };
})();
/**
 * The first ply the video plays: the preview's FROM, else the EDL's
 * startPly (edl.mjs); 0 otherwise.
 */
const START_PLY = PLY_WINDOW?.from ?? EDL?.startPly ?? 0;
/** Whether this render plays the video's opening: the cold open and VS. */
const PLAYS_OPENING = START_PLY === (EDL?.startPly ?? 0);
/**
 * The events that play after their move lands, in list order. A freeze, an
 * explain and a lead zoom start before the move; the move loop places them. An overlay
 * takes no time of its own: it rides over the frames after its move lands.
 */
const landingEventsAt = (plyIndex) =>
  eventsAt(plyIndex).filter(
    (e) =>
      e.kind !== "freeze" &&
      e.kind !== "explain" &&
      e.kind !== "overlay" &&
      !(e.kind === "zoom" && e.lead),
  );
/** The ply's lead zoom (edl.mjs "lead": true), if it has one. */
const leadZoomAt = (plyIndex) =>
  eventsAt(plyIndex).find((e) => e.kind === "zoom" && e.lead);

/**
 * Which browser draws the frames. `chromium` is the one Playwright downloads
 * (`playwright install chromium`), which is all the 4090 render box has;
 * `chrome` is an installed Google Chrome.
 */
const BROWSER = arg("browser", "chromium");
/** `nvenc` encodes on the GPU (the 4090); `x264` on the CPU, anywhere. */
const ENCODER = arg("encoder", "x264");
if (!["chromium", "chrome"].includes(BROWSER)) {
  console.error(`--browser must be chromium or chrome, got ${BROWSER}`);
  process.exit(2);
}
if (!["x264", "nvenc"].includes(ENCODER)) {
  console.error(`--encoder must be x264 or nvenc, got ${ENCODER}`);
  process.exit(2);
}
/**
 * How many Chromium processes take the screenshots (shoot-workers.mjs). The
 * default fits the 4-thread cap of a daily render job (render-4090.mjs).
 */
const WORKERS = Number(arg("workers", "4"));
/**
 * --from-cache reads the game's capture from the capture cache
 * (capture-cache.mjs) and never opens its replay page, so the render adds no
 * view. A daily render without it writes the cache.
 */
const FROM_CACHE = flag("from-cache");
const CACHE_DIR = resolve(
  arg("cache", join(REPO, "tmp/game-video/capture-cache")),
);
/** How many games the cache keeps, newest first. */
const CACHE_KEEP = 30;
if (!/^[A-Za-z0-9_-]+$/.test(GAME_ID)) {
  console.error(`the game id ${GAME_ID} is not letters, digits, _ and -`);
  process.exit(2);
}
if (!Number.isInteger(WORKERS) || WORKERS < 1 || WORKERS > 16) {
  console.error(
    `--workers must be a whole number from 1 to 16, got ${arg("workers")}`,
  );
  process.exit(2);
}

/** A flag wins; otherwise each style keeps its own pace. */
const PACE_OVERRIDE = arg("seconds-per-move");
/**
 * How the frame is shaped.
 *
 *   fit    (default) the frame is whatever the content needs. No empty bands.
 *   square forced 1080x1080, which costs the board height - see below.
 *   9x16   the tall canvas with a reserved band at the bottom.
 *
 * 9:16 WAS THE ORIGINAL DEFAULT AND THE REASONING WAS SOUND FOR THE WRONG
 * AUDIENCE. It came from the growth plan's short-form video angle - TikTok and
 * Shorts, where the platform paints captions and buttons over the lower part of
 * every video, so a reserved band earns its place. Nil shares these on X,
 * YouTube, WhatsApp and Discord, where nothing is painted over the frame and a
 * 9:16 video is shown small and letterboxed in a timeline. There the band buys
 * nothing and costs the board its share of the frame. It survives as a flag
 * because the original argument still holds wherever it applies.
 */
const ASPECT = arg("aspect", "fit");
/** Output frame rate. */
const FPS = 30;
/** The soundtrack is always on. Capture shake follows the recorded result. */
const AUDIO = true;
/**
 * A preview's work dir and video have their own name, so it never wipes or
 * overwrites a full render's.
 */
const STEM = PLY_WINDOW ? `${GAME_ID}-preview` : GAME_ID;
/** Absolute, so browser file URLs and ffmpeg inputs resolve the same files. */
const WORK = resolve(arg("work", `tmp/game-video/${STEM}-frames`));

/**
 * The board theme the capture browser uses.
 *
 * THIS MATTERS MORE THAN IT LOOKS. The render browser is logged out, and for a
 * logged-out visitor the theme comes from localStorage and falls back to
 * "default" - so every video before 2026-08-19 shipped the DEFAULT theme while
 * Nil was comparing them against the Crisp theme he actually plays on. The
 * default's blended junctions are the exact muddiness Crisp was written to
 * replace, which is why the pillars looked like neither style to him.
 *
 * The value is JSON-encoded because the app's writeStored does the same
 * (frontend/src/hooks/use-local-storage.ts), and it is set BEFORE the game
 * page loads, so the very first paint is already the right theme.
 */
const BOARD_THEME = arg("board-theme", "crisp");

/** See the note above the board capture: fixed on purpose, to load the page once. */
const CAPTURE_DPR = 3;

/**
 * Music under the game.
 *
 * ON by default, with a RANDOM track, because that is what the product does:
 * frontend/src/lib/music.ts starts its playlist at a random index every game.
 * `--music <name>` pins one - which is what made the four-way comparison
 * possible - and `--no-music` turns it off. An EDL names its music as cues
 * (edl.mjs `music`): the track it opens with, and up to two changes at later
 * plies, with at most two different tracks. `--music` gives one cue, and wins over the EDL's.
 *
 * RIGHTS: music inside our own web app and music inside a video posted to
 * someone else's platform are different uses. A video plays only a track
 * whose license lets it (mayPlay, music-tracks.mjs; the sources are in
 * MUSIC-LICENSES.md): the random pick is among those, and a named track that
 * may not play stops the render. A file given by path has no license record;
 * it is for hand renders, which an EDL cannot ask for.
 */
const SONG_DIR = join(REPO, "frontend/public/audio/songs");

/** A track by file, slug or path; `where` names who asked, for the error. */
const trackFor = (asked, where) => {
  const hit = MUSIC_TRACKS.find(
    (t) => t.file === asked || t.file === `${asked}.mp3` || t.slug === asked,
  );
  if (hit && !mayPlay(hit)) {
    console.error(
      `${where} ${asked} may not play in a video (license ${hit.license}; see scripts/game-video/MUSIC-LICENSES.md)`,
    );
    process.exit(2);
  }
  if (hit) return hit;
  // Any path is allowed too, for a track that is not in the playlist.
  if (existsSync(resolve(asked))) {
    return {
      file: resolve(asked),
      title: asked,
      slug: "custom",
    };
  }
  console.error(
    `${where} ${asked} not found. Known: ${MUSIC_TRACKS.map((t) => `${t.file} (${t.slug})`).join(", ")}`,
  );
  process.exit(2);
};

/**
 * The music cues, in ply order: [{ fromPly, track, file }], or null with
 * --no-music. The first cue's fromPly is the video's startPly.
 */
const MUSIC_CUES = (() => {
  // An EDL's "music": [] is no music, as --no-music is (edl.mjs).
  if (flag("no-music") || EDL?.music?.length === 0) return null;
  const opening = EDL?.startPly ?? 0;
  const asked = cliArg("music");
  const cues = asked
    ? [{ fromPly: opening, track: trackFor(asked, "--music") }]
    : EDL?.music
      ? EDL.music.map((c) => ({
          fromPly: c.fromPly,
          track: trackFor(c.track, "the EDL's music track"),
        }))
      : (() => {
          const playable = MUSIC_TRACKS.filter(mayPlay);
          return [
            {
              fromPly: opening,
              track: playable[Math.floor(Math.random() * playable.length)],
            },
          ];
        })();
  return cues.map((c) => ({
    ...c,
    file: existsSync(c.track.file)
      ? c.track.file
      : join(SONG_DIR, c.track.file),
  }));
})();
/**
 * The cues this render plays: a --plies preview opens on the cue in force at
 * its first ply and drops the cues it never reaches. Set once the game's
 * length is known (playedCues, below).
 */
const playedCues = (startPly, lastPlyIndex) => {
  if (!MUSIC_CUES) return [];
  const opening = MUSIC_CUES.findLast((c) => c.fromPly <= startPly);
  return [
    { ...opening, fromPly: startPly },
    ...MUSIC_CUES.filter(
      (c) => c.fromPly > startPly && c.fromPly <= lastPlyIndex,
    ),
  ];
};

/* ------------------------------------------------------------- the mix -- */

/**
 * The three levels Nil corrects by ear, as flags with measured defaults.
 *
 * Measured in the 2026-08-19 render, taking the pawn click he is happy with as
 * the reference at -29.4 dB mean: the music bed sat 10.4 dB UNDER it, the
 * capture 10.3 dB OVER and the win sting 15.3 dB OVER. That is exactly the
 * three complaints, in the order of severity he gave them.
 *
 * The defaults below move each one to a deliberate offset from that click:
 *   music   0.3 -> 0.9   from 10 dB under the move click to about 7 under
 *   capture 1.0 -> 0.6   a clear accent above a routine move, not a peak
 *   win     1.0 -> 0.2   see measure-mix.mjs: the win is a 2.6s sustained
 *                        sound, so PEAK understates how loud it is heard.
 *                        Set by loudness, not by peak.
 *
 * THREE THINGS EARLIER ATTEMPTS AT THESE GOT WRONG, all caught by measuring
 * the result rather than predicting it. Cutting the stings made everything
 * ELSE louder, because the limiter had been riding on them and stopped pulling
 * the mix down - so the reference click moved too and the offsets are not
 * simple arithmetic. Comparing a 0.95s hit against a 2.6s sound over unequal
 * windows made the win look quieter than the capture when it was not; impact
 * is a PEAK comparison over matched windows. And the first big cut left both
 * stings at or below a routine move click, which cannot be right for the two
 * moments the whole video is built around.
 *
 * They are flags because this is a judgement made by ear and these numbers are
 * a starting point, not an answer. Expect to move them.
 */
/**
 * The output path: the game, and nothing else.
 *
 * The track briefly appeared here so four comparison renders could be told
 * apart. All four were accepted and the pick is random, so nothing downstream
 * needs to know which one a file got. The chosen track is logged to the
 * console instead, where the person who ran the command sees it and no viewer
 * ever does - and it is enough to reproduce the same render with --music.
 */
const OUT = resolve(arg("out", `tmp/game-video/${STEM}.mp4`));
/**
 * One style writes OUT itself. Several styles write one file each next to it,
 * named for the style, so a comparison never overwrites its own outputs.
 */
const outFor = (styleName) =>
  STYLE_NAMES.length === 1
    ? OUT
    : OUT.replace(/(\.mp4)?$/, `-${styleName.replace(":", "-")}.mp4`);

const MUSIC_VOLUME = 0.3;
/**
 * One step further down for the two stings Nil named as too loud on
 * 2026-10-26 (the scared sound and the opening shotgun), on top of the meme
 * target in meme-sounds.mjs: -3 dB, applied to the scared events and the VS
 * overlay's sound.
 */
const STING_STEP = 10 ** (-3 / 20);
const SHAKE_GAIN = 0.6;
const WIN_GAIN = 0.2;
/**
 * Multiplies the site's own pawn and wall levels, keeping their balance.
 * It was 1.6; Nil, 2026-10-26: "the piece slide sound is a bit too loud,
 * gets a bit repetitive". -8 dB from there, measured on eeFSMEmL's clicks
 * and music rebuilt apart: per window the clicks sit 5 to 13 dB under the
 * music bed at normal pace, and each click's loudest 50 ms about level with
 * it (median +2 to +6 dB, -6 dB where the bed is loudest).
 */
const MOVE_GAIN = 1.6 * 10 ** (-8 / 20);
/**
 * Four takes of a move's click, by ply, so no two moves in a row sound the
 * same: a small pitch step (rate, resampled) and gain step on the site's
 * one sample.
 */
const MOVE_CLICK_VARIANTS = [
  { rate: 1, gain: 1 },
  { rate: 1.06, gain: 0.89 },
  { rate: 0.95, gain: 0.94 },
  { rate: 1.03, gain: 0.84 },
];
/**
 * The clicks of a fastForward range (edl.mjs) come 3 to 5 a second, so they
 * are one step quieter, -6 dB (Wall Game PM, 2026-10-26).
 */
const FAST_FORWARD_CLICK_STEP = 10 ** (-6 / 20);
/**
 * A walk's tick a step (cueWalkTicks): the pawn click a fifth up, as loud
 * as a pawn click, about 6 dB under the VS hit (Wall Game Director,
 * 2026-10-29: 14 dB quieter, the ticks were near-silence on a phone).
 */
const TICK_RATE = 1.5;
/** The settle click in the last opening walk's hold: 9 dB under a wall. */
const SETTLE_STEP = 10 ** (-9 / 20);

/** Seconds the music takes to arrive, and to leave before the end card. */
const MUSIC_FADE_IN = 1.6;
const MUSIC_FADE_OUT = 2.0;
/**
 * A music cue's change of track: the old one leaves over CUE_FADE_OUT from
 * the cue's ply beat, and the new one arrives over CUE_FADE_IN, short, so the
 * change lands on its moment.
 */
const CUE_FADE_OUT = 1.0;
const CUE_FADE_IN = 0.25;

if (
  PACE_OVERRIDE !== undefined &&
  !(Number.isFinite(Number(PACE_OVERRIDE)) && Number(PACE_OVERRIDE) > 0)
) {
  console.error(
    `--seconds-per-move must be a positive number, got ${arg("seconds-per-move")}`,
  );
  process.exit(2);
}
if (!["fit", "square", "9x16"].includes(ASPECT)) {
  console.error(`--aspect must be "fit", "square" or "9x16", got ${ASPECT}`);
  process.exit(2);
}

/**
 * How long the non-move beats run, in seconds.
 *
 * These are deliberately NOT tied to --seconds-per-move. The pace argument is
 * about how fast the game reads; these three are about how long a human needs
 * to take in a name, register a result and read a URL, which does not change
 * when the game is played back faster.
 */
const FINAL_HOLD_SECONDS = 1.8;
const END_SECONDS = 3.0;
/** How long the shake runs after the winning move, in seconds. */
const SHAKE_SECONDS = 0.6;

/**
 * The daily effects, in seconds. A punch-in goes in over ZOOM_IN, holds for
 * the EDL's holdSeconds and lets go over ZOOM_OUT; its scale comes from the
 * EDL too (edl.mjs). After the effects of a ply, the plain position rests for
 * EFFECT_REST_SECONDS before the next move.
 */
const SCARED_SECONDS = 1.2;
const LAUGH_SECONDS = 1.3;
const STAMP_SECONDS = 1.0;
/**
 * A stamp lands this long after its move, so the move is seen first (audit
 * item 4); its event lasts STAMP_LAND_AT + stampSeconds: STAMP_SECONDS, or
 * longer when its word needs more to be read fully shown. A trap's word
 * the same, from TRAP_STAMP_AT.
 */
const STAMP_LAND_AT = 0.3;
/**
 * A stamp or trap word is at most this share of the board's width; a longer
 * word shrinks to it (an EDL allows 12 letters, which measure wider than
 * the board at the stamp's size).
 */
const STAMP_MAX_WIDTH = 0.9;
const EFFECT_REST_SECONDS = 0.3;
const ZOOM_IN = 0.12;
const ZOOM_OUT = 0.25;
/**
 * The moment effects (edl.mjs: blunder, brilliant, react, trap, freeze,
 * race), in seconds. The trap's word lands TRAP_STAMP_AT into it; the
 * blunder shakes over its first BLUNDER_SHAKE_SECONDS and flashes over its
 * first BLUNDER_FLASH_SECONDS; a freeze pushes in over FREEZE_PUSH to
 * FREEZE_SCALE before its hold; a race number that changes pops over
 * RACE_TICK_SECONDS, added to the move.
 */
const BLUNDER_SECONDS = 1.2;
const BLUNDER_SHAKE_SECONDS = 0.5;
const BLUNDER_FLASH_SECONDS = 0.3;
const BRILLIANT_SECONDS = 1.3;
const REACT_SECONDS = 1.2;
/** How long each mark on a cell plays (paintCellFx), by its kind. */
const FX_SECONDS = {
  blunder: BLUNDER_SECONDS,
  brilliant: BRILLIANT_SECONDS,
  react: REACT_SECONDS,
};
const TRAP_SECONDS = 1.6;
/**
 * A path event (edl.mjs "path"): each walk draws itself from the hunter in
 * drawSeconds, PATH_STEP_SECONDS a step (at least PATH_DRAW_MIN_SECONDS,
 * at most PATH_DRAW_MAX_SECONDS), with a tick a step, so the steps can be
 * counted by ear (Wall Game Director, 2026-10-29); with `compare` the walk
 * before the move then holds for PATH_BEFORE_SECONDS and fades as the walk
 * after it draws; the last walk holds for the event's holdSeconds and
 * fades in PATH_FADE_SECONDS.
 */
const PATH_STEP_SECONDS = 0.06;
const PATH_DRAW_MIN_SECONDS = 0.45;
const PATH_DRAW_MAX_SECONDS = 0.9;
const PATH_BEFORE_SECONDS = 0.45;
const PATH_FADE_SECONDS = 0.3;
/** How long a walk (its cells, the hunter's first) takes to draw. */
const drawSeconds = (points) =>
  Math.min(
    PATH_DRAW_MAX_SECONDS,
    Math.max(PATH_DRAW_MIN_SECONDS, (points.length - 1) * PATH_STEP_SECONDS),
  );
/**
 * An explain (edl.mjs "explain"), in seconds: the old walk draws
 * (drawSeconds) and rests EXPLAIN_BEFORE_REST_SECONDS before the move; the
 * move lands and its walls and pawns glow for EXPLAIN_LAND_SECONDS; the new
 * walk draws over the old one, a ghost at EXPLAIN_GHOST alpha, and holds
 * EXPLAIN_AFTER_HOLD_SECONDS, the last PATH_FADE_SECONDS of it a fade.
 * A change of steps under EXPLAIN_MIN_CHANGE has little to show
 * (explain-flat).
 */
const EXPLAIN_BEFORE_REST_SECONDS = 0.7;
const EXPLAIN_LAND_SECONDS = 0.8;
const EXPLAIN_AFTER_HOLD_SECONDS = 1.2;
const EXPLAIN_GHOST = 0.35;
const EXPLAIN_MIN_CHANGE = 2;
/**
 * A callback explain (edl.mjs "explain" with `callback`), in seconds: the
 * move lands and the counter ticks (CALLBACK_LAND_SECONDS); the old wall
 * fades out (CALLBACK_FADE_SECONDS); the walk without it draws and rests
 * EXPLAIN_BEFORE_REST_SECONDS, or, a walk of 1 step drawing no line, the
 * board without the wall holds CALLBACK_GONE_SECONDS; the wall fades back
 * in, glowing; the real walk draws and holds as an explain's new walk.
 */
/**
 * A plant (edl.mjs "plant"): its wall glows as the move lands, and the
 * glow fades over the last PLANT_FADE_SECONDS.
 */
const PLANT_SECONDS = 0.8;
const PLANT_FADE_SECONDS = 0.25;
const CALLBACK_LAND_SECONDS = 0.6;
/**
 * The evaluation strip (edl.mjs evalStrip), under the players' names: it
 * moves to a move's value over
 * EVAL_MOVE_SECONDS from its landing (Wall Game Director, 2026-10-31: a
 * swing reads as motion), and a marked move's swing flashes for
 * EVAL_FLASH_SECONDS.
 */
const EVAL_MOVE_SECONDS = 0.3;
const EVAL_FLASH_SECONDS = 0.6;
const CALLBACK_FADE_SECONDS = 0.3;
const CALLBACK_GONE_SECONDS = 1.0;
/**
 * The opening walks (edl.mjs introPaths): each draws as a path event's
 * walk does and shows its steps INTRO_PATH_HOLD_SECONDS. The hold was 0.6
 * s, too short to take the number in (Wall Game Director, 2026-10-29). The
 * last one fades over the end of its hold, not after it: with the fade
 * after it, 0.65 s of silence came before the first move (vets of
 * 2026-10-29). The settle click sounds SETTLE_AT seconds into that hold,
 * which leaves about 0.35 s of silence on each side of it (the Director's
 * target: no gap over 0.4 s from the VS hit to the first move).
 */
const INTRO_PATH_HOLD_SECONDS = 1;
const SETTLE_AT = 0.45;
/**
 * The next opening walk starts this long after the one before has drawn its
 * last step, while that one holds its number (Wall Game Director,
 * 2026-10-29: a 0.9 s silent hold between the walks).
 */
const INTRO_WALK_GAP_SECONDS = 0.5;
/**
 * An overlay (edl.mjs "overlay") fades out over its last
 * TEXT_TIMING.overlayFade (overlays.mjs); the capture loading bar shows
 * LOADING_ERROR_LINE after the save lands, for LOADING_ERROR_SECONDS: the
 * save's hit on the panel (stage.html ERROR_HIT_SECONDS), the line's
 * reading time and the fade, then it closes. It was 0.9 s, and its 3 words
 * need 2.1 s (vet of v-2026-10-31-16: shown fully for 0.7 s).
 */
const LOADING_ERROR_LINE = "ERROR: CAPTURE FAILED";
const LOADING_ERROR_HIT_SECONDS = 0.3;
const LOADING_ERROR_SECONDS =
  LOADING_ERROR_HIT_SECONDS +
  readingSeconds({}, LOADING_ERROR_LINE) +
  TEXT_TIMING.overlayFade;
const TRAP_STAMP_AT = 0.55;
const FREEZE_PUSH = 0.25;
const FREEZE_SCALE = 1.6;
/**
 * A lead zoom pushes in over LEAD_PUSH on the position before its move;
 * its still is LEAD_STILL_AT after the move lands, the pawn just landed.
 */
const LEAD_PUSH = 0.35;
const LEAD_STILL_AT = 0.2;
const RACE_TICK_SECONDS = 0.3;
const RACE_FLASH_SECONDS = 0.8;
/**
 * The capture picture (Wall Game Director, 2026-10-29, "B+A"): on the last
 * board of a CAUGHT game, the catcher on the caught pawn, both bigger than
 * the page's two small pawns, as boxes {x, y, w, h} in cells of the caught
 * pawn's cell. INSIDE stays in the cell, so it covers no wall: at the
 * capture the walls are the story. POUNCE leaves the cell, so it is used
 * only where it covers no wall, no other pawn and no edge. Both are drawn
 * for a catcher from the right; one from the left mirrors them. The catcher
 * lands over CAPTURE_POUNCE_SECONDS as the move lands, with its click: it
 * grows from its feet to its box, so it never covers more than the box.
 */
const CAPTURE_INSIDE = {
  mouse: { x: 0, y: 0.38, w: 0.62, h: 0.62 },
  cat: { x: 0.2, y: 0, w: 0.8, h: 0.8 },
};
const CAPTURE_POUNCE = {
  mouse: { x: 0, y: 0.1, w: 0.9, h: 0.9 },
  cat: { x: 0.2, y: -0.25, w: 1.15, h: 1.15 },
};
const CAPTURE_POUNCE_SECONDS = 0.15;
/**
 * The cold open (edl.mjs coldOpenPly): the key position for COLD_OPEN_SECONDS,
 * the camera pushing in to COLD_OPEN_SCALE at most. The loop tail: the last
 * LOOP_SECONDS fade from a white flash into the video's own first frame, so
 * a feed that loops the video cuts to the frame it just showed.
 */
const COLD_OPEN_SECONDS = 1.0;
const COLD_OPEN_SCALE = 1.35;
const LOOP_SECONDS = 0.5;
/**
 * The whole mix fades out over the video's last END_FADE_SECONDS, so a
 * sound the end cuts does not stop at full level (Wall Game Director,
 * 2026-10-29: VX's trombone stopped at -16 dBFS, then the loop's seam
 * jumped to the quiet whoosh). A finish sound cut by more than
 * FINISH_CUT_SECONDS is a lint warning (finish-cut).
 */
const END_FADE_SECONDS = 0.3;
const FINISH_CUT_SECONDS = 1;
/**
 * Two meme sounds (an event's, a clip's own, the VS or the finish sound)
 * whose loud parts start less than SOUNDS_APART_SECONDS apart are heard as
 * one noise: a lint warning (sounds-together). Wall Game Director,
 * 2026-10-31: on -8 v2 the lint let letsgo-1 on the ending bar start with
 * the finish sound, at 42.57 s. A sound's loud part starts at its first
 * sample within SOUND_BODY_DB of its own peak. A sound that starts under
 * the quiet end of another is not a fault: -9 v3's trombone-1 starts under
 * the end of airhorn-1, and the Director passed it (2026-10-31).
 */
const SOUNDS_APART_SECONDS = 0.5;
const SOUND_BODY_DB = -20;
/**
 * The music under the daily ending: it fades to this share of its level as
 * the ending starts and holds there to the end, instead of to silence
 * (audit item 6: every daily mix was below -40 dB for 1.5-1.8 s before its
 * end, which on a phone sounds like the video stopped).
 */
const MUSIC_BED = 0.35;
/**
 * The list's faults that a render finds before its shoot pass (R1, Wall
 * Game Director, 2026-10-29): no sound at all for more than SILENCE_SECONDS,
 * and a still board held STILL_BEFORE_ENDING_SECONDS or more right before
 * the ending (a still, silent board after the climax, 2026-10-29). A sound
 * is heard from its first to its last sample above SOUND_FLOOR_DB, at its
 * gain. Both only warn (edl.mjs LINT_KINDS). The silence rules
 * (SILENCE_SECONDS, OPENING_SILENCE_SECONDS) are mix-loudness.mjs's: this
 * check is a forecast before the mix, and the render's `silence` measure
 * of its final track is the one the vet judges. From the VS hit to the
 * first move the limit is OPENING_SILENCE_SECONDS (the T5b rule), only when
 * the VS overlay plays: a video without it (no VS in the style, or a --plies
 * window without the opening) has only the SILENCE_SECONDS rule, so a
 * silent cold open alone does not trip it (Video Reviewer 1, review 64).
 */
const STILL_BEFORE_ENDING_SECONDS = 0.5;
const SOUND_FLOOR_DB = -50;
/**
 * How far a shake may scale the composition: it must not, so this only
 * absorbs float noise in the matrix read. See the winning shake below.
 */
const SCALE_TOLERANCE = 0.001;
/** How long a wallz video holds its last position when nobody won. */
const DRAW_HOLD_SECONDS = 1.3;
/**
 * How deep, in cells, the ending's bar may touch the capture picture on the
 * ending's frames (endingTouch). Nothing else may touch anything.
 */
const ENDING_TOUCH_CELLS = 0.1;
/**
 * A stamp that slams in from less than this times its size looks flat: the
 * lint notes it (stamp-flat). placeStamp caps the slam so that it covers
 * nothing.
 */
const STAMP_FLAT_POP = 1.15;
/**
 * A race flash for a change under this many steps tells nothing new: the
 * lint warns (race-small; Wall Game Director, 2026-10-29: the guide says
 * to leave a change of 1 or 2 out, and a vet failed one).
 */
const RACE_MIN_CHANGE = 3;
/**
 * A stamp with less room than this to slam shrinks, down to
 * STAMP_MIN_SHRINK of its size, until it has it (Wall Game Director,
 * 2026-10-29).
 */
const STAMP_TARGET_POP = 1.5;
const STAMP_MIN_SHRINK = 0.85;
/** How many plies before and after a flat stamp the lint looks for a better one. */
const STAMP_NEARBY_PLIES = 3;

/* ------------------------------------------------------------- geometry -- */

/**
 * Sizes per aspect, in output pixels.
 *
 * VERTICAL IS THE DEFAULT because the audience for this is short-form video,
 * where 9:16 is the native shape. A square board in a 9:16 frame leaves a band
 * above and below, and those bands are not waste - they are exactly where the
 * two player plates go, which is also where the product itself puts them.
 *
 * The block is pushed up by a reserved band at the bottom rather than centred
 * in the whole frame, so the board clears the caption and buttons that TikTok
 * and Shorts paint over the bottom of every video.
 */
/**
 * The frame is 1080 wide and the board takes nearly all of it; everything else
 * about the shape is DERIVED, not chosen.
 *
 * The VS screen and the end card are sized as fractions of the frame height so
 * they scale with whatever shape the content produces, instead of being tuned
 * for one canvas and breaking on the next.
 */
const FRAME_WIDTH = 1080;
const FRAME_PAD = 20;
const GAP = 26;
const BRAND_GAP = 24;

const frameVars = (height, boardPx, chromePx) => ({
  "--board": `${boardPx}px`,
  "--gap": `${GAP}px`,
  "--avatar": `${Math.round(boardPx * 0.092)}px`,
  "--plate-pad": `${Math.round(boardPx * 0.021)}px ${Math.round(boardPx * 0.027)}px`,
  "--plate-name": `${Math.round(boardPx * 0.05)}px`,
  "--plate-tag": `${Math.round(boardPx * 0.024)}px`,
  "--chrome": `${chromePx}px`,
  "--brand-bottom": `${FRAME_PAD}px`,
  "--brand-size": `${Math.round(height * 0.019)}px`,
  "--beam-h": `${Math.round(height * 0.219)}px`,
  "--beam-top": `${Math.round(height * 0.218)}px`,
  "--beam-bottom": `${Math.round(height * 0.526)}px`,
  "--portrait": `${Math.round(height * 0.156)}px`,
  "--name-size": `${Math.round(height * 0.0437)}px`,
  "--sub-size": `${Math.round(height * 0.0156)}px`,
  "--vs-size": `${Math.round(height * 0.156)}px`,
  "--end-kicker": `${Math.round(height * 0.0208)}px`,
  "--end-avatar": `${Math.round(height * 0.156)}px`,
  "--end-name": `${Math.round(height * 0.05)}px`,
  "--end-how": `${Math.round(height * 0.0219)}px`,
  "--end-cta": `${Math.round(height * 0.0396)}px`,
  "--end-cta2": `${Math.round(height * 0.0177)}px`,
});

/* ---------------------------------------------------------------- ffmpeg -- */

/**
 * Find an ffmpeg. The box this was written on had none, so a scratch copy under
 * tmp/ is accepted as a fallback; the intended install is a real one on PATH.
 */
const findFfmpeg = () => {
  const override = arg("ffmpeg");
  if (override) return override;
  const scratch = join(
    REPO,
    "tmp/f89e649f-video/enc/node_modules/ffmpeg-static/ffmpeg",
  );
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return "ffmpeg";
  } catch {
    if (existsSync(scratch)) return scratch;
    console.error(
      "ffmpeg not found. Install it (apt install ffmpeg) or pass --ffmpeg <path>.",
    );
    process.exit(3);
  }
};
const FFMPEG = findFfmpeg();
const ff = (args) =>
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });

/* ------------------------------------------------------------ game facts -- */

const log = (...m) => console.log("[video]", ...m);

log(`game ${GAME_ID} from ${ORIGIN}`);
log(`board theme: ${BOARD_THEME}`);
log(
  MUSIC_CUES
    ? `music: ${MUSIC_CUES.map((c) => `${c.track.title} from ply ${c.fromPly} (${(20 * Math.log10(musicGain(c.track))).toFixed(1)} dB to one level)`).join(", then ")}${cliArg("music") || EDL?.music ? "" : " (picked at random)"}`
    : "music: off",
);
/* ------------------------------------------------------- capture, part 1 -- */

mkdirSync(WORK, { recursive: true });
for (const f of readdirSync(WORK))
  rmSync(join(WORK, f), { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });

const launchBrowser = () =>
  chromium.launch({
    ...(BROWSER === "chrome" ? { channel: "chrome" } : {}),
    args: ["--no-sandbox"],
  });
const browser = await launchBrowser();

/**
 * Load images into a page and wait until they are decoded, so a screenshot
 * never catches one still loading: the stage sets an image's src and does
 * not wait for it. Runs in the page; the images stay referenced there.
 */
const preloadImages = async (urls) => {
  const images = urls.map((url) => {
    const img = new Image();
    img.src = url;
    return img;
  });
  window.__preloaded = [...(window.__preloaded ?? []), ...images];
  await Promise.all(images.map((img) => img.decode()));
};

/**
 * The daily look's seat colours (dailySeatColors in edl.mjs), by each seat's
 * bot flag (configType). Only a daily (EDL) render forces colours; a hand
 * render keeps the players' own (Wall Game PM, 2026-10-26).
 */
const SEAT_COLORS = (body) => {
  /*
    A missing configType reads as "not a bot", which would show an AI game
    as human vs human with no error, so it stops the render like a missing
    pawnColor does (exit 4 in the daily path).
  */
  const bot = (id) => {
    const configType = body.matchStatus?.players?.find(
      (p) => p.playerId === id,
    )?.configType;
    if (typeof configType !== "string") {
      throw new Error(
        `the replay response has no configType for player ${id}; the site changed where the bot flag comes from`,
      );
    }
    return configType === "bot";
  };
  try {
    return dailySeatColors({ 1: bot(1), 2: bot(2) });
  } catch (err) {
    throw new Error(`game ${GAME_ID}: ${err.message}`);
  }
};
/** What a forced colour must sample as on the page, to prove the page used it. */
const COLOR_CHECK = {
  red: ([r, g, b]) => r > g + 40 && r > b + 40,
  blue: ([r, g, b]) => b > r + 40 && b > g + 40,
};

/**
 * Installs window.__boardGrid(cells) in the replay page: the board grid, the
 * one element with exactly `cells` .aspect-square children (board.tsx draws
 * each cell as one; a cell can hold smaller ones, never a whole board), or
 * null. Not found through an arrow overlay inside it: the page draws no
 * arrow after a walls-only move, so the walls, the board box and the cell
 * map went missing there (2026-10-26).
 */
const installBoardGrid = () => {
  window.__boardGrid = (cells) => {
    const parents = new Set(
      [...document.querySelectorAll(".aspect-square")].map(
        (el) => el.parentElement,
      ),
    );
    const grids = [...parents].filter(
      (p) =>
        p && p.querySelectorAll(":scope > .aspect-square").length === cells,
    );
    return grids.length === 1 ? grids[0] : null;
  };
};

/**
 * A viewport big enough that the board renders large in CSS pixels, times a
 * device scale factor, so the clipped board comfortably exceeds the 1010px it
 * is drawn at. Capturing smaller and scaling up is what makes a board video
 * look soft.
 */
/**
 * Open the replay page with the theme already set.
 *
 * The origin is loaded first purely so localStorage can be written for it; the
 * game page is then loaded fresh and reads the theme on its first paint. Doing
 * it the other way round captures one theme and switches mid-video.
 */
const openGamePage = async (dpr) => {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1250 },
    deviceScaleFactor: dpr,
  });
  await page.addInitScript(installBoardGrid);
  await page.emulateMedia({ reducedMotion: "reduce" });

  /*
    Read the page's OWN replay request rather than making a second one. That
    endpoint increments the game's view count on every call, so an extra fetch
    is an extra write to production analytics for no new information.
  */
  const replayUrl = new RegExp(`/api/games/${GAME_ID}(\\?|$)`);
  let replay = null;
  /*
    RED VS BLUE IN THE DAILY LOOK (Nil, 2026-10-26: the players' own
    colours were too alike; a hand render keeps them). The replay page has
    no viewer colour setting - it colours each seat from the pawnColor in the
    game record - so in a daily render the capture browser sets that field in
    the page's own response, before the page reads it: one seat red and the
    other blue (SEAT_COLORS). The page then colours pawns, walls and cards through
    its own resolver; no pixel is recoloured. Every render passes the
    response through here to count it: each request is one view.
  */
  let colorError = null;
  let replayRequests = 0;
  await page.route(replayUrl, async (route) => {
    replayRequests += 1;
    const res = await route.fetch();
    let body;
    try {
      body = await res.json();
    } catch {
      // A non-JSON body here is a server error; the null check below reports it.
      await route.fulfill({ response: res });
      return;
    }
    replay ??= structuredClone(body);
    if (!EDL) {
      await route.fulfill({ response: res, json: body });
      return;
    }
    try {
      const colors = SEAT_COLORS(body);
      for (const p of body.matchStatus?.players ?? []) {
        /*
          Only this one field is touched, and only when it is where the page
          reads it: if a site change moved it, the render stops here rather
          than ship the players' own colours in a red vs blue video.
        */
        if (typeof p.appearance?.pawnColor !== "string") {
          throw new Error(
            `the replay response has no appearance.pawnColor for player ${p.playerId}; the site changed where seat colours come from`,
          );
        }
        p.appearance.pawnColor = colors[p.playerId];
      }
    } catch (err) {
      colorError = err;
    }
    await route.fulfill({ response: res, json: body });
  });

  await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.evaluate((theme) => {
    localStorage.setItem("wall-game-board-theme", JSON.stringify(theme));
  }, BOARD_THEME);
  await page.goto(`${ORIGIN}/game/${GAME_ID}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForTimeout(2500);

  const stored = await page.evaluate(() =>
    localStorage.getItem("wall-game-board-theme"),
  );
  if (stored !== JSON.stringify(BOARD_THEME)) {
    log(`WARNING: board theme did not stick - localStorage holds ${stored}`);
  }
  if (colorError) {
    console.error(String(colorError.message));
    await browser.close();
    process.exit(4);
  }
  if (!replay || replay.kind !== "replay") {
    console.error(
      `no replay data for ${GAME_ID}. The page answered ` +
        `${replay ? `kind "${replay.kind}"` : "nothing"} - check the id exists and the game is finished.`,
    );
    await browser.close();
    process.exit(4);
  }
  /*
    Each request to the replay endpoint adds a view, and the page could fetch
    again (a refetch on focus or remount), so the count is measured.
  */
  log(
    `replay requests: ${replayRequests} (each one adds a view to this game's count)`,
  );
  if (replayRequests !== 1) {
    log(`WARNING: expected one replay request, saw ${replayRequests}`);
  }
  return { page, replay, replayRequests: () => replayRequests };
};

/**
 * The replay data comes from the page's OWN request, intercepted.
 *
 * Fetching it separately would be a second `views + 1` for the same render.
 * The page has to load anyway, and it asks for exactly this JSON, so the
 * renderer reads that response instead of asking again. See openGamePage.
 */
/**
 * What changes the captured pixels. A cache serves a render only with the
 * same inputs (capture-cache.mjs).
 */
const CAPTURE_INPUTS = {
  gameId: GAME_ID,
  seatColors: Boolean(EDL),
  greyStartWalls: STYLE_NAMES.includes("daily"),
  boardTheme: BOARD_THEME,
  browser: BROWSER,
  captureDpr: CAPTURE_DPR,
  // The site's yellow glow on the last placed wall is off at capture: a
  // plain new wall has no mark, and a trap's or an explain's walls take the
  // stage's own look (paintTrap; Nil, 2026-10-30, C27: "B is the best look.
  // all others have weird gaps").
  siteWallGlow: false,
};
const GAME_CACHE = join(CACHE_DIR, GAME_ID);
/** The cached capture with --from-cache; null when the page is captured live. */
let cached = null;
if (FROM_CACHE) {
  try {
    cached = readCaptureCache(GAME_CACHE, CAPTURE_INPUTS);
  } catch (err) {
    console.error(String(err.message));
    await browser.close();
    process.exit(4);
  }
  log(
    `capture from the cache (taken ${cached.capturedAt}): the replay page is not opened, so no view`,
  );
}
const {
  page: gamePage,
  replay,
  replayRequests,
} = cached
  ? { page: null, replay: cached.replay, replayRequests: () => 0 }
  : await openGamePage(CAPTURE_DPR);
let game = gamePage;

const history = replay.state?.history ?? [];
if (history.length === 0) {
  console.error(`game ${GAME_ID} has no moves to show`);
  await browser.close();
  process.exit(4);
}
if (PLY_WINDOW && PLY_WINDOW.to >= history.length) {
  console.error(
    `--plies ends at ply ${PLY_WINDOW.to}, after the last ply ${history.length - 1}`,
  );
  await browser.close();
  process.exit(2);
}
/** The board's cells: the replay page draws one .aspect-square for each. */
const CELL_COUNT =
  replay.state.config.boardWidth * replay.state.config.boardHeight;
/** The board after the last ply this render plays: the game's end, or TO's. */
const LAST_BOARD = PLY_WINDOW ? PLY_WINDOW.to + 1 : history.length;

const apiPlayers = replay.matchStatus.players;
const nameOf = (playerId) =>
  apiPlayers.find((p) => p.playerId === playerId)?.displayName ??
  `Player ${playerId}`;

/**
 * The outcome, taken from the recorded result rather than matched by name.
 *
 * `state.result.winner` is a PlayerId. An earlier version looked the winner up
 * by DISPLAY NAME and preferred player 1 on a tie, so two seats sharing a name
 * - two guests can be assigned the same animal - would have credited the wrong
 * player. An id cannot collide.
 */
const outcome = (() => {
  const r = replay.state?.result;
  if (!r || r.winner == null) return null;
  return { winnerId: r.winner, reason: r.reason };
})();
/**
 * The word an ending stamps, from the game record (Nil, 2026-10-26: a
 * Classic game ended under "CAUGHT", and in Classic nobody is caught).
 *
 * The final position says what the winning move did: in Classic a cat that
 * stands on its own home reached it, "HOME"; in every other variant two
 * pawns of different players on one cell are a catch, "CAUGHT". A game won
 * any other way (time, resignation, survival) stamps no word.
 */
const FINISH_WORD = (() => {
  if (outcome?.reason !== "capture") return null;
  const live = replay.state.pawns;
  const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  if (live?.kind === "classic") {
    const w = live.pawns[outcome.winnerId];
    return same(w?.cat, w?.home) ? "HOME" : null;
  }
  const cells =
    live?.kind === "survival"
      ? [
          { player: "cat", cell: live.cat },
          { player: "mouse", cell: live.mouse },
        ]
      : live?.pawns
        ? Object.entries(live.pawns).flatMap(([player, pawns]) =>
            Object.values(pawns).map((cell) => ({ player, cell })),
          )
        : [];
  const caught = cells.some((a) =>
    cells.some((b) => a.player !== b.player && same(a.cell, b.cell)),
  );
  return caught ? "CAUGHT" : null;
})();
/**
 * Whether the winner's own move made the catch: false when the loser's pawn
 * walked onto the winner's (a mouse into a cat). The last move names the
 * pawn it moved (standard notation "Me8"); the final position names the
 * winner's pawn that shares a cell with the loser's. True when either is
 * not known.
 */
const WINNER_MOVED_LAST = (() => {
  const live = replay.state.pawns;
  const letter = String(history.at(-1)?.notation ?? "")
    .split(".")
    .find((t) => /^[A-Z]/.test(t))?.[0];
  const moved = { C: "cat", M: "mouse", D: "dog", E: "elephant" }[letter];
  if (!moved || !live) return true;
  if (live.kind === "survival") return moved === "cat";
  const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  const mine = Object.entries(live.pawns?.[outcome?.winnerId] ?? {});
  const theirs = Object.entries(live.pawns ?? {})
    .filter(([player]) => Number(player) !== outcome?.winnerId)
    .flatMap(([, pawns]) => Object.values(pawns));
  const catcher = mine.find(([, cell]) => theirs.some((c) => same(c, cell)));
  return catcher ? catcher[0] === moved : true;
})();
const capturePlan = captureFeedbackPlan({
  isFinalPly: true,
  resultReason: outcome?.reason,
});
const CAPTURE_SHAKE = capturePlan.stageShakeCount === 1;

/** The ends a move makes, so the gg ending cracks out of its cell. */
const ENDS_BY_MOVE = ["capture", "goal"];
const REASON_WORDS = {
  capture: "by capture",
  resignation: "by resignation",
  timeout: "on time",
  goal: "by reaching the goal",
  forfeit: "by forfeit",
};

log(
  `${history.length} plies, ${nameOf(1)} vs ${nameOf(2)}` +
    (outcome ? `, winner ${nameOf(outcome.winnerId)} (${outcome.reason})` : ""),
);

/**
 * The two player cards, with the render recipe the app already resolved:
 * the ordered layer srcs and the css filter that colours the pawn. Read, never
 * recomputed - see the header.
 */
const cards = cached
  ? cached.cards
  : await game.evaluate((origin) => {
      const out = [];
      for (const img of document.querySelectorAll('img[src*="/pawns/"]')) {
        const stack = img.parentElement;
        if (!stack || !stack.className.includes("rounded-full")) continue;
        const card = stack.closest("div")?.parentElement?.parentElement;
        const rect = stack.getBoundingClientRect();
        out.push({
          y: Math.round(rect.y),
          cardText: (card?.textContent ?? "").trim(),
          layers: [...stack.querySelectorAll("img")].map((i) => ({
            src: new URL(i.getAttribute("src"), origin).href,
            filter: getComputedStyle(i).filter,
          })),
        });
      }
      return out.sort((a, b) => a.y - b.y);
    }, ORIGIN);

if (cards.length !== 2) {
  console.error(
    `expected 2 player cards on the replay page, found ${cards.length}`,
  );
  await browser.close();
  process.exit(5);
}

/**
 * Which card belongs to which player id.
 *
 * The card truncates a long name ("Guest Bi.."), so it cannot be compared
 * whole. Match on the visible prefix instead, and fall back to the page's own
 * ordering - the replay page draws player 1 at the bottom - if the prefix is
 * ambiguous.
 */
const attribute = () => {
  /*
    Prefer the PAWN ART, which is per-player data from the record rather than a
    guess about layout: the card renders that player's chosen skin, and the
    record says which skin each player chose. A name can be truncated and a
    page order can change; a skin filename matches or it does not.
  */
  const skinOf = (card) => {
    const svg = card.layers
      .map((l) => l.src)
      .find((u) => /\/pawns\/.+\.svg/.test(u));
    return svg ? svg.split("/").at(-1) : null;
  };
  const chosenSkins = (player) =>
    Object.entries(player.appearance ?? {})
      .filter(([k, v]) => k.endsWith("Skin") && v && v !== "default")
      .map(([, v]) => v);

  const bySkin = cards.map((card) => {
    const skin = skinOf(card);
    if (!skin) return null;
    const hits = apiPlayers.filter((p) => chosenSkins(p).includes(skin));
    return hits.length === 1 ? hits[0].playerId : null;
  });
  if (bySkin[0] && bySkin[1] && bySkin[0] !== bySkin[1]) {
    return { top: bySkin[0], bottom: bySkin[1] };
  }

  /*
    Then the visible name. The card truncates a long one ("Guest Bi.."), so it
    is compared as a prefix rather than whole.
  */
  const prefixOf = (text) =>
    (text.match(/^(.*?)(?:\.\.)?\d{3,4}/)?.[1] ?? "").trim();
  const byPrefix = cards.map((c) => {
    const prefix = prefixOf(c.cardText);
    const hits = apiPlayers.filter(
      (p) => prefix.length >= 3 && p.displayName.startsWith(prefix),
    );
    return hits.length === 1 ? hits[0].playerId : null;
  });
  if (byPrefix[0] && byPrefix[1] && byPrefix[0] !== byPrefix[1]) {
    return { top: byPrefix[0], bottom: byPrefix[1] };
  }

  /*
    Last resort: the page's own order, which today puts player 1 at the bottom.
    This is a fact about the current layout, not about the record, so it is
    said out loud rather than assumed silently.
  */
  log(
    "WARNING: could not identify the seats from pawn art or names; falling back to the page's current order (player 1 at the bottom). If the plates look swapped, this is why.",
  );
  return { top: 2, bottom: 1 };
};

const seats = attribute();
log(`seats: top = ${nameOf(seats.top)}, bottom = ${nameOf(seats.bottom)}`);

const cardFor = (playerId) => cards[seats.top === playerId ? 0 : 1];

/* ------------------------------------------------- portraits, at full size */

/**
 * Re-compose each card's layer stack at portrait size.
 *
 * The backings and foreground fixes are 300px PNGs and the pawn itself is an
 * SVG, so 300px is native resolution rather than an upscale.
 */
const PORTRAIT_PX = 300;
const portraits = {};
const accents = {};

/**
 * Inline a layer as a data url.
 *
 * The bytes still come from the origin - this is the same read the browser
 * would do - but inlining keeps the canvas untainted, so the colour below can
 * be sampled from the pixels the product paints.
 */
const inlineLayer = async (src) => {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`could not read ${src}: HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "application/octet-stream";
  const body = Buffer.from(await res.arrayBuffer()).toString("base64");
  return `data:${type};base64,${body}`;
};

/**
 * Compose a pawn's layer stack ({src, filter}, as the page drew it) into a
 * PORTRAIT_PX PNG at `file`, on `page` (PORTRAIT_PX square). The seat cards,
 * a reactor's prey (REACTOR_ART) and the capture picture's pawns are
 * composed the same way.
 */
const composeLayers = async (page, layers, file) => {
  const inlined = await Promise.all(
    layers.map(async (l) => ({ ...l, data: await inlineLayer(l.src) })),
  );
  await page.setContent(
    `<html><body style="margin:0;width:${PORTRAIT_PX}px;height:${PORTRAIT_PX}px;background:transparent">
       <div style="position:relative;width:100%;height:100%">
         ${inlined
           .map(
             (l) =>
               `<img src="${l.data}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;filter:${l.filter}">`,
           )
           .join("")}
       </div></body></html>`,
    { waitUntil: "networkidle" },
  );
  await page.screenshot({ path: file, omitBackground: true });
};
const portraitPageOptions = {
  viewport: { width: PORTRAIT_PX, height: PORTRAIT_PX },
  deviceScaleFactor: 2,
};

if (cached) {
  Object.assign(portraits, cached.portraits);
  Object.assign(accents, cached.accents);
} else {
  const portraitPage = await browser.newPage(portraitPageOptions);
  for (const playerId of [1, 2]) {
    const file = join(WORK, `portrait-p${playerId}.png`);
    await composeLayers(portraitPage, cardFor(playerId).layers, file);
    portraits[playerId] = file;

    /**
     * The player's colour, sampled from the pawn the product just painted.
     *
     * There is no hex to read on this page: the desktop card carries the colour
     * only as a css filter on the pawn image, and the hex map is used by the
     * compact card alone. Rather than keep a second copy of the colour table
     * here, or mount a mobile breakpoint to go fishing for it, the colour is
     * taken from the pixels - which is the colour a viewer actually sees, and
     * stays correct if the palette or the filters ever change.
     */
    accents[playerId] = await portraitPage.evaluate(async (size) => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const imgs = [...document.querySelectorAll("img")];
      await Promise.all(
        imgs.map((i) =>
          i.complete ? null : new Promise((r) => (i.onload = r)),
        ),
      );
      for (const img of imgs) {
        ctx.filter =
          img.style.filter && img.style.filter !== "none"
            ? img.style.filter
            : "none";
        ctx.drawImage(img, 0, 0, size, size);
      }
      const { data } = ctx.getImageData(0, 0, size, size);
      // Bucket the strongly coloured pixels by hue; the biggest bucket wins.
      const buckets = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a < 200) continue;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max < 60 || (max - min) / max < 0.35) continue; // grey, white or black
        let hue = 0;
        if (max === r) hue = ((g - b) / (max - min)) * 60;
        else if (max === g) hue = ((b - r) / (max - min)) * 60 + 120;
        else hue = ((r - g) / (max - min)) * 60 + 240;
        const key = Math.round(((hue + 360) % 360) / 15);
        const acc = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        acc.n += 1;
        acc.r += r;
        acc.g += g;
        acc.b += b;
        buckets.set(key, acc);
      }
      if (buckets.size === 0) return null;
      const best = [...buckets.values()].sort((x, y) => y.n - x.n)[0];
      return [
        Math.round(best.r / best.n),
        Math.round(best.g / best.n),
        Math.round(best.b / best.n),
      ];
    }, PORTRAIT_PX);

    if (!accents[playerId]) {
      log(
        `could not sample a colour for ${nameOf(playerId)}; falling back to neutral`,
      );
      accents[playerId] = [148, 163, 184];
    }
  }
  await portraitPage.close();
}
log(
  `portraits captured; colours ${[1, 2]
    .map((id) => `${nameOf(id)}=rgb(${accents[id].join(",")})`)
    .join(", ")}`,
);

/**
 * Guard against the failure this replaced: an accent probe that returned the
 * SAME neutral for both players and reported nothing wrong. Two players whose
 * sampled colours are indistinguishable means the sampler is broken, not that
 * the game was played in one colour - the product does not allow that.
 */
{
  const [a, b] = [accents[1], accents[2]];
  const distance =
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  if (distance < 40) {
    log(
      `WARNING: the two players sampled to near-identical colours (distance ${distance}). The VS screen will read as one colour; check the portrait art.`,
    );
  }
}

/*
  The page must have used the forced colours (SEAT_COLORS): each portrait is
  coloured by the page's own resolver, so its sampled accent shows whether it
  did. A site that ignored or renamed the colour would otherwise give a video
  whose "AI" word is red over pawns of another colour.
*/
for (const [playerId, color] of Object.entries(
  EDL ? SEAT_COLORS(replay) : {},
)) {
  if (!COLOR_CHECK[color](accents[playerId])) {
    throw new Error(
      `${nameOf(Number(playerId))} should show ${color} but sampled rgb(${accents[playerId].join(",")}); the page did not use the forced seat colour`,
    );
  }
}

/* ---------------------------------------------------- capture, the board -- */

/**
 * Work out the frame from the content, instead of choosing a canvas and
 * letting the composition float in it.
 *
 * The plate height is not ours to predict - it follows the avatar, the font
 * and the padding - so it is MEASURED in the real stage rather than guessed at
 * with a pixel budget, which is the trap CLAUDE.md rule 1 describes. Everything
 * else follows from it.
 */
const resolveFrame = async () => {
  const probe = await browser.newPage({
    viewport: { width: FRAME_WIDTH, height: 2400 },
    deviceScaleFactor: 1,
  });
  await probe.goto(`file://${join(HERE, "stage.html")}`, { waitUntil: "load" });
  const trialBoard = FRAME_WIDTH - FRAME_PAD * 2;
  await probe.evaluate(
    (vars) => {
      for (const [k, v] of Object.entries(vars)) {
        document.documentElement.style.setProperty(k, v);
      }
    },
    frameVars(1920, trialBoard, 0),
  );
  const furniture = await probe.evaluate(() => {
    document.getElementById("play").classList.remove("hidden");
    document.getElementById("brand").classList.remove("hidden");
    for (const id of ["pNameT", "pNameB"])
      document.getElementById(id).textContent = "Player Name";
    for (const id of ["pTagT", "pTagB"])
      document.getElementById(id).textContent = "player";
    const h = (sel) =>
      document.querySelector(sel).getBoundingClientRect().height;
    return {
      plateTop: h("#play .plate.top"),
      plateBottom: h("#play .plate.bottom"),
      brand: h("#brand"),
    };
  });
  await probe.close();

  /*
    The branding line is absolutely positioned, so it does not push the column
    down by itself - the column has to RESERVE its space or the two overlap,
    which is exactly what the first content-fitted frame did. That reserved
    strip is the same number passed to the stage as --chrome.
  */
  const brandZone = BRAND_GAP + furniture.brand + FRAME_PAD;
  const stack =
    FRAME_PAD * 2 +
    furniture.plateTop +
    GAP * 2 +
    furniture.plateBottom +
    brandZone;

  /** H.264 wants even dimensions. */
  const even = (n) => Math.round(n / 2) * 2;

  if (ASPECT === "9x16") {
    return {
      width: FRAME_WIDTH,
      height: 1920,
      boardPx: trialBoard,
      chromePx: 150,
    };
  }
  if (ASPECT === "square") {
    const boardPx = even(FRAME_WIDTH - stack);
    return {
      width: FRAME_WIDTH,
      height: FRAME_WIDTH,
      boardPx,
      chromePx: brandZone,
    };
  }
  // fit: the board keeps the full width and the frame takes whatever height
  // the content needs. If that lands close to square, snap to it exactly.
  const natural = stack + trialBoard;
  if (Math.abs(natural - FRAME_WIDTH) <= 90) {
    return {
      width: FRAME_WIDTH,
      height: FRAME_WIDTH,
      boardPx: even(FRAME_WIDTH - stack),
      chromePx: brandZone,
    };
  }
  return {
    width: FRAME_WIDTH,
    height: even(natural),
    boardPx: trialBoard,
    chromePx: brandZone,
  };
};

const FRAME = await resolveFrame();
const LAYOUT = {
  width: FRAME.width,
  height: FRAME.height,
  vars: frameVars(FRAME.height, FRAME.boardPx, FRAME.chromePx),
};
log(
  `frame ${LAYOUT.width}x${LAYOUT.height} (--aspect ${ASPECT}), board ${FRAME.boardPx}px ` +
    `= ${Math.round((FRAME.boardPx / LAYOUT.height) * 100)}% of the frame height`,
);

/** The board grid's box (installBoardGrid), or null. */
const measureBoard = (page) =>
  page.evaluate((cells) => {
    const grid = window.__boardGrid(cells);
    if (!grid) return null;
    const r = grid.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, CELL_COUNT);

let boardBox = cached ? cached.boardBox : await measureBoard(game);
if (!boardBox) {
  console.error("could not find the board on the replay page");
  await browser.close();
  process.exit(5);
}

/**
 * Capture the board at whatever resolution it needs, not a fixed one.
 *
 * The replay page does not draw every board at the same size: an 8x8 came out
 * 505 css px wide and a 7x7 animal-cycle only 438, and at a fixed device scale
 * of 2 that second one arrived as 876 device pixels to fill a 1040px slot - a
 * 19% upscale, plainly soft when magnified. The board is the whole subject of
 * the video, so the scale factor follows the measurement instead of a
 * hardcoded 2, with a little headroom so a downscale is always what happens.
 */
/*
  The capture scale is FIXED, not adaptive, and that is a deliberate trade.
  Adapting it meant measuring the board on one page load and then loading the
  page AGAIN at a higher scale - a second `views + 1` on production for every
  render. A single scale of 3 covers every board this page draws (the smallest
  measured was a 7x7 at 422 css px, giving 1266 device px for a 1040px slot),
  so every board is still captured above its slot size and downscaled, never
  stretched.
*/
const boardSlotPx = parseInt(LAYOUT.vars["--board"], 10);
const capturedPx = Math.round(boardBox.width * CAPTURE_DPR);
if (capturedPx < boardSlotPx) {
  log(
    `WARNING: board captured at ${capturedPx}px for a ${boardSlotPx}px slot - it will be upscaled and look soft. Raise CAPTURE_DPR.`,
  );
}

/** A little air around the grid, so walls on the rim are not shaved off. */
const PAD = Math.round(boardBox.width * 0.02);
const clip = {
  x: Math.round(boardBox.x) - PAD,
  y: Math.round(boardBox.y) - PAD,
  width: Math.round(boardBox.width) + PAD * 2,
  height: Math.round(boardBox.height) + PAD * 2,
};
log(
  `board clip ${clip.width}x${clip.height} css px at dpr ${CAPTURE_DPR} = ` +
    `${Math.round(clip.width * CAPTURE_DPR)}px captured for a ${boardSlotPx}px slot`,
);

/*
  The walls that were on the board at the start are a muted grey (audit
  item 7): with Red vs Blue the only story, a third colour is noise. The
  site paints them START_WALL itself since a63de775 (frontend board.tsx,
  NEUTRAL_WALL_COLOR, on wallgame.io 2026-10-31) - a wall's background, a
  pillar's fill - so the capture keeps them as they are; before, it
  repainted the site's brown #92400e. A capture of a game with start walls
  stops if nothing on the board is that grey: the site changed them again.
*/
const START_WALL = "#64748b";
/** On the board, count the parts painted START_WALL. */
const countStartWallPaint = () =>
  game.evaluate(
    ([c, grey]) => {
      const d = document.createElement("div");
      d.style.color = grey;
      document.body.append(d);
      const greyRgb = getComputedStyle(d).color;
      d.remove();
      let parts = 0;
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        if (x < c.x || x > c.x + c.width || y < c.y || y > c.y + c.height)
          continue;
        const cs = getComputedStyle(el);
        if ([cs.backgroundColor, cs.fill].includes(greyRgb)) parts += 1;
      }
      return parts;
    },
    [clip, START_WALL],
  );
/*
  Since a63de775 (on wallgame.io 2026-10-31) the site draws each player's
  shortest walk as dots on the start position (board.tsx renderWalks). The
  video draws its own (edl.mjs introPaths), so the capture hides the site's
  in every style, as the captures before it had none. Their svg is the only
  one on the board whose circles have the dark rim #0b0f1c.
*/
const SITE_WALK_DOTS = 'svg:has(> g > circle[stroke="#0b0f1c"])';
if (!cached) {
  await game.addStyleTag({
    content: `${SITE_WALK_DOTS} { display: none !important; }`,
  });
}
/**
 * At the start position: the site's walk dots are on the page and none
 * shows. A variant with a hunt draws them, so none found there stops the
 * capture: the site changed how it draws them.
 */
const checkWalkDotsHidden = async () => {
  const dots = await game.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map(
        (el) => getComputedStyle(el).display,
      ),
    SITE_WALK_DOTS,
  );
  if (huntsFor(replay.state.config.variant).length > 0 && dots.length === 0) {
    throw new Error(
      `the start position shows no site walk dots (${SITE_WALK_DOTS}): the site changed how it draws them`,
    );
  }
  const shown = dots.filter((d) => d !== "none").length;
  if (shown > 0) {
    throw new Error(
      `${shown} of the site's ${dots.length} walk dot layers still show at the start position`,
    );
  }
};
// A cached capture was taken with them (CAPTURE_INPUTS.greyStartWalls).
if (!cached && STYLE_NAMES.includes("daily")) {
  // Every position shows the start walls: no move removes one.
  const startWalls = replay.state.initialState.walls.length;
  const grey = await countStartWallPaint();
  if (startWalls > 0 && grey === 0) {
    throw new Error(
      `the game has ${startWalls} start walls, but nothing on the board is ${START_WALL}: the site changed how it paints them`,
    );
  }
  log(`start walls: ${startWalls}, ${grey} board parts ${START_WALL}`);
  // The site's glow on the last placed wall (board.tsx, a box-shadow in
  // --wall-highlight-glow) is off (CAPTURE_INPUTS.siteWallGlow). If the
  // site renames the variable, the old one is no longer set: the render
  // stops rather than capture the glow.
  const glow = () =>
    game.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--wall-highlight-glow")
        .trim(),
    );
  const siteGlow = await glow();
  if (siteGlow === "") {
    throw new Error(
      "the page sets no --wall-highlight-glow: the site changed how it marks the last wall",
    );
  }
  await game.addStyleTag({
    content: "* { --wall-highlight-glow: transparent !important; }",
  });
  if ((await glow()) !== "transparent") {
    throw new Error(
      `the site's last-wall glow did not turn off: --wall-highlight-glow is still ${await glow()}`,
    );
  }
  log(`the site's last-wall glow: off (was ${siteGlow})`);
}

/**
 * The page's top-left and bottom-right cells, in css px: the board map
 * (GRID, board-grid.mjs) is built from where the page drew them.
 */
const cellRects = cached
  ? cached.cellRects
  : await game.evaluate((count) => {
      const grid = window.__boardGrid(count);
      const cells = grid
        ? [...grid.querySelectorAll(":scope > .aspect-square")]
        : [];
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      return {
        count: cells.length,
        first: cells[0] ? rect(cells[0]) : null,
        last: cells.length ? rect(cells[cells.length - 1]) : null,
      };
    }, CELL_COUNT);
{
  const { boardWidth, boardHeight } = replay.state.config;
  if (cellRects.count !== CELL_COUNT) {
    throw new Error(
      `the replay page drew ${cellRects.count} cells for a ${boardWidth}x${boardHeight} board: the site changed how it draws them`,
    );
  }
}

const moveButtons = cached
  ? null
  : game.locator("button[aria-pressed]:visible");
if (moveButtons && (await moveButtons.count()) !== history.length) {
  throw new Error(
    `replay exposes ${await moveButtons.count()} move buttons for ${history.length} recorded plies`,
  );
}
const jumpStart = cached
  ? null
  : game.getByRole("button", { name: "Jump to beginning" });
/**
 * Where the page drew each pawn at each captured position, as centres in the
 * board image (0..1), keyed by board index (0 = the start). Read off the
 * page's own pawn images at capture time, so the mouse beats can put their
 * bubble where it covers no other pawn without a second copy of the rules.
 */
const pawnSpots = new Map(cached?.pawnSpots);
/**
 * Where the page drew each wall at each captured position: the centre and
 * direction of every placed wall (board.tsx gives only those z-index 10),
 * in the board image (0..1), keyed by board index. A highlight must lie on
 * one of them (litWallLine).
 */
const wallSpots = new Map(cached?.wallSpots);
/**
 * The art of each pawn the page drew in the start position, as its layer
 * stack (the backing, the skin with its colour filter, a foreground fix):
 * [{type, layers: [{src, filter}]}]. Read off the board, as the cards are,
 * never rebuilt from the record's skins (pawn-style.ts lives in the app):
 * a reactor that shows a seat's prey composes it from here (REACTOR_ART).
 * Null for a cache made before 2026-10-29, which did not keep it.
 */
let pawnArt = cached ? (cached.pawnArt ?? null) : null;
/** Up to here: the browser, the replay page and the game record. */
const LOAD_SECONDS = secondsSince(RUN_STARTED);
const captureStarted = Date.now();
const captureResult = cached
  ? cached.capture
  : await captureReplayFrames({
      moveCount: history.length,
      selectInitial: async () => {
        await jumpStart.click();
        await game.waitForFunction(() => {
          const button = document.querySelector(
            'button[aria-label="Jump to beginning"]',
          );
          return button?.disabled === true;
        });
        await checkWalkDotsHidden();
      },
      selectPly: async (ply) => {
        const button = moveButtons.nth(ply);
        await button.click();
        await game.waitForFunction(
          ([index, count]) => {
            const buttons = [
              ...document.querySelectorAll("button[aria-pressed]"),
            ].filter((button) => button.getClientRects().length > 0);
            if (buttons[index]?.getAttribute("aria-pressed") !== "true")
              return false;
            return (
              buttons.every(
                (candidate, i) =>
                  i === index ||
                  candidate.getAttribute("aria-pressed") !== "true",
              ) && buttons.length === count
            );
          },
          [ply, history.length],
        );
        await game.evaluate(
          () =>
            new Promise((done) =>
              requestAnimationFrame(() => requestAnimationFrame(done)),
            ),
        );
      },
      readCommittedPly: async () => {
        if (await jumpStart.isDisabled()) return -1;
        const pressed = [];
        for (let i = 0; i < history.length; i += 1) {
          if (
            (await moveButtons.nth(i).getAttribute("aria-pressed")) === "true"
          )
            pressed.push(i);
        }
        return pressed.length === 1 ? pressed[0] : Number.NaN;
      },
      capture: async (expectedPly) => {
        const file = join(
          WORK,
          `board-${String(expectedPly + 1).padStart(4, "0")}.png`,
        );
        await game.screenshot({ path: file, clip });
        if (expectedPly === -1) {
          pawnArt = await game.evaluate((c) => {
            const art = [];
            for (const img of document.querySelectorAll(
              'img[src*="/pawns/"]',
            )) {
              const r = img.getBoundingClientRect();
              const x = r.x + r.width / 2;
              const y = r.y + r.height / 2;
              const inside =
                x > c.x && x < c.x + c.width && y > c.y && y < c.y + c.height;
              if (!inside || r.width >= c.width / 4) continue;
              const m = /\/pawns\/([a-z-]+)\/([^/?#]+)\.svg/i.exec(img.src);
              if (!m) continue;
              // Animal Cycle keeps its four pawns in one folder, by type.
              const type = (
                m[1] === "animal-cycle" ? m[2] : m[1]
              ).toLowerCase();
              // PawnImage stacks its layers in a span; a bare pawn is one img.
              const stack =
                img.parentElement?.tagName === "SPAN"
                  ? [...img.parentElement.querySelectorAll("img")]
                  : [img];
              art.push({
                type,
                layers: stack.map((i) => ({
                  src: i.src,
                  filter: getComputedStyle(i).filter,
                })),
              });
            }
            return art;
          }, clip);
        }
        pawnSpots.set(
          expectedPly + 1,
          await game.evaluate((c) => {
            const spots = [];
            for (const img of document.querySelectorAll(
              'img[src*="/pawns/"]',
            )) {
              const r = img.getBoundingClientRect();
              const x = r.x + r.width / 2;
              const y = r.y + r.height / 2;
              const inside =
                x > c.x && x < c.x + c.width && y > c.y && y < c.y + c.height;
              // A pawn on the board is about a cell; the seat cards are bigger.
              if (inside && r.width < c.width / 4) {
                spots.push({
                  x: (x - c.x) / c.width,
                  y: (y - c.y) / c.height,
                  w: r.width / c.width,
                  h: r.height / c.height,
                });
              }
            }
            return spots;
          }, clip),
        );
        wallSpots.set(
          expectedPly + 1,
          await game.evaluate(
            ({ c, cells }) => {
              const grid = window.__boardGrid(cells);
              // No grid is a page we cannot read, never a board with no walls.
              if (!grid) return null;
              const walls = [];
              for (const el of grid.children) {
                const cs = getComputedStyle(el);
                if (cs.position !== "absolute" || cs.zIndex !== "10") continue;
                const r = el.getBoundingClientRect();
                walls.push({
                  vertical: r.height > r.width,
                  x: (r.x + r.width / 2 - c.x) / c.width,
                  y: (r.y + r.height / 2 - c.y) / c.height,
                });
              }
              return walls;
            },
            { c: clip, cells: CELL_COUNT },
          ),
        );
        if (!wallSpots.get(expectedPly + 1)) {
          throw new Error(
            `could not find the board grid after ply ${expectedPly}: the site changed how it draws the board`,
          );
        }
        return file;
      },
    });
assertCompleteCapture(captureResult);
const CAPTURE_SECONDS = secondsSince(captureStarted);
const boardFrames = captureResult.records.map((record) => record.file);
writeFileSync(
  join(WORK, "capture-manifest.json"),
  JSON.stringify(
    captureResult.records.map((record) => ({
      expectedPly: record.expectedPly,
      notation:
        record.expectedPly < 0 ? null : history[record.expectedPly]?.notation,
      sha256: record.sha256,
    })),
    null,
    2,
  ),
);
if (cached) {
  log(`${boardFrames.length} board positions from the cache`);
} else {
  log(`${boardFrames.length} board positions captured`);
  await game.close();
  /*
    A daily render saves its capture, so later renders of this game (a
    preview, a proof) need no view. A failed save must not fail the video:
    it is only reported.
  */
  if (EDL) {
    try {
      writeCaptureCache(GAME_CACHE, {
        inputs: CAPTURE_INPUTS,
        capturedAt: new Date().toISOString(),
        replay,
        cards,
        accents,
        portraits,
        boardBox,
        cellRects,
        capture: captureResult,
        pawnSpots,
        wallSpots,
        pawnArt,
      });
      log(`capture saved to the cache: ${GAME_CACHE}`);
      const pruned = pruneCaptureCaches(CACHE_DIR, CACHE_KEEP);
      if (pruned.length > 0) log(`cache: removed ${pruned.join(", ")}`);
    } catch (err) {
      log(
        `WARNING: could not save the capture cache: ${String(err.message ?? err).slice(0, 200)}`,
      );
    }
  }
}

const fileUrl = (p) => `file://${resolve(p)}`;

/**
 * The art of each reactor overlay of the EDL, by its role (overlays.mjs
 * reactorRole), and of each redraw (its `pawn`, composed as a prey is):
 * a "hunter" shows the seat's card (its cat); a "prey" shows
 * the seat's one hunted pawn (race-replay.ts preyTypeOf), composed from the
 * board's own art for it (pawnArt): the pawn of that type whose colour
 * filter is the seat card's. {url}, or {stop}: why it cannot, which stops
 * the lint and the render (reactor-pawn) so the director picks another beat
 * (Wall Game PM, 2026-10-29: never a cat as the prey), or {recapture}: the
 * capture is older than the pawn art, which a live capture mends
 * (reactor-capture).
 * @type {Map<object, { url: string } | { stop: string } | { recapture: string }>}
 */
/**
 * The board's own art (pawnArt) for `player`'s pawn of `type`: every pawn of
 * that type in the start position whose colour filter is the player's
 * card's. One, unless the variant gives a seat two of a type.
 */
const seatPawnArt = (player, type) => {
  const pawnFilter = (layers) =>
    layers.find((l) => /\/pawns\//.test(l.src))?.filter ?? null;
  const filter = pawnFilter(cardFor(player).layers);
  return (pawnArt ?? []).filter(
    (a) => a.type === type && pawnFilter(a.layers) === filter,
  );
};
const REACTOR_ART = new Map();
if (EDL) {
  const colourOf = SEAT_COLORS(replay);
  const playerOf = (seat) => (colourOf[1] === seat ? 1 : 2);
  /** @type {Map<string, { url: string } | { stop: string } | { recapture: string }>} */
  const prey = new Map();
  let page = null;
  const preyArt = async (player, seat, type) => {
    if (!pawnArt) {
      return {
        recapture: `this game's capture was made before the board's pawn art was kept, so it has no ${type} to show: the render must capture the game live (one view; direct marks the list so)`,
      };
    }
    const hits = seatPawnArt(player, type);
    if (hits.length !== 1) {
      return {
        stop: `the start position shows ${hits.length} ${type} pawns in ${seat}'s colour, not one`,
      };
    }
    page ??= await browser.newPage(portraitPageOptions);
    const file = join(WORK, `prey-p${player}-${type}.png`);
    await composeLayers(page, hits[0].layers, file);
    return { url: fileUrl(file) };
  };
  for (const ev of EDL.events) {
    if (ev.kind !== "overlay") continue;
    /*
      A redraw shows the pawn that emotes it (overlays.mjs `pawn`): the
      board's own art for that seat's piece, as a reactor's prey.
    */
    /*
      The pointing pawns show the standoff's two pieces: the seat's hunter
      and the piece it hunts, each in its board art.
    */
    if (OVERLAYS[ev.asset].redraw === "pointing") {
      const player = playerOf(ev.seat);
      const hunt = huntsFor(replay.state.config.variant).find(
        (h) => h.hunter.player === player && h.target.player !== player,
      );
      if (!hunt) {
        REACTOR_ART.set(ev, {
          stop: `the ${ev.asset} on ply ${ev.ply}: ${ev.seat} hunts no piece of the other side in ${replay.state.config.variant}`,
        });
        continue;
      }
      const other = colourOf[hunt.target.player];
      const pair = [
        [player, ev.seat, hunt.hunter.type],
        [hunt.target.player, other, hunt.target.type],
      ];
      const arts = [];
      for (const [p, seat, type] of pair) {
        const key = `${p}:${type}`;
        if (!prey.has(key)) prey.set(key, await preyArt(p, seat, type));
        arts.push(prey.get(key));
      }
      const bad = arts.find((a) => !("url" in a));
      REACTOR_ART.set(
        ev,
        !bad
          ? { url: arts[0].url, url2: arts[1].url, player2: hunt.target.player }
          : "stop" in bad
            ? { stop: `the ${ev.asset} on ply ${ev.ply}: ${bad.stop}` }
            : bad,
      );
      continue;
    }
    if (OVERLAYS[ev.asset].draw === "redraw") {
      const pawn = parsePawn(ev.pawn);
      const player = playerOf(pawn.seat);
      const key = `${player}:${pawn.piece}`;
      if (!prey.has(key))
        prey.set(key, await preyArt(player, pawn.seat, pawn.piece));
      const art = prey.get(key);
      REACTOR_ART.set(
        ev,
        "stop" in art
          ? { stop: `the ${ev.asset} on ply ${ev.ply}: ${art.stop}` }
          : art,
      );
      continue;
    }
    if (OVERLAYS[ev.asset].draw !== "reactor") continue;
    const player = playerOf(ev.seat);
    if (reactorRole(OVERLAYS[ev.asset]) === "hunter") {
      REACTOR_ART.set(ev, { url: fileUrl(portraits[player]) });
      continue;
    }
    const kind = preyTypeOf(replay.state.config.variant, player);
    if ("reason" in kind) {
      REACTOR_ART.set(ev, {
        stop: `the ${ev.asset} on ply ${ev.ply} shows ${ev.seat}'s prey, and ${kind.reason}: pick another beat`,
      });
      continue;
    }
    const key = `${player}:${kind.type}`;
    if (!prey.has(key))
      prey.set(key, await preyArt(player, ev.seat, kind.type));
    const art = prey.get(key);
    REACTOR_ART.set(
      ev,
      "stop" in art
        ? { stop: `the ${ev.asset} on ply ${ev.ply}: ${art.stop}` }
        : art,
    );
  }
  await page?.close();
}

/* ----------------------------------------------------------- the sounds -- */

/**
 * The soundtrack, built from the site's own effects.
 *
 * Which sound a ply gets comes from the recorded notation: a term starting
 * with > or ^ is a wall, anything else is a pawn. A turn can be both, and then
 * it gets both, once each - a turn that placed two walls does not deserve two
 * wall clicks on top of each other.
 *
 * Nothing here carries the story. The video is built to read with the sound
 * off, because a feed autoplays muted; the audio is for whoever taps it.
 */
const AUDIO_DIR = join(REPO, "frontend/public/audio");

/**
 * The mix the site itself plays at, from frontend/src/lib/sounds.ts.
 *
 * A wall is deliberately quieter than a pawn there, and copying that keeps a
 * wall-heavy game from turning into a hammering.
 */
const SITE_VOLUMES = { pawn: 0.9, wall: 0.5, gameStart: 0.7, gameEnd: 0.7 };

/**
 * The meme sounds of the daily look: the files of the keys in
 * meme-sounds.mjs (MEME_DIR), which also says where they come from and why
 * they are not in the repository. The EDL names its sound cues by these keys.
 */
const meme = (name) => {
  if (!(name in MEME_SOUNDS)) {
    console.error(
      `meme sound ${name} is not known. Known: ${Object.keys(MEME_SOUNDS).join(", ")}`,
    );
    process.exit(2);
  }
  return {
    name,
    file: join(MEME_DIR, `${name}.mp3`),
    gain: memeGain(name),
  };
};

/**
 * EVERY SOUND THAT IS NOT THE SITE'S OWN, IN ONE TABLE. Chosen by Nil
 * 2026-08-19 for the current look; the meme two are candidates until he picks.
 *
 * THIS IS THE ONE PLACE TO CHANGE THEM. Swapping any of them is editing one
 * line below - the placement, the mixing and the encoding do not care which
 * file is named. A clip that draws a YouTube copyright claim is swapped here.
 *
 * Any format ffmpeg can read works. The two sounds Nil bought are .m4a while
 * everything else here is .wav or .mp3, and NOTHING in this file treats that
 * differently: ffmpeg decodes by content, and every clip is normalised to the
 * same sample format inside the mix. There is no extension check to keep in
 * step with the file list.
 *
 *   vsStamp   lands on the VS mark's punch (current)
 *   vsMeme    lands on the VS mark's punch in the overlay (daily: no riser,
 *             the overlay has no time for its 1.6 s lead-in)
 *   shake     lands on the winning capture, under the screen shake (current)
 *   win       lands with the end card (current)
 *   vsMeme    lands on the punch of the VS overlay (daily)
 *   finish    lands on the impact of the ending (daily)
 *
 * The two daily meme slots are defaults (DEFAULT_SLOT_SOUNDS in edl.mjs):
 * an EDL can name its own with vsSound and finishSound. The names map
 * vsSound -> vsMeme and finishSound -> finish; --sounds (hand renders only)
 * keeps the slot names of this table.
 *
 * Every other daily sound is a cue in the EDL.
 */
const PIXEL_PACK = join(REPO, "assets/audio/pixel_game_essentials");
const STING_DIR = join(REPO, "assets/stings");
/**
 * The daily VS banners' whoosh (make-stings.mjs): its peak meets the
 * banners' exit, about 6 dB under the VS hit (Wall Game Director,
 * 2026-10-29: choice (b), Nil's 4.0 s VS card kept).
 */
const VS_WHOOSH = {
  name: "vs-whoosh",
  file: join(STING_DIR, "vs-whoosh.wav"),
  gain: 10 ** (-5 / 20),
};
/**
 * How much sooner the exit whoosh starts, played slower so that its peak
 * still meets the banners' exit. Its first 0.12 s are under the silence
 * floor (-45 dBFS), and the gap from the VS hit's tail to it measured
 * 0.63-0.66 s, over the 0.6 s rule (v-2026-10-29-1 and -2, 2026-10-29);
 * 0.2 s sooner at rate 1/1.2 brings it to about 0.48 s.
 */
const VS_EXIT_WHOOSH_LEAD = 0.2;
const SOUNDS = {
  vsStamp: {
    name: "vs-b-riser",
    file: join(STING_DIR, "vs-b-riser.wav"),
    gain: 1.0,
    /*
      This one is built rather than recorded, so its impact is not at its
      start. make-stings.mjs publishes where the hit sits and stage.html
      publishes where the visual punch is; the placement below is derived from
      both, so retiming either cannot silently pull the sound off the picture.
    */
    hitOffsetSeconds: () => stingManifest.vsHitSeconds,
  },
  shake: {
    name: "die-1",
    file: join(PIXEL_PACK, "die-1.m4a"),
    gain: SHAKE_GAIN,
  },
  win: {
    name: "level-complete-1",
    file: join(PIXEL_PACK, "level-complete-1.m4a"),
    gain: WIN_GAIN,
  },
  vsMeme: meme(DEFAULT_SLOT_SOUNDS.vsSound),
  finish: meme(DEFAULT_SLOT_SOUNDS.finishSound),
};

/**
 * Audition plumbing, so one capture can carry a different candidate per
 * style: `--sounds finish=shotgun-4` for every style, or `daily:finish=shotgun-4`
 * for one. Only the meme slots take a candidate.
 */
const soundsFor = (styleName) => {
  const picked = EDL
    ? { ...SOUNDS, vsMeme: meme(EDL.vsSound), finish: meme(EDL.finishSound) }
    : { ...SOUNDS };
  for (const entry of String(arg("sounds", "")).split(",").filter(Boolean)) {
    const m = entry.match(/^(?:([a-z]+):)?(finish|vsMeme)=([\w-]+)$/);
    if (!m) {
      console.error(
        `--sounds entry "${entry}" is not [style:]finish|vsMeme=<candidate>`,
      );
      process.exit(2);
    }
    if (!m[1] || m[1] === styleName) picked[m[2]] = meme(m[3]);
  }
  return picked;
};

/*
  The riser is generated, not recorded, and it is deliberately NOT committed:
  make-stings.mjs is deterministic, so the stings are rebuilt here when a wav
  is missing or stings.json is older than this renderer. That keeps the
  repository free of generated audio without making a fresh checkout render
  a silent VS screen.
*/
/**
 * Whether every sting and every time in stings.json is there (make-stings.mjs
 * --check, which owns that list). A copy from before the whoosh had no
 * whooshPeakSeconds, and with both wavs present it was never rebuilt: the
 * whoosh's cue went to NaN and every render failed in the mix (Wall Game
 * Director, 2026-10-29, main 10f2b1ca).
 */
const MAKE_STINGS = join(HERE, "make-stings.mjs");
const stingsReady = () =>
  spawnSync(process.execPath, [MAKE_STINGS, "--check"], { stdio: "ignore" })
    .status === 0;
if (AUDIO && !stingsReady()) {
  log("stings missing or out of date; running make-stings.mjs");
  execFileSync(process.execPath, [MAKE_STINGS], { stdio: "inherit" });
  if (!stingsReady()) {
    throw new Error("make-stings.mjs ran, and its --check still fails");
  }
}

const stingManifest = AUDIO
  ? JSON.parse(readFileSync(join(STING_DIR, "stings.json"), "utf8"))
  : { vsHitSeconds: 0, whooshPeakSeconds: 0 };

/**
 * The music as mix parts (mix-loudness.mjs Music), one per played cue
 * (CUES). The first starts at `musicStart`; a later one at the beat start of
 * its ply (`beatStartAt`), where the part before it fades out. The last part
 * fades to `bed` at `musicEndAt`, as the one track did before there were
 * cues, so a one-cue video mixes exactly as before.
 * @param {{ beatStartAt: Map<number, number>, musicStart: number,
 *           musicEndAt: number, bed: number }} at
 */
const musicParts = ({ beatStartAt, musicStart, musicEndAt, bed }) => {
  const startOf = (k) => {
    if (k === 0) return musicStart;
    const t = beatStartAt.get(CUES[k].fromPly);
    if (t === undefined) {
      throw new Error(`music cue ${k} at ply ${CUES[k].fromPly} never played`);
    }
    return t;
  };
  return CUES.map((c, k) => {
    const last = k === CUES.length - 1;
    return {
      file: c.file,
      start: startOf(k),
      endAt: last ? musicEndAt : startOf(k + 1) + CUE_FADE_OUT,
      bed: last ? bed : 0,
      // Every track at one level (music-tracks.mjs musicGain).
      volume: MUSIC_VOLUME * musicGain(c.track),
      fadeIn: k === 0 ? MUSIC_FADE_IN : CUE_FADE_IN,
      fadeOut: last ? MUSIC_FADE_OUT : CUE_FADE_OUT,
    };
  });
};

/**
 * Mix the cues the composer recorded, and the music parts (musicParts) under
 * them.
 *
 * Every cue carries the second its frame went into the timeline, so a sound
 * cannot drift off its picture when a beat is retimed or a swing move holds
 * longer than a routine one.
 *
 * The music starts at `musicStart` and its last fade COMPLETES at
 * `musicEndAt`, the moment the last sting arrives. Measured 2026-08-19: with the fade spread
 * over the end card, the last second of it carried music at -17.5 dB peak
 * where a no-music build is digital silence - and the bed is three times
 * louder than when Nil first called the win screen too loud. The riser owns
 * the VS moment; the last sting should own the end.
 *
 * NO DYNAMICS ARE APPLIED TO THE MUSIC. There used to be a sidechain
 * compressor keyed on the effects, added when the music sat at 0.3 and might
 * have buried a click. At 0.8s per move with a 320ms release the music never
 * recovered between moves, so it pumped on every single move for the whole
 * video - Nil heard it and asked whether he was imagining it. He was not.
 * MUSIC_VOLUME WAS 0.9 AND IS NOW 0.3, AND THAT IS A RESTORATION RATHER THAN A
 * RETUNE. Measured 2026-08-20: the compressor had been holding the music down
 * by 9.45 dB CONTINUOUSLY - not a dip on each hit - so the mix Nil approved
 * was one where the music was ~9.5 dB below what the constant said.
 *
 * Returns the track, and each meme sound's loudness over the rest of the
 * mix with the master's measure (mix-loudness.mjs) for the RESULT line;
 * both null when no sound exists. A master outside the gate (masterFault)
 * fails the render.
 */
const buildAudio = ({ cues, totalSeconds, music, work }) => {
  const present = cues.filter((e) => existsSync(e.file));
  const absent = cues.filter((e) => !existsSync(e.file));
  // A daily video plays exactly its list: a sound left out is a wrong
  // video, not a warning. A hand render still mixes what it has.
  if (EDL && absent.length > 0) {
    throw new Error(
      `sounds missing, so the video would not play its list: ${[...new Set(absent.map((e) => e.file))].join(", ")}`,
    );
  }
  for (const missing of absent) {
    log(`WARNING: sound missing, left out of the mix: ${missing.file}`);
  }
  if (present.length === 0)
    return { audioPath: null, loudness: null, mixed: [] };
  const graph = mixGraph({ cues: present, totalSeconds, music });
  const { inputs, chains } = graph;
  // The whole mix fades over its last END_FADE_SECONDS, so no sound stops
  // at full level at the loop's seam.
  const finish =
    `atrim=0:${totalSeconds.toFixed(3)},` +
    `afade=t=out:st=${Math.max(0, totalSeconds - END_FADE_SECONDS).toFixed(3)}:d=${END_FADE_SECONDS}`;
  // The master (mix-loudness.mjs): pass 1 measures the mix, pass 2 (encode)
  // gives it one gain to the feed level and a true-peak limiter. A draft
  // gets the same master, so it sounds as the final does.
  const mixLufs = mixIntegrated(FFMPEG, graph, `${finish},`);

  // What went into the mix, so its parts can be rebuilt and measured apart.
  writeFileSync(
    join(work, "audio-plan.json"),
    JSON.stringify(
      {
        totalSeconds,
        music,
        cues: present,
      },
      null,
      1,
    ),
  );
  const audioPath = join(work, "track.m4a");
  const encode = ({ limitDbtp, makeupDb }) => {
    const { gainDb, filters } = masterFilters(mixLufs, limitDbtp, makeupDb);
    ff([
      ...inputs,
      "-filter_complex",
      [...chains, `[mix]${filters},${finish}[out]`].join(";"),
      "-map",
      "[out]",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      audioPath,
    ]);
    return measureMaster(FFMPEG, audioPath, gainDb);
  };
  const master = runMaster(encode, log);
  const masterProblem = masterFault(master);
  if (masterProblem) throw new Error(masterProblem);
  // A measure that cannot run is reported, not fatal: the gate fails it.
  let loudness;
  try {
    loudness = memeLoudness({
      ffmpeg: FFMPEG,
      cues: present,
      totalSeconds,
      music,
    });
  } catch (err) {
    loudness = { error: String(err.message ?? err).slice(0, 300) };
  }
  // The memes are measured in the mix before the master gain, so
  // MAX_MEME_LUFS (daily/quality.mjs) passes the same mixes as before it.
  return { audioPath, loudness: { ...loudness, master }, mixed: present };
};

/* ----------------------------------------------------------- compose it -- */

/**
 * A player's identity as the stage needs it.
 *
 * The label under a name says whether the seat was a person or one of our
 * bots, which is true, comes straight from the record, and gives away nothing
 * about who won. It is also the one fact about this game that is worth
 * advertising: a bot ladder is what the site has and the competitor does not.
 */
const seatLabel = (playerId) =>
  apiPlayers.find((p) => p.playerId === playerId)?.configType === "bot"
    ? "bot"
    : "player";

const side = (playerId) => {
  const [r, g, b] = accents[playerId];
  const rgb = (alpha) => `rgba(${r},${g},${b},${alpha})`;
  return {
    name: nameOf(playerId),
    portrait: fileUrl(portraits[playerId]),
    hex: `rgb(${r},${g},${b})`,
    soft: rgb(0.16),
    sub: seatLabel(playerId),
    // Colour at the portrait end, fading into the frame at the other - so the
    // two banners read as two players rather than two rectangles.
    gradient: `linear-gradient(100deg, ${rgb(0.95)} 0%, ${rgb(0.62)} 44%, rgba(11,15,28,0.92) 100%)`,
    gradientMirrored: `linear-gradient(260deg, ${rgb(0.95)} 0%, ${rgb(0.62)} 44%, rgba(11,15,28,0.92) 100%)`,
  };
};

/**
 * Where a cell sits on the captured board image, as fractions of its width
 * and height: GRID.x(u) and GRID.y(v) map a coordinate in cells (an integer
 * is the line between two cells) to the image, as the page drew the cells
 * (board-grid.mjs).
 *
 * The capture clip is the replay page's grid plus PAD on every side, so the
 * grid spans [pad, 1 - pad]. Rows are counted the way standard notation counts
 * them (shared/domain/standard-notation.ts): row 1 is the bottom row, and the
 * replay page draws it at the bottom.
 */
const GRID = {
  ...boardGrid({
    clip,
    first: cellRects.first,
    last: cellRects.last,
    cols: replay.state.config.boardWidth,
    rows: replay.state.config.boardHeight,
  }),
  pad: PAD / clip.width,
};
const cellAt = ([row, col]) => ({
  x: GRID.x(col + 0.5),
  y: GRID.y(row + 0.5),
});

/**
 * The cell a turn is about: where its pawn landed, or else where its first
 * wall went, as a 0-based [row from the top, column]. Null when the notation
 * names no cell (a resignation has no move).
 */
const cellOfPly = (plyIndex) => {
  const terms = String(history[plyIndex]?.notation ?? "")
    .split(".")
    .filter(Boolean);
  const parse = (term) => {
    const m = term.match(/^[>^A-Z]?([a-z])(\d+)$/);
    if (!m) return null;
    return [GRID.rows - Number(m[2]), m[1].charCodeAt(0) - "a".charCodeAt(0)];
  };
  const pawn = terms.find((t) => !t.startsWith(">") && !t.startsWith("^"));
  return (pawn && parse(pawn)) ?? (terms[0] ? parse(terms[0]) : null);
};

/**
 * An EDL cell or wall as the box it covers, in cells: [top, left, bottom,
 * right], with row 0 at the top. A cell is its square; a wall is a thin strip
 * on the cell's edge: ^h4 on the top edge of h4, >h4 on its right edge
 * (shared/domain/standard-notation.ts).
 */
const termBox = (term) => {
  const m = term.match(/^([>^]?)([a-z])(\d+)$/);
  const row = GRID.rows - Number(m[3]);
  const col = m[2].charCodeAt(0) - "a".charCodeAt(0);
  if (m[1] === "^") return [row - 0.1, col, row + 0.1, col + 1];
  if (m[1] === ">") return [row, col + 0.9, row + 1, col + 1.1];
  return [row, col, row + 1, col + 1];
};

/**
 * Which side of a beat's mouse its bubble goes on: up, right, left or down,
 * whichever leaves the bubble farthest from every other pawn the page drew at
 * that position (Wall Game PM, 2026-10-26: the relief beat is "the cat
 * missed", so the bubble must never hide the cat). A side that would leave
 * the board is not a choice; on a tie the earlier side wins. A side in
 * `onPawn` (its mark, measured, hides another pawn) is taken only when every
 * side is, and then the render stops (mark-covers-pawn); a side in `covered`
 * (its mark covers a wall) only when every side left is (Wall Game
 * Director, 2026-10-29). A pawn comes first: the vet of v-2026-10-30-5 found
 * the "!" of the mouse on a1 over the cat on b1 for 1.1 s, because "up"
 * covered a wall and a wall then outranked the cat.
 * A side as near another pawn as to its own (a cell) reads as that pawn's
 * mark: it ranks under a side that covers a wall (vet of v-2026-10-31-16:
 * the scared "!" of the mouse on g3 went to g2, right of the cat on f2,
 * because "up" covered ^f3, and it read as the cat's).
 */
const OWN_MARK_CELLS = 1;
const BUBBLE_SIDES = {
  up: [0, -1],
  right: [1, 0],
  left: [-1, 0],
  down: [0, 1],
};
const bubbleSide = (
  boardIndex,
  at,
  covered = new Set(),
  onPawn = new Set(),
) => {
  // One cell in each axis, so a board with rows != cols measures true cells.
  const cellX = GRID.pitchX;
  const cellY = GRID.pitchY;
  const away = (p, x, y) => Math.hypot((p.x - x) / cellX, (p.y - y) / cellY);
  const others = (pawnSpots.get(boardIndex) ?? []).filter(
    (p) => away(p, at.x, at.y) > 0.3,
  );
  // Rank: hides no pawn, then reads as no other pawn's, then covers no
  // wall, then the most room.
  let best = "up";
  let bestRank = [-1, -1, -1, -1];
  const better = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      if (Math.abs(a[i] - b[i]) > 1e-9) return a[i] > b[i];
    }
    return false;
  };
  for (const [side, [dx, dy]] of Object.entries(BUBBLE_SIDES)) {
    const x = at.x + dx * cellX;
    const y = at.y + dy * cellY;
    if (x < GRID.pad || x > 1 - GRID.pad || y < GRID.pad || y > 1 - GRID.pad)
      continue;
    const room = Math.min(Infinity, ...others.map((p) => away(p, x, y)));
    const rank = [
      onPawn.has(side) ? 0 : 1,
      room > OWN_MARK_CELLS + 1e-6 ? 1 : 0,
      covered.has(side) ? 0 : 1,
      room,
    ];
    if (better(rank, bestRank)) {
      best = side;
      bestRank = rank;
    }
  }
  return best;
};

/**
 * Where a stamp or trap word goes (stamp-spot.mjs), over the position after
 * `boardIndex` plies: it avoids the pawns the page drew there (their
 * measured boxes), the cell and walls of the move `plyIndex`, and
 * `extraWalls` (a trap's). `size` is the word's measured box; `pop`
 * (stampSpot) is where its slam starts.
 */
const placeStamp = (boardIndex, plyIndex, size, extraWalls, punchFrom) => {
  const ofCells = ([top, left, bottom, right]) => [
    GRID.x(left),
    GRID.y(top),
    GRID.x(right),
    GRID.y(bottom),
  ];
  const cell = cellOfPly(plyIndex);
  const moveWalls = String(history[plyIndex]?.notation ?? "")
    .split(".")
    .filter((t) => t.startsWith(">") || t.startsWith("^"));
  const avoid = [
    ...(pawnSpots.get(boardIndex) ?? []).map((p) => [
      p.x - p.w / 2,
      p.y - p.h / 2,
      p.x + p.w / 2,
      p.y + p.h / 2,
    ]),
    ...(cell ? [ofCells([cell[0], cell[1], cell[0] + 1, cell[1] + 1])] : []),
    ...[...moveWalls, ...extraWalls].map((t) => ofCells(termBox(t))),
  ];
  return stampSpot({
    size,
    pad: GRID.pad,
    avoid,
    cellArea: GRID.pitchX * GRID.pitchY,
    focus: cell ? cellAt(cell) : null,
    punchFrom,
  });
};

/** The centre of an EDL cell on the board image (0..1), for the mouse overlays. */
const cellAtTerm = (term) => {
  const [top, left] = termBox(term);
  return cellAt([top, left]);
};

/** A 0-based [row from the top, column] as an EDL cell: [7, 6] is g1 on 8 rows. */
const termOfCell = ([row, col]) =>
  `${String.fromCharCode(97 + col)}${GRID.rows - row}`;

/** The cell of a pawn as the page drew it (pawnSpots). */
const drawnPawnCell = (p) =>
  termOfCell([
    Math.round((p.y - GRID.y(0)) / GRID.pitchY - 0.5),
    Math.round((p.x - GRID.x(0)) / GRID.pitchX - 0.5),
  ]);
/** The cell under a point of the board image (0..1). */
const cellUnder = (x, y) =>
  termOfCell([
    Math.floor((y - GRID.y(0)) / GRID.pitchY),
    Math.floor((x - GRID.x(0)) / GRID.pitchX),
  ]);
/**
 * The width of a wall's groove, the gap between two cells, as fractions of
 * the board image: `x` for a vertical wall, `y` for a horizontal one.
 */
const GROOVE = { x: GRID.pitchX - GRID.cellX, y: GRID.pitchY - GRID.cellX };
/**
 * The walls the page drew on a board (wallSpots), each as the groove it
 * fills: the gap between two cells wide, a pitch long, named in notation.
 */
const wallBoxes = (boardIndex) =>
  (wallSpots.get(boardIndex) ?? []).map((w) => {
    const bw = w.vertical ? GROOVE.x : GRID.pitchX;
    const bh = w.vertical ? GRID.pitchY : GROOVE.y;
    return {
      x0: w.x - bw / 2,
      y0: w.y - bh / 2,
      x1: w.x + bw / 2,
      y1: w.y + bh / 2,
      what: w.vertical
        ? `wall >${cellUnder(w.x - GRID.pitchX / 2, w.y)}`
        : `wall ^${cellUnder(w.x, w.y + GRID.pitchY / 2)}`,
    };
  });
/**
 * How far box `b` ({x, y, w, h}) goes into box `k` ({x0, y0, x1, y1}), in
 * cells: the lesser of its two overlaps, 0 or less when they are apart. A
 * box under a hundredth of a cell into another only touches it.
 */
const depthInto = (b, k) =>
  Math.min(
    (Math.min(b.x + b.w, k.x1) - Math.max(b.x, k.x0)) / GRID.pitchX,
    (Math.min(b.y + b.h, k.y1) - Math.max(b.y, k.y0)) / GRID.pitchY,
  );
const TOUCH_CELLS = 0.01;

/**
 * An EDL wall as the line it draws on the board image, [x1, y1, x2, y2] in
 * 0..1: ^h4 is the top edge of h4, >h4 its right edge.
 */
const wallLine = (term) => {
  const m = term.match(/^([>^])([a-z])(\d+)$/);
  const row = GRID.rows - Number(m[3]);
  const col = m[2].charCodeAt(0) - "a".charCodeAt(0);
  return m[1] === "^"
    ? [GRID.x(col), GRID.y(row), GRID.x(col + 1), GRID.y(row)]
    : [GRID.x(col + 1), GRID.y(row), GRID.x(col + 1), GRID.y(row + 1)];
};

/**
 * wallLine for a highlight over the position after `boardIndex` plies, held
 * to where the page drew that wall: a highlight more than 1 css px off every
 * wall the page drew there stops the render (Nil, 2026-10-26, on a glow off
 * its wall: "editing errors shouldn't make it to me").
 */
const WALL_TOLERANCE = { x: 1 / clip.width, y: 1 / clip.height };
const litWallLine = (term, boardIndex) => {
  const line = wallLine(term);
  if (!onSiteWall(line, wallSpots.get(boardIndex) ?? [], WALL_TOLERANCE)) {
    throw new Error(
      `the highlight of ${term} after ply ${boardIndex - 1} is not on a wall the page drew there`,
    );
  }
  return line;
};

/**
 * A wall's owner's colour (the seat's accent): the seat whose move placed
 * it, from REPLAYED.movers (the game state's turn, not the ply's parity: a
 * custom setup can start with player 2; VR1, review 106 C1). Only an EDL
 * lights walls, so REPLAYED is there.
 */
const wallOwnerRgb = (term) => {
  const i = history.findIndex((h) =>
    String(h.notation ?? "")
      .split(".")
      .includes(term),
  );
  if (i < 0) throw new Error(`no move of the game placed the wall ${term}`);
  if (!REPLAYED) throw new Error(`the wall ${term} is lit with no EDL`);
  return `rgb(${accents[REPLAYED.movers[i]].join(",")})`;
};
/**
 * The outer cells' box, as fractions of the image: a lit wall ends at its
 * edge, where the page's wall at the board's edge ends (measured on item
 * 13's >d1, 2026-10-30: the page's wall ends at the cell's edge, half a
 * groove inside GRID.y(rows)).
 */
const GRID_BOX = [
  GRID.x(0) + GROOVE.x / 2,
  GRID.y(0) + GROOVE.y / 2,
  GRID.x(GRID.cols) - GROOVE.x / 2,
  GRID.y(GRID.rows) - GROOVE.y / 2,
];
/**
 * The stage's lit walls (paintTrap) for the wall terms `terms` over the
 * position after `boardIndex` plies: each wall's line and its owner's
 * colour, the groove's width and the outer cells' box.
 * @param {string[]} terms
 * @param {number} boardIndex
 */
const litWalls = (terms, boardIndex) => ({
  walls: terms.map((w) => litWallLine(w, boardIndex)),
  colors: terms.map(wallOwnerRgb),
  groove: GROOVE,
  box: GRID_BOX,
});

/**
 * The punch-in that frames every term of a zoom: the scale, at most
 * `maxScale`, at which their box plus ZOOM_MARGIN cells fills the frame, and
 * the transform origin that puts the box's centre in the middle of it.
 *
 * With origin O and scale s, the image point p shows at O + s(p - O), so the
 * visible window is [O - O/s, O + (1 - O)/s] and its centre is the box's
 * centre C when O = (sC - 0.5) / (s - 1). O is kept inside the board, which
 * keeps every edge of the magnified board outside the frame.
 */
const ZOOM_MARGIN = 0.75;
/**
 * A zoom never cuts a pawn in half at the frame's edge (Wall Game Director,
 * 2026-10-29: the zoom on VX-IPenv ply 12 cut the red cat on f2). When the
 * window shows a pawn of `boards` (the board indexes the zoom shows) only
 * in part, it either grows until each such pawn is fully inside (the pawn
 * joins the box; a grown window can catch the next pawn, so it repeats), or
 * closes in on the same centre until each is fully outside, while it still
 * holds the terms plus CLOSE_MARGIN cells, at most CLOSE_MOST times the
 * scale asked and never above the EDL's largest zoom scale. Of the two, the scale nearer to
 * the one asked wins; a tie grows. The hold drifts `drift` above the scale
 * (zoomAt), and with one origin the windows nest: a pawn is safe for the
 * whole hold when it is whole in the smallest window or unseen in the
 * largest. A pawn left out still crosses the edge during the push and the
 * pull-out, as the camera moves. The 1.05 floor is for the frame asked; a grown window may go
 * down to 1.0, the whole board, which cuts nothing (only a drift above 1.0
 * can, and then a WARNING says so). Each change and each pawn still cut
 * also goes to `report(kind, message)` for the lint (edl.mjs LINT_KINDS
 * "zoom-scale", "zoom-cuts-pawn").
 */
const PAWN_AIR = 0.1;
const CLOSE_MARGIN = 0.3;
const CLOSE_MOST = 1.1;
const frameZoom = (
  terms,
  maxScale,
  { boards, drift = 0, label, report = () => {} },
) => {
  const boxes = terms.map(termBox);
  /** The terms' box plus `margin` cells, in cells. */
  const spanOf = (margin) => ({
    top: Math.min(...boxes.map((b) => b[0])) - margin,
    left: Math.min(...boxes.map((b) => b[1])) - margin,
    bottom: Math.max(...boxes.map((b) => b[2])) + margin,
    right: Math.max(...boxes.map((b) => b[3])) + margin,
  });
  const centreOf = (box) => ({
    x: GRID.x((box.left + box.right) / 2),
    y: GRID.y((box.top + box.bottom) / 2),
  });
  // At 1.0 any origin shows the whole board; the centre is where a drift
  // pushes in.
  const at = (scale, centre) => {
    const origin = (c) =>
      Math.max(
        0,
        Math.min(1, scale === 1 ? c : (scale * c - 0.5) / (scale - 1)),
      );
    return { scale, x: origin(centre.x), y: origin(centre.y) };
  };
  /** The scale at which `box` fills the frame `less` below its peak. */
  const fill = (box, floor, less) => {
    const w = (box.right - box.left) * GRID.pitchX;
    const h = (box.bottom - box.top) * GRID.pitchY;
    return Math.max(floor, Math.min(maxScale, 1 / Math.max(w, h) - less));
  };
  /** The window on the board image at `up` above the zoom's scale, 0..1. */
  const windowOf = (z, up) => {
    const s = z.scale + up;
    return {
      x0: z.x - z.x / s,
      x1: z.x + (1 - z.x) / s,
      y0: z.y - z.y / s,
      y1: z.y + (1 - z.y) / s,
    };
  };
  const eps = 1e-6;
  const pawns = boards.flatMap((b) => pawnSpots.get(b) ?? []);
  /**
   * The pawns that the window cuts at some time of the hold: not whole in
   * its smallest window (the peak) and seen in its largest (the hold's
   * start).
   */
  const cutBy = (z) => {
    const small = windowOf(z, drift);
    const large = windowOf(z, 0);
    return pawns.filter((p) => {
      const [x0, x1, y0, y1] = [
        p.x - p.w / 2,
        p.x + p.w / 2,
        p.y - p.h / 2,
        p.y + p.h / 2,
      ];
      const whole =
        x0 >= small.x0 - eps &&
        x1 <= small.x1 + eps &&
        y0 >= small.y0 - eps &&
        y1 <= small.y1 + eps;
      const seen =
        x0 < large.x1 && x1 > large.x0 && y0 < large.y1 && y1 > large.y0;
      return seen && !whole;
    });
  };
  const cells = (ps) => [...new Set(ps.map(drawnPawnCell))].join(", ");

  const box = spanOf(ZOOM_MARGIN);
  // As before T9: no drift in the asked fit, so a zoom that cuts no pawn
  // is the same to the byte.
  const asked = at(fill(box, 1.05, 0), centreOf(box));
  const cut = cutBy(asked);
  if (cut.length === 0) return asked;

  let grown = asked;
  const grownBox = { ...box };
  const grownFor = [];
  for (let pass = 0; pass < 6 && cutBy(grown).length > 0; pass += 1) {
    for (const p of cutBy(grown)) {
      grownFor.push(p);
      grownBox.top = Math.min(
        grownBox.top,
        (p.y - p.h / 2 - GRID.y(0)) / GRID.pitchY - PAWN_AIR,
      );
      grownBox.left = Math.min(
        grownBox.left,
        (p.x - p.w / 2 - GRID.x(0)) / GRID.pitchX - PAWN_AIR,
      );
      grownBox.bottom = Math.max(
        grownBox.bottom,
        (p.y + p.h / 2 - GRID.y(0)) / GRID.pitchY + PAWN_AIR,
      );
      grownBox.right = Math.max(
        grownBox.right,
        (p.x + p.w / 2 - GRID.x(0)) / GRID.pitchX + PAWN_AIR,
      );
    }
    grown = at(fill(grownBox, 1, drift), centreOf(grownBox));
  }

  const must = spanOf(CLOSE_MARGIN);
  const holds = (z) => {
    const v = windowOf(z, drift);
    return (
      Math.max(0, GRID.x(must.left)) >= v.x0 - eps &&
      Math.min(1, GRID.x(must.right)) <= v.x1 + eps &&
      Math.max(0, GRID.y(must.top)) >= v.y0 - eps &&
      Math.min(1, GRID.y(must.bottom)) <= v.y1 + eps
    );
  };
  // At most CLOSE_MOST above the scale asked, and never above the largest
  // scale an EDL may ask for (Wall Game Director, 2026-10-29, after Video
  // Reviewer 2 found "nearer wins" alone took 2.00 to 2.51 and 3.0 to
  // almost 5). Above the cap, close-in is no candidate and the zoom grows.
  const cap = Math.min(asked.scale * CLOSE_MOST, EDL_LIMITS.zoomScale[1]);
  let closer = null;
  let closeStop = "cap";
  for (let step = 1; asked.scale + step / 100 <= cap + eps; step += 1) {
    const z = at(asked.scale + step / 100, centreOf(box));
    if (!holds(z)) {
      closeStop = "frame";
      break;
    }
    if (cutBy(z).length === 0) {
      closer = z;
      break;
    }
  }
  const noCloser =
    closeStop === "frame"
      ? " (it cannot close in and keep the frame)"
      : ` (closing in needs more than ${cap.toFixed(2)}, the cap)`;

  const z =
    closer && closer.scale - asked.scale < asked.scale - grown.scale
      ? closer
      : grown;
  const change =
    z === closer
      ? `${label}: ${asked.scale.toFixed(2)} -> ${z.scale.toFixed(2)}, the window closes in and leaves the pawn on ${cells(cut)} out (to show it whole: ${grown.scale.toFixed(2)})`
      : `${label}: ${asked.scale.toFixed(2)} -> ${z.scale.toFixed(2)}, the window grows and shows the pawn on ${cells(grownFor)} whole${closer ? "" : noCloser}`;
  log(change);
  report("zoom-scale", change);
  const still = cutBy(z);
  if (still.length > 0) {
    const message = `${label} still cuts the pawn on ${cells(still)} at the frame's edge`;
    log(`WARNING: ${message}`);
    report("zoom-cuts-pawn", message);
  }
  return z;
};

if (EDL) {
  if (EDL.gameId !== GAME_ID) {
    console.error(`the EDL is for game ${EDL.gameId}, not ${GAME_ID}`);
    await browser.close();
    process.exit(2);
  }
  const problems = checkEdlAgainstGame(EDL, {
    notations: history.map((h) => h.notation),
    cols: GRID.cols,
    rows: GRID.rows,
    initialState: replay.state.initialState,
  });
  if (problems.length > 0) {
    console.error(`the EDL does not fit the game:\n  ${problems.join("\n  ")}`);
    await browser.close();
    process.exit(2);
  }
  // Every highlight on its wall before a frame is composed.
  for (const ev of EDL.events.filter((e) => e.kind === "trap")) {
    for (const w of ev.walls) litWallLine(w, ev.ply + 1);
  }
}

/** The music cues this render plays (playedCues): none with --no-music. */
const CUES = playedCues(START_PLY, LAST_BOARD - 1);
/**
 * The daily look's credit (music-tracks.mjs): each track that played and the
 * game sounds, on the video over its ending as one line per track (stage.html
 * #credit), and as one line of text in RESULT, so the post can carry the same
 * words.
 */
/** Each different track that played, once, in the order it first played. */
const PLAYED_TRACKS = [
  ...new Map(CUES.map((c) => [c.track.file, c.track])).values(),
];
const CREDIT_LINES = EDL ? creditLines(PLAYED_TRACKS) : null;
const CREDIT = CREDIT_LINES ? creditLine(PLAYED_TRACKS) : null;
/** How long the race counter takes to give its place to the credit. */
const CREDIT_FADE_SECONDS = 0.3;

/**
 * Each player's steps to their target at every position, from the game
 * record through shared/domain (race-replay.ts), the same numbers the
 * daily picker ranks by. The daily look shows them all video long (audit
 * item 1); a variant where a side hunts nothing (Survival) shows no counter,
 * and an EDL that flashes the counter there is refused.
 */
/** The game replayed from its moves: each position's state and walks. */
const REPLAYED = EDL
  ? replayDistances({
      variant: replay.state.config.variant,
      boardWidth: GRID.cols,
      boardHeight: GRID.rows,
      initialState: replay.state.initialState,
      moves: history.map((h) => h.notation),
    })
  : null;
const RACE_DISTANCES =
  REPLAYED && REPLAYED.distances.every((d) => d[1] !== null && d[2] !== null)
    ? REPLAYED.distances
    : null;

/**
 * Each path event's walks (edl.mjs "path"), keyed by the event: the hunt
 * whose hunter stands on its cell after the move, its walk in the position
 * after the move, and with `compare` its walk in the position before it.
 * huntPath walks as grid.distance does, so the steps drawn are the counter's.
 */
/**
 * A walk (huntPath) as the page draws it: its cells' centres on the board
 * image, and `holes`, the centres of the cells on it where another pawn
 * stands: the walk draws no dot there (Wall Game Director, 2026-10-29: a
 * walk that teaches "cat -> the other mouse" must not dot the other cat).
 */
const drawnWalk = (pawns, walk) => ({
  cells: walk,
  points: walk.map(([r, c]) => cellAt([r, c])),
  holes: pawnCellsOn(pawns, walk).map((i) => cellAt(walk[i])),
});
/**
 * How far into the blocked step a cut walk's line goes, as a part of the
 * step: its last dot stays clear of the wall (a dot's radius is about a
 * sixth of a cell, the wall is at half the step).
 */
const CUT_REACH = 0.25;
/**
 * A walk (drawnWalk, or a line made from one) as it may be drawn on a board
 * whose walls are `grid`'s: whole when the board blocks none of its steps,
 * else cut at the first blocked step, its line ending a little way into
 * that step, towards the wall, with `cut` set (the page draws no number
 * on it: the walk it counted is gone). A walk from an earlier position,
 * drawn after a move put a wall across it (a path's compared walk, an
 * explain's ghost), so shows where the new wall stops it, and never
 * crosses it (Nil, 2026-10-31, the revise of v-2026-10-31-9).
 */
const onBoard = (walk, grid) => {
  const k = firstBlockedStep(grid, walk.cells);
  if (k < 0) return walk;
  const [a, b] = [walk.points[k], walk.points[k + 1]];
  return {
    ...walk,
    cells: walk.cells.slice(0, k + 1),
    points: [
      ...walk.points.slice(0, k + 1),
      { x: a.x + (b.x - a.x) * CUT_REACH, y: a.y + (b.y - a.y) * CUT_REACH },
    ],
    cut: true,
  };
};
/**
 * The opening walks (edl.mjs introPaths), in the order they play: each
 * side's hunter to its target in the start position, the first mover's
 * first. Where a side hunts more than one pawn, its shortest walk: the
 * number the race counter shows for it. None without a counter (a variant
 * where no side hunts) or when the EDL turns them off.
 */
const INTRO_WALKS =
  EDL?.introPaths &&
  PLAYS_OPENING &&
  REPLAYED?.distances.every((d) => d[1] !== null && d[2] !== null)
    ? (() => {
        const start = REPLAYED.states[START_PLY];
        const first = REPLAYED.movers[START_PLY];
        return [first, first === 1 ? 2 : 1].map((player) => {
          const walks = huntsFor(start.config.variant)
            .filter((h) => h.hunter.player === player)
            .map((h) => huntPath(start.grid, start.pawns, h));
          const walk = walks.reduce((a, b) => (b.length < a.length ? b : a));
          return { player, ...drawnWalk(start.pawns, walk) };
        });
      })()
    : [];
/**
 * When each opening walk plays, in seconds from the first one's start: it
 * draws in drawSeconds; the next starts INTRO_WALK_GAP_SECONDS after it,
 * and it fades as the next one has drawn, so its number shows the whole
 * time; the last shows INTRO_PATH_HOLD_SECONDS, its fade included.
 */
const INTRO_PLAN = (() => {
  let at = 0;
  const plan = INTRO_WALKS.map((w) => {
    const p = { ...w, start: at, draw: drawSeconds(w.points), fadeAt: 0 };
    at = p.start + p.draw + INTRO_WALK_GAP_SECONDS;
    return p;
  });
  plan.forEach((p, k) => {
    const next = plan[k + 1];
    p.fadeAt = next
      ? next.start + next.draw
      : p.start + p.draw + INTRO_PATH_HOLD_SECONDS - PATH_FADE_SECONDS;
  });
  return plan;
})();
const PATHS = new Map();
for (const ev of EVENTS.filter((e) => e.kind === "path")) {
  const [row, col] = [
    GRID.rows - Number(ev.cell.slice(1)),
    ev.cell.charCodeAt(0) - "a".charCodeAt(0),
  ];
  const after = REPLAYED.states[ev.ply + 1];
  // Two cats may share a cell (cats do not catch cats): `hunter` says whose.
  const colours = SEAT_COLORS(replay);
  const hunts = huntsFor(after.config.variant).filter((h) => {
    const at = pawnCell(after.pawns, h.hunter.player, h.hunter.type);
    return (
      at &&
      at[0] === row &&
      at[1] === col &&
      (!ev.hunter || colours[h.hunter.player] === ev.hunter)
    );
  });
  const hunt = hunts.length === 1 ? hunts[0] : null;
  if (!hunt) {
    console.error(
      hunts.length > 1
        ? `the path event on ply ${ev.ply} names ${ev.cell}, where both hunters stand after the move: name one with "hunter": "red" or "blue"`
        : `the path event on ply ${ev.ply} names ${ev.cell}, and no ${ev.hunter ? `${ev.hunter} ` : ""}hunter stands there after the move`,
    );
    await browser.close();
    process.exit(2);
  }
  const walk = (state) =>
    drawnWalk(state.pawns, huntPath(state.grid, state.pawns, hunt));
  PATHS.set(ev, {
    player: hunt.hunter.player,
    walks: [
      // Drawn after the move, on its board: cut where the move's walls
      // stop it, so its draw time and its ticks are the cut walk's.
      ...(ev.compare
        ? [onBoard(walk(REPLAYED.states[ev.ply]), after.grid)]
        : []),
      walk(after),
    ],
  });
}
/** When a path event's last walk starts to draw: after the compared one. */
const lastWalkFrom = (ev) =>
  ev.compare
    ? drawSeconds(PATHS.get(ev).walks[0].points) + PATH_BEFORE_SECONDS
    : 0;
const pathSeconds = (ev) =>
  lastWalkFrom(ev) +
  drawSeconds(PATHS.get(ev).walks.at(-1).points) +
  ev.holdSeconds +
  PATH_FADE_SECONDS;
/**
 * Each explain event's facts (edl.mjs "explain"), from the game record as
 * the race counter has them: the hunter (the EDL's, or the side whose steps
 * change most), its shortest walk before and after the move with their
 * steps, and the walls the move placed. (No glow on a moved pawn's step:
 * Nil, 2026-10-30, C21: "the yellow highlight for the move arrow doesn't
 * look good. probably unnecessary".)
 */
const EXPLAINS = new Map();
for (const ev of EVENTS.filter((e) => e.kind === "explain" && !e.callback)) {
  if (!RACE_DISTANCES) {
    console.error(
      `the explain on ply ${ev.ply} draws a hunter's walk, and ${replay.state.config.variant} gives a side nothing to hunt`,
    );
    await browser.close();
    process.exit(2);
  }
  const [k0, k1] = [ev.ply, ev.ply + 1];
  const change = (id) =>
    Math.abs(RACE_DISTANCES[k1][id] - RACE_DISTANCES[k0][id]);
  const colours = SEAT_COLORS(replay);
  const red = colours[1] === "red" ? 1 : 2;
  const blue = red === 1 ? 2 : 1;
  // With no hunter named, the side whose steps change most; on a tie, red.
  const player = ev.hunter
    ? ev.hunter === "red"
      ? red
      : blue
    : change(blue) > change(red)
      ? blue
      : red;
  /*
    The walk drawn comes from huntPath and the steps shown from the race
    counter (RACE_DISTANCES): the same BFS today, and a walk that does not
    match its number stops the render (Video Reviewer 1, review 75).
  */
  const walkIn = (state, k) => {
    const walks = huntsFor(state.config.variant)
      .filter((h) => h.hunter.player === player)
      .map((h) => huntPath(state.grid, state.pawns, h));
    if (walks.length === 0) {
      throw new Error(
        `the explain on ply ${ev.ply}: ${colours[player]} hunts nothing in ${state.config.variant}`,
      );
    }
    const walk = walks.reduce((a, b) => (b.length < a.length ? b : a));
    if (walk.length - 1 !== RACE_DISTANCES[k][player]) {
      throw new Error(
        `the explain on ply ${ev.ply}: ${colours[player]}'s walk after ${k} plies has ${walk.length - 1} steps, and the race counter says ${RACE_DISTANCES[k][player]}`,
      );
    }
    return drawnWalk(state.pawns, walk);
  };
  const before = REPLAYED.states[k0];
  const after = REPLAYED.states[k1];
  EXPLAINS.set(ev, {
    player,
    before: walkIn(before, k0),
    after: walkIn(after, k1),
    steps: [RACE_DISTANCES[k0][player], RACE_DISTANCES[k1][player]],
    walls: String(history[ev.ply].notation ?? "")
      .split(".")
      .filter((t) => t.startsWith(">") || t.startsWith("^")),
  });
}
/**
 * `grid` with the wall `term` taken out: the board a callback explain shows
 * while that wall is gone.
 */
const gridWithout = (grid, term) => {
  const gone = wallFromStandardNotation(term, GRID.rows);
  const out = new Grid(grid.width, grid.height, grid.variant);
  for (const w of grid.getWalls()) {
    const same =
      w.orientation === gone.orientation &&
      w.cell[0] === gone.cell[0] &&
      w.cell[1] === gone.cell[1];
    if (!same) out.addWall(w);
  }
  return out;
};
/** The ply whose move placed the wall `term`, or -1. */
const plyOfWall = (term) =>
  history.findIndex((h) =>
    String(h.notation ?? "")
      .split(".")
      .includes(term),
  );
/**
 * The walls of the position after `boardIndex` plies that end at the point
 * `end` (0..1 on the board image), in notation, but `term`.
 */
const wallsEndingAt = (boardIndex, end, term) =>
  REPLAYED.states[boardIndex].grid
    .getWalls()
    .map((w) => wallToStandardNotation(w, GRID.rows))
    .filter((t) => t !== term)
    .filter((t) => {
      const [x1, y1, x2, y2] = wallLine(t);
      return [
        [x1, y1],
        [x2, y2],
      ].some(
        ([x, y]) =>
          Math.abs(x - end[0]) < GRID.pitchX / 10 &&
          Math.abs(y - end[1]) < GRID.pitchY / 10,
      );
    });
/** How close a pawn's move arrow on the page may come to an erased wall. */
const ARROW_CLEAR_CELLS = 0.3;
/** The distance from point p to the box [x0, y0, x1, y1], in cells. */
const boxDistance = (p, [x0, y0, x1, y1]) =>
  Math.hypot(
    Math.max(x0 - p.x, 0, p.x - x1) / GRID.pitchX,
    Math.max(y0 - p.y, 0, p.y - y1) / GRID.pitchY,
  );

/**
 * Each callback explain's facts (edl.mjs "explain" with `callback`): the
 * hunter, its walk on the position after the move with the old wall W and
 * without it, and how the frames take W away. The board is a screenshot,
 * so W is covered with the same spot of the screenshot from before W's
 * move (the same capture: the pixels match), its groove and its two
 * joints. A joint where a later wall meets W draws that wall's round end
 * as the page draws a lone wall's end (a half-disc, its tip on the joint's
 * centre): a disc of the wall's own pixels, from one groove further along
 * it. A joint the renderer cannot draw without W (two or more later
 * walls) stops the render (callback-joint), and so does a page mark that
 * the old spot would cover or bring back: a glow of a move's new walls at
 * W's ends, or a move arrow near W (callback-cover).
 */
const CALLBACKS = new Map();
for (const ev of EVENTS.filter((e) => e.kind === "explain" && e.callback)) {
  const term = ev.callback.wall;
  const where = `the callback explain on ply ${ev.ply}`;
  const wallPly = plyOfWall(term);
  if (!RACE_DISTANCES || wallPly < 0 || wallPly >= ev.ply) {
    console.error(
      !RACE_DISTANCES
        ? `${where} draws a hunter's walk, and ${replay.state.config.variant} gives a side nothing to hunt`
        : `${where} names ${term}, and no move before ply ${ev.ply} placed it`,
    );
    await browser.close();
    process.exit(2);
  }
  const board = ev.ply + 1;
  const state = REPLAYED.states[board];
  const without = gridWithout(state.grid, term);
  const hunts = huntsFor(state.config.variant);
  const withSteps = RACE_DISTANCES[board];
  const withoutSteps = raceFromWalks(
    hunts,
    walksOn(hunts, without, state.pawns),
  );
  const colours = SEAT_COLORS(replay);
  const red = colours[1] === "red" ? 1 : 2;
  const blue = red === 1 ? 2 : 1;
  const change = (id) => Math.abs(withSteps[id] - withoutSteps[id]);
  const player = ev.hunter
    ? ev.hunter === "red"
      ? red
      : blue
    : change(blue) > change(red)
      ? blue
      : red;
  const walkOn = (grid) =>
    hunts
      .filter((h) => h.hunter.player === player)
      .map((h) => huntPath(grid, state.pawns, h))
      .reduce((a, b) => (b.length < a.length ? b : a));
  const walks = [walkOn(without), walkOn(state.grid)];
  const steps = [withoutSteps[player], withSteps[player]];
  walks.forEach((w, k) => {
    if (w.length - 1 !== steps[k]) {
      throw new Error(
        `${where}: ${colours[player]}'s walk ${k === 0 ? "without" : "with"} ${term} has ${w.length - 1} steps, and the count says ${steps[k]}`,
      );
    }
  });
  const faults = { joint: [], cover: [] };
  const [x1, y1, x2, y2] = wallLine(term);
  const ends = [
    [x1, y1],
    [x2, y2],
  ];
  const px = { x: 1 / clip.width, y: 1 / clip.height };
  const box = [
    Math.min(x1, x2) - GROOVE.x / 2 - px.x,
    Math.min(y1, y2) - GROOVE.y / 2 - px.y,
    Math.max(x1, x2) + GROOVE.x / 2 + px.x,
    Math.max(y1, y2) + GROOVE.y / 2 + px.y,
  ];
  const caps = [];
  for (const end of ends) {
    const now = wallsEndingAt(board, end, term);
    const then = wallsEndingAt(wallPly, end, term);
    if (now.join() === then.join()) continue;
    if (now.length === 1 && then.length === 0) {
      const [a1, b1, a2, b2] = wallLine(now[0]);
      const far =
        Math.abs(a1 - end[0]) + Math.abs(b1 - end[1]) <
        Math.abs(a2 - end[0]) + Math.abs(b2 - end[1])
          ? [a2, b2]
          : [a1, b1];
      const horizontal = b1 === b2;
      const u = [Math.sign(far[0] - end[0]), Math.sign(far[1] - end[1])];
      // The joint's half-length along the wall; its thickness across.
      const along = horizontal ? GROOVE.x : GROOVE.y;
      const r = horizontal
        ? (GROOVE.y * clip.height) / 2
        : (GROOVE.x * clip.width) / 2;
      caps.push({
        cx: end[0] + (u[0] * along) / 2,
        cy: end[1] + (u[1] * along) / 2,
        rx: r / clip.width,
        ry: r / clip.height,
        dx: -u[0] * along,
        dy: -u[1] * along,
      });
    } else {
      faults.joint.push(
        `${where}: ${term} meets ${now.join(" ")} at one end, and ${now.filter((t) => !then.includes(t)).join(" ")} came after ply ${wallPly}; the video cannot draw that joint without ${term}: pick another wall or ply`,
      );
    }
  }
  // The page's marks of the two boards' last moves: the glow on a move's
  // new walls, and the arrow of each pawn it moved.
  for (const k of [wallPly - 1, ev.ply]) {
    if (k < 0) continue;
    const terms = String(history[k].notation ?? "").split(".");
    const glowing = terms.filter(
      (t) =>
        (t.startsWith(">") || t.startsWith("^")) &&
        t !== term &&
        ends.some((end) => wallsEndingAt(k + 1, end, term).includes(t)),
    );
    if (glowing.length > 0) {
      faults.cover.push(
        `${where}: ply ${k} placed ${glowing.join(" ")} at an end of ${term}, and the page's glow on it differs between the two screenshots`,
      );
    }
    const [from, to] = [REPLAYED.states[k].pawns, REPLAYED.states[k + 1].pawns];
    for (const p of boardPawns(to)) {
      const was = pawnCell(from, p.playerId, p.type);
      if (!was || (was[0] === p.cell[0] && was[1] === p.cell[1])) continue;
      const [a, b] = [cellAt(was), cellAt(p.cell)];
      const near = Array.from({ length: 21 }, (_, i) => i / 20).some(
        (f) =>
          boxDistance(
            { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f },
            box,
          ) < ARROW_CLEAR_CELLS,
      );
      if (near) {
        faults.cover.push(
          `${where}: the page's arrow for ply ${k}'s ${p.type} passes ${term}, and the old spot would cover or bring it back`,
        );
      }
    }
  }
  CALLBACKS.set(ev, {
    board,
    player,
    term,
    wallPly,
    without,
    walks: walks.map((w) => drawnWalk(state.pawns, w)),
    steps,
    // Both sides' counts without the wall: the counter shows them while
    // the wall is gone, so the frame never says two things.
    withoutSteps,
    erase: { wall: term, oldBoard: wallPly, box, caps },
    faults,
  });
}
// The strip's values (edl.mjs evalStrip) are one a position of this game.
if (EDL?.evalStrip && EDL.evalStrip.length !== history.length + 1) {
  console.error(
    `evalStrip lists ${EDL.evalStrip.length} values, and the game's ${history.length} moves have ${history.length + 1} positions`,
  );
  await browser.close();
  process.exit(2);
}
// A plant glows a wall its own move places.
for (const ev of EVENTS.filter((e) => e.kind === "plant")) {
  if (plyOfWall(ev.wall) !== ev.ply) {
    console.error(
      `the plant on ply ${ev.ply} names ${ev.wall}, which that ply's move (${history[ev.ply]?.notation}) does not place`,
    );
    await browser.close();
    process.exit(2);
  }
}
/**
 * The walls a frame shows of the position after `boardIndex` plies: with a
 * callback's wall fully taken away (`erase.a` 1), all but that one.
 */
const gridShown = (boardIndex, erase) => {
  if (!(erase && erase.a >= 1)) return REPLAYED.states[boardIndex].grid;
  const c = [...CALLBACKS.values()].find(
    (x) => x.erase.wall === erase.wall && x.board === boardIndex,
  );
  if (!c) {
    throw new Error(
      `a frame takes ${erase.wall} away on board ${boardIndex}, which no callback shows`,
    );
  }
  return c.without;
};
if (EDL && !RACE_DISTANCES && EVENTS.some((e) => e.kind === "race")) {
  console.error(
    `the EDL flashes the race counter, but ${replay.state.config.variant} gives a side nothing to hunt, so the video shows no counter`,
  );
  await browser.close();
  process.exit(2);
}

/**
 * The facts each overlay event reads from the game (overlays.mjs), keyed by
 * the event, so a render that cannot draw one stops before any frame:
 *   loading  the player whose hunter is closest after the move (the mover
 *            on a tie), and the board where its steps first rise (the save).
 *   compare  the player whose steps rose most with the move: before, after.
 *   sequence the clip's frames as file URLs, checked against the hashes the
 *            registry pins (overlay-clips.mjs loadClip), and its fps.
 *   image    the picture as a file URL, checked against the hash the
 *            registry pins.
 *   card     the player whose colour it takes, for a card with a seat.
 *   pawn     for an asset a pawn emotes (overlays.mjs `pawn`): that pawn's
 *            player, and its cell once the ply's move has landed (its ply
 *            holds while it shows, so the pawn stays there).
 */
const OVERLAY_FACTS = new Map();
for (const ev of [
  ...EVENTS.filter((e) => e.kind === "overlay"),
  ...(OPENING ? [OPENING] : []),
]) {
  const draw = OVERLAYS[ev.asset].draw;
  if (takesPawn(OVERLAYS[ev.asset])) {
    const pawn = parsePawn(ev.pawn);
    const player = SEAT_COLORS(replay)[1] === pawn.seat ? 1 : 2;
    const cell = pawnCell(
      REPLAYED.states[ev.ply + 1].pawns,
      player,
      pawn.piece,
    );
    if (!cell) {
      console.error(
        `ply ${ev.ply}: the ${ev.asset} overlay is tied to the ${ev.pawn}, and ${replay.state.config.variant} gives ${pawn.seat} no ${pawn.piece}`,
      );
      await browser.close();
      process.exit(2);
    }
    OVERLAY_FACTS.set(ev, { player, cell });
  }
  if (draw === "image") {
    const { file, sha256 } = OVERLAYS[ev.asset].image;
    const path = join(REPO, VISUAL_MEME_DIR, file);
    const got = existsSync(path) ? sha256Of(path) : null;
    if (got !== sha256) {
      console.error(
        `ply ${ev.ply}: the ${ev.asset} overlay's picture ${VISUAL_MEME_DIR}/${file} ${got === null ? "is missing here; copy it from the director's assets/visual-memes and sync the render kit" : `is ${got}, the registry pins ${sha256}`}`,
      );
      await browser.close();
      process.exit(2);
    }
    OVERLAY_FACTS.set(ev, { ...OVERLAY_FACTS.get(ev), src: fileUrl(path) });
  }
  if ((draw === "card" || draw === "redraw") && ev.seat !== undefined) {
    OVERLAY_FACTS.set(ev, {
      player: SEAT_COLORS(replay)[1] === ev.seat ? 1 : 2,
    });
  }
  if (draw === "sequence") {
    try {
      const asset = OVERLAYS[ev.asset];
      const clip = loadClip(ev.asset, asset.sequence, REPO);
      OVERLAY_FACTS.set(ev, {
        fps: clip.fps,
        frames: clip.files.map(fileUrl),
        // Its own sound, when the EDL plays it (edl.mjs `audio`).
        audio: ev.audio === "own" ? clip.audio : null,
        // A cover clip's pixels, for what it hides (placeOverlays).
        ...(asset.form === "cover"
          ? {
              coverage: clipCoverage(clip.files, clip.width, clip.height),
              aspect: clip.width / clip.height,
            }
          : {}),
      });
    } catch (err) {
      console.error(`ply ${ev.ply}: ${err.message}`);
      await browser.close();
      process.exit(2);
    }
  }
  if ((draw === "loading" || draw === "compare") && !RACE_DISTANCES) {
    console.error(
      `the ${ev.asset} overlay on ply ${ev.ply} reads the race counter, and ${replay.state.config.variant} shows none`,
    );
    await browser.close();
    process.exit(2);
  }
  const at = ev.ply + 1;
  if (draw === "loading") {
    const d = RACE_DISTANCES[at];
    const mover = REPLAYED.movers[ev.ply];
    const other = mover === 1 ? 2 : 1;
    const player = d[other] < d[mover] ? other : mover;
    let rise = null;
    for (let b = at + 1; b < RACE_DISTANCES.length && rise === null; b += 1) {
      if (RACE_DISTANCES[b][player] > RACE_DISTANCES[b - 1][player]) rise = b;
    }
    if (rise === null) {
      console.error(
        `the capture loading bar on ply ${ev.ply} waits for a save, and the steps of the closest hunter never rise after it`,
      );
      await browser.close();
      process.exit(2);
    }
    OVERLAY_FACTS.set(ev, { player, rise });
  }
  if (draw === "compare") {
    const [before, after] = [RACE_DISTANCES[ev.ply], RACE_DISTANCES[at]];
    const player = [1, 2]
      .filter((id) => after[id] > before[id])
      .sort((a, b) => after[b] - before[b] - (after[a] - before[a]))[0];
    if (player === undefined) {
      console.error(
        `the path-compare overlay on ply ${ev.ply} compares a walk that grew, and no side's steps rose with that move`,
      );
      await browser.close();
      process.exit(2);
    }
    OVERLAY_FACTS.set(ev, {
      player,
      before: before[player],
      after: after[player],
    });
  }
}

/**
 * The hunter's and the target's cells of the closest hunt at a board, as
 * [row, col]: the race's moment, which an overlay must not hide. None in a
 * variant where nothing hunts.
 */
const closestHunts = new Map();
const closestHuntAt = (boardIndex) => {
  if (!closestHunts.has(boardIndex)) {
    const st = REPLAYED.states[boardIndex];
    const walks = huntsFor(st.config.variant).map((h) =>
      huntPath(st.grid, st.pawns, h),
    );
    const best = walks.reduce(
      (a, w) => (a === null || w.length < a.length ? w : a),
      null,
    );
    closestHunts.set(boardIndex, best ? [best[0], best.at(-1)] : []);
  }
  return closestHunts.get(boardIndex);
};

/**
 * The variant's goal in one line, from the rules guide's own sentence
 * (shared/domain/variant-rules.ts), for the daily VS card. Null when the
 * variant has no rules guide.
 */
/**
 * The rules in one line, for a viewer who does not know the game (Nil and
 * Wall Game Director, 2026-10-28): the head row shows it while the VS overlay
 * is in, where the goal sentence (variant-rules.ts GOAL_SENTENCES) was, which
 * it contains. Keyed by the variant's captureKind, as GOAL_SENTENCES is. Each
 * side has a cat AND a mouse, so the line says which hunts which.
 */
const RULES_LINES = {
  // A viewer plays neither side, so "your cat" would not say whose.
  "cat-captures-mouse":
    "each cat hunts the other mouse · walls block · first catch wins",
  "reach-home": "each cat races home · walls block · first home wins",
  "animal-cycle": "each animal hunts the next · walls block · first catch wins",
};
/**
 * What the race counter counts, under its VS: cells to walk (the grid
 * distance), not turns, since a turn can hold more than one action.
 */
const RACE_LABELS = {
  "cat-captures-mouse": "STEPS TO CATCH",
  "reach-home": "STEPS HOME",
  "animal-cycle": "STEPS TO CATCH",
};
const RULES_VARIANT = helpVariantFor(replay.state.config.variant);
/** The variant's captureKind; null for one with no rules guide (Survival). */
const CAPTURE_KIND = RULES_VARIANT
  ? helpRulesFor(RULES_VARIANT).captureKind
  : null;
/** The head row's line during the VS overlay (stage.html #goal). */
const GOAL_LINE = EDL && CAPTURE_KIND ? RULES_LINES[CAPTURE_KIND] : null;
if (
  CAPTURE_KIND &&
  (!Object.hasOwn(RULES_LINES, CAPTURE_KIND) ||
    !Object.hasOwn(RACE_LABELS, CAPTURE_KIND))
) {
  // A new kind in variant-rules.ts needs its words here, not a blank.
  console.error(
    `captureKind ${CAPTURE_KIND} has no rules line or race label (RULES_LINES, RACE_LABELS)`,
  );
  await browser.close();
  process.exit(2);
}
const RACE_LABEL = CAPTURE_KIND ? RACE_LABELS[CAPTURE_KIND] : "STEPS";

/**
 * The 9:16 frame of the wallz look. The caption, the head row and the board
 * stack inside SAFE_AREA (edl.mjs), SHAKE_ROOM in from its edges so the
 * shakes stay inside too; the stage then sizes the board to what is left
 * (window.__fitWallz), so --board here is only a first guess. A --head-gap
 * of 37 px gives 40 px between the drawn boxes (the boxes add 3 px of inner
 * space) from the caption to the head row and from the head row to the
 * board (Director, 2026-10-29): the board gives up the room.
 */
const SHAKE_ROOM = 16;
const WALLZ_LAYOUT = {
  width: DAILY_FRAME.w,
  height: DAILY_FRAME.h,
  vars: {
    ...frameVars(DAILY_FRAME.h, SAFE_AREA.w - 2 * SHAKE_ROOM, 0),
    "--caption-size": "56px",
    "--caption-gap": "36px",
    "--head-gap": "37px",
    "--shake-room": `${SHAKE_ROOM}px`,
    "--safe-top": `${SAFE_AREA.y}px`,
    "--safe-left": `${SAFE_AREA.x}px`,
    "--safe-right": `${DAILY_FRAME.w - SAFE_AREA.x - SAFE_AREA.w}px`,
    "--safe-bottom": `${DAILY_FRAME.h - SAFE_AREA.y - SAFE_AREA.h}px`,
    "--strip-w": `${STRIP_AREA.w}px`,
    "--strip-area-top": `${STRIP_AREA.y}px`,
    "--strip-area-bottom": `${STRIP_AREA.y + STRIP_AREA.h}px`,
  },
};

const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/**
 * The camera scale at `t` seconds into a punch-in to `scale` that holds for
 * `hold`. It drifts in a little during the hold, so the frame never freezes.
 */
const ZOOM_DRIFT = 0.04;
const zoomAt = (t, scale, hold) => {
  if (t < ZOOM_IN) return 1 + (scale - 1) * easeOut(t / ZOOM_IN);
  if (t < ZOOM_IN + hold) return scale + (ZOOM_DRIFT * (t - ZOOM_IN)) / hold;
  const back = Math.min(1, (t - ZOOM_IN - hold) / ZOOM_OUT);
  return scale + ZOOM_DRIFT - (scale + ZOOM_DRIFT - 1) * easeInOut(back);
};

function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The contact sheet of a daily render: its stills side by side, each labelled
 * with its ply, its event and its sound, written next to the mp4 as
 * <name>-sheet.png. It comes from the same capture as the video, so it costs
 * the game no view, and the director checks it before Nil sees anything.
 *
 * The labels are laid out by the browser, not drawn by ffmpeg: the ffmpeg on
 * some boxes has no drawtext.
 */
const SHEET_TILE_WIDTH = 360;
const writeContactSheet = async (stills, out) => {
  if (stills.length === 0) return null;
  const png = out.replace(/(\.mp4)?$/, "-sheet.png");
  const tiles = stills.map((st) => ({
    src: `data:image/png;base64,${readFileSync(st.file).toString("base64")}`,
    label: `ply ${st.ply} (move ${st.ply + 1}) - ${st.kind}${st.sound ? ` - ${st.sound}` : ""}${st.place ? ` - ${placeName(st.place)}` : ""} - ${st.at.toFixed(1)}s`,
  }));
  const page = await browser.newPage({
    viewport: { width: 400, height: 400 },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<body style="margin:0;background:#111;font:600 16px sans-serif;color:#eee">
       <div id="g" style="display:grid;gap:12px;padding:12px;
         grid-template-columns:repeat(${Math.min(4, tiles.length)},${SHEET_TILE_WIDTH}px)"></div>
     </body>`,
  );
  await page.evaluate((list) => {
    for (const t of list) {
      const cell = document.createElement("div");
      const img = document.createElement("img");
      img.src = t.src;
      img.style.width = "100%";
      img.style.display = "block";
      const cap = document.createElement("div");
      cap.textContent = t.label;
      cap.style.padding = "6px 2px";
      cell.append(img, cap);
      document.getElementById("g").append(cell);
    }
  }, tiles);
  await page.evaluate(() =>
    Promise.all([...document.images].map((i) => i.decode())),
  );
  await page.screenshot({ path: png, fullPage: true });
  await page.close();
  return {
    png,
    sha256: sha256Of(png),
    stills: stills.map(({ ply, kind, sound, place }) => ({
      ply,
      kind,
      sound,
      place: place ? { where: place.where, small: place.scale < 1 } : null,
    })),
  };
};

/**
 * Compose, mix, encode and verify one style from the board captures above.
 * Returns what the RESULT line reports.
 */
const renderStyle = async (styleName) => {
  const composeStarted = Date.now();
  const wallz = STYLES[styleName].look === "wallz";
  const style = wallz
    ? { ...STYLES[styleName], ending: EDL.ending }
    : STYLES[styleName];
  const pace = PACE_OVERRIDE ? Number(PACE_OVERRIDE) : style.secondsPerMove;
  /**
   * Seconds per move at a ply: the EDL's pace where it sets one (daily),
   * rounded to whole frames, so a move lasts the same inside the VS overlay
   * (which splits it into single frames) as outside it.
   */
  const paceAt = (plyIndex) =>
    Math.round(
      ((wallz &&
        EDL.pace.find((r) => r.fromPly <= plyIndex && plyIndex <= r.toPly)
          ?.secondsPerMove) ||
        pace) * FPS,
    ) / FPS;
  /** The fastForward range (edl.mjs) that holds a ply, or undefined. */
  const fastRangeOf = (plyIndex) =>
    wallz
      ? EDL.pace.find(
          (r) => r.fastForward && r.fromPly <= plyIndex && plyIndex <= r.toPly,
        )
      : undefined;
  /** The speed tag over the position a fast move led to, or null. */
  const fastForwardAt = (boardIndex) => {
    const r = fastRangeOf(boardIndex - 1);
    return r ? fastForwardTag(r.secondsPerMove) : null;
  };
  const layout = wallz ? WALLZ_LAYOUT : LAYOUT;
  const sounds = soundsFor(styleName);
  const out = outFor(styleName);
  const work = join(WORK, styleName);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  log(
    `style ${styleName}: ${layout.width}x${layout.height}, ${pace}s per move` +
      (wallz
        ? `, ${EVENTS.length} EDL events, ending ${EDL.ending}, finish word ${FINISH_WORD ?? "(none)"}`
        : ""),
  );

  /**
   * The stage as every frame needs it: the layout's size and variables, the
   * fonts in, and the daily board fitted. The main page and each shoot
   * worker open it this same way, so they paint a state the same way.
   * Returns the page and the daily board's size (null in the current look).
   */
  const seatColors = wallz ? SEAT_COLORS(replay) : null;
  /** The seats as the daily look orders them: red on the left, blue on the right. */
  const [redSeat, blueSeat] = seatColors?.[1] === "blue" ? [2, 1] : [1, 2];
  /**
   * The name the daily look shows for a player, wherever it shows one: the
   * strip, an overlay's {red}/{blue}, the ending (edl.mjs dailySeatNames:
   * "Bot" or "Human"; two bots "Red Bot" and "Blue Bot", two humans "Red" and "Blue").
   */
  const seatOf = (id) => {
    const seat = apiPlayers.find((p) => p.playerId === id);
    // A seat missing from the game's players is a data fault: stop, never
    // name it "Human" by default (VR1, review 79).
    if (!seat) throw new Error(`seat ${id} is not in the game's players`);
    return seat;
  };
  const dailyNames = dailySeatNames({
    red: seatOf(redSeat),
    blue: seatOf(blueSeat),
  });
  const dailyName = (id) => (id === redSeat ? dailyNames.red : dailyNames.blue);
  /**
   * A side as the daily VS overlay shows it: its daily name, never a
   * player's (Nil, 2026-10-26: "AI (in Red) vs Human (in Blue)"; 2026-10-29:
   * Bot and Human, as everywhere else), drawn in the side's colour. No
   * emoji: Nil found the first version "too crowded".
   */
  const overlaySide = (playerId) => ({
    ...side(playerId),
    word: dailyName(playerId),
  });
  /**
   * The players strip under the daily board (stage.html #strip): each side's
   * portrait and its daily name in its colour.
   */
  const stripSide = (id) => ({
    name: dailyName(id),
    portrait: side(id).portrait,
    hex: side(id).hex,
  });
  const strip = wallz
    ? { a: stripSide(redSeat), b: stripSide(blueSeat) }
    : null;
  const openStage = async (owner) => {
    const page = await owner.newPage({
      viewport: { width: layout.width, height: layout.height },
      deviceScaleFactor: 1,
    });
    await page.goto(`file://${join(HERE, "stage.html")}`, {
      waitUntil: "load",
    });
    await page.evaluate((vars) => {
      for (const [k, v] of Object.entries(vars)) {
        document.documentElement.style.setProperty(k, v);
      }
    }, layout.vars);
    // The text timings it paints with (overlays.mjs TEXT_TIMING).
    await page.evaluate((t) => {
      window.__TEXT_TIMING = t;
    }, TEXT_TIMING);
    /*
      The VS names are fitted by measuring them, and a measurement taken while
      a font still loads is wrong, so no frame is taken before the fonts are in.
    */
    await page.evaluate(() => document.fonts.ready);
    /** The daily look's board, sized by the stage to what the safe area leaves. */
    const board = wallz
      ? await page.evaluate((a) => window.__fitWallz(a), {
          captions: CAPTIONS,
          hud: Boolean(RACE_DISTANCES || GOAL_LINE),
          goal: GOAL_LINE,
          raceLabel: RACE_LABEL,
          credit: CREDIT_LINES,
          strip,
          cta: EDL?.cta ?? null,
          evalStrip: Boolean(EDL?.evalStrip),
          ending: style.ending,
          // The widest speed tag, for the counter's middle (stage.html).
          fastForward:
            (EDL?.pace ?? [])
              .filter((r) => r.fastForward)
              .map((r) => fastForwardTag(r.secondsPerMove))
              .reduce((a, b) => (b.length > a.length ? b : a), "") || null,
        })
      : null;
    return { page, board };
  };
  const { page: stage, board: dailyBoard } = await openStage(browser);
  if (wallz) log(`daily board ${dailyBoard}px, inside the safe area`);

  /**
   * Published by stage.html: each ending's length, hold, impact second and
   * white flash.
   */
  const endingTimings = await stage.evaluate(() => window.__ENDINGS);
  /** A stamp's length from its landing: punch, reading time, fade. */
  const stampSeconds = (text) =>
    Math.max(
      STAMP_SECONDS,
      TEXT_TIMING.stampPunch + readingSeconds({}, text) + TEXT_TIMING.stampFade,
    );

  /** Published by stage.html, so the sting can be aligned to the visual punch. */
  const vsPunchFraction = await stage.evaluate(
    () => window.__VS_PUNCH_FRACTION,
  );

  /**
   * The timeline, with the exact seconds and semantic range for each image.
   * Encoding later converts every duration to an integer 30 fps frame count.
   * `elapsed` is where the next image starts, and every sound cue is taken
   * from it, so the soundtrack follows the picture by construction.
   */
  const timeline = [];
  const cues = [];
  let elapsed = 0;
  /**
   * The list's faults that composing finds (R1, Wall Game Director,
   * 2026-10-29: "report EVERY fault at once, with ply and second"): its
   * kind (edl.mjs LINT_KINDS), the 0-based ply (null for the whole video),
   * the video second, whether it stops a render, and a one-line message.
   * Composing goes on past each one; before the shoot pass a render stops
   * on those that stop it and names them all, and --lint reports them all.
   * A kind that is a note (the renderer changed something on its own) goes
   * to `notes` instead.
   */
  const faults = [];
  const notes = [];
  const fault = (kind, ply, message, at = elapsed) => {
    const how = LINT_KINDS[kind];
    if (!how) throw new Error(`${kind} is not in edl.mjs LINT_KINDS`);
    const item = {
      kind,
      ply: ply ?? null,
      at: Number(at.toFixed(2)),
      message: message.replace(/\s*\n\s*/g, "; "),
    };
    if (how === "note") notes.push(item);
    else faults.push({ ...item, stops: how === "stops" });
  };
  // A reactor with no right pawn to show (REACTOR_ART) stops here, before
  // any frame is composed.
  for (const [ev, art] of REACTOR_ART) {
    if ("stop" in art) fault("reactor-pawn", ev.ply, art.stop, 0);
    if ("recapture" in art)
      fault("reactor-capture", ev.ply, `the ${ev.asset}: ${art.recapture}`, 0);
  }
  const cue = (sound, role, { at = elapsed, event = null } = {}) => {
    // A time built from a missing value is NaN, and ffmpeg's mix refuses it
    // with no word on which sound (2026-10-29): stop here and name it.
    if (!Number.isFinite(at) || at < 0) {
      throw new Error(
        `the ${sound.name} sound (${role}) has no valid time: ${at} s. A value its time is built from is missing or wrong`,
      );
    }
    cues.push({
      file: sound.file,
      gain: sound.gain,
      at,
      rate: sound.rate ?? 1,
      // A meme sound is measured against the rest of the mix (mix-loudness.mjs);
      // so is an overlay clip's own sound, which names itself.
      meme: sound.meme ?? (sound.name in MEME_SOUNDS ? sound.name : null),
      // For RESULT.timeline (timeline-frames.mjs videoTimeline).
      name: sound.name,
      role,
      event,
    });
  };
  /** For RESULT.timeline: the second each move lands, and each event's span. */
  const moveTimes = [];
  const eventSpans = [];
  /**
   * The evaluation strip over the position after `boardIndex` plies, now:
   * red's share of the engine's view (edl.mjs evalStrip, player 1's view
   * from -1 to 1), red on the left; moving from the last position's share
   * as the move lands; `swing` while a blunder or brilliant mark's swing
   * flashes. Null in a video without one.
   */
  const evalStripAt = (boardIndex) => {
    if (!wallz || !EDL?.evalStrip) return null;
    const red = seatColors[1] === "red" ? 1 : 2;
    const blue = red === 1 ? 2 : 1;
    const share = (b) =>
      red === 1 ? (1 + EDL.evalStrip[b]) / 2 : (1 - EDL.evalStrip[b]) / 2;
    const to = share(boardIndex);
    const landed =
      boardIndex > 0
        ? moveTimes.findLast((m) => m.ply === boardIndex - 1)
        : undefined;
    const strip = { left: side(red).hex, right: side(blue).hex };
    if (!landed) return { ...strip, x: to, swing: null };
    const from = share(boardIndex - 1);
    const t = elapsed - landed.at;
    // The swing flashes with the move's "??" or "!!", as it pops.
    const mark = markAt.get(boardIndex - 1);
    const m = mark === undefined ? null : elapsed - mark;
    return {
      ...strip,
      x: from + (to - from) * easeInOut(Math.min(1, t / EVAL_MOVE_SECONDS)),
      swing:
        m !== null && m >= 0 && m < EVAL_FLASH_SECONDS
          ? { from, to, t: m / EVAL_FLASH_SECONDS }
          : null,
    };
  };
  /** When each ply's blunder or brilliant mark started, for the strip. */
  const markAt = new Map();
  /** Whether the strip still moves on the board `boardIndex`. */
  const evalMoving = (boardIndex) => {
    if (!wallz || !EDL?.evalStrip || !(boardIndex > 0)) return false;
    const landed = moveTimes.findLast((m) => m.ply === boardIndex - 1);
    return !!landed && elapsed - landed.at < EVAL_MOVE_SECONDS;
  };
  /** An EDL event has played from `start` to now. */
  const spanOf = (ev, start) =>
    eventSpans.push({
      index: EVENTS.indexOf(ev),
      ply: ev.ply,
      kind: ev.kind,
      start,
      end: elapsed,
    });
  /**
   * The cue of an EDL event's own sound, at `at`. The opening is not in
   * EVENTS, so its cue has no event, as music has none.
   */
  const cueEvent = (sound, ev, at = elapsed) =>
    cue(sound, "event", {
      at,
      event: ev === OPENING ? null : EVENTS.indexOf(ev),
    });
  let shakeGeometryVerdict = "not run (no capture shake in this style)";

  /**
   * Measure the composition WITHOUT putting a frame in the video.
   *
   * Returns the board's bounding box - which is the geometry under test - and
   * writes the frame so a human can look at it too.
   *
   * The box is read with getBoundingClientRect, which includes every transform
   * on every ancestor. That is what makes it the right instrument: the defect it
   * guards against was a scale on a PARENT of the board, and a rect read catches
   * that exactly, to the sub-pixel, with no threshold to argue about.
   */
  const probeGeometry = async (state, tag) => {
    const file = join(work, `probe-${tag}.png`);
    await stage.evaluate(preloadImages, fileUrlsIn([state]));
    await stage.evaluate((s) => window.__stage(s), state);
    const rect = await stage.evaluate(() => {
      const r = document.getElementById("boardWrap").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await stage.screenshot({ path: file });
    return { rect };
  };

  /**
   * The scale factors currently applied to the composition.
   *
   * This is the property that actually broke: the shake used to scale to 1.045
   * and reset to none, so the board settled 4.5% smaller. Comparing the board
   * box BEFORE and AFTER cannot see that - both are the reset state, so both
   * match and the check passes while the defect ships. The only moment the bug
   * exists is DURING the shake, so that is when this is read.
   *
   * Translation leaves the scale at 1, and so does rotation: for a rotation
   * matrix, sqrt(a^2 + b^2) is 1. Any scale shows up here immediately.
   */
  const shakeScaleFactors = () =>
    stage.evaluate(() => {
      const t = getComputedStyle(document.getElementById("play")).transform;
      if (!t || t === "none") return { x: 1, y: 1 };
      const n = t.match(/-?[0-9.e+-]+/g)?.map(Number) ?? [];
      if (n.length < 4) return { x: 1, y: 1 };
      const [a, b, c, d] = n;
      return { x: Math.hypot(a, b), y: Math.hypot(c, d) };
    });

  /**
   * How many pixels differ between two written frames, and by how much at worst.
   *
   * The frames are DECODED to raw rgb first. Comparing the png bytes directly is
   * worthless - two identical images compress to different lengths - and the
   * first version of this did exactly that and reported a sentinel instead of a
   * measurement.
   */
  const pixelResidue = (tagA, tagB) => {
    const raw = (tag) => {
      const path = join(work, `probe-${tag}.raw`);
      ff([
        "-i",
        join(work, `probe-${tag}.png`),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        path,
      ]);
      return readFileSync(path);
    };
    const a = raw(tagA);
    const b = raw(tagB);
    if (a.length !== b.length) return { differing: null, maxDelta: null };
    let differing = 0;
    let maxDelta = 0;
    for (let i = 0; i < a.length; i += 3) {
      const d =
        Math.abs(a[i] - b[i]) +
        Math.abs(a[i + 1] - b[i + 1]) +
        Math.abs(a[i + 2] - b[i + 2]);
      if (d > 0) {
        differing += 1;
        if (d > maxDelta) maxDelta = d;
      }
    }
    return { differing, maxDelta, pixels: a.length / 3 };
  };

  /**
   * The contact sheet's stills: one frame per EDL event, so the director can
   * check, before anyone watches the video, that each cue lands on the right
   * move and each effect is on the right cell, wall or zoom. `stillNext`
   * marks the next frame shot as the still of an event.
   */
  const stills = [];
  let stillNext = null;
  let frameNo = 0;
  /** The video's first frame, which the loop tail ends on. */
  let firstState = null;
  /** Every image to shoot, in order: its stage state and its file (shootAll). */
  const shots = [];
  /*
    Play frames go through emit(), or the VS guard (movesUnderOverlay) misses
    them. shoot() records the image; shootAll() takes the screenshots after
    the whole video is composed. The main page still paints each state, so
    the checks that read the page (the geometry probes, the board box after
    effects) see the frame they follow.
  */
  /**
   * The whole walks whose number found no free side beside its target
   * (stage.html paintPath), once each by ply, colour and steps: the disc
   * then sits off the board's middle, on the walk or by a pawn (Video
   * Reviewer 1, review 84). A note: the page still keeps it off the pawns
   * where it can.
   */
  const crowdedWalks = new Map();
  const shoot = async (state, seconds, meta) => {
    firstState ??= state;
    const file = join(work, `f-${String(frameNo++).padStart(5, "0")}.png`);
    const crowded = await stage.evaluate((s) => {
      window.__stage(s);
      return window.__crowdedWalks;
    }, state);
    for (const w of crowded) {
      const key = `${meta.ply ?? ""}|${w.hex}|${w.steps}`;
      if (!crowdedWalks.has(key)) {
        crowdedWalks.set(key, { ply: meta.ply ?? null, at: elapsed, ...w });
      }
    }
    // A part of the shoot pass may start here only at a plain position.
    const rest =
      meta.ply !== undefined &&
      isRestShot({ kind: meta.kind, state }, playState(meta.ply + 1));
    if (meta.kind === "move" && !rest) {
      throw new Error(
        `image ${frameNo - 1} is labelled a plain move (ply ${meta.ply}) but its state is not the plain position: an effect must use its own kind`,
      );
    }
    shots.push({ state, file, rest });
    timeline.push({ file, seconds, ...meta });
    if (stillNext) {
      stills.push({ ...stillNext, file, at: elapsed });
      stillNext = null;
    }
    elapsed += seconds;
  };

  /**
   * The VS overlay covers the first seconds of play, whatever is being shown
   * under it - the opening position, routine moves or a punch-in. So the
   * overlay is applied HERE, to every play image that starts inside its
   * window: such an image is split into single frames that each carry the
   * overlay, and only what is left after the window stays one image. Those
   * frames are their own kind: the encode check classifies "move" frames by
   * the board, and a board under two banners is not one it can read.
   */
  const overlay =
    style.vsOverlay && PLAYS_OPENING
      ? await stage.evaluate(() => window.__VS_OVERLAY)
      : null;
  /** Where the overlay starts: after the cold open, if there is one. */
  let overlayStart = 0;
  /**
   * Whether the head row shows the rules line (GOAL_LINE) in place of the
   * race counter: from the VS overlay's start to the first move, through
   * the opening walks it explains (Wall Game Director, 2026-10-29).
   */
  let goalOn = false;
  const inOverlay = () =>
    elapsed >= overlayStart - 1e-6 &&
    elapsed < overlayStart + overlay.seconds - 1e-6;
  /*
    The EDL's overlays (edl.mjs "overlay", overlays.mjs) work the same way:
    an overlay opens a window as its move lands (openOverlay), and every play
    image while it is live is split into single frames that carry it. A plain
    position under an overlay is not one the encode check can read, so those
    frames are kind "overlay"; an effect's frames keep their own kind.

    Where an overlay goes is known only once its window closes: the frames
    it covered decide it (placeOverlay). The screenshots come after the whole
    video is composed (shootAll), so placeOverlays then writes the place,
    and the fade of the last frames, into the states those frames hold. Until
    then the stage paints an overlay without a place as nothing.
  */
  const boardIndexOf = new Map(boardFrames.map((f, i) => [fileUrl(f), i]));
  const overlayWindows = [];
  /** The overlay on screen now, or null. */
  const liveOverlay = () => {
    const w = overlayWindows.at(-1);
    return w && (w.end === null || elapsed < w.end - 1e-6) ? w : null;
  };
  /** An overlay's line, with the seats' names put in (dailySeatNames). */
  const overlayText = (ev) =>
    (ev.text ?? OVERLAYS[ev.asset].line ?? "")
      .replace("{red}", stripSide(redSeat).name)
      .replace("{blue}", stripSide(blueSeat).name);
  /**
   * Open the overlay `ev` as its move lands. It closes after its seconds;
   * the loading bar after the save (overlayFrame); a fast-forward's overlay
   * when the move after its range lands; any of them when the ending starts.
   */
  const openOverlay = (ev) => {
    const live = liveOverlay();
    if (live) {
      fault(
        "overlay-overlap",
        ev.ply,
        `the ${ev.asset} overlay on ply ${ev.ply} opens while the ${live.ev.asset} overlay of ply ${live.ev.ply} still shows; one overlay at a time`,
      );
      closeOverlay();
    }
    const fast = fastRangeOf(ev.ply);
    overlayWindows.push({
      ev,
      asset: OVERLAYS[ev.asset],
      start: elapsed,
      // `seconds` is the time it is fully shown: its pop and fade come on top.
      end:
        ev.seconds === null
          ? null
          : elapsed +
            TEXT_TIMING.overlayPop +
            ev.seconds +
            TEXT_TIMING.overlayFade,
      // The board the move after the fast-forward range leads to.
      closesOnBoard: fast ? fast.toPly + 2 : null,
      // A bar's: the boxes the ending draws, measured (endingBoxes).
      avoid: [],
      place: {},
      frames: [],
    });
    if (ev.sound) cueEvent(meme(ev.sound), ev);
    const own = OVERLAY_FACTS.get(ev)?.audio;
    if (own) {
      // Levelled as a meme sound is, and measured with them (`meme`).
      cueEvent(
        {
          name: clipSoundName(ev.asset),
          meme: clipSoundName(ev.asset),
          file: own.path,
          gain: levelGain(own),
        },
        ev,
      );
    }
  };
  /** A ply's overlays that open as its move lands (the bar is the ending's). */
  const plyOverlays = (plyIndex) =>
    eventsAt(plyIndex).filter((e) => e.kind === "overlay" && e.form !== "bar");
  /**
   * A ply with a trap opens its overlays after the trap's word, not as the
   * move lands, so the beat reads word, then face, and the word never
   * stamps over a cut-out (Wall Game Director, 2026-10-29, v-2026-10-29-1
   * ply 4: "BOXED IN" stamped over the mouse's cut-out for about 1 s).
   */
  const hasTrap = (plyIndex) =>
    eventsAt(plyIndex).some((e) => e.kind === "trap");
  /**
   * Hold the ply until the live overlay closes, when a pawn emotes it
   * (overlays.mjs `pawn`): the next move waits, as it waits for a mark, so
   * the pawn stands still under its tail (Wall Game Director, 2026-10-30,
   * from the preview's ply 10: the scream showed over the next move).
   * Before the ending (`ending`), any overlay with its seconds holds the
   * last ply, because the ending closes it: v-2026-10-30-9 and -10's panel
   * on the winning ply opened after the lead zoom and showed 0 s. `zoom`
   * is the camera the lead zoom left, when it runs into the ending: the
   * hold keeps it, and the ending's flash covers the cut.
   */
  const holdForOverlay = async (
    ply,
    plyIndex,
    { ending = false, zoom = null } = {},
  ) => {
    const live = liveOverlay();
    if (!live || live.end === null) return;
    if (!ending && !takesPawn(live.asset)) return;
    const rest = live.end - elapsed;
    if (rest > 0.5 / FPS) {
      await emit(zoom ? playState(ply, { zoom }) : playState(ply), rest, {
        kind: zoom ? "swing-zoom" : "move",
        ply: plyIndex,
      });
    }
  };
  /**
   * The loading bar's ERROR starts on the first frame of the save's board
   * (OVERLAY_FACTS rise), and the bar closes LOADING_ERROR_SECONDS later.
   */
  const startLoadingError = (w, boardIndex) => {
    if (
      w.asset.draw === "loading" &&
      w.end === null &&
      boardIndex >= OVERLAY_FACTS.get(w.ev).rise
    ) {
      w.end = elapsed + LOADING_ERROR_SECONDS;
      w.errorAt = elapsed;
    }
  };
  /**
   * Open the overlays of a ply. On the save's ply, the loading bar shows
   * its ERROR: they wait until it closes, so the ERROR is read in full and
   * one overlay shows at a time (v-2026-10-31-4 ply 13-14 stopped with
   * overlay-overlap).
   */
  const openPlyOverlays = async (ply, plyIndex) => {
    const overlays = plyOverlays(plyIndex);
    const live = liveOverlay();
    if (overlays.length > 0 && live?.asset.draw === "loading") {
      startLoadingError(live, ply);
      const rest = live.end === null ? 0 : live.end - elapsed;
      if (rest > 0.5 / FPS) {
        await emit(playState(ply), rest, { kind: "move", ply: plyIndex });
      }
    }
    overlays.forEach(openOverlay);
  };
  /** Close the live overlay now (the ending, or the end of a preview). */
  const closeOverlay = () => {
    const live = liveOverlay();
    if (live) live.end = elapsed;
  };
  /**
   * The overlay a play frame carries, or null: what to draw, from the facts
   * of the board the frame shows. The frame is recorded with its window, so
   * placeOverlays can see what it shows.
   */
  const overlayFrame = (state) => {
    const w = liveOverlay();
    if (!w) return null;
    const b = boardIndexOf.get(state.board);
    if (w.closesOnBoard !== null && b >= w.closesOnBoard) {
      w.end = elapsed;
      return null;
    }
    const facts = OVERLAY_FACTS.get(w.ev);
    startLoadingError(w, b);
    const o = {
      draw: w.asset.draw,
      form: w.asset.form,
      t: elapsed - w.start,
      alpha: 1,
      place: w.place,
      ...(w.asset.draw === "toast" || w.asset.draw === "whitebar"
        ? { text: overlayText(w.ev) }
        : {}),
      ...(w.asset.draw === "reactor"
        ? {
            text: overlayText(w.ev),
            // REACTOR_ART has every reactor of the EDL; one with a stop or
            // a recapture never reaches the shoot (reactor-pawn,
            // reactor-capture).
            portrait: REACTOR_ART.get(w.ev)?.url ?? null,
            motion: w.asset.motion ?? null,
          }
        : {}),
      ...(w.asset.draw === "loading"
        ? {
            hex: side(facts.player).hex,
            // After the save, the last percent before it, which the ERROR
            // drains; `error.t` is the seconds since the save showed.
            percent: loadingPercent(
              RACE_DISTANCES[Math.min(b, facts.rise - 1)][facts.player],
            ),
            error:
              b >= facts.rise
                ? { t: elapsed - w.errorAt, text: LOADING_ERROR_LINE }
                : null,
          }
        : {}),
      ...(w.asset.draw === "sequence"
        ? {
            src: facts.frames[
              clipFrameIndex(elapsed - w.start, facts.fps, facts.frames.length)
            ],
          }
        : {}),
      ...(w.asset.draw === "compare"
        ? {
            hex: side(facts.player).hex,
            label: RACE_LABEL,
            before: facts.before,
            after: facts.after,
          }
        : {}),
      ...(w.asset.draw === "card"
        ? {
            card: w.asset.card,
            text: overlayText(w.ev),
            hex: facts ? side(facts.player).hex : null,
          }
        : {}),
      ...(w.asset.draw === "image"
        ? {
            src: facts.src,
            crop: w.asset.image.crop,
            pixels: w.asset.image.pixels,
            // A cut-out: its outline as shares of its crop's box.
            outline: w.asset.image.outline
              ? w.asset.image.outline.map(([x, y]) => [
                  x / w.asset.image.pixels[0] / w.asset.image.crop.w -
                    w.asset.image.crop.x / w.asset.image.crop.w,
                  y / w.asset.image.pixels[1] / w.asset.image.crop.h -
                    w.asset.image.crop.y / w.asset.image.crop.h,
                ])
              : null,
            fade: w.asset.image.fade ?? 0,
          }
        : {}),
      ...(w.asset.draw === "redraw"
        ? {
            redraw: w.asset.redraw,
            art: REACTOR_ART.get(w.ev)?.url ?? null,
          }
        : {}),
      // The pointing pawns: the other pawn's art and both seats' colours.
      ...(w.asset.redraw === "pointing"
        ? {
            art2: REACTOR_ART.get(w.ev)?.url2 ?? null,
            hex: side(facts.player).hex,
            hex2: side(REACTOR_ART.get(w.ev).player2).hex,
          }
        : {}),
      // Who emotes it: a ring in the pawn's seat colour, and the tail its
      // place holds (placeNear).
      ...(takesPawn(w.asset) ? { ring: side(facts.player).hex } : {}),
      ...(w.asset.tint ? { tint: w.asset.tint } : {}),
    };
    w.frames.push({ o, state, at: elapsed, image: timeline.length });
    return o;
  };
  /** The box of the cell around a point of the board. */
  const around = (p) => ({
    x0: p.x - GRID.pitchX / 2,
    y0: p.y - GRID.pitchY / 2,
    x1: p.x + GRID.pitchX / 2,
    y1: p.y + GRID.pitchY / 2,
  });
  /**
   * Every pawn of a frame, as boxes in the board as the camera shows it,
   * each named by its cell ("pawn on e7"), for the message of an overlay
   * with no free place. Each box is the pawn the page drew (pawnSpots), not
   * its cell's pitch: the pitch holds the wall grooves, half again as wide
   * as the pawn, and a bar refused for a groove has no place on a board
   * with pawns near both edges (2026-10-29). A frame with the capture
   * picture adds its catcher and caught pawn, bigger than the page's
   * (Video Reviewer 1, review 57), each as the box of its art's opaque
   * pixels, as the page's pawns are their drawn box.
   */
  const pawnBoxes = (state) => [
    ...(pawnSpots.get(boardIndexOf.get(state.board)) ?? []).flatMap((p) => {
      const drawn = {
        x0: p.x - p.w / 2,
        y0: p.y - p.h / 2,
        x1: p.x + p.w / 2,
        y1: p.y + p.h / 2,
      };
      const box = boxOnScreen(drawn, state.zoom);
      return box ? [{ ...box, what: `pawn on ${drawnPawnCell(p)}` }] : [];
    }),
    ...(state.capture
      ? [
          ...(state.capture.mouseSrc ? [state.capture.mouseArt] : []),
          state.capture.catArt,
        ].flatMap((art) => {
          const box = boxOnScreen(art, state.zoom);
          return box
            ? [{ ...box, what: "the capture picture", capture: true }]
            : [];
        })
      : []),
  ];
  /**
   * What a frame shows in play, as boxes in the board as the camera shows
   * it: the cells the last move's pawns left and reached, its walls, the
   * closest hunt's hunter and target, a path's cells and a cell effect's
   * cell.
   */
  const inPlay = (state) => {
    const b = boardIndexOf.get(state.board);
    const spots = (i) => pawnSpots.get(i) ?? [];
    const same = (p, q) =>
      Math.abs(p.x - q.x) < 1e-3 && Math.abs(p.y - q.y) < 1e-3;
    const notIn = (list) => (p) => !list.some((q) => same(p, q));
    const pawns =
      b > 0
        ? [
            ...spots(b).filter(notIn(spots(b - 1))),
            ...spots(b - 1).filter(notIn(spots(b))),
          ]
        : [];
    const walls = String(history[b - 1]?.notation ?? "")
      .split(".")
      .filter((t) => t.startsWith(">") || t.startsWith("^"))
      .map((t) => {
        const [top, left, bottom, right] = termBox(t);
        return {
          x0: GRID.x(left),
          y0: GRID.y(top),
          x1: GRID.x(right),
          y1: GRID.y(bottom),
        };
      });
    /** @type {[string, { x0: number, y0: number, x1: number, y1: number }][]} */
    const named = [
      ...pawns.map((p) => ["the move's pawn", around(p)]),
      ...closestHuntAt(b).map((c) => ["the closest hunt", around(cellAt(c))]),
      ...walls.map((w) => ["a new wall", w]),
      ...(state.path?.lines ?? []).flatMap((l) =>
        l.points.map((p) => ["a path", around(p)]),
      ),
      ...(state.cellFx ? [["an effect", around(state.cellFx.cell)]] : []),
    ];
    return named.flatMap(([what, box]) => {
      const shown = boxOnScreen(box, state.zoom);
      // A wall of the move: a tail may cross it (overlays.mjs placeNear).
      return shown
        ? [{ ...shown, what, ...(what === "a new wall" ? { wall: true } : {}) }]
        : [];
    });
  };
  /**
   * The boxes the ending draws over the board now (the main page shows the
   * frame just composed), in the board (0..1): its card, banner, pawn,
   * badge and stamp, where shown.
   */
  const endingBoxes = () =>
    stage.evaluate(() => {
      const wrap = document.getElementById("boardWrap").getBoundingClientRect();
      return ["ggCard", "koBanner", "koPawn", "replayBadge", "stamp"]
        .map((id) => document.getElementById(id))
        .filter((el) => el && !el.classList.contains("hidden"))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            x0: (r.left - wrap.left) / wrap.width,
            y0: (r.top - wrap.top) / wrap.height,
            x1: (r.right - wrap.left) / wrap.width,
            y1: (r.bottom - wrap.top) / wrap.height,
          };
        });
    });

  /**
   * The capture picture's box as the ending's bar avoids it: on an ending
   * frame (from its impact, the board greyed and darkened, the action over)
   * the bar may touch the art up to ENDING_TOUCH_CELLS deep, so a bar has a
   * place beside a caught pawn at the board's edge (8Fro, 2026-10-29: 0.06
   * cell of the mouse's feet). `full` keeps the whole box, for the log.
   * During play, and every other pawn, keeps the strict rule (Wall Game
   * Director, 2026-10-29: "never hide the action" holds until the impact).
   */
  const endingTouch = (box, state) => {
    if (
      !state.ending ||
      state.ending.t < endingTimings[state.ending.kind].impact
    )
      return box;
    const s = state.zoom?.scale ?? 1;
    const dx = ENDING_TOUCH_CELLS * GRID.pitchX * s;
    const dy = ENDING_TOUCH_CELLS * GRID.pitchY * s;
    return {
      ...box,
      x0: box.x0 + dx,
      y0: box.y0 + dy,
      x1: box.x1 - dx,
      y1: box.y1 - dy,
      full: { ...box, cellW: GRID.pitchX * s, cellH: GRID.pitchY * s },
    };
  };
  /**
   * How far a place ({x, y, w, h}) goes into a box ({full}, as endingTouch
   * gives it), in cells as shown: the lesser of its two overlaps, 0 when
   * they are apart.
   */
  const touchDepth = (p, { full: k }) =>
    Math.max(
      0,
      Math.min(
        (Math.min(p.x + p.w, k.x1) - Math.max(p.x, k.x0)) / k.cellW,
        (Math.min(p.y + p.h, k.y1) - Math.max(p.y, k.y0)) / k.cellH,
      ),
    );

  /** A reach in words for the log, or nothing when the art stays in its box. */
  const reachWords = (r) =>
    Object.values(r).some((v) => v > 0.005)
      ? `, its art reaching past its box by ${Object.entries(r)
          .filter(([, v]) => v > 0.005)
          .map(([k, v]) => `${v.toFixed(2)} ${k}`)
          .join(", ")}`
      : "";
  /**
   * How far a clip's art reaches past its box (overlays.mjs Reach), by the
   * scale of the place: the most over every frame of its window, painted
   * at a corner of that scale (the reach is in shares of the box, the same
   * at every corner). A bar's or a panel's art stays in its box.
   */
  const reachOf = async (w) => {
    if (w.asset.form !== "clip") return NO_REACH;
    const reaches = new Map();
    for (const probe of overlayPlaces(w.asset, NO_REACH)) {
      if (reaches.has(probe.scale)) continue;
      const most = { top: 0, right: 0, bottom: 0, left: 0 };
      for (const f of w.frames) {
        const r = await stage.evaluate(
          (st) => {
            window.__stage(st);
            return window.__overlayReach();
          },
          { ...f.state, overlay: { ...f.o, place: probe } },
        );
        for (const side of Object.keys(most)) {
          most[side] = Math.max(most[side], r[side]);
        }
      }
      reaches.set(probe.scale, most);
    }
    return (scale) => reaches.get(scale);
  };

  /** What stops an off-board place, by the stage's room (paintOverlay). */
  const ROOM_WORDS = {
    "no-caption-line": "this look shows no caption line",
    "no-room": "it does not fit between the safe area's top and the head row",
    narrow: "the left margin beside this board is too narrow",
    "no-text-fit": "its words do not fit there",
  };
  /**
   * Whether `w` has room in each off-board place of its asset, as
   * placeOverlay's offRoom: null when it has, else what stops it. The stage
   * paints it there once for each different thing it shows, and every one
   * must fit (the caption's place and the margin are measured in the frame,
   * and the board's size is the video's).
   */
  const offBoardRoom = async (w) => {
    const room = new Map();
    for (const kind of placesOf(w.asset).filter((k) => OFF_BOARD.includes(k))) {
      const place = offBoardPlace(w.asset, kind);
      let stop = null;
      for (const f of distinctFrames(w)) {
        const fit = await stage.evaluate(
          (st) => {
            window.__stage(st);
            return window.__overlayFit;
          },
          { ...f.state, overlay: { ...f.o, place } },
        );
        const why =
          fit.room !== "ok" ? fit.room : fit.fits ? null : "no-text-fit";
        if (why) {
          stop = ROOM_WORDS[why] ?? why;
          break;
        }
      }
      room.set(kind, stop);
    }
    // null is "has room": not a missing kind.
    return (kind) =>
      room.has(kind) ? room.get(kind) : "not one of its places";
  };
  /**
   * One frame of `w` for each different thing it shows, without its time,
   * fade and place (Video Reviewer 1, review 29: the loading bar shows two
   * texts in one window, so one frame is not enough).
   */
  const distinctFrames = (w) => {
    const shown = new Map();
    for (const f of w.frames) {
      const key = JSON.stringify({
        ...f.o,
        t: 0,
        alpha: 0,
        place: 0,
        error: Boolean(f.o.error),
        // A clip's frames hold no text: one is enough.
        src: 0,
      });
      if (!shown.has(key)) shown.set(key, f);
    }
    return [...shown.values()];
  };

  /**
   * Once the video is composed: each overlay's place, where it hides nothing
   * in play on any frame it covered (or the render stops), its fade, the
   * fit of its line (or the render stops), its span in RESULT.timeline and
   * its still on the contact sheet.
   */
  /** A cell's size in the board, for a tail (overlays.mjs placeNear). */
  const PITCH = { x: GRID.pitchX, y: GRID.pitchY };
  /**
   * What a cover clip hides (overlays.mjs, form "cover"): on each frame it
   * covered, the share of each pawn's box and of each thing in play under
   * its pixels (overlay-clips.mjs coverOver), the clip drawn as the stage
   * draws it, filling the board. The worst over COVER_HIDE_SHARE, or null.
   * An opening's frames under the VS banners are free: no move is shown
   * there, and the banners cover the board anyway.
   */
  const coverHides = async (w) => {
    const r = await stage.evaluate(() => {
      const b = document.getElementById("boardWrap").getBoundingClientRect();
      return b.width / b.height;
    });
    const facts = OVERLAY_FACTS.get(w.ev);
    const { cols, rows, grids } = facts.coverage;
    let worst = null;
    for (const f of w.frames) {
      if (w.ev.opening && f.state.vsOverlay) continue;
      const grid =
        grids[clipFrameIndex(f.at - w.start, facts.fps, grids.length)];
      for (const b of [...inPlay(f.state), ...pawnBoxes(f.state)]) {
        const share = coverOver(
          grid,
          cols,
          rows,
          boardToCover(b, r, facts.aspect),
        );
        if (share > COVER_HIDE_SHARE && (!worst || share > worst.share)) {
          worst = { share, what: b.what, at: f.at };
        }
      }
    }
    return worst;
  };
  const placeOverlays = async () => {
    for (const w of overlayWindows) {
      const where = `the ${w.ev.asset} overlay on ply ${w.ev.ply}`;
      /*
        Its words stay up long enough to be read (overlays.mjs
        readingSeconds; Nil, 2026-10-28: "goes away before i can read it").
        validateEdl holds `seconds` to that; here the ending, the end of a
        fast-forward or the save may close it sooner. No automatic stretch:
        the director gives it time (Wall Game Director, 2026-10-29).
      */
      const text = w.ev.text ?? w.asset.line;
      const read = readingSeconds(w.asset, text);
      const showsFor = w.end - w.start;
      // Fully shown: after its pop (on a won ending, the bar's white flash
      // if longer) and before its fade.
      const comesIn =
        w.asset.form === "bar" && winnerId !== null
          ? Math.max(TEXT_TIMING.overlayPop, endingTimings[style.ending].flash)
          : TEXT_TIMING.overlayPop;
      const fullFor = showsFor - comesIn - TEXT_TIMING.overlayFade;
      if (fullFor + 0.5 / FPS < read) {
        fault(
          "reading-time",
          w.ev.ply,
          `${where} is fully shown ${fullFor.toFixed(1)} s, and its ${overlayWords(w.asset, text)} words need ${read} s to be read (${READ_BASE_SECONDS} s + ${READ_WORD_SECONDS} s a word): ${w.asset.form === "bar" ? "the ending holds for its bar, so this is a bug" : `open it earlier or slow its plies with pace${w.asset.text === "none" ? "" : ", or use fewer words"}`}`,
          w.start,
        );
      }
      /*
        No overlay hides a pawn on any frame it shows, a fast-forward's and
        the ending's included (Nil, 2026-10-28: "Overlays should never cover
        the pawns"; the ending's bar too, Wall Game Director, 2026-10-29).
        A bar also avoids what the ending draws, and a pawn that the ending
        already hides whole needs no room. Every other overlay also hides
        nothing in play; so does a bar on a replay ending, because the
        replay shows the capture again (Wall Game Director, 2026-10-28).
      */
      const inside = (p, a) =>
        p.x0 >= a.x0 && p.y0 >= a.y0 && p.x1 <= a.x1 && p.y1 <= a.y1;
      const busy =
        w.asset.form === "bar"
          ? [
              ...w.avoid.map((b) => ({ ...b, what: "the ending" })),
              ...w.frames.flatMap((f) => [
                ...(style.ending === "replay" ? inPlay(f.state) : []),
                ...pawnBoxes(f.state)
                  .filter((p) => !w.avoid.some((a) => inside(p, a)))
                  .map((p) => (p.capture ? endingTouch(p, f.state) : p)),
              ]),
            ]
          : w.frames.flatMap((f) => [
              ...inPlay(f.state),
              ...pawnBoxes(f.state),
            ]);
      const reach = await reachOf(w);
      const offRoom = await offBoardRoom(w);
      /*
        A picture a pawn emotes goes nearest that pawn, with a tail that
        points at it (overlays.mjs placeNear; Nil, 2026-10-30, C20). Its
        ply holds while it shows, so the pawn stands still under the tail;
        a zoom on that ply would move it, so the render stops.
      */
      if (w.asset.form === "cover") {
        const hid = await coverHides(w);
        if (hid) {
          fault(
            "overlay-place",
            w.ev.ply,
            `${where} hides the ${hid.what} at ${hid.at.toFixed(2)} s: its pixels cover ${Math.round(hid.share * 100)}% of it (at most ${Math.round(COVER_HIDE_SHARE * 100)}%); put it on a ply where nothing in play is under its art, or cut it shorter`,
            hid.at,
          );
          continue;
        }
      }
      const pawnAt = takesPawn(w.asset)
        ? cellAt(OVERLAY_FACTS.get(w.ev).cell)
        : null;
      if (pawnAt && w.frames.some((f) => (f.state.zoom?.scale ?? 1) !== 1)) {
        fault(
          "overlay-pawn",
          w.ev.ply,
          `${where} points at the ${w.ev.pawn}, and a zoom on its ply moves the board under it: put the zoom on another ply`,
          w.start,
        );
        continue;
      }
      // The other pawns' centres, for its tip (overlays.mjs nearFaults).
      // Its ply holds, so they stand still while it shows: one each.
      const others = pawnAt
        ? [
            ...new Map(
              w.frames
                .flatMap((f) => pawnBoxes(f.state))
                .filter((b) => !b.capture)
                .map((b) => [
                  b.what,
                  {
                    x: (b.x0 + b.x1) / 2,
                    y: (b.y0 + b.y1) / 2,
                    what: b.what,
                  },
                ]),
            ).values(),
          ].filter(
            (o) =>
              Math.hypot(
                (o.x - pawnAt.x) / PITCH.x,
                (o.y - pawnAt.y) / PITCH.y,
              ) > 0.5,
          )
        : [];
      const place =
        w.asset.form === "cover"
          ? COVER_PLACE
          : pawnAt
            ? placeNear(w.asset, busy, reach, pawnAt, others, PITCH, {
                place: w.ev.place,
                // Every wall it shows, old and new: it keeps off them first.
                walls: w.frames.flatMap((f) =>
                  wallBoxes(boardIndexOf.get(f.state.board)).flatMap((b) => {
                    const box = boxOnScreen(b, f.state.zoom);
                    return box ? [box] : [];
                  }),
                ),
              })
            : placeOverlay(w.asset, busy, reach, offRoom);
      if (!place) {
        // What is under each place, each thing once, and what stops each
        // place off the board: the director moves the overlay to a ply
        // where one place is free.
        const under = placesOf(w.asset).flatMap((kind) =>
          kind === "board"
            ? overlayPlaces(w.asset, reach, { middles: !!pawnAt })
                .filter(
                  (p) => w.ev.place === undefined || p.where === w.ev.place,
                )
                .map(
                  (p) =>
                    `${placeName(p)}: ${nearFaults(p, pawnAt ? tailOf(p.full, pawnAt, PITCH) : null, busy, others, PITCH).join(", ")}`,
                )
            : [`${kind}: ${offRoom(kind)}`],
        );
        fault(
          "overlay-place",
          w.ev.ply,
          `${where} has no free place${w.ev.place === undefined ? "" : ` at its place ${w.ev.place}`} while it shows (${(w.end - w.start).toFixed(1)} s)${reachWords(reach(1))}${pawnAt ? `, nor one whose tail to the ${w.ev.pawn} on ${termOfCell(OVERLAY_FACTS.get(w.ev).cell)} is clear and points at it only` : ""}; under each place:\n  ${under.join("\n  ")}`,
          w.start,
        );
        continue;
      }
      Object.assign(w.place, place);
      // How far it goes into the capture picture, where endingTouch let it
      // (none from the caption's place, off the board).
      const touch =
        place.full === null
          ? 0
          : Math.max(
              0,
              ...busy.flatMap((b) =>
                b.full ? [touchDepth(place.full, b)] : [],
              ),
            );
      // Where a picture a pawn emotes points, and what it covers.
      const pawnWords = !pawnAt
        ? ""
        : (place.tail
            ? `, its tail to the ${w.ev.pawn}${place.over.length > 0 ? `, under ${place.over.length} wall(s) of the move (no place had a clear tail)` : ""}`
            : `, beside the ${w.ev.pawn}`) +
          (place.onWall
            ? ", over a wall (every free place covers one, or the list named it)"
            : "");
      log(
        `${where}: ${placeName(place)}${pawnWords}${reachWords(reach(place.scale))}${touch > 0 ? `, touches the capture picture ${touch.toFixed(2)} cell (the ending allows ${ENDING_TOUCH_CELLS})` : ""}`,
      );
      for (const f of w.frames) {
        f.o.alpha = Math.max(
          0,
          Math.min(1, (w.end - f.at) / TEXT_TIMING.overlayFade),
        );
      }
      // The opening is no event of the list: the VS still shows it.
      if (!w.ev.opening) {
        eventSpans.push({
          index: EVENTS.indexOf(w.ev),
          ply: w.ev.ply,
          kind: "overlay",
          start: w.start,
          end: w.end,
        });
      }
      /*
        Its lines fit its box (stage.html paintOverlay shrinks one, down to
        a floor): each different thing it shows painted once at its place,
        as the shots will paint it.
      */
      for (const f of distinctFrames(w)) {
        const fit = await stage.evaluate(
          (st) => {
            window.__stage(st);
            return window.__overlayFit;
          },
          { ...f.state, overlay: f.o },
        );
        // An off-board place was measured before it was taken
        // (offBoardRoom), so this is a bug.
        if (fit.room !== "ok") {
          fault(
            "overlay-place",
            w.ev.ply,
            `${where}: in the ${place.where} place, ${ROOM_WORDS[fit.room] ?? fit.room}, after offBoardRoom found room there; this is a bug`,
            w.start,
          );
          break;
        }
        if (!fit.fits) {
          fault(
            "text-fit",
            w.ev.ply,
            `${where}: its text does not fit its box even at ${fit.floor.toFixed(0)} px (it needs ${fit.needs.join("x")} px, the box has ${fit.has.join("x")}); shorten it`,
            w.start,
          );
          break;
        }
      }
      const mid = w.frames[Math.floor(w.frames.length / 2)];
      if (mid) {
        stills.push({
          ply: w.ev.ply,
          kind: "overlay",
          sound:
            w.ev.sound ??
            (w.ev.audio === "own" ? clipSoundName(w.ev.asset) : null),
          place: { where: place.where, scale: place.scale },
          file: timeline[mid.image].file,
          at: mid.at,
        });
      }
    }
    stills.sort((a, b) => a.at - b.at);
  };

  /** When the last move landed (land), for the capture picture's pounce. */
  /*
    No dot line crosses a wall that its frame shows (Nil, 2026-10-31, the
    revise of v-2026-10-31-9: "such editing blunders shouldn't reach me").
    Each line is read back from what the page draws: the part of it drawn
    so far, sampled along its points and turned into the grid's cells, and
    each step from cell to cell must be open on the frame's board
    (firstBlockedStep). onBoard cuts the walks, so a hit means the cut
    failed: it stops the render, once a line and ply.
  */
  const wallHits = new Set();
  const PATH_SAMPLES_A_CELL = 8;
  const drawnCells = (l) => {
    const seg = l.points
      .slice(1)
      .map((q, i) => Math.hypot(q.x - l.points[i].x, q.y - l.points[i].y));
    let left = seg.reduce((a, b) => a + b, 0) * Math.min(1, l.drawn);
    const cells = [];
    const add = ({ x, y }) => {
      const cell = [
        Math.floor((y - GRID.y(0)) / GRID.pitchY),
        Math.floor((x - GRID.x(0)) / GRID.pitchX),
      ];
      const last = cells.at(-1);
      if (!last || last[0] !== cell[0] || last[1] !== cell[1]) {
        cells.push(cell);
      }
    };
    add(l.points[0]);
    for (let i = 0; i < seg.length && left > 0; i += 1) {
      const [a, b] = [l.points[i], l.points[i + 1]];
      const f = Math.min(1, left / seg[i]);
      const n = Math.max(
        1,
        Math.ceil((seg[i] / GRID.pitchX) * PATH_SAMPLES_A_CELL),
      );
      for (let j = 1; j <= n; j += 1) {
        const u = (f * j) / n;
        add({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
      }
      left -= seg[i];
    }
    return cells;
  };
  const checkPathWalls = (state, meta) => {
    const lines = state.path?.lines ?? [];
    if (lines.length === 0) return;
    const index = boardIndexOf.get(state.board);
    if (index === undefined) {
      throw new Error(
        `a frame draws a walk on a board that is not a position (${state.board})`,
      );
    }
    const grid = gridShown(index, state.erase);
    const name = ([r, c]) => `${String.fromCharCode(97 + c)}${GRID.rows - r}`;
    lines.forEach((l, n) => {
      if (!(l.alpha > 0 && l.drawn > 0)) return;
      const cells = drawnCells(l);
      const k = firstBlockedStep(grid, cells);
      const key = `${meta.kind}|${meta.ply}|${n}`;
      if (k < 0 || wallHits.has(key)) return;
      wallHits.add(key);
      fault(
        "path-through-wall",
        meta.ply ?? null,
        `a walk drawn on ply ${meta.ply} (${meta.kind}, line ${n + 1}${l.alpha < 1 ? `, alpha ${l.alpha.toFixed(2)}` : ""}) crosses a wall the frame shows, from ${name(cells[k])} to ${name(cells[k + 1])}`,
      );
    });
  };
  let captureLandAt = null;
  const emit = async (state, seconds, meta = {}) => {
    checkPathWalls(state, meta);
    const vs = () => overlay && state.segment === "play" && inOverlay();
    const overlaid = () => state.segment === "play" && liveOverlay() !== null;
    const pouncing = () =>
      !!state.capture &&
      captureLandAt !== null &&
      elapsed - captureLandAt < CAPTURE_POUNCE_SECONDS;
    // The evaluation strip moving to a move's value, frame by frame.
    const striping = () =>
      !!state.evalStrip && evalMoving(boardIndexOf.get(state.board));
    if (!vs() && !overlaid() && !pouncing() && !striping()) {
      await shoot(state, seconds, meta);
      return;
    }
    const frames = Math.round(seconds * FPS);
    let used = 0;
    for (
      ;
      used < frames && (vs() || overlaid() || pouncing() || striping());
      used += 1
    ) {
      let s = state;
      let kind = meta.kind;
      if (striping()) {
        s = { ...s, evalStrip: evalStripAt(boardIndexOf.get(state.board)) };
      }
      if (pouncing()) {
        s = {
          ...s,
          capture: {
            ...s.capture,
            pounce: (elapsed - captureLandAt) / CAPTURE_POUNCE_SECONDS,
          },
        };
        if (kind === "move") kind = "capture";
      }
      if (vs()) {
        s = {
          ...s,
          // Red on top, in the strip's order ("Red vs Blue"), not the
          // replay page's (Wall Game Director, 2026-10-30: v-2026-10-30-7,
          // two humans, showed Blue on top over a "Red vs Blue" strip).
          vsOverlay: {
            t: elapsed - overlayStart,
            a: overlaySide(redSeat),
            b: overlaySide(blueSeat),
          },
        };
        kind = "vs-overlay";
      }
      const o = overlayFrame(s);
      if (o) {
        s = { ...s, overlay: o };
        if (kind === "move" || kind === "initial") kind = "overlay";
      }
      await shoot(s, 1 / FPS, { ...meta, kind });
    }
    if (used < frames) {
      // The strip at rest now, not as it was when the state was made.
      const rest = state.evalStrip
        ? { ...state, evalStrip: evalStripAt(boardIndexOf.get(state.board)) }
        : state;
      await shoot(rest, (frames - used) / FPS, meta);
    }
  };

  /**
   * The capture picture of the last board (CAPTURE_INSIDE, CAPTURE_POUNCE),
   * or null. The two pawns are the one on the capture cell before the last
   * move and the one that came onto it; the catcher is the winner's
   * (WINNER_MOVED_LAST). Each is cut from that board, where it stands alone
   * at full size, with its own cell's colour made clear (stage.html
   * __pawnSprite). A square of the capture cell's colour covers the page's
   * two small pawns.
   */
  const capturePicture = await (async () => {
    const L = LAST_BOARD;
    if (!wallz || FINISH_WORD !== "CAUGHT" || L !== history.length) return null;
    const cell = cellOfPly(L - 1);
    if (!cell) return null;
    const at = cellAt(cell);
    const near = (p) =>
      Math.hypot((p.x - at.x) / GRID.pitchX, (p.y - at.y) / GRID.pitchY) < 0.3;
    const same = (p, q) =>
      Math.abs(p.x - q.x) < 1e-3 && Math.abs(p.y - q.y) < 1e-3;
    const before = pawnSpots.get(L - 1) ?? [];
    const after = pawnSpots.get(L) ?? [];
    const waiting = before.filter(near);
    const moved = before.filter(
      (p) => !near(p) && !after.some((q) => same(p, q)),
    );
    const name = termOfCell(cell);
    if (waiting.length !== 1 || moved.length !== 1) {
      log(
        `capture picture: none, ${waiting.length} pawn(s) on ${name} and ${moved.length} moved onto it`,
      );
      return null;
    }
    const [catcher, caught] = WINNER_MOVED_LAST
      ? [moved, waiting]
      : [waiting, moved];
    const s = GRID.cellX;
    const cellBox = { x: at.x - s / 2, y: at.y - s / 2, w: s, h: s };
    // The side the last move came from, the catcher's or the caught's.
    const fromLeft = moved[0].x < at.x - GRID.pitchX * 0.3;
    // A layout in the board image, mirrored on x for a catcher from the left.
    const layoutOn = (layout, mirrored) =>
      Object.fromEntries(
        Object.entries(layout).map(([k, b]) => [
          k,
          {
            x: cellBox.x + (mirrored ? 1 - b.x - b.w : b.x) * s,
            y: cellBox.y + b.y * s,
            w: b.w * s,
            h: b.h * s,
          },
        ]),
      );
    // What a layout would cover outside the capture cell, by name: the
    // walls of the last board, the other pawns as the page drew them, and
    // the board's edge.
    const blockers = [
      ...wallBoxes(L),
      ...after
        .filter((p) => !near(p))
        .map((p) => ({
          x0: p.x - p.w / 2,
          y0: p.y - p.h / 2,
          x1: p.x + p.w / 2,
          y1: p.y + p.h / 2,
          what: `pawn on ${cellUnder(p.x, p.y)}`,
        })),
    ];
    const refusal = (layout) => {
      const boxes = Object.values(layout);
      const x0 = Math.min(...boxes.map((b) => b.x));
      const y0 = Math.min(...boxes.map((b) => b.y));
      const x1 = Math.max(...boxes.map((b) => b.x + b.w));
      const y1 = Math.max(...boxes.map((b) => b.y + b.h));
      if (
        x0 < GRID.x(0) ||
        y0 < GRID.y(0) ||
        x1 > GRID.x(GRID.cols) ||
        y1 > GRID.y(GRID.rows)
      )
        return "the board's edge";
      for (const k of blockers) {
        const depth = Math.max(...boxes.map((b) => depthInto(b, k)));
        if (depth > TOUCH_CELLS) return `${k.what} (${depth.toFixed(2)} cell)`;
      }
      return null;
    };
    const sides = [fromLeft, !fromLeft];
    const tried = sides.map((m) => ({
      mirrored: m,
      why: refusal(layoutOn(CAPTURE_POUNCE, m)),
    }));
    const pounce = tried.find((t) => t.why === null);
    const mirrored = pounce ? pounce.mirrored : fromLeft;
    const side = (m) => (m ? "left" : "right");
    log(
      pounce
        ? `capture picture on ${name}: pounce, to the ${side(mirrored)} (the move came from the ${side(fromLeft)})`
        : `capture picture on ${name}: inside the cell, the pounce covers ${tried.map((t) => `${t.why} to the ${side(t.mirrored)}`).join(", ")}`,
    );
    const boardUrl = (i) =>
      `data:image/png;base64,${readFileSync(boardFrames[i]).toString("base64")}`;
    const colourAt = (url, x, y) =>
      stage.evaluate(
        ([u, b]) => window.__cellColour(u, b),
        [url, { x0: x - s / 2, y0: y - s / 2, x1: x + s / 2, y1: y + s / 2 }],
      );
    /*
      Each pawn of the picture, composed from the board's own art for its
      seat and type (seatPawnArt, as a reactor's prey), not cut from the
      board image: the cut took what the page drew round the pawn (Nil,
      2026-10-30, C21: "weird vertical edge" at v-2026-10-30-7's catch, the
      yellow glow on the wall just placed, and the cell's rank label). A
      capture made before the pawn art was kept falls back to the cut.
    */
    const endPawns = replay.state.pawns
      ? boardPawns(replay.state.pawns).filter(
          (q) => q.cell[0] === cell[0] && q.cell[1] === cell[1],
        )
      : [];
    const winner = outcome?.winnerId ?? null;
    let artPage = null;
    const sprite = async (p, file, winners) => {
      const own = endPawns.filter((q) => (q.playerId === winner) === winners);
      const found =
        own.length === 1 ? seatPawnArt(own[0].playerId, own[0].type) : [];
      if (found.length === 1) {
        artPage ??= await browser.newPage(portraitPageOptions);
        const path = join(WORK, file);
        await composeLayers(artPage, found[0].layers, path);
        // As a data: URL: a file: one taints the stage's canvas.
        const data = `data:image/png;base64,${readFileSync(path).toString("base64")}`;
        return {
          src: fileUrl(path),
          art: await stage.evaluate((u) => window.__artBox(u), data),
        };
      }
      // Which path made the picture, for the vet (review 102 N1).
      log(
        `capture picture: ${file} cut from the board, ${
          !pawnArt
            ? "this capture has no pawn art"
            : own.length === 1
              ? `${found.length} pawn arts for ${SEAT_COLORS(replay)[own[0].playerId]} ${own[0].type}, not one`
              : `${own.length} ${winners ? "winning" : "losing"} pawns on the cell, not one`
        }`,
      );
      const url = boardUrl(L - 1);
      const { png, art } = await stage.evaluate(
        ([u, b, key]) => window.__pawnSprite(u, b, key),
        [
          url,
          {
            x0: p.x - p.w / 2,
            y0: p.y - p.h / 2,
            x1: p.x + p.w / 2,
            y1: p.y + p.h / 2,
          },
          await colourAt(url, p.x, p.y),
        ],
      );
      const path = join(WORK, file);
      writeFileSync(path, Buffer.from(png.split(",")[1], "base64"));
      return { src: fileUrl(path), art };
    };
    const boxes = layoutOn(pounce ? CAPTURE_POUNCE : CAPTURE_INSIDE, mirrored);
    const mouse = await sprite(caught[0], "capture-mouse.png", false);
    const cat = await sprite(catcher[0], "capture-cat.png", true);
    await artPage?.close();
    // Where each pawn's art is drawn (its box less the picture's clear
    // margin): what an overlay avoids (pawnBoxes).
    const artIn = (b, a) => ({
      x0: b.x + a.x0 * b.w,
      y0: b.y + a.y0 * b.h,
      x1: b.x + a.x1 * b.w,
      y1: b.y + a.y1 * b.h,
    });
    return {
      cell: cellBox,
      under: await colourAt(boardUrl(L), at.x, at.y),
      ...boxes,
      mouseSrc: mouse.src,
      catSrc: cat.src,
      mouseArt: artIn(boxes.mouse, mouse.art),
      catArt: artIn(boxes.cat, cat.art),
    };
  })();

  /**
   * The playing state of a position: the board, the caption, the race
   * counter and the goal line. Effects add to it through `extra`.
   */
  /**
   * The race counter at a position (board index), or null when the video
   * shows none: red on the left, blue on the right, each with its steps,
   * and which number changed with the move that led here. `t` is the
   * seconds since that move landed; the counter is settled from
   * RACE_TICK_SECONDS on.
   */
  const raceHud = (boardIndex, t = RACE_TICK_SECONDS) => {
    if (!wallz || !RACE_DISTANCES) return null;
    const now = RACE_DISTANCES[boardIndex];
    const before = RACE_DISTANCES[boardIndex - 1] ?? now;
    const seat = (id) => ({
      word: seatColors[id].toUpperCase(),
      hex: side(id).hex,
      n: now[id],
      changed: now[id] !== before[id],
    });
    return { a: seat(redSeat), b: seat(blueSeat), t };
  };
  const playState = (boardIndex, extra = {}) => ({
    segment: "play",
    look: style.look,
    evalStrip: evalStripAt(boardIndex),
    caption: wallz ? captionAt(boardIndex) : "",
    board: fileUrl(boardFrames[boardIndex]),
    top: side(seats.top),
    bottom: side(seats.bottom),
    race: raceHud(boardIndex),
    goal: wallz && goalOn ? GOAL_LINE : null,
    fastForward: fastForwardAt(boardIndex),
    /*
      Settled; emit plays its pounce frame by frame. It stays under a gg or
      ko ending, which shows the whole board after its flash (Wall Game
      Director, 2026-10-29: without it the catch shrank back to two small
      icons); a ko throws the caught pawn off, so only the catcher stays. A
      replay ending replays the move, so it shows the page's board.
    */
    capture:
      capturePicture &&
      boardIndex === LAST_BOARD &&
      (!extra.ending || ["gg", "ko"].includes(extra.ending.kind))
        ? {
            ...capturePicture,
            pounce: 1,
            ...(extra.ending?.kind === "ko" && { mouseSrc: null }),
          }
        : null,
    ...extra,
    // A walk's number keeps off the pawns this board shows (stage.html
    // path; render vet, 2026-10-30: since walks go around the other pawns,
    // the "6" of v-2026-10-28-3's opening walks sat on a cat and a mouse).
    /*
      Each line is drawn on this board, so it is cut where this board's
      walls stop it (onBoard): an explain's ghost, the walk before the
      move, stays on after the move put its walls down (Wall Game
      Director, 2026-10-31: -8's ghost ran through >b5).
    */
    ...(extra.path && {
      path: {
        ...extra.path,
        lines: extra.path.lines.map((l) =>
          onBoard(l, gridShown(boardIndex, extra.erase)),
        ),
        pawns: (pawnSpots.get(boardIndex) ?? []).map(({ x, y, w, h }) => ({
          x,
          y,
          w,
          h,
        })),
      },
    }),
  });

  /** The site's own click for a turn: one sound per turn, wall wins. */
  const moveClick = (plyIndex) => {
    const terms = String(history[plyIndex].notation ?? "")
      .split(".")
      .filter(Boolean);
    const hasWall = terms.some((s) => s.startsWith(">") || s.startsWith("^"));
    const take = MOVE_CLICK_VARIANTS[plyIndex % MOVE_CLICK_VARIANTS.length];
    return {
      name: hasWall ? "wall" : "pawn",
      file: join(AUDIO_DIR, hasWall ? "wall.wav" : "pawn.wav"),
      rate: take.rate,
      // The site's own balance - a wall is quieter than a pawn there - times
      // one gain, so raising the moves does not flatten that relationship.
      gain:
        (hasWall ? SITE_VOLUMES.wall : SITE_VOLUMES.pawn) *
        MOVE_GAIN *
        take.gain *
        (fastRangeOf(plyIndex) ? FAST_FORWARD_CLICK_STEP : 1),
    };
  };
  /**
   * The ticks of a walk that starts to draw at `from`: one a step, as the
   * walk reaches it, so the steps can be counted by ear. The site's pawn
   * click, pitched up (TICK_RATE): short and dry, never a ding
   * (Wall Game Director, 2026-10-29: Nil disliked the three dings).
   * `fromStart`: one more tick as the walk starts, on the hunter's cell. An
   * explain draws on a still board after a mark, and its first step comes
   * a step's time later: without it, that was 1.6 s of silence on
   * VX-IPenv ply 11 (Wall Game Director and Wall Game PM, 2026-10-29).
   */
  const cueWalkTicks = (points, from, { fromStart = false } = {}) => {
    const steps = points.length - 1;
    for (let k = fromStart ? 0 : 1; k <= steps; k += 1) {
      cue(
        {
          name: "tick",
          file: join(AUDIO_DIR, "pawn.wav"),
          rate: TICK_RATE,
          gain: SITE_VOLUMES.pawn * MOVE_GAIN,
        },
        "tick",
        { at: from + (k / steps) * drawSeconds(points) },
      );
    }
  };
  /** The move of `plyIndex` lands on the next frame: its click and its time. */
  const land = (plyIndex) => {
    cue(moveClick(plyIndex), "move");
    moveTimes.push({ ply: plyIndex, at: elapsed });
    if (plyIndex === LAST_BOARD - 1) captureLandAt = elapsed;
  };

  /*
    The cold open (edl.mjs coldOpenPly, audit item 2): the video starts on
    the key position, caption up, that ply's walls glowing and the camera
    pushing in on them, with that move's own click; then it cuts to the VS
    overlay and the game. No overlay on these frames: they come before it.
  */
  const coldPly = wallz && PLAYS_OPENING ? EDL.coldOpenPly : null;
  if (coldPly !== null) {
    const terms = String(history[coldPly].notation ?? "")
      .split(".")
      .filter(Boolean);
    const walls = terms.filter((t) => t.startsWith(">") || t.startsWith("^"));
    const at = cellOfPly(coldPly);
    const z = frameZoom(
      walls.length > 0 ? walls : at ? [termOfCell(at)] : ["a1"],
      COLD_OPEN_SCALE,
      {
        boards: [coldPly + 1],
        label: `cold open on ply ${coldPly}`,
        report: (kind, m) => fault(kind, coldPly, m),
      },
    );
    cue(moveClick(coldPly), "cold-open");
    const coldLit = litWalls(walls, coldPly + 1);
    const frames = Math.round(COLD_OPEN_SECONDS * FPS);
    for (let i = 0; i < frames; i += 1) {
      const t = i / FPS;
      const push = easeInOut(t / COLD_OPEN_SECONDS);
      await shoot(
        playState(coldPly + 1, {
          zoom: { ...z, scale: 1 + (z.scale - 1) * push },
          ...(walls.length > 0 && {
            trap: { t, ...coldLit, lit: true },
          }),
        }),
        1 / FPS,
        { kind: "cold-open", ply: coldPly },
      );
    }
    overlayStart = elapsed;
    log(`cold open: ply ${coldPly}, ${COLD_OPEN_SECONDS}s`);
  }

  goalOn = Boolean(overlay);
  // The opening clip plays over the board from the VS overlay's start,
  // under its banners (edl.mjs `opening`).
  if (OPENING && overlay) openOverlay(OPENING);
  // The overlay's punch gets the VS sound, at the second the mark lands.
  const vsHitAt = overlay
    ? overlayStart + overlay.entry * vsPunchFraction
    : null;
  if (overlay) {
    const vsSound = sounds[style.vsSound];
    cue({ ...vsSound, gain: vsSound.gain * STING_STEP }, "vs", {
      at: vsHitAt,
    });
    /*
      The same whoosh under the banners' slide-in, so the video has sound
      from its first frame (Wall Game Director, 2026-10-29: the first 0.8 s
      were silent). It starts with the slide and is played faster, so its
      peak meets the VS hit; the rest of it goes under the hit.
    */
    cue(
      {
        ...VS_WHOOSH,
        rate: stingManifest.whooshPeakSeconds / (vsHitAt - overlayStart),
      },
      "vs",
      { at: overlayStart },
    );
    cue(
      {
        ...VS_WHOOSH,
        rate:
          stingManifest.whooshPeakSeconds /
          (stingManifest.whooshPeakSeconds + VS_EXIT_WHOOSH_LEAD),
      },
      "vs",
      {
        at:
          overlayStart +
          overlay.seconds -
          overlay.exit -
          stingManifest.whooshPeakSeconds -
          VS_EXIT_WHOOSH_LEAD,
      },
    );
  }

  // --- the VS screen, animated
  if (style.vsSeconds > 0 && PLAYS_OPENING) {
    const vsFrames = Math.round(style.vsSeconds * FPS);
    // The VS stamp, aligned so its impact meets the visual punch.
    const vsSound = sounds[style.vsSound];
    if (existsSync(vsSound.file)) {
      const lead = vsSound.hitOffsetSeconds?.() ?? 0;
      const startAt = style.vsSeconds * vsPunchFraction - lead;
      if (startAt < 0) {
        log(
          `WARNING: the VS segment is too short for a ${lead}s lead-in; the impact will be clipped.`,
        );
      }
      cue(vsSound, "vs", { at: Math.max(0, startAt) });
    } else {
      log(
        `VS sound missing at ${vsSound.file}; falling back to the site's start sound`,
      );
      cue(
        {
          name: "game_start",
          file: join(AUDIO_DIR, "game_start.mp3"),
          gain: SITE_VOLUMES.gameStart,
        },
        "vs",
      );
    }
    for (let i = 0; i < vsFrames; i += 1) {
      await emit(
        {
          segment: "vs",
          look: style.look,
          t: i / (vsFrames - 1),
          a: side(seats.top),
          b: side(seats.bottom),
        },
        1 / FPS,
        { kind: "vs-transition" },
      );
    }
    log("vs screen rendered");
  }
  // A cold open is the hook, so the music is already under it.
  const musicStart = coldPly !== null ? 0 : elapsed;

  // --- the moves
  await stage.evaluate((state) => window.__stage(state), playState(START_PLY));
  const boardRectNow = () =>
    stage.evaluate(() => {
      const rect = document.getElementById("boardCam").getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
  const encodedBoardRect = await boardRectNow();

  /**
   * The boxes a viewer must see, measured at rest (stage.html
   * __layoutBoxes), for the RESULT line and crew.mjs check. The renderer
   * holds them to SAFE_AREA itself too: a layout that breaks it stops here,
   * before any frame is spent.
   */
  const layoutBoxes = wallz
    ? await stage.evaluate((a) => window.__layoutBoxes(a), {
        captions: CAPTIONS,
        race: Boolean(RACE_DISTANCES),
        goal: Boolean(GOAL_LINE),
        credit: Boolean(CREDIT),
        strip: Boolean(strip),
      })
    : null;
  /*
    The board's cells in the video's frame, at rest with no zoom, in
    board-grid.mjs boardGrid's own shape ({clip, first, last, cols, rows},
    css px of the frame): boardGrid(layout.grid) maps a cell to the frame,
    so the daily app can crop around a cell (Video Editor (daily app),
    2026-10-29). A zoom moves the board: then it does not hold.
  */
  const layoutGrid = wallz
    ? await stage.evaluate(
        ({ c, first, last, cols, rows }) => {
          const w = document
            .getElementById("boardWrap")
            .getBoundingClientRect();
          const box = { x: w.x, y: w.y, width: w.width, height: w.height };
          const inFrame = (r) => ({
            x: box.x + ((r.x - c.x) / c.width) * box.width,
            y: box.y + ((r.y - c.y) / c.height) * box.height,
            width: (r.width / c.width) * box.width,
            height: (r.height / c.height) * box.height,
          });
          return {
            clip: box,
            first: inFrame(first),
            last: inFrame(last),
            cols,
            rows,
          };
        },
        {
          c: clip,
          first: cellRects.first,
          last: cellRects.last,
          cols: GRID.cols,
          rows: GRID.rows,
        },
      )
    : null;
  for (const [name, b] of Object.entries(layoutBoxes ?? {})) {
    const area = areaOf(name);
    if (
      b.x < area.x ||
      b.y < area.y ||
      b.x + b.w > area.x + area.w ||
      b.y + b.h > area.y + area.h
    ) {
      throw new Error(
        `the ${name} box ${JSON.stringify(b)} is outside its area ${JSON.stringify(area)}`,
      );
    }
  }
  if (GOAL_LINE) {
    const fit = await stage.evaluate(() => window.__goalFit());
    if (!fit.fits) {
      fault(
        "text-fit",
        null,
        `the goal line does not fit one line at its smallest size: ${GOAL_LINE}`,
      );
    }
    log(`goal line: "${GOAL_LINE}", ${fit.size}px`);
  }
  if (strip) {
    const fit = await stage.evaluate(() => window.__stripFit());
    if (!fit.fits) {
      fault(
        "text-fit",
        null,
        `the players strip (or its call to action) does not fit STRIP_AREA on one line at its smallest size: ${strip.a.name} vs ${strip.b.name}, ${EDL?.cta ?? DEFAULT_CTA}`,
      );
    }
    log(
      `players strip: ${strip.a.name} vs ${strip.b.name}, ${fit.size}px, box ${JSON.stringify(layoutBoxes.strip)}`,
    );
  }

  /**
   * Each caption beat's measured line count and text width (stage.html
   * __captionText), for the RESULT line, keyed like its box: the daily
   * check fails a beat that wraps. Measured at rest, like the boxes, in the
   * same CSS px: not in the frame loop, where a shake or zoom scales them.
   */
  const captionText = wallz
    ? await stage
        .evaluate((c) => window.__captionText(c), CAPTIONS)
        .then(([caption, payoff]) => ({
          ...(caption && { caption }),
          ...(payoff && { payoff }),
        }))
    : null;

  /**
   * The credit as the stage fitted it (stage.html __creditText): one line
   * per track and no more, inside its width in the GG card or the board's
   * corner, or the render stops here, before any frame.
   */
  const creditText =
    wallz && CREDIT_LINES
      ? await stage.evaluate(() => window.__creditText())
      : null;
  if (creditText && creditText.lines !== CREDIT_LINES.length) {
    fault(
      "text-fit",
      null,
      `the credit takes ${creditText.lines} lines at its smallest size, not ${CREDIT_LINES.length}: ${CREDIT}`,
    );
  } else if (creditText && !creditText.fits) {
    fault(
      "text-fit",
      null,
      `the credit does not fit its width in its corner: ${CREDIT}`,
    );
  }
  /** The credit over the ending, `t` seconds after the ending began. */
  const creditAt = (t) =>
    creditText ? { a: Math.min(1, t / CREDIT_FADE_SECONDS) } : undefined;

  /**
   * Where each stamp and trap word lands (stampSpot) and how much it shrinks
   * to fit (STAMP_MAX_WIDTH), keyed by its event.
   */
  const stampSpots = new Map();
  /**
   * What the lint says of a stamp or trap word when it plays: `covers`, it
   * covers some of its move (stamp-covers warns), and `flat`, something at
   * its edge leaves it almost no slam (stamp-flat, a note); each a message
   * or null. The kinds stay literal in fault() calls, where the LINT_KINDS
   * test reads them.
   */
  const stampLints = new Map();
  /** How big a stamp starts its slam (stage.html punch at its start). */
  const punchFrom = await stage.evaluate(() => window.__PUNCH_FROM);
  /**
   * The colour of each scared or laughing mouse's cell with no pawn, read
   * from the board it shows (stage.html __cellColour), for the window its
   * crop moves in.
   */
  const cellColours = new Map();
  for (const ev of EVENTS) {
    if (ev.kind !== "scared" && ev.kind !== "laugh") continue;
    const at = cellAtTerm(ev.cell);
    cellColours.set(
      ev,
      await stage.evaluate(
        ([url, box]) => window.__cellColour(url, box),
        [
          `data:image/png;base64,${readFileSync(boardFrames[ev.ply + 1]).toString("base64")}`,
          {
            x0: at.x - GRID.cellX / 2,
            y0: at.y - GRID.cellX / 2,
            x1: at.x + GRID.cellX / 2,
            y1: at.y + GRID.cellX / 2,
          },
        ],
      ),
    );
    log(`${ev.kind} on ${ev.cell}, ply ${ev.ply}: cell ${cellColours.get(ev)}`);
  }
  /** The beats with a mark beside a cell's pawn, and how long each plays. */
  const MARK_SECONDS = {
    ...FX_SECONDS,
    scared: SCARED_SECONDS,
    laugh: LAUGH_SECONDS,
  };
  /**
   * What the stage paints for a mark beside a cell's pawn on board `ply`,
   * its time left out: a scared or laughing mouse's beat (paintBeat) or a
   * react, blunder or brilliant mark (paintCellFx), on `side`. One builder
   * for both the frames and the measure, so the measure is what plays.
   */
  const markState = (ev, ply, side) => {
    const at = cellAtTerm(ev.cell);
    const size = GRID.pitchX;
    return ev.kind === "scared" || ev.kind === "laugh"
      ? {
          beat: {
            kind: ev.kind,
            board: fileUrl(boardFrames[ply]),
            cell: at,
            size,
            cellSize: GRID.cellX,
            under: cellColours.get(ev),
            side,
          },
        }
      : {
          cellFx: {
            kind: ev.kind,
            cell: at,
            size,
            side,
            emoji: ev.kind === "react" ? REACTIONS[ev.emoji] : undefined,
          },
        };
  };
  /**
   * The side of each mark beside a cell's pawn (MARK_SECONDS): one where
   * the mark, measured on the stage on every frame it plays (__beatBox,
   * __cellFxBox), covers no wall of its board, when there is one (Wall
   * Game Director, 2026-10-29: the eyes on VX ply 8 covered half of a cage
   * wall's end for 1.2 s); else bubbleSide's, and the lint warns
   * (fxCovers, as the event plays). A side where the mark hides another
   * pawn comes last, and the render stops if every side does (fxHides).
   */
  const fxSides = new Map();
  const fxCovers = new Map();
  const fxHides = new Map();
  for (const ev of EVENTS) {
    if (!(ev.kind in MARK_SECONDS)) continue;
    const board = ev.ply + 1;
    const at = cellAtTerm(ev.cell);
    const walls = wallBoxes(board);
    // The other pawns, as the page drew them: not the mark's own.
    const pawns = (pawnSpots.get(board) ?? [])
      .filter(
        (p) =>
          Math.hypot((p.x - at.x) / GRID.pitchX, (p.y - at.y) / GRID.pitchY) >
          0.3,
      )
      .map((p) => ({
        x0: p.x - p.w / 2,
        y0: p.y - p.h / 2,
        x1: p.x + p.w / 2,
        y1: p.y + p.h / 2,
        what: `pawn on ${cellUnder(p.x, p.y)}`,
      }));
    const hides = new Map();
    const covers = new Map();
    const ts = Array.from(
      { length: Math.round(MARK_SECONDS[ev.kind] * FPS) },
      (_, i) => i / FPS,
    );
    for (const side of Object.keys(BUBBLE_SIDES)) {
      const box = await stage.evaluate(
        ([m, t]) =>
          m.beat
            ? window.__beatBox(m.beat, t)
            : window.__cellFxBox(m.cellFx, t),
        [markState(ev, board, side), ts],
      );
      const hit = walls.find((k) => depthInto(box, k) > TOUCH_CELLS);
      if (hit) covers.set(side, hit.what);
      const under = pawns.find((k) => depthInto(box, k) > TOUCH_CELLS);
      if (under) hides.set(side, under.what);
    }
    const side = bubbleSide(
      board,
      at,
      new Set(covers.keys()),
      new Set(hides.keys()),
    );
    fxSides.set(ev, side);
    if (hides.has(side)) {
      fxHides.set(
        ev,
        `the ${ev.kind} mark on ${ev.cell} hides the ${hides.get(side)}: every side it can take hides a pawn; move the mark to another ply`,
      );
    }
    if (covers.has(side)) {
      fxCovers.set(
        ev,
        `the ${ev.kind} mark on ${ev.cell} covers the ${covers.get(side)}: every side it can take ${hides.size > 0 ? "hides a pawn or " : ""}covers a wall`,
      );
    }
    log(
      `${ev.kind} on ${ev.cell}, ply ${ev.ply}: ${side}${hides.size > 0 ? ` (hides a pawn: ${[...hides].map(([k, w]) => `${k} ${w}`).join(", ")})` : ""}${covers.size > 0 ? ` (covers a wall: ${[...covers].map(([k, w]) => `${k} ${w}`).join(", ")})` : ""}`,
    );
  }
  if (wallz) {
    for (const ev of EVENTS) {
      if (ev.kind !== "stamp" && ev.kind !== "trap") continue;
      const measured = await stage.evaluate(
        (t) => window.__stampBox(t),
        ev.text,
      );
      const fit = Math.min(1, STAMP_MAX_WIDTH / measured.w);
      const spotOn = (ply, shrink) =>
        placeStamp(
          ply + 1,
          ply,
          { w: measured.w * fit * shrink, h: measured.h * fit * shrink },
          ev.kind === "trap" ? ev.walls : [],
          punchFrom,
        );
      /*
        A word with little room to slam shrinks, by whole percents down to
        STAMP_MIN_SHRINK, until it slams in from STAMP_TARGET_POP, and never
        to a place that hides more of the move (Wall Game Director,
        2026-10-29: "WALLED" on 8Fro ply 12 slammed from 1.06x; choice B,
        so every stamp keeps the same centre zoom). At the floor it keeps
        what it reached; under STAMP_FLAT_POP the lint still notes it.
      */
      const full = spotOn(ev.ply, 1);
      let shrink = 1;
      let spot = full;
      if (full.pop < STAMP_TARGET_POP) {
        for (let k = 99; k >= STAMP_MIN_SHRINK * 100 - 1e-9; k -= 1) {
          const s = spotOn(ev.ply, k / 100);
          if (s.covered > full.covered + 1e-9 || s.pop <= spot.pop) continue;
          shrink = k / 100;
          spot = s;
          if (s.pop >= STAMP_TARGET_POP) break;
        }
      }
      /*
        For a flat slam, the nearest ply within STAMP_NEARBY_PLIES where the
        same word hides none of its move and slams in fully, so the beat can
        move there without trial renders (Wall Game Director, 2026-10-29).
        A trap only goes where its walls are already on the board (as
        validateEdl requires), and only where the page drew the board.
      */
      const placed = (ply) =>
        ev.kind !== "trap" ||
        ev.walls.every((w) =>
          history
            .slice(0, ply + 1)
            .some((h) => String(h.notation).split(".").includes(w)),
        );
      const nearby = () => {
        for (let d = 1; d <= STAMP_NEARBY_PLIES; d += 1) {
          for (const ply of [ev.ply - d, ev.ply + d]) {
            if (ply < 0 || !pawnSpots.has(ply + 1) || !placed(ply)) continue;
            const s = spotOn(ply, 1);
            if (s.covered <= 0.01 && s.pop >= STAMP_FLAT_POP) {
              return { ply, ...s };
            }
          }
        }
        return null;
      };
      const better = spot.pop < STAMP_FLAT_POP ? nearby() : null;
      stampSpots.set(ev, { at: spot.at, fit: fit * shrink, pop: spot.pop });
      stampLints.set(ev, {
        covers:
          spot.covered > 0.01
            ? `the ${ev.kind} word "${ev.text}" covers ${spot.covered.toFixed(2)} cells of the move: no band of the board is free of it`
            : null,
        // Wall Game Director, 2026-10-29: so a flat slam is seen without
        // watching, and the beat can move to another ply.
        flat:
          spot.pop < STAMP_FLAT_POP
            ? `the ${ev.kind} word "${ev.text}" slams in from only ${spot.pop.toFixed(2)}x, so it looks flat: a pawn or wall is at its edge; ${better ? `on ply ${better.ply} it would slam in from ${better.pop.toFixed(2)}x (${better.band} of the board)` : `no ply within ${STAMP_NEARBY_PLIES} does better`}`
            : null,
      });
      log(
        `${ev.kind} "${ev.text}" on ply ${ev.ply}: ${spot.band} of the board at ${(fit * shrink).toFixed(2)} size${shrink < 1 ? ` (shrunk to ${Math.round(shrink * 100)}% to slam, from ${full.pop.toFixed(2)}x at full size)` : ""}, over ${spot.covered.toFixed(2)} cells of the move, slams in from ${spot.pop.toFixed(2)}`,
      );
    }
  }

  /**
   * Whether a ply shows who speaks a voice sound (meme-sounds.mjs
   * VOICE_FAMILIES): a zoom, a mark on a cell where a pawn stands after the
   * move, or a cut-out (a reactor, a seat's portrait) on that ply (Nil,
   * 2026-10-29: "zoom on the mouse so it's clear who is talking").
   */
  const speakerShown = (plyIndex) => {
    const pawnsAfter = new Set(
      boardPawns(REPLAYED.states[plyIndex + 1].pawns).map((p) =>
        termOfCell(p.cell),
      ),
    );
    return EVENTS.some(
      (e) =>
        e.ply === plyIndex &&
        (e.kind === "zoom" ||
          (e.kind in MARK_SECONDS && pawnsAfter.has(e.cell)) ||
          (e.kind === "overlay" &&
            PORTRAIT_DRAWS.includes(OVERLAYS[e.asset].draw))),
    );
  };

  /**
   * A voice needs its speaker on screen (DIRECTOR.md): a zoom, a mark on a
   * pawn or a portrait cut-out on the ply. An explain's walk is not a
   * speaker (Wall Game PM, 2026-10-29), so it does not count. Only events
   * are linted: the two slot sounds (vsSound on the VS card, finishSound
   * on the ending) have no ply and no speaker, so a voice there is the
   * director's choice and is not checked (VR1's note).
   */
  const lintVoice = (ev, plyIndex) => {
    if (!ev.sound || !isVoice(ev.sound)) return;
    if (speakerShown(plyIndex)) return;
    fault(
      "voice-no-speaker",
      plyIndex,
      `the voice ${ev.sound} on ply ${plyIndex} has no speaker on screen: add a zoom, a mark on the speaking pawn or a cut-out on this ply`,
    );
  };

  /**
   * One frame of an after-landing EDL effect, `t` seconds (frame `i`) into
   * its `seconds`, as the stage state it adds to the position.
   */
  const momentState = (ev, ply, t, seconds, i) => {
    if (ev.kind === "stamp") {
      return t < STAMP_LAND_AT
        ? {}
        : {
            midStamp: {
              text: ev.text,
              t: t - STAMP_LAND_AT,
              seconds: seconds - STAMP_LAND_AT,
              ...stampSpots.get(ev),
            },
          };
    }
    if (ev.kind === "race") return { race: { ...raceHud(ply), flash: t } };
    if (ev.kind === "path") {
      const { player, walks } = PATHS.get(ev);
      const lastFrom = lastWalkFrom(ev);
      const span01 = (x) => Math.max(0, Math.min(1, x));
      return {
        path: {
          cell: GRID.pitchX,
          lines: walks.map(({ cells, points, holes, cut }, k) => {
            const last = k === walks.length - 1;
            const from = last ? lastFrom : 0;
            const fadeAt = last ? seconds - PATH_FADE_SECONDS : lastFrom;
            return {
              hex: side(player).hex,
              cells,
              points,
              holes,
              cut,
              steps: points.length - 1,
              drawn: span01((t - from) / drawSeconds(points)),
              alpha: 1 - span01((t - fadeAt) / PATH_FADE_SECONDS),
            };
          }),
        },
      };
    }
    if (ev.kind === "plant") {
      return {
        trap: {
          t,
          fade:
            1 -
            Math.max(
              0,
              Math.min(
                1,
                (t - (PLANT_SECONDS - PLANT_FADE_SECONDS)) / PLANT_FADE_SECONDS,
              ),
            ),
          ...litWalls([ev.wall], ply),
        },
      };
    }
    if (ev.kind === "trap") {
      return {
        trap: { t, ...litWalls(ev.walls, ply) },
        midStamp:
          t >= TRAP_STAMP_AT
            ? {
                text: ev.text,
                t: t - TRAP_STAMP_AT,
                seconds: seconds - TRAP_STAMP_AT,
                ...stampSpots.get(ev),
              }
            : undefined,
      };
    }
    const mark = markState(ev, ply, fxSides.get(ev));
    if (mark.beat) return { beat: { ...mark.beat, t } };
    const cellFx = { ...mark.cellFx, t };
    if (ev.kind !== "blunder") return { cellFx };
    const shake = Math.max(0, 1 - t / BLUNDER_SHAKE_SECONDS);
    return {
      cellFx,
      flash: 0.5 * Math.max(0, 1 - t / BLUNDER_FLASH_SECONDS),
      shake: 0.8 * shake * shake,
      shakePhase: i,
    };
  };

  /**
   * A freeze (edl.mjs), BEFORE the move of `plyIndex` lands: the position
   * before it goes grey and the camera pushes in on the move's cell, holds,
   * and the move then cuts in at full size. Its sound starts with it.
   */
  const playFreeze = async (ply, plyIndex) => {
    const ev = eventsAt(plyIndex).find((e) => e.kind === "freeze");
    if (!ev) return;
    const at = cellOfPly(plyIndex);
    if (!at) {
      throw new Error(`ply ${plyIndex} names no cell for its freeze to frame`);
    }
    const start = elapsed;
    if (ev.sound) cueEvent(meme(ev.sound), ev);
    const z = frameZoom([termOfCell(at)], FREEZE_SCALE, {
      boards: [ply - 1],
      label: `freeze on ply ${plyIndex}`,
      report: (kind, m) => fault(kind, plyIndex, m),
    });
    const frames = Math.round((FREEZE_PUSH + ev.holdSeconds) * FPS);
    const mid = Math.round((FREEZE_PUSH + ev.holdSeconds / 2) * FPS);
    for (let i = 0; i < frames; i += 1) {
      if (i === mid) {
        stillNext = { ply: plyIndex, kind: "freeze", sound: ev.sound ?? null };
      }
      const t = i / FPS;
      const scale = 1 + (z.scale - 1) * easeOut(Math.min(1, t / FREEZE_PUSH));
      // The position before the move can close a fastForward range; the
      // freeze is a slow moment all the same, so it shows no speed tag.
      await emit(
        playState(ply - 1, {
          zoom: { ...z, scale },
          freeze: { t },
          fastForward: null,
        }),
        1 / FPS,
        { kind: "freeze", ply: plyIndex },
      );
    }
    spanOf(ev, start);
  };

  /**
   * An explain (edl.mjs), around the move of `plyIndex`: the hunter's old
   * walk draws on the position before the move, with a tick a step; the
   * move lands with its walls and its pawns' steps glowing (the trap's
   * glow); the old walk stays as a ghost while the new one draws and holds.
   * An old walk of 1 step (the hunter next to its prey) shows no line: a
   * "1" badge does not read as a path (Nil, 2026-10-30, C17), so the move
   * lands with its glow, and then the new walk draws.
   * The whole board stays in view. The ply's other events follow. Faults:
   * the script's `expect` against the game (explain-mismatch), and a change
   * too small to show (explain-flat).
   */
  const playExplain = async (ply, plyIndex, ev) => {
    const f = EXPLAINS.get(ev);
    const start = elapsed;
    lintVoice(ev, plyIndex);
    const [was, now] = f.steps;
    const said = [];
    if (ev.expect?.before !== undefined && ev.expect.before !== was) {
      said.push(`${ev.expect.before} steps before, the game has ${was}`);
    }
    if (ev.expect?.after !== undefined && ev.expect.after !== now) {
      said.push(`${ev.expect.after} steps after, the game has ${now}`);
    }
    const sameWalls = (a, b) =>
      a.length === b.length && a.every((w) => b.includes(w));
    if (ev.expect?.walls && !sameWalls(ev.expect.walls, f.walls)) {
      said.push(
        `walls ${ev.expect.walls.join(" ") || "none"}, the move places ${f.walls.join(" ") || "none"}`,
      );
    }
    if (said.length > 0) {
      fault(
        "explain-mismatch",
        plyIndex,
        `the explain on ply ${plyIndex} expects ${seatColors[f.player]}: ${said.join("; ")}`,
      );
    }
    if (Math.abs(now - was) < EXPLAIN_MIN_CHANGE) {
      fault(
        "explain-flat",
        plyIndex,
        `the explain on ply ${plyIndex} shows ${seatColors[f.player]}'s steps going from ${was} to ${now}; it has little to show under a change of ${EXPLAIN_MIN_CHANGE}`,
      );
    }
    const hex = side(f.player).hex;
    const span01 = (x) => Math.max(0, Math.min(1, x));
    const line = (walk, drawn, alpha) => ({
      hex,
      cells: walk.cells,
      points: walk.points,
      holes: walk.holes,
      steps: walk.points.length - 1,
      drawn,
      alpha,
    });
    const lit = litWalls(f.walls, ply);
    const glow = (t) => ({ t, ...lit });
    const oldWalk = was > 1;
    // 1. The old walk, on the position before the move.
    const drawBefore = drawSeconds(f.before.points);
    if (oldWalk) cueWalkTicks(f.before.points, start, { fromStart: true });
    const beforeFrames = oldWalk
      ? Math.round((drawBefore + EXPLAIN_BEFORE_REST_SECONDS) * FPS)
      : 0;
    for (let i = 0; i < beforeFrames; i += 1) {
      if (i === beforeFrames - 1) {
        stillNext = { ply: plyIndex, kind: "explain-before", sound: null };
      }
      // The position before the move can close a fastForward range; the
      // explain is a slow moment all the same, so it shows no speed tag.
      await emit(
        playState(ply - 1, {
          path: {
            cell: GRID.pitchX,
            lines: [line(f.before, span01(i / FPS / drawBefore), 1)],
          },
          fastForward: null,
        }),
        1 / FPS,
        { kind: "explain", ply: plyIndex },
      );
    }
    /*
      Until the new walk is drawn, the counter keeps the old numbers, and
      so does the caption: a payoff from this ply ("1 to 13") shows with
      the counter's new number, not 1.5 s before it (Wall Game Director,
      2026-10-30: a4wv and lQeZ).
    */
    const beforeNumbers = {
      race: raceHud(ply - 1),
      caption: wallz ? captionAt(ply - 1) : "",
    };
    // 2. The move lands; its walls and its pawns' steps glow.
    land(plyIndex);
    const landed = elapsed;
    const landFrames = Math.round(EXPLAIN_LAND_SECONDS * FPS);
    for (let i = 0; i < landFrames; i += 1) {
      await emit(
        playState(ply, {
          // The counter keeps the old numbers until the new walk draws, so
          // it never disagrees with the walk's own number (Wall Game PM,
          // 2026-10-29).
          ...beforeNumbers,
          trap: glow(i / FPS),
          path: {
            cell: GRID.pitchX,
            lines: oldWalk ? [line(f.before, 1, EXPLAIN_GHOST)] : [],
          },
        }),
        1 / FPS,
        { kind: "explain", ply: plyIndex },
      );
    }
    // 3. The new walk draws over the ghost of the old one, and holds.
    const drawAfter = drawSeconds(f.after.points);
    cueWalkTicks(f.after.points, elapsed, { fromStart: true });
    // The explain's sound is the reaction to the new number: it plays as
    // the new walk is fully drawn and the counter shows its steps.
    if (ev.sound) cueEvent(meme(ev.sound), ev, elapsed + drawAfter);
    const afterSeconds = drawAfter + EXPLAIN_AFTER_HOLD_SECONDS;
    const afterFrames = Math.round(afterSeconds * FPS);
    for (let i = 0; i < afterFrames; i += 1) {
      const t = i / FPS;
      if (i === Math.round((drawAfter + 0.2) * FPS)) {
        stillNext = {
          ply: plyIndex,
          kind: "explain-after",
          sound: ev.sound ?? null,
        };
      }
      const fade =
        1 -
        span01((t - (afterSeconds - PATH_FADE_SECONDS)) / PATH_FADE_SECONDS);
      await emit(
        playState(ply, {
          // The counter ticks as the new walk is drawn and shows its own
          // number, so the two never disagree.
          ...(t < drawAfter
            ? beforeNumbers
            : { race: raceHud(ply, t - drawAfter) }),
          trap: glow(elapsed - landed),
          path: {
            cell: GRID.pitchX,
            lines: [
              ...(oldWalk ? [line(f.before, 1, EXPLAIN_GHOST * fade)] : []),
              line(f.after, span01(t / drawAfter), fade),
            ],
          },
        }),
        1 / FPS,
        { kind: "explain", ply: plyIndex },
      );
    }
    spanOf(ev, start);
  };

  /**
   * A callback explain (edl.mjs "explain" with `callback`) on the move of
   * `plyIndex`: the move lands and the counter ticks; then, on the position
   * after it, the old wall fades out and the hunter's walk without it
   * draws (no line for a walk of 1 step: Nil, 2026-10-30, C17); the wall
   * fades back in with the trap's glow, and the real walk draws over the
   * ghost of the other one, cut where the wall stops it (onBoard). Faults:
   * the script's `expect` (explain-mismatch), a change too small to show
   * (explain-flat), and the joints and page marks the old spot cannot
   * stand in for (callback-joint, callback-cover).
   */
  const playCallback = async (ply, plyIndex, ev) => {
    const f = CALLBACKS.get(ev);
    const start = elapsed;
    lintVoice(ev, plyIndex);
    for (const m of f.faults.joint) fault("callback-joint", plyIndex, m);
    for (const m of f.faults.cover) fault("callback-cover", plyIndex, m);
    const [was, now] = f.steps;
    const said = [];
    if (ev.expect?.without !== undefined && ev.expect.without !== was) {
      said.push(
        `${ev.expect.without} steps without ${f.term}, the game has ${was}`,
      );
    }
    if (ev.expect?.with !== undefined && ev.expect.with !== now) {
      said.push(`${ev.expect.with} steps with it, the game has ${now}`);
    }
    if (said.length > 0) {
      fault(
        "explain-mismatch",
        plyIndex,
        `the callback explain on ply ${plyIndex} expects ${seatColors[f.player]}: ${said.join("; ")}`,
      );
    }
    if (Math.abs(now - was) < EXPLAIN_MIN_CHANGE) {
      fault(
        "explain-flat",
        plyIndex,
        `the callback explain on ply ${plyIndex} shows ${seatColors[f.player]}'s steps ${was} without ${f.term} and ${now} with it; it has little to show under a change of ${EXPLAIN_MIN_CHANGE}`,
      );
    }
    const hex = side(f.player).hex;
    const span01 = (x) => Math.max(0, Math.min(1, x));
    const line = (walk, drawn, alpha) => ({
      hex,
      cells: walk.cells,
      points: walk.points,
      holes: walk.holes,
      steps: walk.points.length - 1,
      drawn,
      alpha,
    });
    const erase = (a) => ({
      a,
      wall: f.term,
      old: fileUrl(boardFrames[f.erase.oldBoard]),
      cur: fileUrl(boardFrames[ply]),
      box: f.erase.box,
      caps: f.erase.caps,
    });
    const frames = (seconds) => Math.round(seconds * FPS);
    const meta = { kind: "explain", ply: plyIndex };
    // 1. The move lands, as any move, and the counter ticks.
    land(plyIndex);
    for (let i = 0; i < frames(CALLBACK_LAND_SECONDS); i += 1) {
      await emit(
        playState(ply, { race: raceHud(ply, i / FPS) }),
        1 / FPS,
        meta,
      );
    }
    /*
      The wall's own click as it goes, low and soft, and as it comes back:
      the board is still while it changes, and a walk of 1 step ticks
      nothing (a silence of 1.8 s on 2Xnv0iiY ply 37, 2026-10-31).
    */
    const wallClick = (rate, step) => ({
      name: "wall",
      file: join(AUDIO_DIR, "wall.wav"),
      rate,
      gain: SITE_VOLUMES.wall * MOVE_GAIN * step,
    });
    cue(wallClick(0.75, SETTLE_STEP), "tick");
    // 2. The old wall fades out.
    for (let i = 0; i < frames(CALLBACK_FADE_SECONDS); i += 1) {
      await emit(
        playState(ply, {
          erase: erase(easeInOut((i + 1) / frames(CALLBACK_FADE_SECONDS))),
        }),
        1 / FPS,
        meta,
      );
    }
    /*
      While the wall is gone the counter shows the counts without it,
      ticking to them, and as it comes back it ticks back to the game's
      (Wall Game PM and Video Reviewer 1, 2026-11-01: the frame showed the
      board without the wall and the count with it).
    */
    const withHud = raceHud(ply);
    const withoutHud = (t) =>
      withHud && {
        ...withHud,
        a: {
          ...withHud.a,
          n: f.withoutSteps[redSeat],
          changed: f.withoutSteps[redSeat] !== withHud.a.n,
        },
        b: {
          ...withHud.b,
          n: f.withoutSteps[blueSeat],
          changed: f.withoutSteps[blueSeat] !== withHud.b.n,
        },
        t,
      };
    const backHud = (t) =>
      withHud && {
        ...withHud,
        a: { ...withHud.a, changed: f.withoutSteps[redSeat] !== withHud.a.n },
        b: { ...withHud.b, changed: f.withoutSteps[blueSeat] !== withHud.b.n },
        t,
      };
    // 3. The walk without it, on the board without it.
    const [walkNo, walkYes] = f.walks;
    const gone = elapsed;
    const drawn = was > 1;
    const drawNo = drawSeconds(walkNo.points);
    if (drawn) cueWalkTicks(walkNo.points, elapsed, { fromStart: true });
    const goneFrames = frames(
      drawn ? drawNo + EXPLAIN_BEFORE_REST_SECONDS : CALLBACK_GONE_SECONDS,
    );
    for (let i = 0; i < goneFrames; i += 1) {
      if (i === goneFrames - 1) {
        stillNext = { ply: plyIndex, kind: "callback-without", sound: null };
      }
      await emit(
        playState(ply, {
          race: withoutHud(elapsed - gone),
          erase: erase(1),
          path: {
            cell: GRID.pitchX,
            lines: drawn ? [line(walkNo, span01(i / FPS / drawNo), 1)] : [],
          },
        }),
        1 / FPS,
        meta,
      );
    }
    // 4. The wall comes back, glowing; the walk without it stays as a ghost.
    const lit = litWalls([f.term], ply);
    const back = elapsed;
    cue(wallClick(1, 1), "tick");
    const ghost = (alpha) =>
      drawn ? [line(walkNo, 1, EXPLAIN_GHOST * alpha)] : [];
    for (let i = 0; i < frames(CALLBACK_FADE_SECONDS); i += 1) {
      await emit(
        playState(ply, {
          erase: erase(1 - easeInOut((i + 1) / frames(CALLBACK_FADE_SECONDS))),
          race: backHud(elapsed - back),
          trap: { t: elapsed - back, ...lit },
          path: { cell: GRID.pitchX, lines: ghost(1) },
        }),
        1 / FPS,
        meta,
      );
    }
    // 5. The real walk draws over the ghost, and holds.
    const drawYes = drawSeconds(walkYes.points);
    cueWalkTicks(walkYes.points, elapsed, { fromStart: true });
    if (ev.sound) cueEvent(meme(ev.sound), ev, elapsed + drawYes);
    const afterSeconds = drawYes + EXPLAIN_AFTER_HOLD_SECONDS;
    const afterFrames = frames(afterSeconds);
    for (let i = 0; i < afterFrames; i += 1) {
      const t = i / FPS;
      if (i === frames(drawYes + 0.2)) {
        stillNext = {
          ply: plyIndex,
          kind: "callback-with",
          sound: ev.sound ?? null,
        };
      }
      const fade =
        1 -
        span01((t - (afterSeconds - PATH_FADE_SECONDS)) / PATH_FADE_SECONDS);
      await emit(
        playState(ply, {
          race: backHud(elapsed - back),
          trap: { t: elapsed - back, ...lit },
          path: {
            cell: GRID.pitchX,
            lines: [...ghost(fade), line(walkYes, span01(t / drawYes), fade)],
          },
        }),
        1 / FPS,
        meta,
      );
    }
    spanOf(ev, start);
  };

  /**
   * A lead zoom (edl.mjs "lead": true), around the move of `plyIndex`: the
   * camera pushes in on `frame` over the position before the move, in
   * colour; the move lands inside the zoom with its click and the zoom's
   * sound (Nil, 2026-10-26: "the bye right as it moves would be the best
   * narrative"), the race counter ticks, and the camera holds and lets go.
   * The ply's other events and its rest follow, as for any move.
   */
  /**
   * `pullOut` false: the zoom holds to its last frame and the ending cuts
   * in from it (intoEnding, below).
   */
  const playLeadZoom = async (ply, plyIndex, ev, { pullOut = true } = {}) => {
    const start = elapsed;
    // The push shows the board before the move, the hold the board after.
    const z = frameZoom(ev.frame, ev.scale, {
      boards: [ply - 1, ply],
      drift: ZOOM_DRIFT,
      label: `lead zoom on ply ${plyIndex}`,
      report: (kind, m) => fault(kind, plyIndex, m),
    });
    const push = Math.round(LEAD_PUSH * FPS);
    // The position before the move can close a fastForward range; the zoom
    // is a slow moment all the same, so it shows no speed tag.
    for (let i = 0; i < push; i += 1) {
      const scale = 1 + (z.scale - 1) * easeOut((i + 1) / push);
      await emit(
        playState(ply - 1, { zoom: { ...z, scale }, fastForward: null }),
        1 / FPS,
        { kind: "lead-zoom", ply: plyIndex },
      );
    }
    land(plyIndex);
    if (ev.sound) cueEvent(meme(ev.sound), ev);
    const frames = Math.round(
      (ev.holdSeconds + (pullOut ? ZOOM_OUT : 0)) * FPS,
    );
    const zoomFor = (t) => ({
      ...z,
      scale: zoomAt(ZOOM_IN + t, z.scale, ev.holdSeconds),
    });
    const stillAt = Math.round(LEAD_STILL_AT * FPS);
    for (let i = 0; i < frames; i += 1) {
      if (i === stillAt) {
        stillNext = { ply: plyIndex, kind: "zoom", sound: ev.sound ?? null };
      }
      const t = i / FPS;
      await emit(
        playState(ply, { zoom: zoomFor(t), race: raceHud(ply, t) }),
        1 / FPS,
        { kind: "swing-zoom", ply: plyIndex },
      );
    }
    spanOf(ev, start);
    // The camera it leaves: whole again after a pull-out, and the push's
    // last camera when it holds no frame (review 104 N1).
    if (pullOut) return null;
    return frames > 0 ? zoomFor((frames - 1) / FPS) : { ...z };
  };

  /**
   * As a move lands, the race numbers that it changed pop, over the first
   * RACE_TICK_SECONDS of the move's own time, at most `budget` seconds.
   * Above the board, so these frames show the position itself; they are
   * their own kind all the same, because a frame of a moving counter is not
   * a plain position. Returns the seconds it used.
   */
  const playRaceTick = async (ply, plyIndex, budget) => {
    const hud = raceHud(ply);
    if (!hud || !(hud.a.changed || hud.b.changed)) return 0;
    const frames = Math.max(
      0,
      Math.min(Math.round(RACE_TICK_SECONDS * FPS), Math.round(budget * FPS)),
    );
    for (let i = 0; i < frames; i += 1) {
      await emit(playState(ply, { race: raceHud(ply, i / FPS) }), 1 / FPS, {
        kind: "race-tick",
        ply: plyIndex,
      });
    }
    return frames / FPS;
  };

  /**
   * The EDL events of one ply, in list order, as the move lands; then the
   * plain position rests. Each effect runs frame by frame and is its own
   * kind, because the encode check classifies "move" frames by the board
   * under them. Like the shake, every effect must give the board back exactly
   * as it found it, so the box is read again afterwards and must match.
   */
  /**
   * `intoEnding`: the ending cuts in after these events, so a zoom that is
   * the last of them holds to its last frame and no rest follows it.
   */
  const playEvents = async (ply, plyIndex, { intoEnding = false } = {}) => {
    const landing = landingEventsAt(plyIndex);
    const endsInZoom = intoEnding && landing.at(-1)?.kind === "zoom";
    for (const ev of landing) {
      const label = { ply: plyIndex, kind: ev.kind, sound: ev.sound ?? null };
      const start = elapsed;
      if (ev.kind === "blunder" || ev.kind === "brilliant") {
        markAt.set(plyIndex, start);
      }
      if (ev.kind === "race" && RACE_DISTANCES) {
        const before = RACE_DISTANCES[plyIndex];
        const after = RACE_DISTANCES[plyIndex + 1];
        const change = Math.max(
          Math.abs(after[1] - before[1]),
          Math.abs(after[2] - before[2]),
        );
        if (change < RACE_MIN_CHANGE) {
          fault(
            "race-small",
            plyIndex,
            `the race flash on ply ${plyIndex} shows a change of ${change} step${change === 1 ? "" : "s"} (${[1, 2].map((id) => `${seatColors[id]} ${before[id]} to ${after[id]}`).join(", ")}); flash it only for ${RACE_MIN_CHANGE} or more`,
          );
        }
      }
      lintVoice(ev, plyIndex);
      const said = stampLints.get(ev);
      if (said?.covers) fault("stamp-covers", plyIndex, said.covers);
      if (said?.flat) fault("stamp-flat", plyIndex, said.flat);
      if (fxCovers.has(ev))
        fault("mark-covers-wall", plyIndex, fxCovers.get(ev));
      if (fxHides.has(ev)) fault("mark-covers-pawn", plyIndex, fxHides.get(ev));
      if (ev.sound) {
        const sound = meme(ev.sound);
        // A stamp's or trap's sound lands with its word (-12 vet, 2026-10-31:
        // the trap's sting-1 started 0.4 s before TRAPPED appeared).
        cueEvent(
          {
            ...sound,
            gain: sound.gain * (ev.kind === "scared" ? STING_STEP : 1),
          },
          ev,
          elapsed +
            (ev.kind === "stamp"
              ? STAMP_LAND_AT
              : ev.kind === "trap"
                ? TRAP_STAMP_AT
                : 0),
        );
      }
      if (ev.kind === "sound") {
        stillNext = label;
        spanOf(ev, start);
        continue;
      }
      if (ev.kind === "zoom") {
        const z = frameZoom(ev.frame, ev.scale, {
          boards: [ply],
          drift: ZOOM_DRIFT,
          label: `zoom on ply ${plyIndex}`,
          report: (kind, m) => fault(kind, plyIndex, m),
        });
        const out = endsInZoom && ev === landing.at(-1) ? 0 : ZOOM_OUT;
        const frames = Math.round((ZOOM_IN + ev.holdSeconds + out) * FPS);
        const mid = Math.round((ZOOM_IN + ev.holdSeconds / 2) * FPS);
        for (let i = 0; i < frames; i += 1) {
          if (i === mid) stillNext = label;
          await emit(
            playState(ply, {
              zoom: { ...z, scale: zoomAt(i / FPS, z.scale, ev.holdSeconds) },
            }),
            1 / FPS,
            { kind: "swing-zoom", ply: plyIndex },
          );
        }
        spanOf(ev, start);
        continue;
      }
      const seconds = {
        ...MARK_SECONDS,
        stamp: STAMP_LAND_AT + stampSeconds(ev.text),
        trap: Math.max(TRAP_SECONDS, TRAP_STAMP_AT + stampSeconds(ev.text)),
        plant: PLANT_SECONDS,
        race: RACE_FLASH_SECONDS,
        path: ev.kind === "path" ? pathSeconds(ev) : 0,
      }[ev.kind];
      const frames = Math.round(seconds * FPS);
      if (ev.kind === "path") {
        const { walks } = PATHS.get(ev);
        walks.forEach((w, k) =>
          cueWalkTicks(
            w.points,
            start + (k === walks.length - 1 ? lastWalkFrom(ev) : 0),
          ),
        );
      }
      // A stamp's or trap's still shows its word; a race flash's shows the
      // counter at its second swell (stage.html swells it as sin^2 over
      // RACE_FLASH_SECONDS, so the middle frame falls between the two swells,
      // with no glow; the second comes after the RACE_TICK_SECONDS tick); the
      // others are judged mid-effect.
      const stillAt =
        ev.kind === "trap"
          ? Math.round((TRAP_STAMP_AT + 0.4) * FPS)
          : ev.kind === "stamp"
            ? Math.round((STAMP_LAND_AT + 0.4) * FPS)
            : ev.kind === "race"
              ? Math.round(RACE_FLASH_SECONDS * 0.75 * FPS)
              : Math.round(frames / 2);
      for (let i = 0; i < frames; i += 1) {
        if (i === stillAt) stillNext = label;
        const extra = momentState(ev, ply, i / FPS, seconds, i);
        await emit(playState(ply, extra), 1 / FPS, {
          kind: `beat-${ev.kind}`,
          ply: plyIndex,
        });
        /*
          The blunder shakes like the winning move, so it is held to the same
          guard: translation and rotation only, read on every shaking frame.
        */
        if (extra.shake > 0) {
          const sc = await shakeScaleFactors();
          if (
            Math.abs(sc.x - 1) > SCALE_TOLERANCE ||
            Math.abs(sc.y - 1) > SCALE_TOLERANCE
          ) {
            throw new Error(
              `the blunder shake on ply ${plyIndex} SCALED the composition (x ${sc.x.toFixed(4)}, y ${sc.y.toFixed(4)}). Translation and rotation only.`,
            );
          }
        }
      }
      spanOf(ev, start);
      // After the ply's last trap: its word has shown (hasTrap).
      if (ev === landing.findLast((e) => e.kind === "trap")) {
        await openPlyOverlays(ply, plyIndex);
      }
    }
    if (!endsInZoom) {
      // The rest of the ply's pace, from its landing (timeline-frames.mjs).
      const landedAt = moveTimes.findLast((m) => m.ply === plyIndex).at;
      await emit(
        playState(ply),
        restAfterEvents({
          landedAt,
          pace: paceAt(plyIndex),
          now: elapsed,
          minRest: EFFECT_REST_SECONDS,
        }),
        { kind: "move", ply: plyIndex },
      );
    }
    // The board's layout box, not the camera layer: after a zoom that runs
    // into the ending (endsInZoom) the camera is still zoomed here.
    const after = await boardRectNow();
    if (JSON.stringify(after) !== JSON.stringify(encodedBoardRect)) {
      throw new Error(
        `the effects on ply ${plyIndex} did not give the board back - before ${JSON.stringify(encodedBoardRect)} after ${JSON.stringify(after)}`,
      );
    }
  };

  /*
    The starting position gets one beat of its own, so the first move is a
    change the eye can catch rather than the first thing it ever sees. Under
    the VS overlay it holds longer: no move plays under the banners, so the
    first move lands only once they have fully left, at the end of their
    exit, rounded up to a whole frame (Nil's rule; Wall Game PM, 2026-10-26:
    a move under the sliding banner was half hidden). movesUnderOverlay
    holds the timeline to it.

    The rules line shows from the overlay's start to the first move, so it
    is read: at least its reading time (overlays.mjs readingSeconds; it was
    on screen 3.4 s for the 4.5 s its 11 words need, Wall Game Director,
    2026-10-29). The opening walks count toward it; the hold covers the
    rest.
  */
  const goalRead = goalOn ? readingSeconds({}, GOAL_LINE) : 0;
  /*
    The opening walks start as the VS banners start to leave, so no silence
    follows the VS hit (Wall Game Director, 2026-10-29); a move still waits
    for the banners to be gone, and the walks outlast their exit.
  */
  const introSeconds =
    INTRO_PLAN.length > 0 ? INTRO_PLAN.at(-1).fadeAt + PATH_FADE_SECONDS : 0;
  const walksAt = overlay
    ? overlayStart +
      Math.max(
        INTRO_PLAN.length > 0
          ? overlay.seconds - overlay.exit
          : overlay.seconds,
        overlay.seconds - introSeconds,
        goalRead - introSeconds,
      )
    : 0;
  // With a startPly, the opening position is the one before that ply; it is
  // labelled as that earlier ply, which the video never plays on its own.
  await emit(
    playState(START_PLY),
    Math.max(
      paceAt(START_PLY),
      Math.ceil((walksAt - elapsed) * FPS - 1e-6) / FPS,
    ),
    { kind: "initial", ply: START_PLY - 1 },
  );

  /*
    The opening walks (edl.mjs introPaths) on the start position, as
    INTRO_PLAN times them: each ticks its steps as it draws; the last one's
    hold gets a soft settle sound SETTLE_AT into it, so the opening has no
    gap of silence over about 0.4 s (Wall Game Director, 2026-10-29). A
    contact-sheet still of each once it is drawn.
  */
  const introStart = elapsed;
  for (const w of INTRO_PLAN) {
    cueWalkTicks(w.points, introStart + w.start);
    log(`intro path: ${side(w.player).name}, ${w.points.length - 1} steps`);
  }
  if (INTRO_PLAN.length > 0) {
    const last = INTRO_PLAN.at(-1);
    cue(
      {
        name: "settle",
        // The wall click, low and soft: the walks have done their counting.
        file: join(AUDIO_DIR, "wall.wav"),
        rate: 0.75,
        // Under the ticks: it ends the counting, it does not hit.
        gain: SITE_VOLUMES.wall * MOVE_GAIN * SETTLE_STEP,
      },
      "tick",
      { at: introStart + last.start + last.draw + SETTLE_AT },
    );
  }
  const span01 = (x) => Math.max(0, Math.min(1, x));
  const stillsAt = INTRO_PLAN.map((w) =>
    Math.round((w.start + w.draw + 0.2) * FPS),
  );
  const introFrames = Math.round(introSeconds * FPS);
  for (let i = 0; i < introFrames; i += 1) {
    const t = i / FPS;
    if (stillsAt.includes(i)) {
      stillNext = { ply: START_PLY, kind: "intro-path", sound: null };
    }
    await emit(
      playState(START_PLY, {
        path: {
          cell: GRID.pitchX,
          lines: INTRO_PLAN.filter((w) => t >= w.start).map((w) => ({
            hex: side(w.player).hex,
            cells: w.cells,
            points: w.points,
            holes: w.holes,
            steps: w.points.length - 1,
            drawn: span01((t - w.start) / w.draw),
            alpha: 1 - span01((t - w.fadeAt) / PATH_FADE_SECONDS),
          })),
        },
      }),
      1 / FPS,
      { kind: "intro-path", ply: START_PLY - 1 },
    );
  }
  goalOn = false;

  const winnerId = outcome?.winnerId ?? null;
  let musicEndAt = null;
  /** The second each ply's beat starts: a freeze, explain or lead zoom included. */
  const beatStartAt = new Map();

  for (let ply = START_PLY + 1; ply <= LAST_BOARD; ply += 1) {
    const plyIndex = ply - 1;
    const isLast = ply === history.length;
    beatStartAt.set(plyIndex, elapsed);
    if (wallz) await playFreeze(ply, plyIndex);
    const lead = wallz ? leadZoomAt(plyIndex) : undefined;
    const explain = wallz
      ? eventsAt(plyIndex).find((e) => e.kind === "explain")
      : undefined;
    /*
      The capture's zoom runs straight into the ending's impact: no pull-out
      and no still board before it (Wall Game Director, 2026-10-29: a still,
      silent board held 0.6-0.8 s after the climax). Only into an ending
      whose impact is its first frame (gg, ko): its white flash covers the
      camera's cut back to the whole board.
    */
    const intoEnding =
      wallz &&
      isLast &&
      winnerId !== null &&
      endingTimings[style.ending].impact === 0;
    const leadIntoEnding =
      intoEnding &&
      lead !== undefined &&
      landingEventsAt(plyIndex).length === 0;
    // The camera a lead zoom into the ending leaves (playLeadZoom).
    let leftZoom = null;
    if (lead) {
      leftZoom = await playLeadZoom(ply, plyIndex, lead, {
        pullOut: !leadIntoEnding,
      });
    } else if (explain?.callback) {
      await playCallback(ply, plyIndex, explain);
    } else if (explain) {
      await playExplain(ply, plyIndex, explain);
    } else {
      land(plyIndex);
    }
    if (wallz) {
      // A fast-forward's overlay closes as the move after its range lands.
      const live = liveOverlay();
      if (live && live.closesOnBoard !== null && ply >= live.closesOnBoard) {
        closeOverlay();
      }
      // On a trap's ply they open after its word (playEvents).
      if (!hasTrap(plyIndex)) await openPlyOverlays(ply, plyIndex);
    }
    /*
      The tick takes its time from a plain move's hold, leaving that hold
      one frame at least; a move with effects keeps all of its own.
    */
    const plainMove =
      wallz && !isLast && landingEventsAt(plyIndex).length === 0;
    // A lead zoom and an explain tick the counter in their own frames.
    const ticked =
      wallz && !lead && !explain
        ? await playRaceTick(
            ply,
            plyIndex,
            plainMove ? paceAt(plyIndex) - 1 / FPS : RACE_TICK_SECONDS,
          )
        : 0;

    if (wallz && isLast) {
      /*
        The last move lands and holds one beat (or plays its EDL events), and
        then the ending plays over the final screenshot. Ending frames are
        their own kind: the encode check classifies "move" frames by the board
        under them, and an ending frame is not a plain position of the game.
      */
      if (landingEventsAt(plyIndex).length > 0) {
        await playEvents(ply, plyIndex, { intoEnding });
      } else if (!leadIntoEnding) {
        await emit(playState(ply), paceAt(plyIndex), {
          kind: "move",
          ply: plyIndex,
        });
      }
      await holdForOverlay(ply, plyIndex, { ending: true, zoom: leftZoom });
      musicEndAt = elapsed;
      // The ending covers the board: an overlay still open closes here.
      closeOverlay();
      // The ending's caption bar (overlays.mjs "bar") opens at its impact,
      // or as a draw's hold starts, and closes before the loop tail.
      const bar = eventsAt(plyIndex).find(
        (e) => e.kind === "overlay" && e.form === "bar",
      );
      /*
        The ending holds as long as its bar's line needs to be read (Wall
        Game Director, 2026-10-29: Nil's "you can run but you can't hide"
        is 7 words, 3.3 s, and the gg ending shows the bar 2.6 s).
        validateEdl caps a line at the 4 s maximum; a short line keeps the
        ending's own length. `shows` is how long the ending shows the bar
        as it is; the hold grows by what is missing, to a whole frame.
      */
      const barRead = bar
        ? readingSeconds(
            OVERLAYS[bar.asset],
            bar.text ?? OVERLAYS[bar.asset].line,
          )
        : 0;
      // Fully shown for its reading time: its pop (or the ending's white
      // flash, if longer) and its fade at the video's end come on top.
      const holdFor = (shows, flash) => {
        const needs =
          barRead +
          Math.max(TEXT_TIMING.overlayPop, flash) +
          TEXT_TIMING.overlayFade;
        const more = Math.ceil(Math.max(0, needs - shows) * FPS) / FPS;
        if (more > 0) log(`ending held +${more.toFixed(1)} s for the bar`);
        return more;
      };
      if (winnerId) {
        const timing = endingTimings[style.ending];
        const impactFrame = Math.round(timing.impact * FPS);
        const how = `wins ${FINISH_WORD === "HOME" ? "by reaching home" : (REASON_WORDS[outcome.reason] ?? outcome.reason)}`;
        const ending = (t) => ({
          kind: style.ending,
          t,
          at: cellAt(
            cellOfPly(plyIndex) ?? [GRID.rows / 2 - 0.5, GRID.cols / 2 - 0.5],
          ),
          cell: GRID.pitchX,
          before: fileUrl(boardFrames[ply - 1]),
          stamp: FINISH_WORD,
          how,
          crack: ENDS_BY_MOVE.includes(outcome.reason),
          winner: { ...side(winnerId), name: dailyName(winnerId) },
          loser: {
            ...side(winnerId === 1 ? 2 : 1),
            name: dailyName(winnerId === 1 ? 2 : 1),
          },
        });
        // The finish slot starts at the impact, or as a death card on this
        // ply opens (overlays.mjs DEATH_CARDS).
        const deathCard = overlayWindows.find(
          (w) => w.ev.ply === plyIndex && DEATH_CARDS.includes(w.asset.card),
        );
        cue(sounds.finish, "finish", {
          at: deathCard ? deathCard.start : elapsed + timing.impact,
        });
        if (deathCard) {
          log(
            `finish sound ${sounds.finish.name} at ${deathCard.start.toFixed(2)} s, as the ${deathCard.ev.asset} card opens`,
          );
        }
        const endingFrames = Math.round(timing.seconds * FPS);
        for (let i = 0; i < endingFrames; i += 1) {
          if (bar && i === impactFrame) openOverlay(bar);
          await emit(
            playState(ply, {
              ending: ending(i / FPS),
              credit: creditAt(i / FPS),
            }),
            1 / FPS,
            { kind: "ending", ply: plyIndex },
          );
          // What the ending draws on every frame the bar shows: the bar
          // goes where none of it is. Not only at the impact and at rest:
          // the ko banner sweeps in and the replay's badge and stamp pop,
          // and between two moments they cross other bands (Video Reviewer
          // 1, review 30; Wall Game Director, 2026-10-28).
          if (bar && i >= impactFrame) {
            liveOverlay().avoid.push(...(await endingBoxes()));
          }
        }
        const barShows = (endingFrames - impactFrame) / FPS + timing.hold;
        /*
          The GG card holds for its words' reading time ("GG", the winner,
          how), fully shown from cardIn (Wall Game Director, 2026-10-30: on
          v-2026-10-30-8 it was fully shown 1.85 s, and "GG Bot wins by
          resignation" needs 2.7 s; on a resignation it is the hook's
          payoff). The card's last line, the call to action, is read too
          (VR1, review 115 N1; Nil: it must be read). With a bar, both
          are on screen together, and the ending holds for the longer of
          the two.
        */
        const cardMore =
          style.ending === "gg"
            ? Math.ceil(
                Math.max(
                  0,
                  readingSeconds(
                    {},
                    `GG ${dailyName(winnerId)} ${how} ${EDL?.cta ?? DEFAULT_CTA}`,
                  ) -
                    (timing.seconds - timing.cardIn + timing.hold),
                ) * FPS,
              ) / FPS
            : 0;
        if (cardMore > 0) {
          log(`ending held +${cardMore.toFixed(1)} s for the GG card`);
        }
        await emit(
          playState(ply, {
            ending: ending(timing.seconds),
            credit: creditAt(timing.seconds),
          }),
          timing.hold +
            Math.max(bar ? holdFor(barShows, timing.flash) : 0, cardMore),
          { kind: "ending-hold", ply: plyIndex },
        );
      } else if (creditText) {
        /*
          A draw has no ending, so its hold carries the credit: faded in
          frame by frame, then held. Not "move" frames: a plain position
          has no credit over it.
        */
        if (bar) openOverlay(bar);
        const fade = Math.round(CREDIT_FADE_SECONDS * FPS);
        for (let i = 0; i < fade; i += 1) {
          await emit(playState(ply, { credit: creditAt(i / FPS) }), 1 / FPS, {
            kind: "ending-hold",
            ply: plyIndex,
          });
        }
        await emit(
          playState(ply, { credit: creditAt(CREDIT_FADE_SECONDS) }),
          DRAW_HOLD_SECONDS -
            fade / FPS +
            (bar ? holdFor(DRAW_HOLD_SECONDS, 0) : 0),
          { kind: "ending-hold", ply: plyIndex },
        );
      } else {
        if (bar) openOverlay(bar);
        await emit(
          playState(ply),
          DRAW_HOLD_SECONDS + (bar ? holdFor(DRAW_HOLD_SECONDS, 0) : 0),
          { kind: "move", ply: plyIndex },
        );
      }
      closeOverlay();
      /*
        The loop tail (audit item 6): a white flash that fades into the
        video's own first frame, so the feed's loop cuts from a frame to
        the same frame.
      */
      const tail = Math.round(LOOP_SECONDS * FPS);
      for (let i = 0; i < tail; i += 1) {
        await emit({ ...firstState, rewind: 1 - i / (tail - 1) }, 1 / FPS, {
          kind: "loop",
          ply: plyIndex,
        });
      }
    } else if (wallz && landingEventsAt(plyIndex).length > 0) {
      await playEvents(ply, plyIndex);
    } else if (isLast && CAPTURE_SHAKE) {
      /*
        The winning move lands, then the frame shakes and settles.

        GEOMETRY IS CHECKED, NOT EYEBALLED. An earlier shake scaled the
        composition up during the effect and reset it afterwards, so the board
        came to rest 4.5% smaller than it started - a jump that "looks the same
        to me" did not catch. The two probes below render the SAME ply with no
        shake, once before the effect and once after it, and the bytes must be
        identical. Nothing but exact equality proves the transform came back.
      */
      const before = await probeGeometry(playState(ply), "shake-before");
      // This is a separate layer ON TOP of the move click: the click says a
      // piece moved, this says it hit something.
      cue(sounds.shake, "shake");
      const shakeFrames = Math.round(SHAKE_SECONDS * FPS);
      let worstScale = { x: 1, y: 1 };
      for (let i = 0; i < shakeFrames; i += 1) {
        const decay = 1 - i / shakeFrames;
        await emit(
          playState(ply, { shake: decay * decay, shakePhase: i }),
          1 / FPS,
          { kind: "winning-shake", ply: plyIndex },
        );
        /*
          Sampled on every shake frame, because the defect only exists while the
          effect is applied - and the two axes are tracked INDEPENDENTLY. An
          earlier version replaced the whole record only when X worsened, so a
          sample of {x: 1, y: 1.045} was thrown away before the Y test could ever
          see it: the check promised "any scale" and delivered "any scale that
          also moves X".
        */
        const sc = await shakeScaleFactors();
        if (Math.abs(sc.x - 1) > Math.abs(worstScale.x - 1))
          worstScale.x = sc.x;
        if (Math.abs(sc.y - 1) > Math.abs(worstScale.y - 1))
          worstScale.y = sc.y;
      }
      await emit(playState(ply), FINAL_HOLD_SECONDS, {
        kind: "move",
        ply: plyIndex,
      });
      const after = await probeGeometry(playState(ply), "shake-after");
      const same =
        before.rect.x === after.rect.x &&
        before.rect.y === after.rect.y &&
        before.rect.w === after.rect.w &&
        before.rect.h === after.rect.h;
      const residue = pixelResidue("shake-before", "shake-after");
      /*
        Both halves must hold, and a failure STOPS THE RENDER. An earlier version
        recorded a sentence and carried on, so a broken shake would have been
        reported in a log line nobody reads and shipped anyway.
      */
      const scaled =
        Math.abs(worstScale.x - 1) > SCALE_TOLERANCE ||
        Math.abs(worstScale.y - 1) > SCALE_TOLERANCE;
      if (scaled) {
        throw new Error(
          `the shake SCALED the composition (worst x ${worstScale.x.toFixed(4)}, worst y ${worstScale.y.toFixed(4)}). ` +
            `A scale cannot return to where it began and leaves the board a different size after the effect. ` +
            `Translation and rotation only.`,
        );
      }
      if (!same) {
        throw new Error(
          `the shake moved the board and did not put it back - before ${JSON.stringify(before.rect)} after ${JSON.stringify(after.rect)}`,
        );
      }
      shakeGeometryVerdict =
        `no scale during shake (worst x ${worstScale.x.toFixed(4)}, y ${worstScale.y.toFixed(4)}), ` +
        `board box identical after (${after.rect.w}x${after.rect.h} at ${after.rect.x},${after.rect.y}), ` +
        `pixel residue ${residue.differing}/${residue.pixels} px, worst ${residue.maxDelta}/765`;
    } else {
      await emit(
        playState(ply),
        isLast
          ? paceAt(plyIndex) + FINAL_HOLD_SECONDS
          : paceAt(plyIndex) - ticked,
        {
          kind: "move",
          ply: plyIndex,
        },
      );
    }
    if (wallz && !isLast) await holdForOverlay(ply, plyIndex);
    if (ply % 10 === 0) log(`  ${ply}/${history.length} plies composed`);
  }
  // A preview can stop before an overlay closes.
  closeOverlay();
  await placeOverlays();

  // --- the end card, in the current look only: wallz has its own endings.
  if (!wallz && LAST_BOARD === history.length) {
    musicEndAt = elapsed;
    cue(
      existsSync(sounds.win.file)
        ? sounds.win
        : {
            name: "game_end",
            file: join(AUDIO_DIR, "game_end.mp3"),
            gain: SITE_VOLUMES.gameEnd,
          },
      "win",
    );
    await emit(
      {
        segment: "end",
        look: style.look,
        kicker: winnerId ? "WINNER" : "GAME OVER",
        winner: winnerId ? side(winnerId) : side(seats.bottom),
        how: outcome ? (REASON_WORDS[outcome.reason] ?? outcome.reason) : "",
      },
      END_SECONDS,
      { kind: "end-card" },
    );
  }
  await stage.close();

  /* -------------------------------------------------- the list's faults -- */

  // Each image's first second; the video's length; the ply a second shows.
  const starts = [];
  let videoSeconds = 0;
  for (const f of timeline) {
    starts.push(videoSeconds);
    videoSeconds += f.seconds;
  }
  const plyAt = (second) =>
    timeline[starts.findLastIndex((t) => t <= second + 1e-9)]?.ply ?? null;
  /*
    A still board right before the ending: the plain position held as the
    last thing before it (Wall Game Director, 2026-10-29: a still, silent
    board after the climax).
  */
  const endingIndex = timeline.findIndex((f) => f.kind === "ending");
  if (endingIndex > 0) {
    let from = endingIndex;
    while (from > 0 && timeline[from - 1].kind === "move") from -= 1;
    const still = starts[endingIndex] - starts[from];
    if (still >= STILL_BEFORE_ENDING_SECONDS - 1e-9) {
      fault(
        "still-before-ending",
        timeline[endingIndex - 1].ply,
        `the board holds still ${still.toFixed(1)} s right before the ending: a zoom on the last ply runs straight into it`,
        starts[from],
      );
    }
  }
  /*
    No sound at all: a stretch where no cue is heard and no music plays. A
    cue is heard from its first to its last sample above SOUND_FLOOR_DB at
    its gain and rate (decoded at 8 kHz, once a file); the music from its
    start to its end, or to the video's end when it holds a bed.
  */
  const pcmOf = new Map();
  const pcm = (file) => {
    if (!pcmOf.has(file)) {
      const raw = existsSync(file)
        ? ff(["-i", file, "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"])
        : null;
      pcmOf.set(file, raw && new Int16Array(Uint8Array.from(raw).buffer));
    }
    return pcmOf.get(file);
  };
  const floor = 32768 * 10 ** (SOUND_FLOOR_DB / 20);
  const heard = [];
  const memeStarts = [];
  for (const c of cues) {
    const x = pcm(c.file);
    if (!x) {
      fault("sound-file", plyAt(c.at), `the sound ${c.file} is not here`, c.at);
      continue;
    }
    let first = -1;
    let last = -1;
    for (let i = 0; i < x.length; i += 1) {
      if (Math.abs(x[i]) * c.gain > floor) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first >= 0) {
      heard.push([
        c.at + first / 8000 / c.rate,
        c.at + (last + 1) / 8000 / c.rate,
      ]);
    }
    if (c.meme && first >= 0) {
      let peak = 0;
      for (let i = first; i <= last; i += 1)
        peak = Math.max(peak, Math.abs(x[i]));
      const body = peak * 10 ** (SOUND_BODY_DB / 20);
      let i = first;
      while (Math.abs(x[i]) < body) i += 1;
      memeStarts.push({ name: c.name, at: c.at + i / 8000 / c.rate });
    }
    // The video's end cuts a long finish sound: the end fade only softens
    // the cut (Wall Game Director, 2026-10-29: VX's trombone-1 was cut
    // 1.6 s before its end).
    const cut = c.at + (last + 1) / 8000 / c.rate - videoSeconds;
    if (c.role === "finish" && first >= 0 && cut > FINISH_CUT_SECONDS) {
      fault(
        "finish-cut",
        plyAt(c.at),
        `the video's end cuts the finish sound ${c.name} ${cut.toFixed(1)} s before its end (${FINISH_CUT_SECONDS} s at most): pick a shorter finish sound`,
        videoSeconds - END_FADE_SECONDS,
      );
    }
  }
  memeStarts.sort((a, b) => a.at - b.at);
  memeStarts.forEach((n, i) => {
    const m = memeStarts[i - 1];
    if (m && n.at - m.at < SOUNDS_APART_SECONDS) {
      fault(
        "sounds-together",
        plyAt(n.at),
        `${m.name} and ${n.name} start together (${(n.at - m.at).toFixed(2)} s apart, at ${m.at.toFixed(1)} s; ${SOUNDS_APART_SECONDS} s at least): move one of them, or drop one`,
        m.at,
      );
    }
  });
  const composedMusic = musicParts({
    beatStartAt,
    musicStart,
    musicEndAt: musicEndAt ?? videoSeconds,
    bed: wallz ? MUSIC_BED : 0,
  });
  for (const m of composedMusic) {
    heard.push([m.start, m.bed > 0 ? videoSeconds : m.endAt]);
  }
  heard.sort((a, b) => a[0] - b[0]);
  // The opening: from the VS hit to the first move, when the video has both.
  const opening =
    vsHitAt !== null && moveTimes.length > 0
      ? [vsHitAt, moveTimes[0].at]
      : null;
  let reach = 0;
  for (const [a, b] of [...heard, [videoSeconds, videoSeconds]]) {
    const inOpening = opening
      ? Math.min(a, opening[1]) - Math.max(reach, opening[0])
      : 0;
    if (a - reach > SILENCE_SECONDS) {
      fault(
        "silence",
        plyAt(reach),
        `no sound for about ${(a - reach).toFixed(1)} s, from ${reach.toFixed(1)} s to ${a.toFixed(1)} s`,
        reach,
      );
    } else if (inOpening > OPENING_SILENCE_SECONDS) {
      fault(
        "silence",
        plyAt(reach),
        `no sound for about ${inOpening.toFixed(1)} s between the VS hit and the first move (${OPENING_SILENCE_SECONDS} s at most), from ${Math.max(reach, opening[0]).toFixed(1)} s`,
        Math.max(reach, opening[0]),
      );
    }
    reach = Math.max(reach, b);
  }

  for (const w of crowdedWalks.values()) {
    fault(
      "walk-number-crowded",
      w.ply,
      `the number of a ${w.steps}-step walk has no free side beside its target (each is off the board, on the walk or by a pawn); it sits on the first side with no pawn, or across the last step`,
      w.at,
    );
  }

  /*
    --lint stops here, before any image is taken, and reports every fault
    with what the list holds. A render with faults stops here too, naming
    them all. In the video's order: placeOverlays finds its faults last.
  */
  /*
    --lint measures the meme sounds as a render's buildAudio does (the same
    cues and music, mix-loudness.mjs memeLoudness), so a list the render
    could not measure is named before a render, and the app can judge the
    levels from a lint (Wall Game Director, 2026-10-29). About 0.4 s a meme
    sound, so a lint only: a render measures its own mix.
  */
  let lintLoudness = null;
  if (LINT) {
    try {
      lintLoudness = memeLoudness({
        ffmpeg: FFMPEG,
        cues: cues.filter((c) => existsSync(c.file)),
        totalSeconds: videoSeconds,
        music: composedMusic,
      });
    } catch (err) {
      const message = String(err.message ?? err).slice(0, 300);
      lintLoudness = { error: message };
      fault(
        "loudness",
        null,
        `the meme sounds cannot be measured, so a render's check fails: ${message}`,
        0,
      );
    }
  }
  // A Story is at most MAX_VIDEO_SECONDS (Wall Game PM, 2026-10-29: each
  // explain adds about 2.7 s).
  if (EDL && videoSeconds > MAX_VIDEO_SECONDS) {
    fault(
      "video-long",
      null,
      `the video is ${videoSeconds.toFixed(1)} s long; an Instagram Story holds ${MAX_VIDEO_SECONDS} s`,
      videoSeconds,
    );
  }
  faults.sort((a, b) => a.at - b.at);
  const videoFps = DRAFT ? DRAFT_FPS : FPS;
  /**
   * RESULT.timeline (timeline-frames.mjs videoTimeline) from the composed
   * moves and events, `played` cues and `music` parts (one per CUES).
   */
  const timelineOf = (played, music) =>
    videoTimeline({
      fps: videoFps,
      moves: moveTimes,
      events: eventSpans,
      sounds: [
        ...played.map((c) => ({ ...c, start: c.at })),
        ...music.map((m, k) => ({
          name: CUES[k].track.slug,
          role: "music",
          start: m.start,
          event: null,
        })),
      ],
    });
  if (LINT) {
    const tally = (keys) => {
      const n = {};
      for (const k of keys) n[k] = (n[k] ?? 0) + 1;
      return n;
    };
    const events = EDL?.events ?? [];
    log(`lint: ${faults.length} fault(s), ${videoSeconds.toFixed(1)} s`);
    return {
      lint: {
        faults,
        notes,
        counts: {
          seconds: Number(videoSeconds.toFixed(2)),
          events: tally(events.map((e) => e.kind)),
          overlays: tally(
            events.filter((e) => e.kind === "overlay").map((e) => e.asset),
          ),
          sounds: EDL ? tally(edlSoundUses(EDL).map(([, key]) => key)) : {},
        },
        // As a render's RESULT.loudness, with no master: a lint mixes nothing.
        loudness: lintLoudness,
        /*
          The composed timeline, as a render's RESULT.timeline: every cue
          the list asks for and the music, so the director can time beats
          without a render (Video Editor (daily app), 2026-10-29).
        */
        timeline: timelineOf(cues, composedMusic),
      },
      timings: {
        load: LOAD_SECONDS,
        capture: CAPTURE_SECONDS,
        compose: secondsSince(composeStarted),
      },
    };
  }
  const faultLine = (f) =>
    `ply ${f.ply ?? "-"}, ${f.at} s, ${f.kind}: ${f.message}`;
  for (const f of faults.filter((f) => !f.stops)) {
    log(`WARNING ${faultLine(f)}`);
  }
  const stopping = faults.filter((f) => f.stops);
  if (stopping.length > 0) {
    throw new Error(
      `the list has ${stopping.length} fault(s), so nothing was shot:\n  ${stopping.map(faultLine).join("\n  ")}`,
    );
  }

  /*
    The shoot pass: WORKERS Chromium processes, each with its own stage,
    screenshot one contiguous part of the images (shoot-workers.mjs). A part
    starts at a plain position, never inside an effect. A worker loads its
    part's images first, and paints the image before its part, so its first
    frame follows the same frame as in a serial run.
  */
  // Every overlay was placed (placeOverlays): a frame composed after that
  // with an overlay would be drawn without it, silently.
  const unplaced = shots.findIndex(
    (s) => s.state.overlay && s.state.overlay.place.where === undefined,
  );
  if (unplaced !== -1) {
    throw new Error(
      `image ${unplaced} carries an overlay that was never placed: it was composed after placeOverlays()`,
    );
  }
  const shotStart = Date.now();
  const composeSeconds = secondsSince(composeStarted);
  /*
    The frames of the video: one range of frames per image. A draft at
    DRAFT_FPS gives no frame to some images (most of them a 1/30 s frame of
    an effect); those are not shot. The stills of the contact sheet are shot
    all the same.
  */
  const encodedRanges = allocateFrameRanges(timeline, videoFps, {
    sample: DRAFT,
  });
  const shown = new Set(encodedRanges.map((r) => r.timelineIndex));
  const stillFiles = new Set(stills.map((st) => st.file));
  const toShoot = shots.filter(
    (st, i) => shown.has(i) || stillFiles.has(st.file),
  );
  // A part starts at a plain position, never inside an effect.
  const parts = partsOf(toShoot.length, WORKERS, (i) => toShoot[i].rest);
  await Promise.all(
    parts.map(async ([from, to]) => {
      const worker = await launchBrowser();
      try {
        const { page } = await openStage(worker);
        /*
          The screenshot goes through the DevTools protocol with
          optimizeForSpeed: a faster zlib setting, so a larger PNG of the
          same pixels (2026-10-26, 4090, 1080x1920: 49 ms a frame, against
          117 ms for page.screenshot). It waits for the fonts first, as
          page.screenshot does.
        */
        const cdp = await page.context().newCDPSession(page);
        const screenshot = async (file) => {
          await page.evaluate(() => document.fonts.ready);
          const { data } = await cdp.send("Page.captureScreenshot", {
            format: "png",
            optimizeForSpeed: true,
            // A draft is shot smaller; the page is laid out the same.
            ...(DRAFT && {
              clip: {
                x: 0,
                y: 0,
                width: layout.width,
                height: layout.height,
                scale: DRAFT_SCALE,
              },
            }),
          });
          writeFileSync(file, Buffer.from(data, "base64"));
        };
        await page.evaluate(
          preloadImages,
          fileUrlsIn(toShoot.slice(from, to).map((s) => s.state)),
        );
        if (from > 0) {
          await page.evaluate(
            (s) => window.__stage(s),
            toShoot[from - 1].state,
          );
        }
        for (let i = from; i < to; i += 1) {
          await page.evaluate((s) => window.__stage(s), toShoot[i].state);
          await screenshot(toShoot[i].file);
        }
      } finally {
        await worker.close();
      }
    }),
  );
  const shootSeconds = secondsSince(shotStart);
  const encodeStarted = Date.now();
  log(
    `${toShoot.length} images shot by ${parts.length} workers in ${shootSeconds}s${DRAFT ? ` (a draft: ${shots.length} composed)` : ""}`,
  );
  // Each image's hash, so two renders can be compared frame by frame.
  writeFileSync(
    join(work, "frame-hashes.json"),
    JSON.stringify(toShoot.map((s) => sha256Of(s.file))),
  );
  log(`${timeline.length} frames written`);

  /* ------------------------------------------------------------- encode -- */

  const totalSeconds = timeline.reduce((a, f) => a + f.seconds, 0);
  const frameSequence = join(work, "cfr");
  rmSync(frameSequence, { recursive: true, force: true });
  mkdirSync(frameSequence, { recursive: true });
  if (overlay) {
    const under = movesUnderOverlay(encodedRanges, START_PLY - 1);
    if (under.length > 0) {
      throw new Error(
        `a move plays under the VS banners (frames ${under[0].startFrame}-${under.at(-1).endFrame}, ply ${under[0].ply}); the first move must wait until they have left`,
      );
    }
  }
  const encodedFrame = encodedRanges.at(-1)?.endFrame ?? 0;
  for (const range of encodedRanges) {
    for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
      linkSync(
        range.source,
        join(frameSequence, `v-${String(frame).padStart(6, "0")}.png`),
      );
    }
  }
  writeFileSync(
    join(work, "timeline-manifest.json"),
    JSON.stringify(
      { fps: videoFps, totalFrames: encodedFrame, ranges: encodedRanges },
      null,
      2,
    ),
  );

  const music = musicParts({
    beatStartAt,
    musicStart,
    musicEndAt: musicEndAt ?? totalSeconds,
    bed: wallz ? MUSIC_BED : 0,
  });
  let audioPath = null;
  /** Each meme sound against the bed; null when the video has no soundtrack. */
  let loudness = null;
  /** The cues the soundtrack holds; none in a silent video. */
  let mixed = [];
  /** RESULT.silence: the final track's silences (mix-loudness.mjs). */
  let silence = null;
  const audioStarted = Date.now();
  if (AUDIO) {
    try {
      ({ audioPath, loudness, mixed } = buildAudio({
        cues,
        totalSeconds,
        music,
        work,
      }));
      for (const m of loudness?.memes ?? []) {
        log(
          `meme ${m.key} at ${m.at}s: ${m.memeLufs} LUFS, bed ${m.bedLufs ?? "silent"}, ${m.overLU ?? "-"} LU over`,
        );
      }
      if (loudness?.error) log(`meme loudness not measured: ${loudness.error}`);
      if (loudness?.master) {
        const { gainDb, lufs, truePeakDbtp } = loudness.master;
        log(
          `master: ${lufs} LUFS, true peak ${truePeakDbtp} dBTP (gain ${gainDb} dB)`,
        );
      }
      // The silences a viewer hears, on the final track: reported for the
      // check and the vet, never a render failure (Wall Game PM, 2026-10-29).
      if (audioPath) {
        try {
          const gaps = measureSilences(FFMPEG, audioPath, totalSeconds);
          silence = {
            floorDbfs: SILENCE_FLOOR_DBFS,
            gaps,
            over: silencesOverRules(gaps, opening),
          };
          for (const g of silence.over) {
            log(
              `silence ${g.start}-${g.end} s: ${g.seconds} s, over ${g.rule} s`,
            );
          }
        } catch (err) {
          silence = { error: String(err.message ?? err).slice(0, 300) };
        }
      }
      log(
        music.length > 0
          ? `soundtrack built, with music under the effects (${music.map((m) => m.file).join(", then ")})`
          : "soundtrack built from the site's own effects",
      );
    } catch (err) {
      // A daily video plays exactly its list, so it never ships silent: any
      // audio failure (a missing file, an ffmpeg error) fails the render
      // with no MP4 (Video Reviewer 1, review 39). A hand render without an
      // EDL still falls back to a silent video.
      if (EDL) throw err;
      log(
        `soundtrack failed, writing a silent video instead: ${String(err.message ?? err).slice(0, 200)}`,
      );
    }
  }

  /**
   * H.264 in mp4, yuv420p, faststart. Chosen because it is the one combination
   * every platform accepts without transcoding it a second time, and the one a
   * phone will upload without complaint. `nvenc` makes the same stream on the
   * 4090's encoder instead of the CPU.
   */
  const codecArgs =
    ENCODER === "nvenc"
      ? [
          "-c:v",
          "h264_nvenc",
          "-profile:v",
          "high",
          "-preset",
          "p7",
          "-tune",
          "hq",
          "-rc",
          "vbr",
          "-cq",
          "19",
          "-b:v",
          "0",
        ]
      : [
          "-c:v",
          "libx264",
          "-profile:v",
          "high",
          "-preset",
          "slow",
          "-crf",
          "20",
        ];
  log(`soundtrack in ${secondsSince(audioStarted)}s`);
  const mp4Started = Date.now();
  mkdirSync(dirname(out), { recursive: true });
  ff([
    "-framerate",
    String(videoFps),
    "-i",
    join(frameSequence, "v-%06d.png"),
    ...(audioPath ? ["-i", audioPath] : []),
    "-vf",
    "format=yuv420p",
    ...codecArgs,
    "-movflags",
    "+faststart",
    "-frames:v",
    String(encodedFrame),
    ...(audioPath ? ["-c:a", "copy"] : []),
    out,
  ]);

  // A draft is not checked: its frames are smaller than the board box the
  // check crops, and it is never posted.
  if (DRAFT) {
    log("a draft: the video is not checked frame by frame");
  } else {
    const encodedReport = verifyEncodedVideo({
      ffmpeg: FFMPEG,
      video: out,
      framePattern: join(frameSequence, "v-%06d.png"),
      fps: FPS,
      ranges: encodedRanges,
      crop: encodedBoardRect,
    });
    writeFileSync(
      join(work, "encoded-verification.json"),
      JSON.stringify(encodedReport, null, 2),
    );
  }

  log(`MP4 written and checked in ${secondsSince(mp4Started)}s`);
  const sheet = wallz ? await writeContactSheet(stills, out) : null;
  for (const f of readdirSync(work)) {
    if (/^f-\d+\.png$/.test(f)) unlinkSync(join(work, f));
  }
  rmSync(frameSequence, { recursive: true, force: true });

  const bytes = statSync(out).size;
  log(`shake geometry before vs after: ${shakeGeometryVerdict}`);
  log(`wrote ${out}`);
  log(
    `${layout.width}x${layout.height}, ${totalSeconds.toFixed(1)}s, ${(bytes / 1e6).toFixed(1)} MB, ${pace}s per move`,
  );
  return {
    /*
      Seconds per step (crew.mjs prints them): load and capture are the
      run's, once for every style; compose (until the shoot pass), shoot and
      encode (with its checks) are this style's. The total is added as the
      run ends.
    */
    timings: {
      load: LOAD_SECONDS,
      capture: CAPTURE_SECONDS,
      compose: composeSeconds,
      shoot: shootSeconds,
      encode: secondsSince(encodeStarted),
    },
    mp4: out,
    bytes,
    sha256: sha256Of(out),
    durationSeconds: Number((encodedFrame / videoFps).toFixed(3)),
    /** A draft (--draft): smaller, fewer frames, not checked; never posted. */
    draft: DRAFT,
    effect: styleName,
    /**
     * The music cues that played: each track by slug, its first ply and the
     * second it starts in the video; null with --no-music.
     */
    music:
      CUES.length > 0
        ? CUES.map((c, k) => ({
            fromPly: c.fromPly,
            track: c.track.slug,
            at: Number(music[k].start.toFixed(2)),
          }))
        : null,
    /** True when the capture came from the cache: the render added no view. */
    fromCache: Boolean(cached),
    /** The plies a --plies preview played, or null for a full render. */
    preview: PLY_WINDOW,
    timeline: timelineOf(mixed, audioPath ? music : []),
    sound: wallz
      ? `vs=${sounds[style.vsSound].name},finish=${sounds.finish.name}`
      : `shake=${sounds.shake.name},win=${sounds.win.name}`,
    /*
      The daily app checks the played ending against its pick, and the EDL
      hash against the EDL it approved; the sheet is for the director.
    */
    ...(wallz && {
      ending: LAST_BOARD === history.length ? style.ending : null,
      // No hash on a preview: the daily app accepts only its EDL's hash.
      edlSha256: PLY_WINDOW ? null : EDL_SHA256,
      sheet,
      layout: {
        frame: DAILY_FRAME,
        boxes: layoutBoxes,
        captionText,
        grid: layoutGrid,
      },
      /*
        The credit line on the video's ending (the box is layout.boxes.credit):
        the words a COPY REQUEST names. Null in a render with no EDL.
      */
      credit: creditText
        ? {
            text: CREDIT,
            lines: creditText.lines,
            width: creditText.width,
            size: creditText.size,
          }
        : null,
      loudness,
      silence,
    }),
  };
};

const results = [];
for (const styleName of STYLE_NAMES) {
  const started = Date.now();
  results.push(await renderStyle(styleName));
  log(
    `style ${styleName} composed and encoded in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}
await browser.close();
log(`replay requests over the whole run: ${replayRequests()}`);
if (replayRequests() !== (cached ? 0 : 1)) {
  log(
    `WARNING: expected ${cached ? "no" : "one"} replay request, saw ${replayRequests()}`,
  );
}

for (const f of readdirSync(WORK)) {
  if (/^board-\d+\.png$/.test(f)) unlinkSync(join(WORK, f));
}

/*
  One RESULT line per style, and nothing else on stdout when --log is set:
  the dashboard parses these. Written past console.log on purpose, because
  --log sends console.log to the file.
*/
const runSeconds = secondsSince(RUN_STARTED);
for (const r of results) {
  r.timings.total = runSeconds;
  process.stdout.write(`RESULT ${JSON.stringify(r)}\n`);
}
