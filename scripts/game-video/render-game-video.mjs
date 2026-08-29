/**
 * Turn a finished Wall Game into a video you can post.
 *
 * Board task f89e649f. Takes a past-game URL, plays the game back through the
 * real replay page in real Chrome, and writes an mp4 sized for a phone feed:
 * a VS screen, the moves at a chosen pace, and a winner card.
 *
 *   node scripts/game-video/render-game-video.mjs --game https://wallgame.io/game/v5P09s6K
 *   node scripts/game-video/render-game-video.mjs --game v5P09s6K --seconds-per-move 0.5
 *   node scripts/game-video/render-game-video.mjs --game v5P09s6K --aspect square
 *   node scripts/game-video/render-game-video.mjs --game v5P09s6K --music a-legend
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
 * Needs: playwright-core with Chrome (no browser download), and ffmpeg.
 */
import { chromium } from "playwright-core";
import {
  mkdirSync,
  writeFileSync,
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
import { fileURLToPath } from "node:url";
import {
  assertCompleteCapture,
  captureReplayFrames,
} from "./capture-replay-frames.mjs";
import { captureFeedbackPlan } from "./capture-feedback.mjs";
import { verifyEncodedVideo } from "./verify-encoded-video.mjs";
import { allocateFrameRanges } from "./timeline-frames.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

/* ------------------------------------------------------------------ args -- */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const rawGame = arg("game");
if (!rawGame) {
  console.error(
    "usage: render-game-video.mjs --game <wallgame.io game url or id>\n" +
      "       [--seconds-per-move 0.8] [--aspect fit|square|9x16]\n" +
      "       [--music deja-vus|tea-for-two|a-legend|skippy] [--no-music]\n" +
      "       [--board-theme crisp|default] [--out FILE]\n" +
      "  plumbing, for the app rather than for a person:\n" +
      "       [--work DIR] [--ffmpeg PATH]",
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
const SECONDS_PER_MOVE = Number(arg("seconds-per-move", "0.8"));
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

/**
 * What each song file actually is, decoded from its ID3 tags 2026-08-19 and
 * recorded in credits.txt. The filenames say nothing, so this is the only way
 * a render can label its own track - and the only way to name one, since the
 * site's random start means there is no "first" song.
 */
const MUSIC_TRACKS = [
  { file: "song1.mp3", title: "Deja Vus (2nd loop) - YannZ", slug: "deja-vus" },
  {
    file: "song2.mp3",
    title: "Tea For Two - Aaron Paul Low",
    slug: "tea-for-two",
  },
  { file: "song3.mp3", title: "A Legend - Ian Aisling", slug: "a-legend" },
  {
    file: "song4.mp3",
    title: "Skippy Mr. Sunshine - Fernweh Goldfish",
    slug: "skippy",
  },
];

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

const MUSIC_VOLUME = 0.3;
const SHAKE_GAIN = 0.6;
const WIN_GAIN = 0.2;
/** Multiplies the site's own pawn and wall levels, keeping their balance. */
const MOVE_GAIN = 1.6;

/** Seconds the music takes to arrive, and to leave before the end card. */
const MUSIC_FADE_IN = 1.6;
const MUSIC_FADE_OUT = 2.0;

if (!Number.isFinite(SECONDS_PER_MOVE) || SECONDS_PER_MOVE <= 0) {
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
const VS_SECONDS = 3.8;
const FINAL_HOLD_SECONDS = 1.8;
const END_SECONDS = 3.0;
/** How long the shake runs after the winning move, in seconds. */
const SHAKE_SECONDS = 0.6;

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
for (const f of readdirSync(WORK)) unlinkSync(join(WORK, f));
mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox"],
});

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
  page.on("response", async (res) => {
    if (replay || !replayUrl.test(res.url())) return;
    try {
      replay = await res.json();
    } catch {
      // A non-JSON body here is a server error; the null check below reports it.
    }
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
  if (!replay || replay.kind !== "replay") {
    console.error(
      `no replay data for ${GAME_ID}. The page answered ` +
        `${replay ? `kind "${replay.kind}"` : "nothing"} - check the id exists and the game is finished.`,
    );
    await browser.close();
    process.exit(4);
  }
  log("one replay page load = one view added to this game's count");
  return { page, replay };
};

/**
 * The replay data comes from the page's OWN request, intercepted.
 *
 * Fetching it separately would be a second `views + 1` for the same render.
 * The page has to load anyway, and it asks for exactly this JSON, so the
 * renderer reads that response instead of asking again. See openGamePage.
 */
const { page: gamePage, replay } = await openGamePage(CAPTURE_DPR);
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

const moveButtons = game.locator("button[aria-pressed]:visible");
if ((await moveButtons.count()) !== history.length) {
  throw new Error(
    `replay exposes ${await moveButtons.count()} move buttons for ${history.length} recorded plies`,
  );
}
const jumpStart = game.getByRole("button", { name: "Jump to beginning" });
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

/* ----------------------------------------------------------- compose it -- */

const stage = await browser.newPage({
  viewport: { width: LAYOUT.width, height: LAYOUT.height },
  deviceScaleFactor: 1,
});
await stage.goto(`file://${join(HERE, "stage.html")}`, { waitUntil: "load" });
await stage.evaluate((vars) => {
  for (const [k, v] of Object.entries(vars)) {
    document.documentElement.style.setProperty(k, v);
  }
}, LAYOUT.vars);

/** Published by stage.html, so the sting can be aligned to the visual punch. */
const vsPunchFraction = await stage.evaluate(() => window.__VS_PUNCH_FRACTION);

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
 * The timeline, with the exact seconds and semantic range for each image.
 * Encoding later converts every duration to an integer 30 fps frame count.
 */
const timeline = [];
let shakeGeometryVerdict = "not run (--no-shake)";

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
  const file = join(WORK, `probe-${tag}.png`);
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
    const path = join(WORK, `probe-${tag}.raw`);
    ff([
      "-i",
      join(WORK, `probe-${tag}.png`),
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
let frameNo = 0;
const emit = async (state, seconds, meta = {}) => {
  const file = join(WORK, `f-${String(frameNo++).padStart(5, "0")}.png`);
  await stage.evaluate((s) => window.__stage(s), state);
  await stage.screenshot({ path: file });
  timeline.push({ file, seconds, ...meta });
};

// --- the VS screen, animated
const vsFrames = Math.round(VS_SECONDS * FPS);
for (let i = 0; i < vsFrames; i += 1) {
  await emit(
    {
      segment: "vs",
      t: i / (vsFrames - 1),
      a: side(seats.top),
      b: side(seats.bottom),
    },
    1 / FPS,
    { kind: "vs-transition" },
  );
}
log("vs screen rendered");

// --- the moves
const playState = (boardIndex, extra = {}) => ({
  segment: "play",
  board: fileUrl(boardFrames[boardIndex]),
  top: side(seats.top),
  bottom: side(seats.bottom),
  ...extra,
});
await stage.evaluate((state) => window.__stage(state), playState(0));
const encodedBoardRect = await stage.evaluate(() => {
  const rect = document.getElementById("boardWrap").getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
});

// The starting position gets one beat of its own, so the first move is a
// change the eye can catch rather than the first thing it ever sees.
await emit(playState(0), SECONDS_PER_MOVE, { kind: "initial", ply: -1 });

for (let ply = 1; ply <= history.length; ply += 1) {
  const isLast = ply === history.length;
  if (isLast && CAPTURE_SHAKE) {
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
    const shakeFrames = Math.round(SHAKE_SECONDS * FPS);
    let worstScale = { x: 1, y: 1 };
    for (let i = 0; i < shakeFrames; i += 1) {
      const decay = 1 - i / shakeFrames;
      await emit(
        playState(ply, { shake: decay * decay, shakePhase: i }),
        1 / FPS,
        { kind: "winning-shake", ply: ply - 1 },
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
      if (Math.abs(sc.x - 1) > Math.abs(worstScale.x - 1)) worstScale.x = sc.x;
      if (Math.abs(sc.y - 1) > Math.abs(worstScale.y - 1)) worstScale.y = sc.y;
    }
    await emit(playState(ply), FINAL_HOLD_SECONDS, {
      kind: "move",
      ply: ply - 1,
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
    const SCALE_TOLERANCE = 0.001;
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
      isLast ? SECONDS_PER_MOVE + FINAL_HOLD_SECONDS : SECONDS_PER_MOVE,
      { kind: "move", ply: ply - 1 },
    );
  }
  if (ply % 10 === 0) log(`  ${ply}/${history.length} plies composed`);
}

// --- the end card
const winnerId = outcome?.winnerId ?? null;
await emit(
  {
    segment: "end",
    kicker: winnerId ? "WINNER" : "GAME OVER",
    winner: winnerId ? side(winnerId) : side(seats.bottom),
    how: outcome ? (REASON_WORDS[outcome.reason] ?? outcome.reason) : "",
  },
  END_SECONDS,
  { kind: "end-card" },
);
await stage.close();
await browser.close();
log(`${timeline.length} frames written`);

/* --------------------------------------------------------------- encode -- */

const totalSeconds = timeline.reduce((a, f) => a + f.seconds, 0);
const frameSequence = join(WORK, "cfr");
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
  join(WORK, "timeline-manifest.json"),
  JSON.stringify(
    { fps: FPS, totalFrames: encodedFrame, ranges: encodedRanges },
    null,
    2,
  ),
);

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
 * THE THREE SOUNDS THE SITE HAS NO COUNTERPART FOR. Chosen by Nil 2026-08-19.
 *
 * THIS IS THE ONE PLACE TO CHANGE THEM. Swapping any of the three is editing a
 * path on the line below - the placement, the mixing and the encoding do not
 * care which file is named. Nil kept the riser "for now", so the VS entry in
 * particular is expected to be replaced.
 *
 * Any format ffmpeg can read works. The two sounds Nil bought are .m4a while
 * everything else here is .wav, and NOTHING in this file treats that
 * differently: ffmpeg decodes by content, and every clip is normalised to the
 * same sample format inside the mix. There is no extension check to keep in
 * step with the file list.
 *
 *   vsStamp   lands on the VS mark's punch
 *   shake     lands on the winning move, under the screen shake
 *   win       lands with the end card
 */
const PIXEL_PACK = join(REPO, "assets/audio/pixel_game_essentials");
const STING_DIR = join(REPO, "assets/stings");
const SOUNDS = {
  vsStamp: {
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
    file: join(PIXEL_PACK, "die-1.m4a"),
    gain: SHAKE_GAIN,
  },
  win: {
    file: join(PIXEL_PACK, "level-complete-1.m4a"),
    gain: WIN_GAIN,
  },
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

const buildAudio = () => {
  const events = [];

  /** When the last move lands - the beat the shake rides on. */
  const shakeAt = VS_SECONDS + SECONDS_PER_MOVE * history.length;

  // --- the VS stamp, aligned so its impact meets the visual punch.
  if (existsSync(SOUNDS.vsStamp.file)) {
    const lead = SOUNDS.vsStamp.hitOffsetSeconds?.() ?? 0;
    const startAt = VS_SECONDS * vsPunchFraction - lead;
    if (startAt < 0) {
      log(
        `WARNING: the VS segment is too short for a ${lead}s lead-in; the impact will be clipped.`,
      );
    }
    events.push({
      file: SOUNDS.vsStamp.file,
      at: Math.max(0, startAt),
      gain: SOUNDS.vsStamp.gain,
    });
  } else {
    log(
      `VS sound missing at ${SOUNDS.vsStamp.file}; falling back to the site's start sound`,
    );
    events.push({
      file: join(AUDIO_DIR, "game_start.mp3"),
      at: 0,
      gain: SITE_VOLUMES.gameStart,
    });
  }

  // --- one sound per turn, wall wins. The site's own rule; see above.
  let t = VS_SECONDS + SECONDS_PER_MOVE; // vs screen, then the initial position
  for (const ply of history) {
    const terms = String(ply.notation ?? "")
      .split(".")
      .filter(Boolean);
    const hasWall = terms.some((s) => s.startsWith(">") || s.startsWith("^"));
    events.push({
      file: join(AUDIO_DIR, hasWall ? "wall.wav" : "pawn.wav"),
      at: t,
      // The site's own balance - a wall is quieter than a pawn there - times
      // one gain, so raising the moves does not flatten that relationship.
      gain: (hasWall ? SITE_VOLUMES.wall : SITE_VOLUMES.pawn) * MOVE_GAIN,
    });
    t += SECONDS_PER_MOVE;
  }

  /*
    The shake had no sound at all until now - the move that won still played
    its ordinary move click and nothing else, which is why the shake read as
    silent. This is a separate layer ON TOP of that click: the click says a
    piece moved, this says it hit something.
  */
  if (CAPTURE_SHAKE && existsSync(SOUNDS.shake.file)) {
    events.push({
      file: SOUNDS.shake.file,
      at: shakeAt,
      gain: SOUNDS.shake.gain,
    });
  }

  // --- the winner, with the end card.
  events.push(
    existsSync(SOUNDS.win.file)
      ? {
          file: SOUNDS.win.file,
          at: totalSeconds - END_SECONDS,
          gain: SOUNDS.win.gain,
        }
      : {
          file: join(AUDIO_DIR, "game_end.mp3"),
          at: totalSeconds - END_SECONDS,
          gain: SITE_VOLUMES.gameEnd,
        },
  );

  const present = events.filter((e) => existsSync(e.file));
  if (present.length === 0) return null;

  const inputs = present.flatMap((e) => ["-i", e.file]);
  const chains = present.map(
    (e, i) =>
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
      `adelay=${Math.round(e.at * 1000)}:all=1,volume=${e.gain}[a${i}]`,
  );
  // The effects bus. Everything above lands here, and it is also what the
  // music is ducked against.
  chains.push(
    present.map((_, i) => `[a${i}]`).join("") +
      `amix=inputs=${present.length}:normalize=0:dropout_transition=0,` +
      `apad,atrim=0:${totalSeconds.toFixed(3)}[fx]`,
  );

  let last = "[fx]";
  if (MUSIC) {
    /*
      Music under the game, and only under the game.

      It starts with the board rather than over the VS screen, because the
      riser owns that moment, and it fades OUT across the end card rather than stopping, so the track
      resolves under the win instead of being cut off mid-phrase.

      NO DYNAMICS ARE APPLIED TO IT. There used to be a sidechain compressor
      keyed on the effects, added when the music sat at 0.3 and might have
      buried a click. At 0.8s per move with a 320ms release the music never
      recovered between moves, so it pumped on every single move for the whole
      video - Nil heard it and asked whether he was imagining it. He was not.
      MUSIC_VOLUME WAS 0.9 AND IS NOW 0.3, AND THAT IS A RESTORATION RATHER
      THAN A RETUNE. Measured 2026-08-20: the compressor had been holding the
      music down by 9.45 dB CONTINUOUSLY - not a dip on each hit - so the mix
      Nil approved was one where the music was ~9.5 dB below what the constant
      said. Deleting the compressor without compensating would have made the
      music louder than anything he ever agreed to, and what he asked for was
      the pumping gone, not the music up. 0.3 puts it back where he had it.
    */
    const musicStart = VS_SECONDS;
    const musicSeconds = totalSeconds - musicStart;
    /*
      The music fade now COMPLETES as the end card arrives, instead of running
      across it. Measured 2026-08-19: with the fade spread over the end card,
      the last second of it carried music at -17.5 dB peak where a no-music
      build is digital silence - and the bed is three times louder than when
      Nil first called the win screen too loud. The riser owns the VS moment;
      the win sting should own this one.
    */
    const endCardAt = totalSeconds - END_SECONDS - musicStart;
    const fadeOutAt = Math.max(0, endCardAt - MUSIC_FADE_OUT);
    inputs.push("-i", MUSIC);
    const mi = present.length;
    chains.push(
      `[${mi}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
        `atrim=0:${musicSeconds.toFixed(3)},` +
        // An explicit, reported correction if one was asked for; otherwise the
        // track is used exactly as the site uses it.
        `afade=t=in:st=0:d=${MUSIC_FADE_IN},` +
        `afade=t=out:st=${fadeOutAt.toFixed(3)}:d=${MUSIC_FADE_OUT},` +
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

  const audioPath = join(WORK, "track.m4a");
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

let audioPath = null;
if (AUDIO) {
  try {
    audioPath = buildAudio();
    log(
      MUSIC
        ? `soundtrack built, with music ducked under the effects (${MUSIC})`
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
 * phone will upload without complaint.
 */
const videoArgs = [
  "-framerate",
  String(FPS),
  "-i",
  join(frameSequence, "v-%06d.png"),
  ...(audioPath ? ["-i", audioPath] : []),
  "-vf",
  "format=yuv420p",
  "-c:v",
  "libx264",
  "-profile:v",
  "high",
  "-preset",
  "slow",
  "-crf",
  "20",
  "-movflags",
  "+faststart",
  "-frames:v",
  String(encodedFrame),
  ...(audioPath ? ["-c:a", "copy"] : []),
  OUT,
];
ff(videoArgs);

const encodedReport = verifyEncodedVideo({
  ffmpeg: FFMPEG,
  video: OUT,
  framePattern: join(frameSequence, "v-%06d.png"),
  fps: FPS,
  ranges: encodedRanges,
  crop: encodedBoardRect,
});
writeFileSync(
  join(WORK, "encoded-verification.json"),
  JSON.stringify(encodedReport, null, 2),
);

{
  for (const f of readdirSync(WORK)) {
    if (/^(f-|board-)\d+\.png$/.test(f)) unlinkSync(join(WORK, f));
  }
  rmSync(frameSequence, { recursive: true, force: true });
}

const mb = (statSync(OUT).size / 1e6).toFixed(1);
log(`shake geometry before vs after: ${shakeGeometryVerdict}`);
log(`wrote ${OUT}`);
log(
  `${LAYOUT.width}x${LAYOUT.height}, ${totalSeconds.toFixed(1)}s, ${mb} MB, ${SECONDS_PER_MOVE}s per move`,
);
