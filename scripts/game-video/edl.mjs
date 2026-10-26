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
 *     "music": "a-legend",
 *     "pace": [{ "fromPly": 13, "toPly": 17, "secondsPerMove": 1.1 }],
 *     "events": [
 *       { "ply": 14, "kind": "scared", "cell": "g4", "sound": "scared-2" },
 *       { "ply": 15, "kind": "zoom", "frame": ["^h4", "g5", "g4"], "sound": "fuahhh-1" },
 *       { "ply": 16, "kind": "laugh", "cell": "g4", "sound": "laugh-2" },
 *       { "ply": 16, "kind": "stamp", "text": "SAVED" },
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
 *   ending   required: the daily app rotates replay, gg and ko, so a render
 *            never falls back to one silently.
 *   music    optional: one of the site's tracks by slug (deja-vus,
 *            tea-for-two, a-legend, skippy). Absent (null after validation)
 *            means a random one, as the site and hand renders do.
 *   pace     optional: seconds per move over a range of plies (inclusive);
 *            the plies outside every range use DEFAULT_SECONDS_PER_MOVE.
 *   events   optional; the events of one ply play in list order, after the
 *            move lands. `sound` is optional on every kind but "sound" and
 *            lands as its event starts.
 *     zoom    the camera punches in to fit every cell and wall in `frame`
 *             (at most `scale`), holds for `holdSeconds`, and lets go.
 *     scared  the mouse on `cell` trembles and sweats, a "!" over it.
 *     laugh   the mouse on `cell` laughs, a 😂 over it.
 *     stamp   `text` stamps onto the middle of the board, and fades.
 *     sound   only the sound, as the move lands.
 *
 * Unknown fields are errors, not ignored: a typo in a field name must not
 * turn into a video without the effect the director asked for.
 */
import { MEME_SOUNDS } from "./meme-sounds.mjs";
import { MUSIC_TRACKS } from "./music-tracks.mjs";

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
export const EVENT_KINDS = ["zoom", "scared", "laugh", "stamp", "sound"];

/** Seconds per move where the EDL sets no pace. Proposed 2026-10-26. */
export const DEFAULT_SECONDS_PER_MOVE = 0.8;
/** The zoom's most scale and its hold, where the EDL sets none. */
export const DEFAULT_ZOOM_SCALE = 1.5;
export const DEFAULT_ZOOM_HOLD_SECONDS = 0.73;

export const EDL_LIMITS = {
  captionWords: 6,
  captionChars: 32,
  stampChars: 12,
  secondsPerMove: [0.2, 3],
  zoomScale: [1.1, 3],
  zoomHoldSeconds: [0.2, 3],
  frameTerms: 6,
  events: 40,
};

