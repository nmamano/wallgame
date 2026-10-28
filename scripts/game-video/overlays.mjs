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
 *          on the last move only, from the ending's impact to its end, in
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
 *                     {blue} put in as the seats' names (dailySeatName);
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
 *   seconds  how long it shows where the EDL sets none (null: the asset
 *            decides, as the loading bar does).
 *   size     a clip's box, or a panel's band, as fractions of the board's
 *            width and height.
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
 *   seconds: number | null,
 *   size?: { w: number, h: number },
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
    source: "drawn by us (stage.html), our seat portrait",
    claim: "None",
    likeness: "None",
    rating: null,
  },
};

/** The draws that show a seat's portrait, so an EDL may name the seat. */
export const PORTRAIT_DRAWS = ["reactor"];

/** An overlay's text: at most this many characters, names put in. */
export const OVERLAY_TEXT_CHARS = 40;
/** The seat names a text may hold: {red} and {blue}, each at most once. */
export const OVERLAY_NAME_TOKENS = ["{red}", "{blue}"];

/**
 * The gap between an overlay and the board's edge, as a fraction of the
 * board, so a corner clip does not touch the board's rim.
 */
const INSET = 0.025;

/**
 * The places an overlay may go, in the order they are tried, each as a box
 * in the board (0..1): a bar's two strips and a panel's two halves (top
 * first: the eye starts there), a clip's four corners (bottom right first,
 * where the model video puts its reactors).
 * @param {{ form: "clip" | "panel" | "bar", size?: { w: number, h: number } }} asset
 * @returns {{ where: string, x: number, y: number, w: number, h: number }[]}
 */
export const overlayPlaces = (asset) => {
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
      });
    }
    return [
      { where: "top", x, y: INSET, w, h },
      { where: "bottom", x, y: 1 - INSET - h, w, h },
      ...bands,
    ];
  }
  const { w, h } = asset.size;
  const left = INSET;
  const right = 1 - INSET - w;
  const top = INSET;
  const bottom = 1 - INSET - h;
  return [
    { where: "bottom-right", x: right, y: bottom, w, h },
    { where: "bottom-left", x: left, y: bottom, w, h },
    { where: "top-right", x: right, y: top, w, h },
    { where: "top-left", x: left, y: top, w, h },
  ];
};

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
 * The first place for `asset` that overlaps none of the `busy` boxes (in
 * the board as shown, 0..1), or null when every place hides something.
 * @param {{ form: "clip" | "panel" | "bar", size?: { w: number, h: number } }} asset
 * @param {{ x0: number, y0: number, x1: number, y1: number }[]} busy
 */
export const placeOverlay = (asset, busy) =>
  overlayPlaces(asset).find((p) => coveredBy(p, busy).length === 0) ?? null;

/**
 * The loading bar's percent for a hunter `steps` from its target: 99% one
 * step away, one less per step further, never under 96% (the model video's
 * "96%... 98%... 99%").
 * @param {number} steps
 */
export const loadingPercent = (steps) =>
  Math.max(96, Math.min(99, 100 - Math.max(1, steps)));
