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
import { execFileSync } from "node:child_process";
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
  DEFAULT_SECONDS_PER_MOVE,
  fastForwardTag,
  dailySeatColors,
  DEFAULT_SLOT_SOUNDS,
  FRAME as DAILY_FRAME,
  REACTIONS,
  SAFE_AREA,
} from "./edl.mjs";
import { replayDistances } from "./race-replay.ts";
import { goalSentenceFor } from "../../shared/domain/variant-rules.ts";
import { MEME_SOUNDS, memeGain } from "./meme-sounds.mjs";
import { MUSIC_TRACKS } from "./music-tracks.mjs";
import { verifyEncodedVideo } from "./verify-encoded-video.mjs";
import { stampSpot } from "./stamp-spot.mjs";
import { allocateFrameRanges } from "./timeline-frames.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

/* ------------------------------------------------------------------ args -- */

const argv = process.argv.slice(2);
const cliArg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

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
  music: EDL?.music,
};
const arg = (name, fallback) => cliArg(name) ?? fromEdl[name] ?? fallback;
const flag = (name) => argv.includes(`--${name}`);

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
    errorToFile(err?.stack ?? err);
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
  console.error(
    "usage: render-game-video.mjs --game <wallgame.io game url or id>\n" +
      "       [--seconds-per-move S] [--aspect fit|square|9x16]\n" +
      "   or: render-game-video.mjs --edl FILE   (the daily look; see edl.mjs)\n" +
      "       [--music deja-vus|tea-for-two|a-legend|skippy] [--no-music]\n" +
      "       [--sounds vsMeme=shotgun-2,finish=shotgun-4] [--board-theme crisp|default] [--out FILE]\n" +
      "  plumbing, for the app rather than for a person:\n" +
      "       [--log FILE] [--work DIR] [--ffmpeg PATH]\n" +
      "       [--browser chromium|chrome] [--encoder x264|nvenc]",
  );
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
 *            EDL places, "AI" in red vs "Human" in blue as an OVERLAY over
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
if (STYLE_NAMES.includes("daily") && !EDL) {
  console.error("the daily look plays an EDL: give --edl FILE (see edl.mjs)");
  process.exit(2);
}
for (const [flagName, field] of [
  ["seconds-per-move", "pace"],
  ["music", "music"],
  ["no-music", "music"],
  ["sounds", "vsSound and finishSound"],
]) {
  if (EDL && argv.includes(`--${flagName}`)) {
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
/** The first ply a daily video plays (edl.mjs startPly); 0 otherwise. */
const START_PLY = EDL?.startPly ?? 0;
/**
 * The events that play after their move lands, in list order. A freeze
 * plays before the move; the move loop places it.
 */
const landingEventsAt = (plyIndex) =>
  eventsAt(plyIndex).filter((e) => e.kind !== "freeze");

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
/** Absolute, so browser file URLs and ffmpeg inputs resolve the same files. */
const WORK = resolve(arg("work", `tmp/game-video/${GAME_ID}-frames`));

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
 * possible - and `--no-music` turns it off.
 *
 * NOTE ON RIGHTS, which is a separate question from whether it plays: three of
 * the four songs are Uppbeat tracks and one is from itch.io, and what we hold
 * in credits.txt is licence CODES and links, not the grants themselves. Music
 * inside our own web app and music inside a video posted to someone else's
 * platform are different uses. Nothing here establishes the second one.
 */
const SONG_DIR = join(REPO, "frontend/public/audio/songs");

const pickTrack = () => {
  if (flag("no-music")) return null;
  const asked = arg("music");
  if (!asked)
    return MUSIC_TRACKS[Math.floor(Math.random() * MUSIC_TRACKS.length)];
  const hit = MUSIC_TRACKS.find(
    (t) => t.file === asked || t.file === `${asked}.mp3` || t.slug === asked,
  );
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
    `--music ${asked} not found. Known: ${MUSIC_TRACKS.map((t) => `${t.file} (${t.slug})`).join(", ")}`,
  );
  process.exit(2);
};
const TRACK = pickTrack();
const MUSIC = TRACK
  ? existsSync(TRACK.file)
    ? TRACK.file
    : join(SONG_DIR, TRACK.file)
  : null;

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
const OUT = resolve(arg("out", `tmp/game-video/${GAME_ID}.mp4`));
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

/** Seconds the music takes to arrive, and to leave before the end card. */
const MUSIC_FADE_IN = 1.6;
const MUSIC_FADE_OUT = 2.0;

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
 * item 4); its event lasts STAMP_LAND_AT + STAMP_SECONDS.
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
const TRAP_SECONDS = 1.6;
const TRAP_STAMP_AT = 0.55;
const FREEZE_PUSH = 0.25;
const FREEZE_SCALE = 1.6;
const RACE_TICK_SECONDS = 0.3;
const RACE_FLASH_SECONDS = 0.8;
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
 * The music under the daily ending: it fades to this share of its level as
 * the ending starts and holds there to the end, instead of to silence
 * (audit item 6: every daily mix was below -40 dB for 1.5-1.8 s before its
 * end, which on a phone sounds like the video stopped).
 */
const MUSIC_BED = 0.35;
/**
 * How far a shake may scale the composition: it must not, so this only
 * absorbs float noise in the matrix read. See the winning shake below.
 */