const CELL = /^[a-z][1-9]\d?$/;
const WALL = /^[>^][a-z][1-9]\d?$/;
const GAME_ID = /^[A-Za-z0-9_-]{4,40}$/;
const STAMP = /^[A-Z0-9 !?]+$/;

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
    ["version", "gameId", "caption", "ending", "music", "pace", "events"],
    "EDL",
  );

  if (raw.version !== EDL_VERSION) {
    fail(`version must be ${EDL_VERSION}, got ${JSON.stringify(raw.version)}`);
  }
  if (typeof raw.gameId !== "string" || !GAME_ID.test(raw.gameId)) {
    fail(`gameId must be a game id, got ${JSON.stringify(raw.gameId)}`);
  }

  const caption = raw.caption ?? "";
  if (typeof caption !== "string") {
    fail("caption must be a string");
  } else {
    const words = caption.split(/\s+/).filter(Boolean).length;
    if (/[\r\n]/.test(caption)) fail("caption must be one line");
    if (words > EDL_LIMITS.captionWords) {
      fail(
        `caption has ${words} words; at most ${EDL_LIMITS.captionWords} are allowed`,
      );
    }
    if (graphemes(caption) > EDL_LIMITS.captionChars) {
      fail(
        `caption has ${graphemes(caption)} characters; at most ${EDL_LIMITS.captionChars} are allowed`,
      );
    }
  }

  if (!ENDINGS.includes(raw.ending)) {
    fail(
      `ending must be one of ${ENDINGS.join(", ")}, got ${JSON.stringify(raw.ending)}`,
    );
  }

  const music = raw.music ?? null;
  const slugs = MUSIC_TRACKS.map((t) => t.slug);
  if (music !== null && !slugs.includes(music)) {
    fail(
      `music must be one of ${slugs.join(", ")}, or absent for a random track; got ${JSON.stringify(music)}`,
    );
  }

  const pace = raw.pace ?? [];
  if (!Array.isArray(pace)) {
    fail("pace must be a list");
  } else {
    pace.forEach((seg, i) => {
      const where = `pace[${i}]`;
      if (!seg || typeof seg !== "object")
        return fail(`${where}: not an object`);
      unknown(seg, ["fromPly", "toPly", "secondsPerMove"], where);
      if (!isPly(seg.fromPly) || !isPly(seg.toPly) || seg.toPly < seg.fromPly) {
        fail(`${where}: fromPly and toPly must be plies with fromPly <= toPly`);
      }
      if (!isNumberIn(seg.secondsPerMove, EDL_LIMITS.secondsPerMove)) {
        fail(
          `${where}: secondsPerMove must be ${EDL_LIMITS.secondsPerMove.join("..")}`,
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
      const fields = {
        zoom: ["frame", "scale", "holdSeconds"],
        scared: ["cell"],
        laugh: ["cell"],
        stamp: ["text"],
        sound: [],
      }[ev.kind];
      unknown(ev, ["ply", "kind", "sound", ...fields], where);
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
        (ev.kind === "scared" || ev.kind === "laugh") &&
        !(typeof ev.cell === "string" && CELL.test(ev.cell))
      ) {
        fail(`${where}: cell must be a cell in standard notation (g4)`);
      }
      if (
        ev.kind === "stamp" &&
        !(
          typeof ev.text === "string" &&
          STAMP.test(ev.text) &&
          graphemes(ev.text) <= EDL_LIMITS.stampChars
        )
      ) {
        fail(
          `${where}: text must be 1..${EDL_LIMITS.stampChars} of A-Z, 0-9, space, ! and ?`,
        );
      }
      filled.push(out);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    edl: {
      version: raw.version,
      gameId: raw.gameId,
      caption,
      ending: raw.ending,
      music,
      pace,
      events: filled,
    },
  };
};

/**
 * Check a valid EDL against its game: every ply exists, every cell is on the
 * board, and every wall a zoom frames is on the board by that ply.
 *
 * `notations` is the game's move list (one notation per ply, e.g.
 * "^a4.^h4"); `cols` and `rows` are the board size. Returns error lines.
 */
export const checkEdlAgainstGame = (edl, { notations, cols, rows }) => {
  const errors = [];
  const onBoard = (term) => {
    const m = term.match(/([a-z])(\d+)$/);
    const col = m[1].charCodeAt(0) - "a".charCodeAt(0);
    const row = Number(m[2]);
    return col < cols && row >= 1 && row <= rows;
  };
  const plies = [
    ...edl.pace.flatMap((s) => [s.fromPly, s.toPly]),
    ...edl.events.map((e) => e.ply),
  ];
  for (const ply of plies) {
    if (ply >= notations.length) {
      errors.push(
        `ply ${ply} is past the last move (the game has ${notations.length} plies, 0-based)`,
      );
    }
  }
  edl.events.forEach((ev, i) => {
    const terms = ev.kind === "zoom" ? ev.frame : ev.cell ? [ev.cell] : [];
    for (const term of terms) {
      if (!onBoard(term)) {
        errors.push(`events[${i}]: ${term} is off the ${cols}x${rows} board`);
      }
      if (WALL.test(term) && ev.ply < notations.length) {
        const placed = notations
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
  return errors;
};
