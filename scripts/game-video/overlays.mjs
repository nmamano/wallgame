/**
 * The overlays an EDL "overlay" event shows (edl.mjs), and where one goes.
 *
 * Wall Game Director, 2026-10-28, from the model video ("UFC 333 in 6
 * Minutes"): a meme every few seconds, tied to a real moment. Two forms:
 *
 *   clip   a small thing in a free corner of the board: a cut-out (a
 *          reactor, the compare numbers) or a toast.
 *   panel  a band across the board, as tall as its content (the loading
 *          bar), at the top, the bottom, or any height between.
 *   bar    the ending's white caption bar (the model video's last beat):
 *          on the last move only, from the ending's impact to its end (the
 *          ending holds longer when its line needs the reading time), in
 *          the top or bottom strip of the board, or else the highest band,
 *          that the ending's own card, banner, pawn and badge leave free
 *          (measured).
 *
 * An overlay rides over the board while the game goes on under it: it opens
 * as its ply's move lands and closes after its seconds (or as its asset
 * says). The renderer then puts it in the first place that hides nothing on
 * any frame it covered (placeOverlay); with no such place the render stops
 * and names what is under each place. Nothing is every pawn (Nil,
 * 2026-10-28: "Overlays should never cover the pawns") and what is in play:
 * the walls the last move placed, the effects on screen, and the hunter and
 * target of the closest hunt. The ending's bar avoids the ending's own
 * boxes instead (and, on a replay ending, what the replay shows). Places lie
 * inside the board, and the board inside SAFE_AREA, so an overlay never
 * covers the head row, the strip or an app's buttons.
 *
 * Each asset records where it comes from and its risks, as meme-sounds.mjs
 * does for sounds: `claim` is the Content ID risk, `likeness` the risk of
 * showing a real person, `rating` Nil's rating (null until he rates it).
 * Every asset here is drawn by the stage (stage.html paintOverlay) from our
 * own art and the game's facts, so none has a risk.
 *
 *   draw     how the stage draws it:
 *            toast    a game-chat toast: the EDL's `text`, with {red} and
 *                     {blue} put in as the seats' names (dailySeatNames);
 *            loading  "CAPTURE LOADING" and a bar at 96..99% as the closest
 *                     hunter's steps fall; ERROR when they rise (the save).
 *                     It lasts until that rise, so the EDL sets no seconds;
 *            compare  a side's steps before the move and after it, as a
 *                     cut-out: "2 -> 12" big and outlined, one small "steps
 *                     to catch" line under it, no box (Nil, 2026-10-28: a
 *                     cut-out is "better than the cards"); the side whose
 *                     steps rose most;
 *            reactor  a seat's portrait reacting in a corner (`motion`:
 *                     shock shakes and punches in, laugh bounces, stare
 *                     creeps in), with the EDL's `text` (or the asset's
 *                     `line`) as its label under it, if any ("the bot's
 *                     last brain cell").
 *            whitebar black text on a white bar, the EDL's `text`. (Not
 *                     "caption": stage.html's #play .caption would win.)
 *            sequence a clip with alpha (a reaction cut-out), one frame of
 *                     its PNG sequence for each moment: frame floor(t *
 *                     fps) of `sequence`, in its corner, standing on the
 *                     board's edge there (overlay-clips.mjs).
 *            The seat of a portrait is the EDL's `seat` ("red" or
 *            "blue"), which it must give: who reacts is the story, and a
 *            default once made the stopped hunter laugh at the save
 *            (Wall Game Director, 2026-10-28).
 *   text     "required", "optional" (the asset's own line if absent) or
 *            "none".
 *   chars    the most characters its text may have, where the EDL gives
 *            one (default OVERLAY_TEXT_CHARS): a reactor's label is one
 *            line under the portrait, so it is shorter.
 *   shows    the words the stage draws besides the EDL's text, as a
 *            sample with as many words ("2 12 STEPS TO CATCH"), for the
 *            reading time (readingSeconds).
 *   seconds  how long it shows where the EDL sets none (null: the asset
 *            decides, as the loading bar does). The EDL's default is this
 *            or the text's reading time, whichever is longer.
 *   size     a clip's box, or a panel's band, as fractions of the board's
 *            width and height.
 *   small    a clip's smaller box, tried in the four corners when none is
 *            free at `size` (overlayPlaces).
 *   sequence a "sequence" draw's frames: their folder in assets/overlays,
 *            fps, count, and the sha256 of the manifest that
 *            prepare-overlay-clip.mjs printed (the render stops if the
 *            frames on the box differ). `seconds` is the clip's length; an
 *            EDL may cut it shorter, never hold it longer.
 */
