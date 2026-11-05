/**
 * The edit decision list (EDL) of a daily video: what the director decides
 * and the renderer plays (Nil, 2026-10-26: "an agent actually directing these
 * shorts, deciding where to put each sound effect", instead of fully
 * deterministic picks).
 *
 * The director (Wall Game Director, through the daily app) writes one EDL per
 * video; the app validates it with validateEdl before it shows it to anyone,
 * and render-game-video.mjs --edl validates it again and plays exactly it.
 * Both import this file, so the two cannot disagree on what is valid.
 *
 *   {
 *     "version": 1,
 *     "gameId": "eeFSMEmL",
 *     "caption": "the bot was 97% winning 💀",
 *     "ending": "replay",
 *     "music": [{ "fromPly": 0, "track": "deja-vus" }],
 *     "pace": [{ "fromPly": 13, "toPly": 17, "secondsPerMove": 1.1 }],
 *     "events": [
 *       { "ply": 14, "kind": "scared", "cell": "g4", "sound": "scared-2" },
 *       { "ply": 15, "kind": "zoom", "frame": ["^h4", "g5", "g4"], "sound": "fuahhh-1" },
 *       { "ply": 15, "kind": "laugh", "cell": "g4", "sound": "laugh-2" },
 *       { "ply": 15, "kind": "stamp", "text": "SAVED" },
 *       { "ply": 3, "kind": "sound", "sound": "shotgun-3" }
 *     ]
 *   }
 *
 * Plies are 0-based indexes into the move list, like the picks of
 * daily-candidates.ts. A cell is in standard notation (g4) and names where
 * things stand AFTER that ply. A wall is in move notation: ^h4 is the wall
 * above h4, >h4 the wall to the right of h4, so a save wall from the
 * close-call picker goes into `frame` as it is.
 *
 *   caption  optional, one line: at most 6 words and 32 characters (Nil,
 *            2026-10-26: a long caption was "way too long").
 *   payoff   optional: { ply, text }, a second caption beat (audit item 9).
 *            From the move of `ply` on, `text` replaces the caption: a setup
 *            line, then its payoff. Same limits as the caption; it needs a
 *            caption to replace. Absent
 *            (null after validation): one caption for the whole video.
 *   ending   required: the daily app rotates replay, gg and ko, so a render
 *            never falls back to one silently.
 *   music    optional: 0 to 3 cues { fromPly, track }, where `track` is a
 *            track's slug in music-tracks.mjs. The first cue's fromPly is
 *            startPly: the track the video opens with (cold open and VS
 *            included). Each later cue changes the track at the start of
 *            its ply's beat (before a lead zoom or freeze): the old track
 *            fades out and the new one starts from its beginning. fromPly
 *            increases, and two cues in a row name different tracks; at
 *            most 2 different tracks in all (one credit line each), so a
 *            track may come back, from its beginning. The
 *            renderer refuses a track whose license does not let a video
 *            play it (music-tracks.mjs `license`, MUSIC-LICENSES.md), and a
 *            cue past the last move. Absent (null after validation) means
 *            one random track of those that may play; [] means no music
 *            at all (Nil, 2026-10-28: "maybe just try without?"): the
 *            meme and game sounds play as they do, and the credit names
 *            only the sounds.
 *   startPly optional, and 0: a daily video shows the full story of the
 *            game (Nil, 2026-10-28), so any other value is refused; a
 *            quiet stretch can be a fastForward range instead. The field
 *            stays because the app and the renderer read it.
 *   coldOpenPly
 *            optional: the video first shows the position after this ply
 *            for about a second, caption up and that ply's walls glowing,
 *            and then cuts to the VS overlay and the game (audit item 2).
 *            Absent (null after validation): no cold open.
 *   introPaths
 *            optional, default true: before the first move, after the VS
 *            overlay, each side's hunter draws its shortest walk to its
 *            target with the dots of a `path` event and its step count,
 *            the first mover's first (Nil, 2026-10-28: the intro must
 *            explain "the gist of the game before the action starts ...
 *            the path from each cat to each mouse"). false: none. A
 *            variant where no side hunts shows none.
 *   vsSound, finishSound
 *            optional: the meme sound on the VS overlay's punch and on the
 *            ending's impact. Absent means DEFAULT_SLOT_SOUNDS.
 *   opening  optional: a cover clip (overlays.mjs, form "cover") that plays
 *            over the board from the VS overlay's start, under its banners:
 *            "the show starts" (the Director's line for Curtain Opening,
 *            meme-pack.md, 2026-10-31). It must hide nothing once the VS
 *            overlay ends, as any cover clip. Muted: the VS slot has its
 *            sound. Absent: none.
 *   cta      optional for the renderer, required by the daily app for a
 *            new list: the call to action (Nil, 2026-10-31, the revise of
 *            v-2026-10-31-6: "a clear CTA to all videos ... you can make
 *            variations per video"), one line of at most CTA_CHARS that
 *            names wallgame.io ("play free at wallgame.io"). It replaces
 *            "wallgame.io" in the badge under the board, for the whole
 *            video, and as the GG card's last line. Absent: "wallgame.io".
 *   evalStrip
 *            optional, OFF by default: the engine's view as a thin strip
 *            under the players' names below the board, in the look of the
 *            site's evaluation bar (info/evaluation_bar.md), each side's
 *            share in its seat's colour under its name, red on the left. The values are
 *            the game's .engine.json evaluationsP1 as they are: one a
 *            position, n + 1 for n moves, each -1 (player 2 wins) to 1
 *            (player 1 wins). The strip moves to each move's value as it
 *            lands, and on a ply with a blunder or brilliant mark the
 *            swing flashes (Wall Game Director, 2026-10-31: the "!!" and
 *            "??" show their swing). A preview for Nil comes before any
 *            posted video uses it.
 *   pace     optional: seconds per move over a range of plies (inclusive);
 *            the plies outside every range use DEFAULT_SECONDS_PER_MOVE.
 *            A range with "fastForward": true (audit item 5) runs a quiet
 *            stretch at 0.2-0.3 s per move with a small speed tag
 *            (fastForwardTag); it holds no events, the cold open is not in
 *            it, and it ends before the last move (the ending plays at
 *            normal speed).
 *   events   optional; the events of one ply play in list order, after the
 *            move lands. Variety: a moment kind (all but zoom, path and
 *            sound) and an overlay asset may each be used at most twice. `sound` is optional on every kind but "sound" and
 *            lands as its event starts.
 *     zoom    the camera punches in to fit every cell and wall in `frame`
 *             (at most `scale`), holds for `holdSeconds`, and lets go.
 *             A window that would cut a pawn grows (down to 1.0) or
 *             closes in (up to 10% above `scale`, never above the
 *             largest zoomScale), whichever is nearer to that scale
 *             (render-game-video.mjs frameZoom).
 *             With "lead": true it starts BEFORE the move: the camera
 *             pushes in on the position before it, the move lands inside
 *             the zoom with the zoom's sound, then the hold and the let-go
 *             (Nil, 2026-10-26: "the bye right as it moves would be the
 *             best narrative"). `frame` must hold the start and end cell
 *             of every pawn the move moves. At most one lead zoom or
 *             freeze per ply.
 *     scared  the mouse on `cell` trembles and sweats, a "!" over it.
 *     laugh   the mouse on `cell` laughs, a 😂 over it.
 *     stamp   `text` stamps onto the middle of the board, and fades.
 *     sound   only the sound, as the move lands.
 *     blunder the board flashes red and shakes, and "??" pops on `cell`.
 *             For the move that threw the game away (often the ply before
 *             a DANGER, on the mover's pawn).
 *     brilliant  a burst and "!!" on `cell`. For the move that wins the
 *             race: a SAVE, or the winner's largest JUMP.
 *     trap    the `walls` (1..6, as in a zoom frame) light up, then `text`
 *             (default TRAPPED) stamps on. For the `*` walls of a JUMP.
 *     race    the race counter flashes: swells and glows for 0.8 s. The
 *             counter itself (each side's steps to its target, over the
 *             board) shows all video long in the daily look, and its
 *             numbers come from the game (race-replay.ts), never from the
 *             EDL. For the ply where a number jumps: a SAVE or a JUMP.
 *     freeze  BEFORE the move lands: the position before it freezes in
 *             grey, the camera pushes in on the move's cell and holds for
 *             `holdSeconds` (default 0.9), then the move lands. Its sound
 *             plays as the freeze starts. For a SAVE or the winning move.
 *     react   `emoji` (skull, mind-blown, fire, moai, clown, eyes) pops on
 *             `cell` and floats up.
 *     path    the hunter on `cell` (after the move) shows its shortest walk
 *             to its target as a dotted line in its colour, with the steps
 *             at its end (the race counter's number), then fades (Nil,
 *             2026-10-28: newcomers must see what is happening). The
 *             renderer computes the walk from the position; the EDL only
 *             names the hunter; `hunter` ("red" or "blue", optional) says
 *             whose, where both cats stand on `cell`. With "compare": true (a SAVE or an
 *             ESCAPE) it first shows the walk BEFORE the move, then the
 *             walk after it, so the wall's effect shows (2, then 12).
 *             `holdSeconds` (default 0.8) holds the last walk.
 *     explain a meme moment made readable (Nil, 2026-10-29: the memes did
 *             not make sense to a viewer), BEFORE the ply's other events:
 *             the board holds on the position before the move while the
 *             hunter's walk to its target draws in dots with its steps;
 *             the move lands slowly, each wall it placed glowing and each
 *             pawn it moved drawn as a glowing line from its old cell;
 *             then the old walk stays as a ghost and the new walk draws
 *             (2, then 16). Its `sound` plays as the new walk is fully
 *             drawn: the reaction to the new number. The whole board
 *             stays in view. `hunter`
 *             ("red" or "blue") names the cat whose walk is the story;
 *             absent, the one whose steps change most (on a tie, red). The renderer
 *             computes the walls and both walks from the game record, as
 *             the race counter does; `expect` (optional: { walls, before,
 *             after }, the steps of that hunter) is what the script says,
 *             and a render whose game says otherwise stops
 *             (explain-mismatch). `expect.walls` may name only some of
 *             the move's walls: then only those glow, and the render
 *             stops unless they alone make the change (with the move's
 *             other walls taken out, the walk after is as long; Wall Game
 *             Director, 2026-11-01). `label` (optional, kebab-case: detour,
 *             near-catch, blunder, punish) goes to RESULT.timeline only.
 *             At most one on a ply, and not with a freeze, a lead zoom or
 *             a path on that ply: it is the ply's explanation.
 *             With `callback` ({ wall }, a wall an EARLIER move placed) it
 *             is a setup's payoff (Wall Game Director, 2026-10-31): the
 *             move lands first, then on the position after it the old
 *             wall fades out and the hunter's walk without it draws;
 *             then the wall comes back, glowing, and the real walk draws
 *             over the ghost of the other (2Xnv0iiY ply 37 and the bot's
 *             >b2 of ply 7: 1, then 5). `expect` is then { without, with },
 *             the hunter's steps; `hunter` absent, the side whose steps
 *             the wall changes most. No number names the wall.
 *             With `buildUp` ({ frame, seconds, scale }; not with
 *             `callback`) the camera pushes in slowly on `frame` (cells
 *             and walls, as a zoom's) after the old walk is drawn, over
 *             `seconds` (default 1.0) with no sound, so the viewer waits
 *             for the move; the move lands inside it and the camera goes
 *             back out while it lands (Nil, 2026-11-01: "with
 *             anticipation and slow zoom maybe").
 *     plant   the setup of a later callback: on the ply that places
 *             `wall`, as its move lands, that wall glows for 0.8 s, with
 *             no word, so the viewer has seen it once.
 *     flashback  the board goes back in time to the move that built
 *             `wall` (Nil, 2026-11-01, C39: "you need to show clearly
 *             that you are showing the past"). `toPly` is the ply that
 *             placed it, before this one. The move lands; REWIND: a VHS
 *             look, "<< REWIND", `sound` (a rewind whir), the board plays
 *             back to the position before toPly, turning sepia; THE PAST:
 *             "MOVE <n>" (n as in the site's move list, where a move is a
 *             pair of plies), toPly's walls land again in their colour on
 *             the sepia board, `wall` with the plant's glow;
 *             FORWARD: ">>", the board plays forward to now, its colour
 *             back, with `forwardSound` (a fast-forward whir: without it
 *             the past and the forward ran 2.2 s quiet, -15 v4); NOW:
 *             `wall` glows on this board, with `nowSound`.
 *             The counters and the evaluation strip follow the positions
 *             shown; the caption holds until NOW. It plays before the
 *             ply's other events, alone: not with an explain, a freeze, a
 *             path or a lead zoom on its ply.
 *     overlay a meme over the board while the game goes on under it
 *             (overlays.mjs): `asset` names it and `form` repeats its form
 *             ("clip": a cut-out or a toast in a free corner; "panel": a
 *             band across the board). It opens as the move lands (on a
 *             ply with a trap: after the trap's word; on a ply with a
 *             death card: after the ply's marks) and shows for
 *             `seconds` (default the asset's, or its words' reading time
 *             if longer; the capture loading bar lasts until the save and
 *             takes none). An overlay with words shows at least their
 *             reading time, READ_BASE_SECONDS + READ_WORD_SECONDS a word
 *             (overlays.mjs readingSeconds): a shorter `seconds` is
 *             refused, and the renderer stops if the ending, a
 *             fast-forward's end or the save closes it sooner. `text` is the asset's line,
 *             where it takes one; {red} and {blue} in it become the seats'
 *             names. `seat` ("red" or "blue") is required on an asset that
 *             shows a seat's portrait: who reacts is the story. `pawn`
 *             ("red mouse": a seat and a piece) is required on an asset
 *             that a pawn emotes (overlays.mjs `pawn`: a picture, a
 *             redraw): it goes in the free place nearest that pawn, with a
 *             tail that points at it, and its ply holds until it closes;
 *             its optional `place` (overlays.mjs PAWN_PLACES, as
 *             "top-left" or "left-middle") is the only place tried, still
 *             refused if it hides a pawn, a wall of the move or the hunt;
 *             such an overlay never goes in a fast-forward. The renderer puts it where it hides no pawn and
 *             nothing in play on any frame it covers, or stops and names
 *             what is under each place. One overlay at a time, and the
 *             ending cuts one still open. On a ply with an explain (not a
 *             callback) `at` may time it inside the explain (Nil,
 *             2026-11-01: a clip "at the time the move is played ...
 *             then one of the others after while it's showing the new
 *             distance path"): "land" opens it as the move lands, and the
 *             new walk waits until it closes; "walk" opens it as the new
 *             walk is fully drawn and its number shows, and the walk
 *             stays up until it closes. One of each a
 *             ply, never a bar. In a fastForward range the only
 *             event allowed is one overlay (not the bar) on the range's
 *             first ply, with no seconds: it lasts the range, which must
 *             be on screen for EDL_LIMITS.overlayFastSeconds at least. A "bar" (the ending's
 *             caption) is on the last move only and shows from the ending's
 *             impact to its end, so it takes no seconds; the ending holds
 *             longer when its line needs more reading time.
 *
 * Unknown fields are errors, not ignored: a typo in a field name must not
 * turn into a video without the effect the director asked for.
 */