const SCALE_TOLERANCE = 0.001;
/** How long a wallz video holds its last position when nobody won. */
const DRAW_HOLD_SECONDS = 1.3;

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
  TRACK
    ? `music: ${TRACK.title}${arg("music") ? "" : " (picked at random)"}`
    : "music: off",
);
/* ------------------------------------------------------- capture, part 1 -- */

mkdirSync(WORK, { recursive: true });
for (const f of readdirSync(WORK))
  rmSync(join(WORK, f), { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch({
  ...(BROWSER === "chrome" ? { channel: "chrome" } : {}),
  args: ["--no-sandbox"],
});

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
const {
  page: gamePage,
  replay,
  replayRequests,
} = await openGamePage(CAPTURE_DPR);
let game = gamePage;

const history = replay.state?.history ?? [];
if (history.length === 0) {
  console.error(`game ${GAME_ID} has no moves to show`);
  await browser.close();
  process.exit(4);
}

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
const capturePlan = captureFeedbackPlan({
  isFinalPly: true,
  resultReason: outcome?.reason,
});
const CAPTURE_SHAKE = capturePlan.stageShakeCount === 1;

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
const cards = await game.evaluate((origin) => {
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
const portraitPage = await browser.newPage({
  viewport: { width: PORTRAIT_PX, height: PORTRAIT_PX },
  deviceScaleFactor: 2,
});
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

for (const playerId of [1, 2]) {
  const card = cardFor(playerId);
  const layers = await Promise.all(
    card.layers.map(async (l) => ({ ...l, data: await inlineLayer(l.src) })),
  );
  await portraitPage.setContent(
    `<html><body style="margin:0;width:${PORTRAIT_PX}px;height:${PORTRAIT_PX}px;background:transparent">
       <div style="position:relative;width:100%;height:100%">
         ${layers
           .map(
             (l) =>
               `<img src="${l.data}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;filter:${l.filter}">`,
           )
           .join("")}
       </div></body></html>`,
    { waitUntil: "networkidle" },
  );
  const file = join(WORK, `portrait-p${playerId}.png`);
  await portraitPage.screenshot({ path: file, omitBackground: true });
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
      imgs.map((i) => (i.complete ? null : new Promise((r) => (i.onload = r)))),
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

/** The board grid: the arrows overlay is `absolute inset-0` inside it. */
const measureBoard = (page) =>
  page.evaluate(() => {
    const grid = document.querySelector("svg.absolute.inset-0")?.parentElement;
    if (!grid) return null;
    const r = grid.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

let boardBox = await measureBoard(game);
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
  The daily look draws the walls that were on the board at the start in a
  muted grey (audit item 7): with Red vs Blue the only story, a third colour
  is noise. The site paints them SITE_START_WALL (frontend board.tsx,
  NEUTRAL_WALL_COLOR) inline - a wall's background, a pillar's fill - so a
  stylesheet rule with !important repaints them on the capture page only;
  the site does not change. The rule is page-wide (brown off the board turns
  grey too), but only the board clip goes into the video. One capture serves
  every style of a run, so with --style current,daily the current look gets
  the grey walls too.
*/
const SITE_START_WALL = "#92400e";
const DAILY_START_WALL = "#64748b";
/**
 * On the board, count the parts painted the site's start-wall colour and
 * the parts painted the daily grey.
 */
const countWallPaint = () =>
  game.evaluate(
    ([c, site, grey]) => {
      const norm = (color) => {
        const d = document.createElement("div");
        d.style.color = color;
        document.body.append(d);
        const v = getComputedStyle(d).color;
        d.remove();
        return v;
      };
      const [siteRgb, greyRgb] = [norm(site), norm(grey)];
      let siteParts = 0;
      let greyParts = 0;
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        if (x < c.x || x > c.x + c.width || y < c.y || y > c.y + c.height)
          continue;
        const cs = getComputedStyle(el);
        const paints = [cs.backgroundColor, cs.fill];
        if (paints.includes(siteRgb)) siteParts += 1;
        if (paints.includes(greyRgb)) greyParts += 1;
      }
      return { site: siteParts, grey: greyParts };
    },
    [clip, SITE_START_WALL, DAILY_START_WALL],
  );
if (STYLE_NAMES.includes("daily")) {
  // Every position shows the start walls: no move removes one.
  const startWalls = replay.state.initialState.walls.length;
  const before = await countWallPaint();
  if (startWalls > 0 && before.site === 0) {
    throw new Error(
      `the game has ${startWalls} start walls, but nothing on the board is ${SITE_START_WALL}: the site changed how it paints them`,
    );
  }
  await game.addStyleTag({
    content:
      // The browser writes an inline colour as rgb(r, g, b).
      `[style*="background-color: rgb(${[1, 3, 5].map((i) => parseInt(SITE_START_WALL.slice(i, i + 2), 16)).join(", ")})"] { background-color: ${DAILY_START_WALL} !important; }\n` +
      `[fill="${SITE_START_WALL}" i] { fill: ${DAILY_START_WALL} !important; }`,
  });
  const after = await countWallPaint();
  if (after.site > 0 || after.grey < before.grey + before.site) {
    throw new Error(
      `the start walls did not all turn grey: ${before.site} parts were ${SITE_START_WALL}, and after the repaint ${after.site} still are, ${after.grey} are grey (${before.grey} were before)`,
    );
  }
  log(`start walls: ${startWalls}, ${before.site} parts repainted grey`);
}

const moveButtons = game.locator("button[aria-pressed]:visible");
if ((await moveButtons.count()) !== history.length) {
  throw new Error(
    `replay exposes ${await moveButtons.count()} move buttons for ${history.length} recorded plies`,
  );
}
const jumpStart = game.getByRole("button", { name: "Jump to beginning" });
/**
 * Where the page drew each pawn at each captured position, as centres in the
 * board image (0..1), keyed by board index (0 = the start). Read off the
 * page's own pawn images at capture time, so the mouse beats can put their
 * bubble where it covers no other pawn without a second copy of the rules.
 */
const pawnSpots = new Map();
const captureResult = await captureReplayFrames({
  moveCount: history.length,
  selectInitial: async () => {
    await jumpStart.click();
    await game.waitForFunction(() => {
      const button = document.querySelector(
        'button[aria-label="Jump to beginning"]',
      );
      return button?.disabled === true;
    });
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
              i === index || candidate.getAttribute("aria-pressed") !== "true",
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
      if ((await moveButtons.nth(i).getAttribute("aria-pressed")) === "true")
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
    pawnSpots.set(
      expectedPly + 1,
      await game.evaluate((c) => {
        const spots = [];
        for (const img of document.querySelectorAll('img[src*="/pawns/"]')) {
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
    return file;
  },
});
assertCompleteCapture(captureResult);
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
log(`${boardFrames.length} board positions captured`);
await game.close();

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
 * meme-sounds.mjs, which also says where they come from and why they are not
 * in the repository. The EDL names its sound cues by these keys.
 */
const MEME_DIR = join(REPO, "assets/meme-sounds");
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
  make-stings.mjs is deterministic, so the wav is rebuilt here when it is
  missing. That keeps the repository free of generated audio without making a
  fresh checkout render a silent VS screen.
*/
if (AUDIO && !existsSync(SOUNDS.vsStamp.file)) {
  log("riser not built yet; running make-stings.mjs");
  execFileSync(process.execPath, [join(HERE, "make-stings.mjs")], {
    stdio: "inherit",
  });
}

const stingManifest = existsSync(join(STING_DIR, "stings.json"))
  ? JSON.parse(readFileSync(join(STING_DIR, "stings.json"), "utf8"))
  : { vsHitSeconds: 0 };

/**
 * Mix the cues the composer recorded, and the music under them.
 *
 * Every cue carries the second its frame went into the timeline, so a sound
 * cannot drift off its picture when a beat is retimed or a swing move holds
 * longer than a routine one.
 *
 * The music starts at `musicStart` and its fade COMPLETES at `musicEndAt`, the
 * moment the last sting arrives. Measured 2026-08-19: with the fade spread
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
 */
const buildAudio = ({
  cues,
  totalSeconds,
  musicStart,
  musicEndAt,
  bed,
  work,
}) => {
  const present = cues.filter((e) => existsSync(e.file));
  for (const missing of cues.filter((e) => !existsSync(e.file))) {
    log(`WARNING: sound missing, left out of the mix: ${missing.file}`);
  }
  if (present.length === 0) return null;

  const inputs = present.flatMap((e) => ["-i", e.file]);
  const chains = present.map(
    (e, i) =>
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
      // A rate above 1 plays the sound higher and shorter.
      (e.rate === 1
        ? ""
        : `asetrate=${Math.round(44100 * e.rate)},aresample=44100,`) +
      `adelay=${Math.round(Math.max(0, e.at) * 1000)}:all=1,volume=${e.gain}[a${i}]`,
  );
  // The effects bus. Everything above lands here.
  chains.push(
    present.map((_, i) => `[a${i}]`).join("") +
      `amix=inputs=${present.length}:normalize=0:dropout_transition=0,` +
      `apad,atrim=0:${totalSeconds.toFixed(3)}[fx]`,
  );

  let last = "[fx]";
  if (MUSIC) {
    const musicSeconds = totalSeconds - musicStart;
    const fadeOutAt = Math.max(0, musicEndAt - musicStart - MUSIC_FADE_OUT);
    inputs.push("-i", MUSIC);
    const mi = present.length;
    /*
      The fade out goes to `bed` (a share of the level) rather than to
      silence when bed > 0: a linear ramp from 1 to bed over the fade, then
      bed to the end. With bed 0 it is the plain fade the current look has.
    */
    const a = fadeOutAt.toFixed(3);
    const b = (fadeOutAt + MUSIC_FADE_OUT).toFixed(3);
    const fadeOut =
      bed > 0
        ? `volume='if(lt(t,${a}),1,if(lt(t,${b}),1-(1-${bed})*(t-${a})/${MUSIC_FADE_OUT},${bed}))':eval=frame,`
        : `afade=t=out:st=${a}:d=${MUSIC_FADE_OUT},`;
    chains.push(
      `[${mi}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
        `atrim=0:${musicSeconds.toFixed(3)},` +
        `afade=t=in:st=0:d=${MUSIC_FADE_IN},` +
        fadeOut +
        `volume=${MUSIC_VOLUME},adelay=${Math.round(musicStart * 1000)}:all=1[mus]`,
    );
    chains.push(
      `[fx][mus]amix=inputs=2:normalize=0:dropout_transition=0[mixed]`,
    );
    last = "[mixed]";
  }

  chains.push(
    `${last}alimiter=limit=0.95,atrim=0:${totalSeconds.toFixed(3)}[out]`,
  );

  // What went into the mix, so its parts can be rebuilt and measured apart.
  writeFileSync(
    join(work, "audio-plan.json"),
    JSON.stringify(
      {
        totalSeconds,
        musicStart,
        musicEndAt,
        bed,
        music: MUSIC,
        musicVolume: MUSIC_VOLUME,
        musicFadeIn: MUSIC_FADE_IN,
        musicFadeOut: MUSIC_FADE_OUT,
        cues: present,
      },
      null,
      1,
    ),
  );
  const audioPath = join(work, "track.m4a");
  ff([
    ...inputs,
    "-filter_complex",
    chains.join(";"),
    "-map",
    "[out]",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    audioPath,
  ]);
  return audioPath;
};

/* ----------------------------------------------------------- compose it -- */

const fileUrl = (p) => `file://${resolve(p)}`;

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
 * A side as the daily VS overlay shows it: no name, only whether the side is
 * the AI or a human (Nil, 2026-10-26), drawn in the side's colour. No
 * emoji: Nil found the first version "too crowded".
 */
const overlaySide = (playerId) => ({
  ...side(playerId),
  word: seatLabel(playerId) === "bot" ? "AI" : "Human",
});

/**
 * Where a cell sits on the captured board image, as fractions of its width
 * and height.
 *
 * The capture clip is the replay page's grid plus PAD on every side, so the
 * grid spans [pad, 1 - pad]. Rows are counted the way standard notation counts
 * them (shared/domain/standard-notation.ts): row 1 is the bottom row, and the
 * replay page draws it at the bottom.
 */
const GRID = {
  cols: replay.state.config.boardWidth,
  rows: replay.state.config.boardHeight,
  pad: PAD / clip.width,
};
const cellAt = ([row, col]) => {
  const span = 1 - 2 * GRID.pad;
  return {
    x: GRID.pad + ((col + 0.5) / GRID.cols) * span,
    y: GRID.pad + ((row + 0.5) / GRID.rows) * span,
  };
};

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
 * the board is not a choice; on a tie the earlier side wins.
 */
const BUBBLE_SIDES = {
  up: [0, -1],
  right: [1, 0],
  left: [-1, 0],
  down: [0, 1],
};
const bubbleSide = (boardIndex, at) => {
  // One cell in each axis, so a board with rows != cols measures true cells.
  const cellX = (1 - 2 * GRID.pad) / GRID.cols;
  const cellY = (1 - 2 * GRID.pad) / GRID.rows;
  const away = (p, x, y) => Math.hypot((p.x - x) / cellX, (p.y - y) / cellY);
  const others = (pawnSpots.get(boardIndex) ?? []).filter(
    (p) => away(p, at.x, at.y) > 0.3,
  );
  let best = "up";
  let bestRoom = -1;
  for (const [side, [dx, dy]] of Object.entries(BUBBLE_SIDES)) {
    const x = at.x + dx * cellX;
    const y = at.y + dy * cellY;
    if (x < GRID.pad || x > 1 - GRID.pad || y < GRID.pad || y > 1 - GRID.pad)
      continue;
    const room = Math.min(Infinity, ...others.map((p) => away(p, x, y)));
    if (room > bestRoom + 1e-9) {
      best = side;
      bestRoom = room;
    }
  }
  return best;
};

/**
 * Where a stamp or trap word goes (stamp-spot.mjs), over the position after
 * `boardIndex` plies: it avoids the pawns the page drew there (their
 * measured boxes), the cell and walls of the move `plyIndex`, and
 * `extraWalls` (a trap's). `size` is the word's measured box.
 */
const placeStamp = (boardIndex, plyIndex, size, extraWalls) => {
  const span = 1 - 2 * GRID.pad;
  const cellW = span / GRID.cols;
  const cellH = span / GRID.rows;
  const ofCells = ([top, left, bottom, right]) => [
    GRID.pad + left * cellW,
    GRID.pad + top * cellH,
    GRID.pad + right * cellW,
    GRID.pad + bottom * cellH,
  ];
  const cell = cellOfPly(plyIndex);
  const moveWalls = String(history[plyIndex]?.notation ?? "")
    .split(".")
    .filter((t) => t.startsWith(">") || t.startsWith("^"));
  return stampSpot({
    size,
    pad: GRID.pad,
    avoid: [
      ...(pawnSpots.get(boardIndex) ?? []).map((p) => [
        p.x - p.w / 2,
        p.y - p.h / 2,
        p.x + p.w / 2,
        p.y + p.h / 2,
      ]),
      ...(cell ? [ofCells([cell[0], cell[1], cell[0] + 1, cell[1] + 1])] : []),
      ...[...moveWalls, ...extraWalls].map((t) => ofCells(termBox(t))),
    ],
    cellArea: cellW * cellH,
    focus: cell ? cellAt(cell) : null,
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

/**
 * An EDL wall as the line it draws on the board image, [x1, y1, x2, y2] in
 * 0..1: ^h4 is the top edge of h4, >h4 its right edge.
 */
const wallLine = (term) => {
  const m = term.match(/^([>^])([a-z])(\d+)$/);
  const row = GRID.rows - Number(m[3]);
  const col = m[2].charCodeAt(0) - "a".charCodeAt(0);
  const span = 1 - 2 * GRID.pad;
  const x = (c) => GRID.pad + (c / GRID.cols) * span;
  const y = (r) => GRID.pad + (r / GRID.rows) * span;
  return m[1] === "^"
    ? [x(col), y(row), x(col + 1), y(row)]
    : [x(col + 1), y(row), x(col + 1), y(row + 1)];
};

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
const frameZoom = (terms, maxScale) => {
  const boxes = terms.map(termBox);
  const top = Math.min(...boxes.map((b) => b[0])) - ZOOM_MARGIN;
  const left = Math.min(...boxes.map((b) => b[1])) - ZOOM_MARGIN;
  const bottom = Math.max(...boxes.map((b) => b[2])) + ZOOM_MARGIN;
  const right = Math.max(...boxes.map((b) => b[3])) + ZOOM_MARGIN;
  const span = 1 - 2 * GRID.pad;
  const w = ((right - left) / GRID.cols) * span;
  const h = ((bottom - top) / GRID.rows) * span;
  const scale = Math.max(1.05, Math.min(maxScale, 1 / Math.max(w, h)));
  const centre = {
    x: GRID.pad + ((left + right) / 2 / GRID.cols) * span,
    y: GRID.pad + ((top + bottom) / 2 / GRID.rows) * span,
  };
  const origin = (c) =>
    Math.max(0, Math.min(1, (scale * c - 0.5) / (scale - 1)));
  return { scale, x: origin(centre.x), y: origin(centre.y) };
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
  });
  if (problems.length > 0) {
    console.error(`the EDL does not fit the game:\n  ${problems.join("\n  ")}`);
    await browser.close();
    process.exit(2);
  }
}

/**
 * Each player's steps to their target at every position, from the game
 * record through shared/domain (race-replay.ts), the same numbers the
 * daily picker ranks by. The daily look shows them all video long (audit
 * item 1); a variant where a side hunts nothing (Survival) shows no counter,
 * and an EDL that flashes the counter there is refused.
 */
const RACE_DISTANCES = (() => {
  if (!EDL) return null;
  const { distances } = replayDistances({
    variant: replay.state.config.variant,
    boardWidth: GRID.cols,
    boardHeight: GRID.rows,
    initialState: replay.state.initialState,
    moves: history.map((h) => h.notation),
  });
  return distances.every((d) => d[1] !== null && d[2] !== null)
    ? distances
    : null;
})();
if (EDL && !RACE_DISTANCES && EVENTS.some((e) => e.kind === "race")) {
  console.error(
    `the EDL flashes the race counter, but ${replay.state.config.variant} gives a side nothing to hunt, so the video shows no counter`,
  );
  await browser.close();
  process.exit(2);
}

/**
 * The variant's goal in one line, from the rules guide's own sentence
 * (shared/domain/variant-rules.ts), for the daily VS card. Null when the
 * variant has no rules guide.
 */
const GOAL_LINE = EDL ? goalSentenceFor(replay.state.config.variant) : null;

/**
 * The 9:16 frame of the wallz look. The caption, the head row and the board
 * stack inside SAFE_AREA (edl.mjs), SHAKE_ROOM in from its edges so the
 * shakes stay inside too; the stage then sizes the board to what is left
 * (window.__fitWallz), so --board here is only a first guess.
 */
const SHAKE_ROOM = 16;
const WALLZ_LAYOUT = {
  width: DAILY_FRAME.w,
  height: DAILY_FRAME.h,
  vars: {
    ...frameVars(DAILY_FRAME.h, SAFE_AREA.w - 2 * SHAKE_ROOM, 0),
    "--caption-size": "56px",
    "--caption-gap": "36px",
    "--head-gap": "14px",
    "--shake-room": `${SHAKE_ROOM}px`,
    "--safe-top": `${SAFE_AREA.y}px`,
    "--safe-left": `${SAFE_AREA.x}px`,
    "--safe-right": `${DAILY_FRAME.w - SAFE_AREA.x - SAFE_AREA.w}px`,
    "--safe-bottom": `${DAILY_FRAME.h - SAFE_AREA.y - SAFE_AREA.h}px`,
  },
};

const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/**
 * The camera scale at `t` seconds into a punch-in to `scale` that holds for
 * `hold`. It drifts in a little during the hold, so the frame never freezes.
 */
const zoomAt = (t, scale, hold) => {
  const drift = 0.04;
  if (t < ZOOM_IN) return 1 + (scale - 1) * easeOut(t / ZOOM_IN);
  if (t < ZOOM_IN + hold) return scale + (drift * (t - ZOOM_IN)) / hold;
  const back = Math.min(1, (t - ZOOM_IN - hold) / ZOOM_OUT);
  return scale + drift - (scale + drift - 1) * easeInOut(back);
};

const sha256Of = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

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
    label: `ply ${st.ply} (move ${st.ply + 1}) - ${st.kind}${st.sound ? ` - ${st.sound}` : ""} - ${st.at.toFixed(1)}s`,
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
    stills: stills.map(({ ply, kind, sound }) => ({ ply, kind, sound })),
  };
};

/**
 * Compose, mix, encode and verify one style from the board captures above.
 * Returns what the RESULT line reports.
 */
const renderStyle = async (styleName) => {
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

  const stage = await browser.newPage({
    viewport: { width: layout.width, height: layout.height },
    deviceScaleFactor: 1,
  });
  await stage.goto(`file://${join(HERE, "stage.html")}`, {
    waitUntil: "load",
  });
  await stage.evaluate((vars) => {
    for (const [k, v] of Object.entries(vars)) {
      document.documentElement.style.setProperty(k, v);
    }
  }, layout.vars);
  /*
    The VS names are fitted by measuring them, and a measurement taken while
    a font still loads is wrong, so no frame is taken before the fonts are in.
  */
  await stage.evaluate(() => document.fonts.ready);

  /** The daily look's board, sized by the stage to what the safe area leaves. */
  if (wallz) {
    const board = await stage.evaluate((a) => window.__fitWallz(a), {
      captions: CAPTIONS,
      hud: Boolean(RACE_DISTANCES || GOAL_LINE),
      goal: GOAL_LINE,
    });
    log(`daily board ${board}px, inside the safe area`);
  }

  /** Published by stage.html: each ending's length, hold and impact second. */
  const endingTimings = await stage.evaluate(() => window.__ENDINGS);

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
  const cue = (sound, at = elapsed) =>
    cues.push({
      file: sound.file,
      gain: sound.gain,
      at,
      rate: sound.rate ?? 1,
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
  const shoot = async (state, seconds, meta) => {
    firstState ??= state;
    const file = join(work, `f-${String(frameNo++).padStart(5, "0")}.png`);
    await stage.evaluate((s) => window.__stage(s), state);
    await stage.screenshot({ path: file });
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
  const overlay = style.vsOverlay
    ? await stage.evaluate(() => window.__VS_OVERLAY)
    : null;
  /** Where the overlay starts: after the cold open, if there is one. */
  let overlayStart = 0;
  const inOverlay = () =>
    elapsed >= overlayStart - 1e-6 &&
    elapsed < overlayStart + overlay.seconds - 1e-6;
  const emit = async (state, seconds, meta = {}) => {
    if (!overlay || state.segment !== "play" || !inOverlay()) {
      await shoot(state, seconds, meta);
      return;
    }
    const frames = Math.round(seconds * FPS);
    let used = 0;
    for (; used < frames && inOverlay(); used += 1) {
      await shoot(
        {
          ...state,
          vsOverlay: {
            t: elapsed - overlayStart,
            a: overlaySide(seats.top),
            b: overlaySide(seats.bottom),
          },
        },
        1 / FPS,
        { ...meta, kind: "vs-overlay" },
      );
    }
    if (used < frames) await shoot(state, (frames - used) / FPS, meta);
  };

  /**
   * The playing state of a position: the board, the caption, the race
   * counter and the goal line. Effects add to it through `extra`.
   */
  const seatColors = wallz ? SEAT_COLORS(replay) : null;
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
    const [red, blue] = seatColors[1] === "red" ? [1, 2] : [2, 1];
    return { a: seat(red), b: seat(blue), t };
  };
  const playState = (boardIndex, extra = {}) => ({
    segment: "play",
    look: style.look,
    caption: wallz ? captionAt(boardIndex) : "",
    board: fileUrl(boardFrames[boardIndex]),
    top: side(seats.top),
    bottom: side(seats.bottom),
    race: raceHud(boardIndex),
    goal: wallz ? GOAL_LINE : null,
    fastForward: fastForwardAt(boardIndex),
    ...extra,
  });

  /** The site's own click for a turn: one sound per turn, wall wins. */
  const moveClick = (plyIndex) => {
    const terms = String(history[plyIndex].notation ?? "")
      .split(".")
      .filter(Boolean);
    const hasWall = terms.some((s) => s.startsWith(">") || s.startsWith("^"));
    const take = MOVE_CLICK_VARIANTS[plyIndex % MOVE_CLICK_VARIANTS.length];
    return {
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

  /*
    The cold open (edl.mjs coldOpenPly, audit item 2): the video starts on
    the key position, caption up, that ply's walls glowing and the camera
    pushing in on them, with that move's own click; then it cuts to the VS
    overlay and the game. No overlay on these frames: they come before it.
  */
  const coldPly = wallz ? EDL.coldOpenPly : null;
  if (coldPly !== null) {
    const terms = String(history[coldPly].notation ?? "")
      .split(".")
      .filter(Boolean);
    const walls = terms.filter((t) => t.startsWith(">") || t.startsWith("^"));
    const at = cellOfPly(coldPly);
    const z = frameZoom(
      walls.length > 0 ? walls : at ? [termOfCell(at)] : ["a1"],
      COLD_OPEN_SCALE,
    );
    cue(moveClick(coldPly));
    const frames = Math.round(COLD_OPEN_SECONDS * FPS);
    for (let i = 0; i < frames; i += 1) {
      const t = i / FPS;
      const push = easeInOut(t / COLD_OPEN_SECONDS);
      await shoot(
        playState(coldPly + 1, {
          zoom: { ...z, scale: 1 + (z.scale - 1) * push },
          ...(walls.length > 0 && {
            trap: { t, walls: walls.map(wallLine), lit: true },
          }),
        }),
        1 / FPS,
        { kind: "cold-open", ply: coldPly },
      );
    }
    overlayStart = elapsed;
    log(`cold open: ply ${coldPly}, ${COLD_OPEN_SECONDS}s`);
  }

  // The overlay's punch gets the VS sound, at the second the mark lands.
  if (overlay) {
    const vsSound = sounds[style.vsSound];
    cue(
      { ...vsSound, gain: vsSound.gain * STING_STEP },
      overlayStart + overlay.entry * vsPunchFraction,
    );
  }

  // --- the VS screen, animated
  if (style.vsSeconds > 0) {
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
      cue(vsSound, Math.max(0, startAt));
    } else {
      log(
        `VS sound missing at ${vsSound.file}; falling back to the site's start sound`,
      );
      cue({
        file: join(AUDIO_DIR, "game_start.mp3"),
        gain: SITE_VOLUMES.gameStart,
      });
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
      })
    : null;
  for (const [name, b] of Object.entries(layoutBoxes ?? {})) {
    if (
      b.x < SAFE_AREA.x ||
      b.y < SAFE_AREA.y ||
      b.x + b.w > SAFE_AREA.x + SAFE_AREA.w ||
      b.y + b.h > SAFE_AREA.y + SAFE_AREA.h
    ) {
      throw new Error(
        `the ${name} box ${JSON.stringify(b)} is outside the safe area ${JSON.stringify(SAFE_AREA)}`,
      );
    }
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
   * Where each stamp and trap word lands (stampSpot) and how much it shrinks
   * to fit (STAMP_MAX_WIDTH), keyed by its event.
   */
  const stampSpots = new Map();
  if (wallz) {
    for (const ev of EVENTS) {
      if (ev.kind !== "stamp" && ev.kind !== "trap") continue;
      const measured = await stage.evaluate(
        (t) => window.__stampBox(t),
        ev.text,
      );
      const fit = Math.min(1, STAMP_MAX_WIDTH / measured.w);
      const spot = placeStamp(
        ev.ply + 1,
        ev.ply,
        { w: measured.w * fit, h: measured.h * fit },
        ev.kind === "trap" ? ev.walls : [],
      );
      stampSpots.set(ev, { at: spot.at, fit });
      log(
        `${ev.kind} "${ev.text}" on ply ${ev.ply}: ${spot.band} of the board at ${fit.toFixed(2)} size, over ${spot.covered.toFixed(2)} cells of the move`,
      );
    }
  }

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
    if (ev.kind === "trap") {
      return {
        trap: { t, walls: ev.walls.map(wallLine) },
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
    const at = cellAtTerm(ev.cell);
    const size = (1 - 2 * GRID.pad) / GRID.cols;
    if (ev.kind === "scared" || ev.kind === "laugh") {
      return {
        beat: {
          kind: ev.kind,
          t,
          board: fileUrl(boardFrames[ply]),
          cell: at,
          size,
          side: bubbleSide(ply, at),
        },
      };
    }
    const cellFx = {
      kind: ev.kind,
      t,
      cell: at,
      size,
      side: bubbleSide(ply, at),
      emoji: ev.kind === "react" ? REACTIONS[ev.emoji] : undefined,
    };
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
    if (ev.sound) cue(meme(ev.sound));
    const z = frameZoom([termOfCell(at)], FREEZE_SCALE);
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
  const playEvents = async (ply, plyIndex) => {
    for (const ev of landingEventsAt(plyIndex)) {
      const label = { ply: plyIndex, kind: ev.kind, sound: ev.sound ?? null };
      if (ev.sound) {
        const sound = meme(ev.sound);
        // A stamp's sound lands with its word.
        cue(
          {
            ...sound,
            gain: sound.gain * (ev.kind === "scared" ? STING_STEP : 1),
          },
          elapsed + (ev.kind === "stamp" ? STAMP_LAND_AT : 0),
        );
      }
      if (ev.kind === "sound") {
        stillNext = label;
        continue;
      }
      if (ev.kind === "zoom") {
        const z = frameZoom(ev.frame, ev.scale);
        const frames = Math.round((ZOOM_IN + ev.holdSeconds + ZOOM_OUT) * FPS);
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
        continue;
      }
      const seconds = {
        scared: SCARED_SECONDS,
        laugh: LAUGH_SECONDS,
        stamp: STAMP_LAND_AT + STAMP_SECONDS,
        blunder: BLUNDER_SECONDS,
        brilliant: BRILLIANT_SECONDS,
        react: REACT_SECONDS,
        trap: TRAP_SECONDS,
        race: RACE_FLASH_SECONDS,
      }[ev.kind];
      const frames = Math.round(seconds * FPS);
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
    }
    await emit(playState(ply), EFFECT_REST_SECONDS, {
      kind: "move",
      ply: plyIndex,
    });
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
    the VS overlay it holds longer: nothing moves under the full banners, and
    the first move plays only once they start to leave (Nil, 2026-10-26).
  */
  const firstMoveAt = overlay
    ? overlayStart + overlay.seconds - overlay.exit
    : 0;
  // With a startPly, the opening position is the one before that ply; it is
  // labelled as that earlier ply, which the video never plays on its own.
  await emit(
    playState(START_PLY),
    Math.max(
      paceAt(START_PLY),
      Math.round((firstMoveAt - elapsed) * FPS) / FPS,
    ),
    { kind: "initial", ply: START_PLY - 1 },
  );

  const winnerId = outcome?.winnerId ?? null;
  let musicEndAt = null;

  for (let ply = START_PLY + 1; ply <= history.length; ply += 1) {
    const plyIndex = ply - 1;
    const isLast = ply === history.length;
    if (wallz) await playFreeze(ply, plyIndex);
    cue(moveClick(plyIndex));
    /*
      The tick takes its time from a plain move's hold, leaving that hold
      one frame at least; a move with effects keeps all of its own.
    */
    const plainMove =
      wallz && !isLast && landingEventsAt(plyIndex).length === 0;
    const ticked = wallz
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
        await playEvents(ply, plyIndex);
      } else {
        await emit(playState(ply), paceAt(plyIndex), {
          kind: "move",
          ply: plyIndex,
        });
      }
      musicEndAt = elapsed;
      if (winnerId) {
        const timing = endingTimings[style.ending];
        const ending = (t) => ({
          kind: style.ending,
          t,
          at: cellAt(
            cellOfPly(plyIndex) ?? [GRID.rows / 2 - 0.5, GRID.cols / 2 - 0.5],
          ),
          cell: (1 - 2 * GRID.pad) / GRID.cols,
          before: fileUrl(boardFrames[ply - 1]),
          stamp: FINISH_WORD,
          how: `wins ${FINISH_WORD === "HOME" ? "by reaching home" : (REASON_WORDS[outcome.reason] ?? outcome.reason)}`,
          winner: side(winnerId),
          loser: side(winnerId === 1 ? 2 : 1),
        });
        cue(sounds.finish, elapsed + timing.impact);
        const endingFrames = Math.round(timing.seconds * FPS);
        for (let i = 0; i < endingFrames; i += 1) {
          await emit(playState(ply, { ending: ending(i / FPS) }), 1 / FPS, {
            kind: "ending",
            ply: plyIndex,
          });
        }
        await emit(
          playState(ply, { ending: ending(timing.seconds) }),
          timing.hold,
          { kind: "ending-hold", ply: plyIndex },
        );
      } else {
        await emit(playState(ply), DRAW_HOLD_SECONDS, {
          kind: "move",
          ply: plyIndex,
        });
      }
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
      cue(sounds.shake);
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
    if (ply % 10 === 0) log(`  ${ply}/${history.length} plies composed`);
  }

  // --- the end card, in the current look only: wallz has its own endings.
  if (!wallz) {
    musicEndAt = elapsed;
    cue(
      existsSync(sounds.win.file)
        ? sounds.win
        : { file: join(AUDIO_DIR, "game_end.mp3"), gain: SITE_VOLUMES.gameEnd },
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
  log(`${timeline.length} frames written`);

  /* ------------------------------------------------------------- encode -- */

  const totalSeconds = timeline.reduce((a, f) => a + f.seconds, 0);
  const frameSequence = join(work, "cfr");
  rmSync(frameSequence, { recursive: true, force: true });
  mkdirSync(frameSequence, { recursive: true });
  const encodedRanges = allocateFrameRanges(timeline, FPS);
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
      { fps: FPS, totalFrames: encodedFrame, ranges: encodedRanges },
      null,
      2,
    ),
  );

  let audioPath = null;
  if (AUDIO) {
    try {
      audioPath = buildAudio({
        cues,
        totalSeconds,
        musicStart,
        musicEndAt: musicEndAt ?? totalSeconds,
        bed: wallz ? MUSIC_BED : 0,
        work,
      });
      log(
        MUSIC
          ? `soundtrack built, with music under the effects (${MUSIC})`
          : "soundtrack built from the site's own effects",
      );
    } catch (err) {
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
  mkdirSync(dirname(out), { recursive: true });
  ff([
    "-framerate",
    String(FPS),
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
    mp4: out,
    bytes,
    sha256: sha256Of(out),
    durationSeconds: Number((encodedFrame / FPS).toFixed(3)),
    effect: styleName,
    /** The track that played, by slug; null with --no-music. */
    music: TRACK?.slug ?? null,
    sound: wallz
      ? `vs=${sounds[style.vsSound].name},finish=${sounds.finish.name}`
      : `shake=${sounds.shake.name},win=${sounds.win.name}`,
    /*
      The daily app checks the played ending against its pick, and the EDL
      hash against the EDL it approved; the sheet is for the director.
    */
    ...(wallz && {
      ending: style.ending,
      edlSha256: EDL_SHA256,
      sheet,
      layout: { frame: DAILY_FRAME, boxes: layoutBoxes, captionText },
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
if (replayRequests() !== 1) {
  log(`WARNING: expected one replay request, saw ${replayRequests()}`);
}

for (const f of readdirSync(WORK)) {
  if (/^board-\d+\.png$/.test(f)) unlinkSync(join(WORK, f));
}

/*
  One RESULT line per style, and nothing else on stdout when --log is set:
  the dashboard parses these. Written past console.log on purpose, because
  --log sends console.log to the file.
*/
for (const r of results) process.stdout.write(`RESULT ${JSON.stringify(r)}\n`);