export const OVERLAY_FORMS = ["clip", "panel", "bar"];

/**
 * @typedef {{
 *   form: "clip" | "panel" | "bar",
 *   draw:
 *     | "toast"
 *     | "loading"
 *     | "compare"
 *     | "reactor"
 *     | "whitebar"
 *     | "sequence",
 *   motion?: "shock" | "laugh" | "stare",
 *   chars?: number,
 *   text: "required" | "optional" | "none",
 *   line?: string,
 *   shows?: string,
 *   seconds: number | null,
 *   size?: { w: number, h: number },
 *   small?: { w: number, h: number },
 *   sequence?: { dir: string, fps: number, frames: number, sha256: string },
 *   source: string,
 *   claim: string,
 *   likeness: string,
 *   rating: string | null,
 * }} OverlayAsset
 */
/** @type {Record<string, OverlayAsset>} */
export const OVERLAYS = {
  "chat-toast": {
    form: "clip",
    draw: "toast",
    text: "required",
    seconds: 1.8,
    size: { w: 0.78, h: 0.15 },
    source: "drawn by us (stage.html)",
    claim: "None",
    likeness: "None",
    rating: null,
  },
  "capture-loading": {
    form: "panel",
    draw: "loading",
    text: "none",
    shows: "CAPTURE LOADING 99%",
    seconds: null,
    size: { w: 0.95, h: 0.28 },
    source: "drawn by us (stage.html)",
    claim: "None",
    likeness: "None",
    rating: null,
  },
  "path-compare": {
    form: "clip",
    draw: "compare",
    text: "none",
    shows: "2 12 STEPS TO CATCH",
    seconds: 1.8,
    size: { w: 0.5, h: 0.3 },
    source: "drawn by us (stage.html)",
    claim: "None",
    likeness: "None",
    rating: null,
  },
  "reactor-shock": {
    form: "clip",
    draw: "reactor",
    motion: "shock",
    text: "optional",
    chars: 28,
    seconds: 1.4,
    size: { w: 0.46, h: 0.42 },
    small: { w: 0.36, h: 0.34 },
    source: "drawn by us (stage.html), our seat portrait",
    claim: "None",
    likeness: "None",
    rating: null,
  },
  "reactor-laugh": {
    form: "clip",
    draw: "reactor",
    motion: "laugh",
    text: "optional",
    chars: 28,
    seconds: 1.4,
    size: { w: 0.46, h: 0.42 },
    small: { w: 0.36, h: 0.34 },
    source: "drawn by us (stage.html), our seat portrait",
    claim: "None",
    likeness: "None",
    rating: null,
  },
  "reactor-stare": {
    form: "clip",
    draw: "reactor",
    motion: "stare",
    text: "optional",
    chars: 28,
    seconds: 1.8,
    size: { w: 0.46, h: 0.42 },
    small: { w: 0.36, h: 0.34 },
    source: "drawn by us (stage.html), our seat portrait",
    claim: "None",
    likeness: "None",
    rating: null,
  },
  "ending-caption": {
    form: "bar",
    draw: "whitebar",
    text: "required",
    chars: 34,
    seconds: null,
    source: "drawn by us (stage.html)",
    claim: "None",
    likeness: "None",
    rating: null,
  },
  "do-something": {
    form: "clip",
    draw: "reactor",
    motion: "stare",
    text: "optional",
    chars: 28,
    line: "c'mon, do something...",
    seconds: 1.8,
    size: { w: 0.46, h: 0.42 },
    small: { w: 0.36, h: 0.34 },
    source: "drawn by us (stage.html), our seat portrait",
    claim: "None",
    likeness: "None",
    rating: null,
  },
};

/** The draws that show a seat's portrait, so an EDL may name the seat. */
export const PORTRAIT_DRAWS = ["reactor"];

/**
 * Which of the seat's pawns a reactor shows, by its motion (Nil,
 * 2026-10-29, on v-2026-10-28-3: "should show the mouse, not the cat.
 * cat's are pursuers"; meme-list.md "Marks and cut-outs", CASES.md C11):
 * a shock is the threatened side's prey (its mouse), a laugh the prey of
 * the side that profits (the saved mouse, CASES.md C2), a stare the
 * hunting seat's card (its cat). "prey" is the one pawn type of the seat
 * that the other side hunts (race-replay.ts preyTypeOf).
 */
export const REACTOR_ROLES = { shock: "prey", laugh: "prey", stare: "hunter" };

/**
 * The role of a reactor asset: "prey" or "hunter".
 * @param {{ draw: string, motion?: string }} asset
 * @returns {"prey" | "hunter"}
 */