import { MEME_SOUNDS } from "./meme-sounds.mjs";
import { MUSIC_TRACKS } from "./music-tracks.mjs";
import {
  OVERLAYS,
  OVERLAY_FORMS,
  OVERLAY_NAME_TOKENS,
  OVERLAY_TEXT_CHARS,
  PORTRAIT_DRAWS,
  parsePawn,
  takesPawn,
  PAWN_PLACES,
  takesSeat,
  READ_BASE_SECONDS,
  READ_WORD_SECONDS,
  TEXT_TIMING,
  overlayWords,
  readingSeconds,
  DEATH_CARDS,
} from "./overlays.mjs";

export const EDL_VERSION = 1;

/**
 * The daily look's seat colours (Nil, 2026-10-26: "red vs blue was the
 * goal"). AI vs human: the AI red and the human blue. Human vs human: the
 * first seat (playerOrder 1) red and the second blue. Bot vs bot never
 * reaches the daily path (the picker keeps it out), so it is an error here.
 * The renderer and the storyboard both read this, so the video and the sheet
 * the Director sees cannot disagree.
 *
 * isBot is { 1: boolean, 2: boolean } by playerId, which is the playerOrder.
 *
 * @param {{ 1: boolean, 2: boolean }} isBot
 * @returns {{ 1: "red" | "blue", 2: "red" | "blue" }}
 */
export const dailySeatColors = (isBot) => {
  if (isBot[1] && isBot[2]) {
    throw new Error(
      "both seats are bots; the daily look shows AI vs human or human vs human",
    );
  }
  return isBot[2] && !isBot[1]
    ? { 1: "blue", 2: "red" }
    : { 1: "red", 2: "blue" };
};
export const ENDINGS = ["replay", "gg", "ko"];

/** The most characters a call to action (`cta`) may have. */
export const CTA_CHARS = 30;
/** What a list without a `cta` shows where a call to action goes. */
export const DEFAULT_CTA = "wallgame.io";

/**
 * Why `cta` is not a call to action the video may show, or null: a string
 * of one line, at most CTA_CHARS, that names wallgame.io.
 * @param {unknown} cta
 */
export const ctaProblem = (cta) => {
  if (typeof cta !== "string" || cta.trim() === "") {
    return "cta must be a line of text";
  }
  if (/[\r\n]/.test(cta)) return "cta must be one line";
  if (cta !== cta.trim()) return "cta must not start or end with a space";
  if ([...cta].length > CTA_CHARS) {
    return `cta has ${[...cta].length} characters; at most ${CTA_CHARS}`;
  }
  if (!cta.toLowerCase().includes("wallgame.io")) {
    return 'cta must name wallgame.io (e.g. "play free at wallgame.io")';
  }
  return null;
};