export const reactorRole = (asset) => {
  const role = asset.draw === "reactor" ? REACTOR_ROLES[asset.motion] : null;
  if (!role) {
    throw new Error(
      `a ${asset.draw} with motion ${asset.motion} has no reactor role`,
    );
  }
  return role;
};

/** An overlay's text: at most this many characters, names put in. */
export const OVERLAY_TEXT_CHARS = 40;
/** The seat names a text may hold: {red} and {blue}, each at most once. */
export const OVERLAY_NAME_TOKENS = ["{red}", "{blue}"];

/**
 * THE READING TIME of an overlay's words (Nil, 2026-10-28, on the "BEFORE
 * 2 vs AFTER 12 steps to catch" card: "too much text, goes away before i
 * can read it. Add some rules ... the reasonable amount of showing time
 * based on the amount of text"). An overlay with words shows at least
 * READ_BASE_SECONDS to find them, plus READ_WORD_SECONDS for each word:
 * about 200 words a minute, the pace of a normal reader. A number counts
 * as a word, an emoji or a symbol (->) does not, and a seat's name
 * ({red}, {blue}) counts as NAME_WORDS ("Guest Jackal").
 */
/**
 * How long text takes to come in and go out, in seconds: an overlay's pop
 * and fade, a stamp's (or trap word's) punch and fade. A reading time is
 * the time a text is fully shown, so these come on top of it (Wall Game
 * Director, 2026-10-29: every timed text got 0.1-0.2 s less than the
 * rule). edl.mjs and the renderer read them here, and the renderer gives
 * them to stage.html, which paints with them.
 */
export const TEXT_TIMING = {
  overlayPop: 0.15,
  overlayFade: 0.2,
  stampPunch: 0.25,
  stampFade: 0.25,
};

export const READ_BASE_SECONDS = 1.2;
export const READ_WORD_SECONDS = 0.3;
const NAME_WORDS = 2;

/**
 * How many words an overlay shows: the words its stage draws (`shows`)
 * and its line.
 * @param {{ shows?: string }} asset
 * @param {string | undefined} text the EDL's text, or the asset's line
 */
export const overlayWords = (asset, text) => {
  const all = `${asset.shows ?? ""} ${text ?? ""}`;
  const names = (all.match(/\{(?:red|blue)\}/g) ?? []).length;
  const words = all
    .replace(/\{(?:red|blue)\}/g, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return words + names * NAME_WORDS;
};

/**
 * The seconds an overlay must show to be read, to 0.1 s; 0 with no words.
 * @param {{ shows?: string }} asset
 * @param {string | undefined} text
 */
export const readingSeconds = (asset, text) => {
  const words = overlayWords(asset, text);
  return words === 0
    ? 0
    : Math.round((READ_BASE_SECONDS + READ_WORD_SECONDS * words) * 10) / 10;
};

/**
 * The gap between an overlay and the board's edge, as a fraction of the
 * board, so a corner clip does not touch the board's rim.
 */
const INSET = 0.025;

/**
 * How far an overlay's art reaches past its box, as shares of the box on
 * each side, 0 or more.
 * @typedef {{ top: number, right: number, bottom: number, left: number }} Reach
 */
/**
 * A place for an overlay: its box (x, y, w, h in the board, 0..1), the
 * scale its content is drawn at, and `full`, the box of its whole art.
 * @typedef {{ where: string, x: number, y: number, w: number, h: number, scale: number, full: { x: number, y: number, w: number, h: number } }} Place
 */
/** The reach of art that stays inside its box. */
export const NO_REACH = () => ({ top: 0, right: 0, bottom: 0, left: 0 });

/**
 * The places an overlay may go, in the order they are tried, each as a box
 * in the board (0..1) with the scale its content is drawn at: a bar's or a
 * panel's band (the top first: the eye starts there; then the bottom, then
 * every height), a clip's four corners (bottom right first, where the model
 * video puts its reactors). A clip with a `small` size then tries its four
 * corners at that size, its content scaled down with it (Wall Game
 * Director, 2026-10-29: the big cut-out reads best on a phone, and the
 * small one saves a late-game moment that no big corner fits).
 *
 * A clip's art can reach past its box (a reactor's punch-in and its 💦),
 * and the board cuts what passes its edge (Wall Game Director, 2026-10-29:
 * VX ply 14, the cat's ears cut flat). `reach(scale)` is how far, as
 * shares of the box on each side (render-game-video.mjs measures it on the
 * stage): a corner sits so that its whole art, `full`, keeps INSET from
 * the board's edge, and `full` is what a place must keep off the pawns. A
 * bar's or a panel's `full` is its box.
 * @param {{ form: "clip" | "panel" | "bar", size?: { w: number, h: number }, small?: { w: number, h: number } }} asset
 * @param {(scale: number) => Reach} reach
 * @returns {Place[]}
 */
export const overlayPlaces = (asset, reach) => {
  if (asset.form === "bar" || asset.form === "panel") {
    // The edges first; then every band from the top down: for an ending
    // that covers both edges (ko: its pawn on top, its banner below), and
    // for a panel between the pawns.
    const h = asset.form === "bar" ? 0.13 : asset.size.h;
    const w = asset.form === "bar" ? 1 - 2 * INSET : asset.size.w;
    const x = (1 - w) / 2;
    const bands = [];
    for (let k = 1; 0.05 * k + h < 1 - INSET; k += 1) {
      bands.push({
        where: `band ${(0.05 * k).toFixed(2)}`,
        x,
        y: 0.05 * k,
        w,
        h,
        scale: 1,
      });
    }
    return [
      { where: "top", x, y: INSET, w, h, scale: 1 },
      { where: "bottom", x, y: 1 - INSET - h, w, h, scale: 1 },
      ...bands,
    ].map((p) => ({ ...p, full: { x: p.x, y: p.y, w, h } }));
  }
  const corners = (/** @type {{ w: number, h: number }} */ { w, h }) => {
    const scale = w / asset.size.w;
    const r = reach(scale);
    const left = INSET + r.left * w;
    const right = 1 - INSET - w - r.right * w;
    const top = INSET + r.top * h;
    const bottom = 1 - INSET - h - r.bottom * h;
    const place = (where, x, y) => ({
      where,
      x,
      y,
      w,
      h,
      scale,
      full: {
        x: x - r.left * w,
        y: y - r.top * h,
        w: w * (1 + r.left + r.right),
        h: h * (1 + r.top + r.bottom),
      },
    });
    return [
      place("bottom-right", right, bottom),
      place("bottom-left", left, bottom),
      place("top-right", right, top),
      place("top-left", left, top),
    ];
  };
  return [...corners(asset.size), ...(asset.small ? corners(asset.small) : [])];
};

/** A place in words: its corner or band, and "small" at the small size. */
export const placeName = (/** @type {{ where: string, scale: number }} */ p) =>
  p.scale < 1 ? `${p.where}, small` : p.where;

/**
 * A box in the board as the camera shows it: scaled by z.scale about the
 * point (z.x, z.y), as stage.html scales #boardCam, then cut to the board
 * (#boardWrap clips the rest). Null when no part of it shows.
 * @param {{ x0: number, y0: number, x1: number, y1: number }} box
 * @param {{ scale: number, x: number, y: number } | null | undefined} zoom
 */
export const boxOnScreen = (box, zoom) => {
  const s = zoom?.scale ?? 1;
  const ox = zoom?.x ?? 0.5;
  const oy = zoom?.y ?? 0.5;
  const x0 = Math.max(0, ox + s * (box.x0 - ox));
  const y0 = Math.max(0, oy + s * (box.y0 - oy));
  const x1 = Math.min(1, ox + s * (box.x1 - ox));
  const y1 = Math.min(1, oy + s * (box.y1 - oy));
  return x0 < x1 && y0 < y1 ? { x0, y0, x1, y1 } : null;
};

/**
 * The boxes a place overlaps.
 * @template {{ x0: number, y0: number, x1: number, y1: number }} B
 * @param {{ x: number, y: number, w: number, h: number }} p
 * @param {B[]} boxes
 * @returns {B[]}
 */
export const coveredBy = (p, boxes) =>
  boxes.filter(
    (b) => b.x1 > p.x && b.x0 < p.x + p.w && b.y1 > p.y && b.y0 < p.y + p.h,
  );

/**
 * The first place for `asset` whose whole art (`full`) overlaps none of
 * the `busy` boxes (in the board as shown, 0..1), or null when every place
 * hides something.
 * @param {{ form: "clip" | "panel" | "bar", size?: { w: number, h: number } }} asset
 * @param {{ x0: number, y0: number, x1: number, y1: number }[]} busy
 * @param {(scale: number) => Reach} reach
 */
export const placeOverlay = (asset, busy, reach) =>
  overlayPlaces(asset, reach).find(
    (p) => coveredBy(p.full, busy).length === 0,
  ) ?? null;

/**
 * The loading bar's percent for a hunter `steps` from its target: 99% one
 * step away, one less per step further, never under 96% (the model video's
 * "96%... 98%... 99%").
 * @param {number} steps
 */
export const loadingPercent = (steps) =>
  Math.max(96, Math.min(99, 100 - Math.max(1, steps)));