/**
 * The names the daily video shows for its two seats, wherever it shows one
 * (the players strip, a {red} or {blue} in an overlay's text, the ending):
 * "Bot" or "Human" by the seat's kind, never a bot's, a guest's or an
 * account's name (Nil, 2026-10-29: "we should never show "Normal Bot" or
 * "Guest Ibex". Bot and Human is less text and conveys the same"). Two
 * bots are "Red Bot" and "Blue Bot". Two humans are only "Red" and "Blue"
 * (Nil, 2026-10-30, C16: "blue human and red human sounds weird ... just
 * Red vs Blue would work, human seems redundant"; the Director chose
 * "Red" vs "Blue").
 * A seat whose kind is not "bot" or "human" stops the render.
 * @param {{ red: { configType?: string, displayName?: string }, blue: { configType?: string, displayName?: string } }} seats
 * @returns {{ red: string, blue: string }}
 */
export const dailySeatNames = ({ red, blue }) => {
  const kind = (seat) => {
    if (seat.configType === "bot") return "Bot";
    if (seat.configType === "human") return "Human";
    // A seat with no kind is a fault in the game record, not a human.
    throw new Error(
      `dailySeatNames: a seat has no kind (configType ${JSON.stringify(seat.configType)}), so it cannot be named Bot or Human`,
    );
  };
  const [r, b] = [kind(red), kind(blue)];
  if (r !== b) return { red: r, blue: b };
  return r === "Human"
    ? { red: "Red", blue: "Blue" }
    : { red: `Red ${r}`, blue: `Blue ${b}` };
};

/**
 * The daily video's frame, and the part of it that the apps do not paint
 * over. Meta, Instagram Reels video ad spec, read 2026-10-26: "Consider
 * leaving at least 14% of the top, 35% of the bottom, and 6% on each side
 * of your asset free from text, logos, or [other key creative elements]"
 * (info/daily-video-quality.md, item 3). The renderer lays the daily look
 * out inside SAFE_AREA, and crew.mjs check holds the measured boxes of a
 * render to it, so the two read the same numbers.
 */
export const FRAME = { w: 1080, h: 1920 };
export const SAFE_AREA = {
  x: Math.round(FRAME.w * 0.06),
  y: Math.round(FRAME.h * 0.14),
  w: FRAME.w - 2 * Math.round(FRAME.w * 0.06),
  h: Math.round(FRAME.h * (1 - 0.35)) - Math.round(FRAME.h * 0.14),
};

/**
 * The band under SAFE_AREA where the players strip goes (Wall Game Director,
 * 2026-10-28: the lower third was empty on desktop). The official guides keep
 * the bottom third free for key elements (Reels 35%, Shorts 672 px, TikTok's
 * in-feed template 660 px), but on organic posts every app's overlay starts
 * lower: the deepest of the presets read on 2026-10-28 keeps the bottom
 * 484 px for the caption, user and sound, and the right 140 px for the
 * buttons (ezugc.ai, revid.ai, uplads.com). So the band runs from SAFE_AREA's
 * bottom to 484 px above the frame's, 140 px in from both sides (the strip
 * is centred). The strip holds the players and the site: nothing a viewer
 * needs to follow the game, so the key elements stay in SAFE_AREA.
 */
export const STRIP_AREA = {
  x: 140,
  y: SAFE_AREA.y + SAFE_AREA.h,
  w: FRAME.w - 2 * 140,
  h: FRAME.h - 484 - (SAFE_AREA.y + SAFE_AREA.h),
};

/** The area a measured layout box must lie in: the strip's, or SAFE_AREA. */
export const areaOf = (boxName) =>
  boxName === "strip" ? STRIP_AREA : SAFE_AREA;

/**
 * The sounds of the VS punch and the finish where the EDL names none. Wall
 * Game PM, 2026-10-26 (Content ID): the finish was shotgun-1, which is
 * Fortnite-named and a high claim risk (meme-sounds.md), and it was in every
 * video; shotgun-2 has no named owner. The renderer and the app's sounds
 * page both read this.
 */
export const DEFAULT_SLOT_SOUNDS = {
  vsSound: "shotgun-2",
  finishSound: "shotgun-2",
};
/**
 * Every meme sound a valid list plays, as [where, key]: its two slots
 * (DEFAULT_SLOT_SOUNDS fills them), then each event that names a sound.
 * @param {{ events: { ply: number, sound?: string | null }[] } & Record<string, unknown>} edl
 * @returns {[string, string][]}
 */
export const edlSoundUses = (edl) => [
  ...Object.keys(DEFAULT_SLOT_SOUNDS).map(
    (slot) => /** @type {[string, string]} */ ([slot, String(edl[slot])]),
  ),
  ...edl.events.flatMap((e) =>
    e.sound
      ? [/** @type {[string, string]} */ ([`ply ${e.ply}`, e.sound])]
      : [],
  ),
];
/**
 * What a render's lint (render-game-video.mjs --lint, R1) can report, by
 * kind: "stops" a render before its shoot pass, "warns" (a weakness of the
 * edit; a render logs it and goes on), or "note" (what the renderer changed
 * on its own, for the director to see). crew.mjs and the tests import this
 * list.
 */
export const LINT_KINDS = {
  "overlay-overlap": "stops",
  "overlay-place": "stops",
  "overlay-pawn": "stops",
  "reading-time": "stops",
  "text-fit": "stops",
  "sound-file": "stops",
  loudness: "stops",
  silence: "warns",
  "still-before-ending": "warns",
  "zoom-cuts-pawn": "warns",
  "stamp-covers": "warns",
  "mark-covers-wall": "warns",
  "mark-covers-pawn": "stops",
  "finish-cut": "warns",
  "sounds-together": "warns",
  "race-small": "warns",
  "explain-mismatch": "stops",
  "end-reason": "stops",
  "path-through-wall": "stops",
  "reactor-pawn": "stops",
  "reactor-capture": "stops",
  "explain-flat": "warns",
  "callback-joint": "stops",
  "callback-cover": "stops",
  "video-long": "warns",
  "voice-no-speaker": "warns",
  "zoom-scale": "note",
  "stamp-flat": "note",
  "walk-number-crowded": "note",
};
/**
 * The stopping kinds that are a fault of the game's capture, not of the
 * list: a render from that capture stops, but a live capture mends it.
 * direct stores such a list and marks it for a live render (routes.mjs
 * lintGate), so the list never waits for a capture that only its own
 * render can make (2026-10-29: v-lQeZ8T needed a list with no reactor,
 * rendered live, before its real list could be directed).
 */
export const RECAPTURE_KINDS = ["reactor-capture"];
export const EVENT_KINDS = [
  "zoom",
  "scared",
  "laugh",
  "stamp",
  "sound",
  "blunder",
  "brilliant",
  "trap",
  "race",
  "freeze",
  "react",
  "path",
  "overlay",
  "explain",
  "plant",
  "flashback",
];

/** When an overlay on an explain's ply opens (`at`): see the header. */
export const OVERLAY_ATS = ["land", "walk"];

/** The fields each kind takes, besides ply, kind and sound. */
const KIND_FIELDS = {
  zoom: ["frame", "scale", "holdSeconds", "lead"],
  scared: ["cell"],
  laugh: ["cell"],
  stamp: ["text"],
  sound: [],
  blunder: ["cell"],
  brilliant: ["cell"],
  trap: ["walls", "text"],
  race: [],
  freeze: ["holdSeconds"],
  react: ["cell", "emoji"],
  path: ["cell", "compare", "holdSeconds", "hunter"],
  overlay: [
    "form",
    "asset",
    "text",
    "seconds",
    "seat",
    "pawn",
    "place",
    "audio",
    "at",
  ],
  explain: ["hunter", "label", "expect", "callback", "buildUp"],
  plant: ["wall"],
  flashback: ["toPly", "wall", "forwardSound", "nowSound"],
};
/**
 * The meme sounds an event plays, in order: its `sound`, and a flashback's
 * `forwardSound` and `nowSound`. Every reader of a list's sounds goes
 * through it (the claim risk, the repeats), so none misses one.
 * @param {{ sound?: string | null, forwardSound?: string, nowSound?: string }} ev
 * @returns {string[]}
 */
export const eventSoundKeys = (ev) =>
  [ev.sound, ev.forwardSound, ev.nowSound].filter((k) => typeof k === "string");

/** The kinds that name one cell, which must be on the board. */
const CELL_KINDS = ["scared", "laugh", "blunder", "brilliant", "react", "path"];
/** How long a path event holds its (last) path, by default. */
export const DEFAULT_PATH_HOLD_SECONDS = 0.8;

/**
 * The reactions a `react` event can pop, by name. They are drawn with the
 * Noto Color Emoji font, which the render kit requires (sync-render-kit.sh).
 */
export const REACTIONS = {
  skull: "💀",
  "mind-blown": "🤯",
  fire: "🔥",
  moai: "🗿",
  clown: "🤡",
  eyes: "👀",
};

/** Seconds per move where the EDL sets no pace. Proposed 2026-10-26. */
export const DEFAULT_SECONDS_PER_MOVE = 0.8;
/**
 * The speed tag of a fastForward range: how many times faster than the
 * default pace it runs, "x4" at 0.2 s per move.
 */
export const fastForwardTag = (secondsPerMove) =>
  `x${Math.round(DEFAULT_SECONDS_PER_MOVE / secondsPerMove)}`;
/** The zoom's most scale and its hold, where the EDL sets none. */
export const DEFAULT_ZOOM_SCALE = 1.5;
/** How long an explain's build-up zoom pushes in, by default. */
export const DEFAULT_BUILD_UP_SECONDS = 1.0;
export const DEFAULT_ZOOM_HOLD_SECONDS = 0.73;
/**
 * The longest video that a story can carry (Instagram, 2026-10-29: a Story
 * is at most 60 s); --lint warns over it (video-long).
 */
export const MAX_VIDEO_SECONDS = 60;
/** A freeze's hold. */
export const DEFAULT_FREEZE_HOLD_SECONDS = 0.9;
export const DEFAULT_TRAP_TEXT = "TRAPPED";

export const EDL_LIMITS = {
  captionWords: 6,
  captionChars: 32,
  stampChars: 12,
  // Up to 4 s a move, for a long sound that must finish on its ply (Wall
  // Game Director, 2026-11-01, f00bf5b6 item 40: -12 ply 26's sting-1 is
  // 3.7 s); scripts still aim at 3 s or less.
  secondsPerMove: [0.2, 4],
  fastForwardSecondsPerMove: [0.2, 0.3],
  zoomScale: [1.1, 3],
  zoomHoldSeconds: [0.2, 3],
  buildUpSeconds: [0.5, 2],
  frameTerms: 6,
  freezeHoldSeconds: [0.4, 2],
  pathHoldSeconds: [0.3, 2],
  overlaySeconds: [0.6, 4],
  /** A fast-forward's overlay must be on screen this long to be read. */
  overlayFastSeconds: 1,
  events: 40,
  musicCues: 3,
  /** Each different track gets a credit line in the head row; two fit. */
  musicTracks: 2,
  /** The most uses of one moment kind, or of one overlay asset (VARIED). */
  sameMoment: 2,
};

/**
 * The moment kinds a video may use at most EDL_LIMITS.sameMoment times
 * (variety). Not zoom, path or sound: each can fit a save, an escape and
 * the capture (Wall Game Director, 2026-10-29).
 */
const VARIED = [
  "scared",
  "laugh",
  "blunder",
  "brilliant",
  "trap",
  "race",
  "react",
  "freeze",
  "stamp",
];

/** The reading rule in words, for the messages. */
const READING = `${READ_BASE_SECONDS} s + ${READ_WORD_SECONDS} s a word`;

const CELL = /^[a-z][1-9]\d?$/;
const WALL = /^[>^][a-z][1-9]\d?$/;
const GAME_ID = /^[A-Za-z0-9_-]{4,40}$/;
const STAMP = /^[A-Z0-9 !?]+$/;

/**
 * What a seat name counts for in an overlay's text: "Guest Ferret" and
 * "Normal Bot" fit; a longer name makes the stage shrink the line.
 */
const NAME_CHARS = 12;

/** Characters as a reader counts them: 💀 is one, not two. */
const graphemes = (s) =>
  [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;

const isNumberIn = (v, [lo, hi]) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isPly = (v) => Number.isInteger(v) && v >= 0;

/**
 * Check an EDL and fill its defaults.
 *
 * Returns { ok: true, edl } with every optional field present, or
 * { ok: false, errors } with one line per problem.
 */
export const validateEdl = (raw) => {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["the EDL is not a JSON object"] };
  }
  const unknown = (obj, allowed, where) => {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) fail(`${where}: unknown field "${key}"`);
    }
  };
  unknown(
    raw,
    [
      "version",
      "gameId",
      "caption",
      "payoff",
      "ending",
      "music",
      "startPly",
      "coldOpenPly",
      "introPaths",
      "vsSound",
      "finishSound",
      "opening",
      "cta",
      "evalStrip",
      "pace",
      "events",
    ],
    "EDL",
  );

  if (raw.version !== EDL_VERSION) {
    fail(`version must be ${EDL_VERSION}, got ${JSON.stringify(raw.version)}`);
  }
  if (typeof raw.gameId !== "string" || !GAME_ID.test(raw.gameId)) {
    fail(`gameId must be a game id, got ${JSON.stringify(raw.gameId)}`);
  }

  /** The caption's limits, for the caption and for its payoff beat. */
  const checkCaptionText = (text, where) => {
    if (typeof text !== "string") return fail(`${where} must be a string`);
    const words = text.split(/\s+/).filter(Boolean).length;
    if (/[\r\n]/.test(text)) fail(`${where} must be one line`);
    if (words > EDL_LIMITS.captionWords) {
      fail(
        `${where} has ${words} words; at most ${EDL_LIMITS.captionWords} are allowed`,
      );
    }
    if (graphemes(text) > EDL_LIMITS.captionChars) {
      fail(
        `${where} has ${graphemes(text)} characters; at most ${EDL_LIMITS.captionChars} are allowed`,
      );
    }
  };
  const caption = raw.caption ?? "";
  checkCaptionText(caption, "caption");

  if (!ENDINGS.includes(raw.ending)) {
    fail(
      `ending must be one of ${ENDINGS.join(", ")}, got ${JSON.stringify(raw.ending)}`,
    );
  }
  /*
    The ko ending throws the caught pawn up and across the whole frame
    while its banner comes in, so no place is free for the ending's bar on
    any game: the renderer found none on a4wv (Wall Game Director,
    2026-10-30). Refused here, before any render.
  */
  if (
    raw.ending === "ko" &&
    Array.isArray(raw.events) &&
    raw.events.some((e) => e?.kind === "overlay" && e?.form === "bar")
  ) {
    fail(
      `the ko ending takes no ending bar: its thrown pawn and banner cover every place the bar can take; use ending "gg" or "replay" with a bar, or drop the bar`,
    );
  }

  const startPly = raw.startPly ?? 0;
  if (!isPly(startPly)) {
    fail("startPly must be a 0-based ply");
  } else if (startPly !== 0) {
    // Nil, 2026-10-28: "i noticed you start videos in the middle of a
    // game. i would avoid this. show the full story of the game every
    // time."
    fail(
      `startPly is ${startPly}; a daily video shows the full story of the game, so it starts at 0 (a quiet stretch can be a fastForward range)`,
    );
  }

  const music = raw.music ?? null;
  const slugs = MUSIC_TRACKS.map((t) => t.slug);
  if (typeof music === "string") {
    // The form before cues (2026-10-28); old EDL files still carry it.
    fail(
      `music is a cue list now: [{ "fromPly": ${startPly}, "track": ${JSON.stringify(music)} }]`,
    );
  } else if (music !== null) {
    if (!Array.isArray(music) || music.length > EDL_LIMITS.musicCues) {
      fail(
        `music must be a list of 0 to ${EDL_LIMITS.musicCues} cues { fromPly, track } ([] for no music), or absent for a random track`,
      );
    } else {
      music.forEach((cue, i) => {
        const where = `music[${i}]`;
        if (!cue || typeof cue !== "object" || Array.isArray(cue)) {
          return fail(`${where}: not an object`);
        }
        unknown(cue, ["fromPly", "track"], where);
        if (!slugs.includes(cue.track)) {
          fail(
            `${where}: track must be one of ${slugs.join(", ")}; got ${JSON.stringify(cue.track)}`,
          );
        }
        if (!isPly(cue.fromPly)) {
          return fail(`${where}: fromPly must be a 0-based ply`);
        }
        if (i === 0 && isPly(startPly) && cue.fromPly !== startPly) {
          fail(
            `music[0].fromPly must be startPly (${startPly}): the first cue is the track the video opens with`,
          );
        }
        const prev = music[i - 1];
        if (i > 0 && isPly(prev?.fromPly) && cue.fromPly <= prev.fromPly) {
          fail(`${where}: fromPly must be after music[${i - 1}].fromPly`);
        }
        if (i > 0 && cue.track === prev?.track) {
          fail(
            `${where}: the same track as music[${i - 1}]; a cue changes the track`,
          );
        }
      });
      const tracks = new Set(music.map((c) => c?.track));
      if (tracks.size > EDL_LIMITS.musicTracks) {
        fail(
          `music plays ${tracks.size} different tracks; at most ${EDL_LIMITS.musicTracks} fit the credit`,
        );
      }
    }
  }
  const introPaths = raw.introPaths ?? true;
  if (typeof introPaths !== "boolean") {
    fail("introPaths must be true or false");
  }
  const evalStrip = raw.evalStrip ?? null;
  if (
    evalStrip !== null &&
    !(
      Array.isArray(evalStrip) &&
      evalStrip.length >= 2 &&
      evalStrip.every((v) => isNumberIn(v, [-1, 1]))
    )
  ) {
    fail(
      "evalStrip must list the game's evaluationsP1, one a position, each -1..1",
    );
  }
  const coldOpenPly = raw.coldOpenPly ?? null;
  if (coldOpenPly !== null && !isPly(coldOpenPly)) {
    fail("coldOpenPly must be a 0-based ply, or absent for no cold open");
  }

  const payoff = raw.payoff ?? null;
  if (payoff !== null) {
    if (typeof payoff !== "object" || Array.isArray(payoff)) {
      fail("payoff must be { ply, text }, or absent for one caption");
    } else {
      unknown(payoff, ["ply", "text"], "payoff");
      if (!isPly(payoff.ply)) fail("payoff.ply must be a 0-based ply");
      checkCaptionText(payoff.text, "payoff.text");
      if (typeof payoff.text === "string" && payoff.text.trim() === "") {
        fail("payoff.text must not be empty");
      }
      if (caption === "") fail("payoff needs a caption to replace");
    }
  }

  const slots = {};
  for (const [field, fallback] of Object.entries(DEFAULT_SLOT_SOUNDS)) {
    slots[field] = raw[field] ?? fallback;
    if (!Object.hasOwn(MEME_SOUNDS, slots[field])) {
      fail(
        `${field} ${JSON.stringify(raw[field])} is not a known sound, or absent for ${fallback}`,
      );
    }
  }

  const opening = raw.opening ?? null;
  if (opening !== null) {
    const asset = Object.hasOwn(OVERLAYS, opening) ? OVERLAYS[opening] : null;
    if (!asset || asset.form !== "cover") {
      fail(
        `opening must be a cover clip (${Object.keys(OVERLAYS)
          .filter((k) => OVERLAYS[k].form === "cover")
          .join(", ")}), or absent for none; got ${JSON.stringify(opening)}`,
      );
    }
  }

  const cta = raw.cta ?? null;
  if (cta !== null) {
    const problem = ctaProblem(cta);
    if (problem) fail(problem);
  }

  const pace = raw.pace ?? [];
  if (!Array.isArray(pace)) {
    fail("pace must be a list");
  } else {
    pace.forEach((seg, i) => {
      const where = `pace[${i}]`;
      if (!seg || typeof seg !== "object")
        return fail(`${where}: not an object`);
      unknown(
        seg,
        ["fromPly", "toPly", "secondsPerMove", "fastForward"],
        where,
      );
      if (!isPly(seg.fromPly) || !isPly(seg.toPly) || seg.toPly < seg.fromPly) {
        fail(`${where}: fromPly and toPly must be plies with fromPly <= toPly`);
      }
      if (!isNumberIn(seg.secondsPerMove, EDL_LIMITS.secondsPerMove)) {
        fail(
          `${where}: secondsPerMove must be ${EDL_LIMITS.secondsPerMove.join("..")}`,
        );
      }
      const ff = seg.fastForward ?? false;
      if (typeof ff !== "boolean") {
        fail(`${where}: fastForward must be true or false`);
      } else if (
        ff &&
        !isNumberIn(seg.secondsPerMove, EDL_LIMITS.fastForwardSecondsPerMove)
      ) {
        fail(
          `${where}: a fastForward range runs at ${EDL_LIMITS.fastForwardSecondsPerMove.join("..")} secondsPerMove`,
        );
      }
    });
    const sorted = [...pace]
      .filter((s) => isPly(s?.fromPly) && isPly(s?.toPly))
      .sort((a, b) => a.fromPly - b.fromPly);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].fromPly <= sorted[i - 1].toPly) {
        fail(
          `pace ranges ${sorted[i - 1].fromPly}-${sorted[i - 1].toPly} and ${sorted[i].fromPly}-${sorted[i].toPly} overlap`,
        );
      }
    }
  }

  /** An overlay event's asset, form, text and seconds (overlays.mjs). */
  const checkOverlay = (ev, out, where) => {
    if (!Object.hasOwn(OVERLAYS, ev.asset)) {
      return fail(
        `${where}: asset must be one of ${Object.keys(OVERLAYS).join(", ")}, got ${JSON.stringify(ev.asset)}`,
      );
    }
    const asset = OVERLAYS[ev.asset];
    if (!OVERLAY_FORMS.includes(ev.form) || ev.form !== asset.form) {
      fail(
        `${where}: ${ev.asset} is a ${asset.form}; form must be "${asset.form}"`,
      );
    }
    if (asset.text === "none" && ev.text !== undefined) {
      fail(`${where}: ${ev.asset} shows no text`);
    } else if (asset.text === "required" && ev.text === undefined) {
      fail(`${where}: ${ev.asset} needs "text"`);
    } else if (ev.text !== undefined) {
      checkOverlayText(ev.text, where, asset.chars ?? OVERLAY_TEXT_CHARS);
    }
    if (!takesSeat(asset)) {
      if (ev.seat !== undefined) fail(`${where}: ${ev.asset} shows no seat`);
    } else if (ev.seat !== "red" && ev.seat !== "blue") {
      fail(
        PORTRAIT_DRAWS.includes(asset.draw)
          ? `${where}: ${ev.asset} shows a seat's portrait; seat must be "red" or "blue" (who reacts)`
          : `${where}: ${ev.asset} takes a seat's colour; seat must be "red" or "blue" (who plays it)`,
      );
    }
    if (!takesPawn(asset)) {
      if (ev.pawn !== undefined)
        fail(`${where}: ${ev.asset} is tied to no pawn`);
      if (ev.place !== undefined)
        fail(
          `${where}: ${ev.asset} is tied to no pawn; only a picture a pawn emotes takes a place`,
        );
    } else {
      const pawn = parsePawn(ev.pawn);
      if (!pawn) {
        fail(
          `${where}: ${ev.asset} shows who emotes it; pawn must be a seat and a piece, as "red mouse" or "blue cat"`,
        );
      } else if (asset.pieces && !asset.pieces.includes(pawn.piece)) {
        fail(
          `${where}: ${ev.asset} is drawn for a ${asset.pieces.join(" or ")}, not a ${pawn.piece}`,
        );
      }
      if (ev.place !== undefined && asset.around) {
        fail(
          `${where}: ${ev.asset} goes round the ${ev.pawn}; it has one place and takes no place`,
        );
      } else if (ev.place !== undefined && !PAWN_PLACES.includes(ev.place)) {
        fail(
          `${where}: place must be one of ${PAWN_PLACES.join(", ")}, got ${JSON.stringify(ev.place)}`,
        );
      }
      // Nil, 2026-10-30, C23: "the scream is fine but should be paired
      // with some sound effect". A clip that plays its own sound (a laugh,
      // a sob) has one.
      // A death card's sound is the finish slot's (DEATH_CARDS).
      if (
        ev.sound == null &&
        !(asset.sequence?.audio && ev.audio === "own") &&
        !DEATH_CARDS.includes(asset.card)
      ) {
        fail(
          `${where}: ${ev.asset} is a picture a pawn emotes; it needs a "sound" as it opens`,
        );
      }
    }
    // A clip with its own sound plays it or not, said out loud: its sound
    // carries its owner's claim (meme-pack.md: "Muting a clip's sound and
    // using one of our own sounds lowers the risk").
    if (asset.sequence?.audio) {
      if (ev.audio !== "own" && ev.audio !== "muted") {
        fail(
          `${where}: ${ev.asset} has its own sound; audio must be "own" (it plays) or "muted"`,
        );
      } else if (ev.audio === "own" && ev.sound != null) {
        fail(
          `${where}: ${ev.asset} plays its own sound; give no "sound", or make it "muted"`,
        );
      }
    } else if (ev.audio !== undefined) {
      fail(`${where}: ${ev.asset} has no sound of its own; give no "audio"`);
    }
    // null is "not set": validateEdl writes it for an overlay that the
    // asset or a fast-forward times, and the renderer validates that copy
    // again (2026-10-28, the first render on the release).
    const seconds = ev.seconds ?? undefined;
    if (asset.seconds === null && seconds !== undefined) {
      fail(
        `${where}: ${ev.asset} lasts as long as its moment; it takes no seconds`,
      );
    }
    // Its words must be readable before it goes (readingSeconds), so its
    // default is at least their reading time, and a shorter one is refused.
    const words = overlayWords(asset, ev.text ?? asset.line);
    const read = readingSeconds(asset, ev.text ?? asset.line);
    const most = EDL_LIMITS.overlaySeconds[1];
    if (read > most) {
      fail(
        `${where}: its ${words} words take ${read} s to read (${READING}); at most ${Math.floor((most - READ_BASE_SECONDS) / READ_WORD_SECONDS + 1e-9)} fit in ${most} s`,
      );
    }
    // An asset that takes no seconds is refused one above; the default is
    // capped at the most, so a text refused for its length gets one error.
    if (asset.seconds !== null && seconds !== undefined && seconds < read) {
      fail(
        `${where}: ${seconds} s is too short to read its ${words} words: it needs ${read} s (${READING})`,
      );
    }
    out.seconds =
      seconds ??
      (asset.seconds === null
        ? null
        : Math.max(asset.seconds, Math.min(read, most)));
    if (
      out.seconds !== null &&
      !isNumberIn(out.seconds, EDL_LIMITS.overlaySeconds)
    ) {
      fail(`${where}: seconds must be ${EDL_LIMITS.overlaySeconds.join("..")}`);
    }
    if (ev.at !== undefined && !OVERLAY_ATS.includes(ev.at)) {
      fail(
        `${where}: at must be one of ${OVERLAY_ATS.join(", ")} (inside its ply's explain), got ${JSON.stringify(ev.at)}`,
      );
    } else if (ev.at !== undefined && asset.form === "bar") {
      fail(`${where}: a bar is the ending's; it takes no "at"`);
    }
    // A clip's last frame held still reads as a frozen video: cut it
    // shorter, never longer.
    if (asset.draw === "sequence" && out.seconds > asset.seconds) {
      fail(
        `${where}: ${ev.asset} is a ${asset.seconds} s clip; seconds may be at most that`,
      );
    }
  };
  /**
   * An overlay's line: one line of at most `chars` characters, each seat
   * name counted as NAME_CHARS, and no {token} but a name.
   */
  const checkOverlayText = (text, where, chars) => {
    if (typeof text !== "string" || text.trim() === "") {
      return fail(`${where}: text must be a line of text`);
    }
    if (/[\r\n]/.test(text)) fail(`${where}: text must be one line`);
    const tokens = text.match(/\{[^}]*\}/g) ?? [];
    for (const t of new Set(tokens)) {
      if (!OVERLAY_NAME_TOKENS.includes(t)) {
        fail(
          `${where}: ${t} is not a name; use ${OVERLAY_NAME_TOKENS.join(" or ")}`,
        );
      } else if (tokens.filter((x) => x === t).length > 1) {
        fail(`${where}: ${t} may show once`);
      }
    }
    const length =
      graphemes(text.replace(/\{[^}]*\}/g, "")) + tokens.length * NAME_CHARS;
    if (length > chars) {
      fail(
        `${where}: text is ${length} characters long (a name counts as ${NAME_CHARS}); at most ${chars} are allowed`,
      );
    }
  };

  const events = raw.events ?? [];
  const filled = [];
  if (!Array.isArray(events)) {
    fail("events must be a list");
  } else if (events.length > EDL_LIMITS.events) {
    fail(`at most ${EDL_LIMITS.events} events are allowed`);
  } else {
    events.forEach((ev, i) => {
      const where = `events[${i}]`;
      if (!ev || typeof ev !== "object") return fail(`${where}: not an object`);
      if (!EVENT_KINDS.includes(ev.kind)) {
        return fail(
          `${where}: kind must be one of ${EVENT_KINDS.join(", ")}, got ${JSON.stringify(ev.kind)}`,
        );
      }
      unknown(ev, ["ply", "kind", "sound", ...KIND_FIELDS[ev.kind]], where);
      if (!isPly(ev.ply)) fail(`${where}: ply must be a 0-based ply`);
      if (ev.kind === "sound" && ev.sound === undefined) {
        fail(`${where}: a sound event needs "sound"`);
      }
      if (ev.sound !== undefined && !(ev.sound in MEME_SOUNDS)) {
        fail(
          `${where}: sound ${JSON.stringify(ev.sound)} is not known. Known: ${Object.keys(MEME_SOUNDS).join(", ")}`,
        );
      }
      const out = { ...ev };
      if (ev.kind === "zoom") {
        const terms = ev.frame;
        if (
          !Array.isArray(terms) ||
          terms.length === 0 ||
          terms.length > EDL_LIMITS.frameTerms ||
          terms.some((t) => !CELL.test(t) && !WALL.test(t))
        ) {
          fail(
            `${where}: frame must list 1..${EDL_LIMITS.frameTerms} cells (g4) or walls (^h4, >h4)`,
          );
        }
        out.scale = ev.scale ?? DEFAULT_ZOOM_SCALE;
        out.holdSeconds = ev.holdSeconds ?? DEFAULT_ZOOM_HOLD_SECONDS;
        out.lead = ev.lead ?? false;
        if (typeof out.lead !== "boolean") {
          fail(`${where}: lead must be true or false`);
        }
        if (!isNumberIn(out.scale, EDL_LIMITS.zoomScale)) {
          fail(`${where}: scale must be ${EDL_LIMITS.zoomScale.join("..")}`);
        }
        if (!isNumberIn(out.holdSeconds, EDL_LIMITS.zoomHoldSeconds)) {
          fail(
            `${where}: holdSeconds must be ${EDL_LIMITS.zoomHoldSeconds.join("..")}`,
          );
        }
      }
      if (
        CELL_KINDS.includes(ev.kind) &&
        !(typeof ev.cell === "string" && CELL.test(ev.cell))
      ) {
        fail(`${where}: cell must be a cell in standard notation (g4)`);
      }
      if (ev.kind === "trap") out.text = ev.text ?? DEFAULT_TRAP_TEXT;
      if (
        (ev.kind === "stamp" || ev.kind === "trap") &&
        !(
          typeof out.text === "string" &&
          STAMP.test(out.text) &&
          graphemes(out.text) <= EDL_LIMITS.stampChars
        )
      ) {
        fail(
          `${where}: text must be 1..${EDL_LIMITS.stampChars} of A-Z, 0-9, space, ! and ?`,
        );
      }
      if (
        ev.kind === "trap" &&
        !(
          Array.isArray(ev.walls) &&
          ev.walls.length > 0 &&
          ev.walls.length <= EDL_LIMITS.frameTerms &&
          ev.walls.every((t) => typeof t === "string" && WALL.test(t))
        )
      ) {
        fail(
          `${where}: walls must list 1..${EDL_LIMITS.frameTerms} walls (^h4, >h4)`,
        );
      }
      if (ev.kind === "freeze") {
        out.holdSeconds = ev.holdSeconds ?? DEFAULT_FREEZE_HOLD_SECONDS;
        if (!isNumberIn(out.holdSeconds, EDL_LIMITS.freezeHoldSeconds)) {
          fail(
            `${where}: holdSeconds must be ${EDL_LIMITS.freezeHoldSeconds.join("..")}`,
          );
        }
      }
      if (ev.kind === "explain") {
        out.hunter = ev.hunter ?? null;
        out.label = ev.label ?? null;
        out.expect = ev.expect ?? null;
        if (out.hunter !== null && !["red", "blue"].includes(out.hunter)) {
          fail(`${where}: hunter must be "red" or "blue"`);
        }
        if (
          out.label !== null &&
          !(
            typeof out.label === "string" &&
            /^[a-z]+(-[a-z]+)*$/.test(out.label)
          )
        ) {
          fail(`${where}: label must be a kebab-case word (near-catch)`);
        }
        // Only when set, so a list without one stores the same bytes.
        const callback = ev.callback ?? null;
        if (callback !== null) {
          out.callback = callback;
          if (
            typeof callback !== "object" ||
            Array.isArray(callback) ||
            typeof callback.wall !== "string" ||
            !WALL.test(callback.wall)
          ) {
            fail(`${where}: callback must be { wall } (^h4, >h4)`);
          } else {
            unknown(callback, ["wall"], `${where}.callback`);
          }
        }
        const buildUp = ev.buildUp ?? null;
        if (buildUp !== null) {
          const b = buildUp;
          if (typeof b !== "object" || Array.isArray(b)) {
            fail(`${where}: buildUp must be { frame, seconds, scale }`);
          } else {
            unknown(b, ["frame", "seconds", "scale"], `${where}.buildUp`);
            if (callback !== null) {
              fail(
                `${where}: a callback has no buildUp (its move lands first)`,
              );
            }
            if (
              !Array.isArray(b.frame) ||
              b.frame.length === 0 ||
              b.frame.length > EDL_LIMITS.frameTerms ||
              b.frame.some((t) => !CELL.test(t) && !WALL.test(t))
            ) {
              fail(
                `${where}: buildUp.frame must list 1..${EDL_LIMITS.frameTerms} cells (g4) or walls (^h4, >h4)`,
              );
            }
            out.buildUp = {
              frame: b.frame,
              seconds: b.seconds ?? DEFAULT_BUILD_UP_SECONDS,
              scale: b.scale ?? DEFAULT_ZOOM_SCALE,
            };
            if (!isNumberIn(out.buildUp.seconds, EDL_LIMITS.buildUpSeconds)) {
              fail(
                `${where}: buildUp.seconds must be ${EDL_LIMITS.buildUpSeconds.join("..")}`,
              );
            }
            if (!isNumberIn(out.buildUp.scale, EDL_LIMITS.zoomScale)) {
              fail(
                `${where}: buildUp.scale must be ${EDL_LIMITS.zoomScale.join("..")}`,
              );
            }
          }
        }
        const steps =
          callback !== null ? ["without", "with"] : ["before", "after"];
        const shape =
          callback !== null ? "{ without, with }" : "{ walls, before, after }";
        if (out.expect !== null) {
          const x = out.expect;
          if (typeof x !== "object" || Array.isArray(x)) {
            fail(`${where}: expect must be ${shape}`);
          } else {
            unknown(
              x,
              callback !== null ? steps : ["walls", ...steps],
              `${where}.expect`,
            );
            if (
              x.walls !== undefined &&
              !(
                Array.isArray(x.walls) &&
                x.walls.every((t) => typeof t === "string" && WALL.test(t))
              )
            ) {
              fail(`${where}: expect.walls must list walls (^h4, >h4)`);
            }
            for (const k of steps) {
              if (
                x[k] !== undefined &&
                !(Number.isInteger(x[k]) && x[k] >= 0)
              ) {
                fail(`${where}: expect.${k} must be a whole number of steps`);
              }
            }
          }
        }
      }
      if (
        (ev.kind === "plant" || ev.kind === "flashback") &&
        !(typeof ev.wall === "string" && WALL.test(ev.wall))
      ) {
        fail(`${where}: wall must be a wall (^h4, >h4)`);
      }
      if (ev.kind === "flashback") {
        if (!isPly(ev.toPly) || !(ev.toPly < ev.ply)) {
          fail(`${where}: toPly must be a ply before ${ev.ply}`);
        }
        for (const key of ["forwardSound", "nowSound"]) {
          if (ev[key] !== undefined && !(ev[key] in MEME_SOUNDS)) {
            fail(`${where}: ${key} ${JSON.stringify(ev[key])} is not known`);
          }
        }
      }
      if (ev.kind === "path") {
        // Only when set, so a list without one stores the same bytes.
        if (ev.hunter != null) {
          out.hunter = ev.hunter;
          if (!["red", "blue"].includes(ev.hunter)) {
            fail(`${where}: hunter must be "red" or "blue"`);
          }
        }
        out.compare = ev.compare ?? false;
        out.holdSeconds = ev.holdSeconds ?? DEFAULT_PATH_HOLD_SECONDS;
        if (typeof out.compare !== "boolean") {
          fail(`${where}: compare must be true or false`);
        }
        if (!isNumberIn(out.holdSeconds, EDL_LIMITS.pathHoldSeconds)) {
          fail(
            `${where}: holdSeconds must be ${EDL_LIMITS.pathHoldSeconds.join("..")}`,
          );
        }
      }
      if (ev.kind === "overlay") checkOverlay(ev, out, where);
      if (ev.kind === "react" && !Object.hasOwn(REACTIONS, ev.emoji)) {
        fail(
          `${where}: emoji must be one of ${Object.keys(REACTIONS).join(", ")}, got ${JSON.stringify(ev.emoji)}`,
        );
      }
      filled.push(out);
    });
  }

  // A fast-forward stretch is quiet: no moment, and no cold open, in it,
  // but one overlay on its first ply, which lasts the range.
  const fastRanges = Array.isArray(pace)
    ? pace.filter((s) => s?.fastForward === true)
    : [];
  const fastRangeOf = (ply) =>
    fastRanges.find((r) => r.fromPly <= ply && ply <= r.toPly);
  const isFastOverlay = (e, r) =>
    e.kind === "overlay" && e.form !== "bar" && e.ply === r.fromPly;
  filled.forEach((e, i) => {
    const r = fastRangeOf(e.ply);
    if (!r) return;
    if (!isFastOverlay(e, r)) {
      return fail(
        `events[${i}] is on ply ${e.ply}, inside the fastForward range ${r.fromPly}-${r.toPly}; a fast-forward plays no moments, only one overlay on its first ply`,
      );
    }
    if (takesPawn(OVERLAYS[e.asset] ?? {})) {
      return fail(
        `events[${i}]: ${e.asset} holds its ply until it closes, and a fast-forward holds none; put it on a ply outside the range`,
      );
    }
    if (filled.findIndex((x) => isFastOverlay(x, r)) !== i) {
      return fail(
        `events[${i}]: the fastForward range ${r.fromPly}-${r.toPly} has an overlay already; it shows one`,
      );
    }
    if (
      (events[i].seconds ?? undefined) !== undefined ||
      OVERLAYS[e.asset]?.seconds === null
    ) {
      fail(
        `events[${i}]: a fast-forward's overlay lasts the range, so it takes no seconds, and ${e.asset} cannot`,
      );
    }
    const onScreen = (r.toPly - r.fromPly + 1) * r.secondsPerMove;
    const asset = OVERLAYS[e.asset];
    // Fully shown for its reading time: its pop and fade come on top.
    const read = readingSeconds(asset, e.text ?? asset.line);
    const comes = TEXT_TIMING.overlayPop + TEXT_TIMING.overlayFade;
    const needs = Math.max(EDL_LIMITS.overlayFastSeconds, read + comes);
    if (onScreen < needs - 1e-9) {
      fail(
        `events[${i}]: the fastForward range ${r.fromPly}-${r.toPly} is on screen ${onScreen.toFixed(2)} s; ${e.asset} needs ${needs.toFixed(2)} s (${read} s to be read, ${comes.toFixed(2)} s to come in and go out)`,
      );
    }
    e.seconds = null;
  });
  if (coldOpenPly !== null && fastRangeOf(coldOpenPly)) {
    fail(`coldOpenPly ${coldOpenPly} is inside a fastForward range`);
  }

  // An explain is its ply's explanation: one a ply, with no other
  // explanation (a freeze, a lead zoom or a path) beside it.
  // An overlay timed inside an explain (`at`): its ply has one, not a
  // callback, and one overlay for each time.
  for (const o of filled.filter((x) => x.kind === "overlay" && x.at)) {
    const explain = filled.find((x) => x.kind === "explain" && x.ply === o.ply);
    if (!explain || explain.callback) {
      fail(
        `the ${o.asset} overlay on ply ${o.ply} opens at its explain's ${o.at === "land" ? "landing" : "new walk"}, but ply ${o.ply} has ${explain ? "a callback" : "no explain"}`,
      );
    }
    if (
      filled.some(
        (x) =>
          x !== o && x.kind === "overlay" && x.ply === o.ply && x.at === o.at,
      )
    ) {
      fail(`ply ${o.ply} has two overlays at "${o.at}"; one of each`);
    }
  }
  for (const e of filled.filter(
    (x) => x.kind === "explain" || x.kind === "flashback",
  )) {
    const others = filled.filter(
      (x) =>
        x !== e &&
        x.ply === e.ply &&
        (x.kind === "explain" ||
          x.kind === "flashback" ||
          x.kind === "freeze" ||
          x.kind === "path" ||
          (x.kind === "zoom" && x.lead)),
    );
    if (others.length > 0) {
      fail(
        `ply ${e.ply} has ${e.kind === "explain" ? "an explain" : "a flashback"} and ${others.map((x) => (x.kind === "zoom" ? "a lead zoom" : x.kind === e.kind ? `another ${x.kind}` : x.kind === "explain" ? "an explain" : `a ${x.kind}`)).join(", ")}; the ${e.kind} is the ply's explanation, so use it alone`,
      );
    }
  }

  // Before its move lands, a ply shows one thing: one freeze or one lead zoom.
  const before = filled
    .filter((e) => e.kind === "freeze" || (e.kind === "zoom" && e.lead))
    .map((e) => e.ply);
  for (const ply of new Set(before)) {
    if (before.filter((p) => p === ply).length > 1) {
      fail(
        `ply ${ply} has more than one freeze or lead zoom; a move plays one of them before it lands`,
      );
    }
  }

  // Variety (Nil, 2026-10-28: "the exclamation mark and sweat is
  // overused. 3 times. add a rule that variety is important"): a moment
  // kind, and an overlay asset, at most EDL_LIMITS.sameMoment times. A
  // zoom, a path and a sound can each be right for a save, an escape and
  // the capture, so they are not counted.
  const uses = new Map();
  for (const e of filled) {
    const what = VARIED.includes(e.kind)
      ? e.kind
      : e.kind === "overlay"
        ? `the overlay ${e.asset}`
        : null;
    if (what) uses.set(what, [...(uses.get(what) ?? []), e.ply]);
  }
  for (const [what, plies] of uses) {
    if (plies.length > EDL_LIMITS.sameMoment) {
      fail(
        `${what} is used ${plies.length} times (plies ${plies.join(", ")}); at most ${EDL_LIMITS.sameMoment} in a video: vary the moments`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    edl: {
      version: raw.version,
      gameId: raw.gameId,
      caption,
      payoff,
      ending: raw.ending,
      music,
      startPly,
      coldOpenPly,
      introPaths,
      ...slots,
      // Only when set, so a list without one stores the same bytes as before.
      ...(opening !== null ? { opening } : {}),
      ...(cta !== null ? { cta } : {}),
      ...(evalStrip !== null ? { evalStrip } : {}),
      pace: pace.map((s) => ({ ...s, fastForward: s.fastForward ?? false })),
      events: filled,
    },
  };
};

/** The pawn letters of move notation (shared/domain/standard-notation.ts). */
const PAWN_LETTERS = { C: "cat", D: "dog", M: "mouse", E: "elephant" };

/**
 * The pawns each ply moves, as { from, to } cells in standard notation, from
 * the start position and the notations alone: the mover alternates from the
 * setup's turn (player 1 when the setup names none, as GameState does), and
 * a pawn term names where that pawn of the mover ends the turn. The app has
 * no shared/domain (it runs plain JavaScript), so this is the one reading of
 * the pawns that the app, the storyboard and the renderer share; edl.test.ts
 * holds it to GameState's replay.
 * @param {{ initialState: { pawns: { p1: object, p2: object },
 *           turn?: { playerId: 1 | 2 } }, notations: string[], rows: number }} game
 * @returns {{ from: string | null, to: string }[][]}
 */
export const pawnMovesOf = ({ initialState, notations, rows }) => {
  const cell = ([row, col]) => `${String.fromCharCode(97 + col)}${rows - row}`;
  const at = { 1: {}, 2: {} };
  for (const id of [1, 2]) {
    for (const [type, c] of Object.entries(initialState.pawns[`p${id}`])) {
      at[id][type] = c ? cell(c) : null;
    }
  }
  let mover = initialState.turn?.playerId ?? 1;
  return notations.map((notation) => {
    const moves = [];
    for (const term of String(notation).split(".")) {
      const type = PAWN_LETTERS[term[0]];
      if (!type) continue;
      const to = term.slice(1);
      moves.push({ from: at[mover][type] ?? null, to });
      at[mover][type] = to;
    }
    mover = mover === 1 ? 2 : 1;
    return moves;
  });
};

/**
 * Whether `cell` lies inside the box of a zoom frame's terms, in cells: a
 * wall counts as the cell it names.
 */
const insideFrame = (cell, frame) => {
  const xy = (t) => {
    const m = t.match(/([a-z])(\d+)$/);
    return [m[1].charCodeAt(0), Number(m[2])];
  };
  const pts = frame.map(xy);
  const [x, y] = xy(cell);
  return (
    x >= Math.min(...pts.map((p) => p[0])) &&
    x <= Math.max(...pts.map((p) => p[0])) &&
    y >= Math.min(...pts.map((p) => p[1])) &&
    y <= Math.max(...pts.map((p) => p[1]))
  );
};

/**
 * Check a valid EDL against its game: every ply exists (music cues too),
 * every cell is on the
 * board, every wall a zoom frames or a trap lights is on the board by that
 * ply (a start wall of the setup is there from ply 0: Kw8fr9S6's ^g4, one
 * of its ply-26 trap's three walls), and a lead zoom's frame holds both
 * cells of every pawn its move moves.
 *
 * `notations` is the game's move list (one notation per ply, e.g.
 * "^a4.^h4"); `cols` and `rows` are the board size; `initialState` is the
 * stored start position (its pawns, and the setup's turn if any), or null
 * for an older report that has none. Returns error lines.
 */
export const checkEdlAgainstGame = (
  edl,
  { notations, cols, rows, initialState },
) => {
  const errors = [];
  // The setup's walls ({ cell: [row, col], orientation }, row 0 the top
  // rank), in the notation's terms: ">" the cell's right side, "^" its top.
  const startWalls = new Set(
    (initialState?.walls ?? []).map(
      ({ cell: [row, col], orientation }) =>
        `${orientation === "vertical" ? ">" : "^"}${String.fromCharCode(97 + col)}${rows - row}`,
    ),
  );
  const onBoard = (term) => {
    const m = term.match(/([a-z])(\d+)$/);
    const col = m[1].charCodeAt(0) - "a".charCodeAt(0);
    const row = Number(m[2]);
    return col < cols && row >= 1 && row <= rows;
  };
  const plies = [
    edl.startPly,
    ...(edl.coldOpenPly === null ? [] : [edl.coldOpenPly]),
    ...(edl.payoff === null ? [] : [edl.payoff.ply]),
    ...edl.pace.flatMap((s) => [s.fromPly, s.toPly]),
    ...edl.events.map((e) => e.ply),
    ...(edl.music ?? []).map((c) => c.fromPly),
  ];
  // The ending plays at normal speed.
  edl.pace.forEach((s, i) => {
    if (s.fastForward && s.toPly >= notations.length - 1) {
      errors.push(
        `pace[${i}] fast-forwards to ply ${s.toPly}; a fastForward range ends before the last move (${notations.length - 1})`,
      );
    }
  });
  for (const ply of plies) {
    if (ply >= notations.length) {
      errors.push(
        `ply ${ply} is past the last move (the game has ${notations.length} plies, 0-based)`,
      );
    }
  }
  edl.events.forEach((ev, i) => {
    const terms =
      ev.kind === "zoom"
        ? ev.frame
        : ev.kind === "trap"
          ? ev.walls
          : ev.cell
            ? [ev.cell]
            : [];
    for (const term of terms) {
      if (!onBoard(term)) {
        errors.push(`events[${i}]: ${term} is off the ${cols}x${rows} board`);
      }
      if (WALL.test(term) && ev.ply < notations.length) {
        const placed =
          startWalls.has(term) ||
          notations
            .slice(0, ev.ply + 1)
            .some((n) => String(n).split(".").includes(term));
        if (!placed) {
          errors.push(
            `events[${i}]: wall ${term} is not on the board by ply ${ev.ply}`,
          );
        }
      }
    }
  });
  // A plant lights its own move's wall; a callback takes away an earlier
  // move's wall.
  const placedBy = (term) =>
    notations.findIndex((n) => String(n).split(".").includes(term));
  edl.events.forEach((ev, i) => {
    if (ev.kind === "flashback" && placedBy(ev.wall) !== ev.toPly) {
      errors.push(
        `events[${i}]: a flashback goes back to the move that built its wall, and ply ${ev.toPly} (${notations[ev.toPly]}) does not place ${ev.wall}`,
      );
    }
    if (ev.kind === "plant" && placedBy(ev.wall) !== ev.ply) {
      errors.push(
        `events[${i}]: a plant lights its own move's wall, and ply ${ev.ply} (${notations[ev.ply]}) does not place ${ev.wall}`,
      );
    }
    if (ev.kind === "explain" && ev.callback) {
      const at = placedBy(ev.callback.wall);
      if (at < 0 || at >= ev.ply) {
        errors.push(
          `events[${i}]: a callback takes away a wall an earlier move placed, and no move before ply ${ev.ply} places ${ev.callback.wall}`,
        );
      }
    }
  });
  if (edl.evalStrip && edl.evalStrip.length !== notations.length + 1) {
    errors.push(
      `evalStrip lists ${edl.evalStrip.length} values, and the game's ${notations.length} moves have ${notations.length + 1} positions`,
    );
  }
  const hasLead = edl.events.some((ev) => ev.kind === "zoom" && ev.lead);
  if (hasLead && !initialState) {
    errors.push(
      "a lead zoom needs the start position, and this game has none (an older report); make a new report",
    );
  } else if (hasLead) {
    const moved = pawnMovesOf({ initialState, notations, rows });
    edl.events.forEach((ev, i) => {
      if (ev.kind !== "zoom" || !ev.lead || ev.ply >= notations.length) return;
      const moves = moved[ev.ply];
      if (moves.length === 0) {
        errors.push(
          `events[${i}]: a lead zoom plays a pawn's move, and ply ${ev.ply} (${notations[ev.ply]}) moves no pawn`,
        );
      }
      for (const { from, to } of moves) {
        const out = [from, to].filter((c) => c && !insideFrame(c, ev.frame));
        if (out.length > 0) {
          errors.push(
            `events[${i}]: the lead zoom's frame must hold the move ${from} -> ${to} of ply ${ev.ply}; add ${out.join(" and ")} to frame`,
          );
        }
      }
    });
  }
  // The ending's caption bar plays over the ending, after the last move.
  edl.events.forEach((ev, i) => {
    if (
      ev.kind === "overlay" &&
      ev.form === "bar" &&
      ev.ply !== notations.length - 1
    ) {
      errors.push(
        `events[${i}]: ${ev.asset} captions the ending, so it is on the last move (ply ${notations.length - 1}), not ply ${ev.ply}`,
      );
    }
  });
  // A path is drawn from a hunter, so its cell holds a pawn after the move.
  const paths = edl.events
    .map((ev, i) => ({ ev, i }))
    .filter(({ ev }) => ev.kind === "path" && ev.ply < notations.length);
  if (paths.length > 0 && !initialState) {
    errors.push(
      "a path needs the start position, and this game has none (an older report); make a new report",
    );
  } else if (paths.length > 0) {
    const moved = pawnMovesOf({ initialState, notations, rows });
    const cell = ([row, col]) =>
      `${String.fromCharCode(97 + col)}${rows - row}`;
    const occupied = new Set(
      Object.values(initialState.pawns)
        .flatMap((side) => Object.values(side))
        .filter(Boolean)
        .map(cell),
    );
    const after = moved.map((moves) => {
      for (const { from, to } of moves) {
        if (from) occupied.delete(from);
        occupied.add(to);
      }
      return new Set(occupied);
    });
    for (const { ev, i } of paths) {
      if (!after[ev.ply].has(ev.cell)) {
        errors.push(
          `events[${i}]: a path starts from a hunter, and no pawn stands on ${ev.cell} after ply ${ev.ply}`,
        );
      }
    }
  }
  return errors;
};

/**
 * The plies a preview plays (render-game-video.mjs --plies FROM..TO), both
 * inclusive. A preview starts at the EDL's startPly or later, because the
 * video never shows a ply before it. Returns { ok: true, from, to } or
 * { ok: false, error }. The last ply of the game is checked by the renderer,
 * which knows it only after the capture is read.
 */
export const parsePlyWindow = (spec, startPly) => {
  const m = /^(\d+)\.\.(\d+)$/.exec(String(spec));
  if (!m) {
    return { ok: false, error: `--plies must be FROM..TO, got ${spec}` };
  }
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (to < from) {
    return { ok: false, error: `--plies ${spec}: TO is before FROM` };
  }
  if (from < startPly) {
    return {
      ok: false,
      error: `--plies ${spec} starts before the EDL's startPly ${startPly}; the video never shows those plies`,
    };
  }
  return { ok: true, from, to };
};
