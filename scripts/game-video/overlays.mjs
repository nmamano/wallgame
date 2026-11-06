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
 *   cover  a clip over the whole board, scaled to fill it (object-fit:
 *          cover): speed lines, confetti, a stage curtain (Nil's meme pack,
 *          Wall Game PM, 2026-10-31). Its box is every pawn's, so what it
 *          hides is MEASURED from its pixels: on no frame may its alpha
 *          cover COVER_HIDE_SHARE of a pawn's box or of a thing in play
 *          (coverOver). A "sequence" draw only.
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
 * inside the board, so an overlay never covers the head row or the strip.
 * The renderer keeps only the ending's bar off the apps' buttons, which the
 * edge-to-edge board reaches under (edl.mjs BUTTONS_ZONE; Nil, 2026-11-06,
 * C58: only TikTok paints them over the board).
 *
 * Off the board, two places hide nothing at all (Nil, 2026-10-30: visual
 * memes "can be carve outs outside the board or on parts of the board that
 * don't cover the action"): the left margin beside the board (the right one
 * is under the platforms' buttons) and the caption's place over the frame,
 * the caption hidden while it shows. The stage measures whether an overlay
 * has room there; `places` says which places an asset may take, in order.
 *
 * Each asset records where it comes from and its risks, as meme-sounds.mjs
 * does for sounds: `claim` is the risk that an owner claims or takes down
 * the post, `likeness` the risk of showing a real person, `rating` Nil's
 * rating (null until he rates it). Risks are "None", or LOW, MEDIUM or HIGH
 * and why (visual-memes.md in the director's repo). A MEDIUM or HIGH asset
 * goes in a daily video only with Nil's OK for that asset (`nilOk`, Wall
 * Game PM's risk rule, 2026-10-30; needsNilOk).
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
 *            card     a known meme's card, drawn by the stage in our own
 *                     art (`card` names it; visual-memes.md Track A): the
 *                     words in `shows`, and for "directed-by" the EDL's
 *                     `text` (or its `line`) as the name.
 *            image    a still picture, `image.file` in VISUAL_MEME_DIR
 *                     (kept out of git, `pixels` wide and high), pinned
 *                     by its sha256 and cut to `image.crop` (shares of the
 *                     picture), kept whole in its box. With
 *                     `image.outline` (points in the picture's pixels) it
 *                     is a cut-out in that outline, not a framed rectangle
 *                     (Nil, 2026-10-30, C20: "carve outs ... the
 *                     silhouette of the visual meme"); its crop is the
 *                     outline's box (outlineCrop), and `image.fade` (a
 *                     share of its height) fades its bottom out.
 *            redraw   a known meme redrawn with the seat's own pawn art
 *                     (the skin the board shows), the meme's props drawn
 *                     by the stage around it (`redraw` names it;
 *                     visual-memes.md "Redraws"): no picture from the web.
 *            The seat of a portrait is the EDL's `seat` ("red" or
 *            "blue"), which it must give: who reacts is the story, and a
 *            default once made the stopped hunter laugh at the save
 *            (Wall Game Director, 2026-10-28). So does a card with
 *            `seat: true`, drawn in that seat's colour (who plays it).
 *   pawn     true: a pawn emotes it, and the EDL names the pawn ("red
 *            mouse"; Nil, 2026-10-30, C20: "it should be clear who is
 *            emoting. between the cats and mice"). It takes the free board
 *            place nearest that pawn (placeNear), a ring in the seat's
 *            colour round its outline and a tail that points at the pawn,
 *            and its ply holds until it closes, so the pawn stays under
 *            the tail. `pieces` limits the pawn's type where the meme names
 *            one (the scream mouse).
 *   around   a cage round the pawn, not a place beside it (gs-jail-bars;
 *            Director Rewriter, 2026-11-03: an empty cage beside the
 *            mouse "reads as a frame, not as that mouse is locked up"):
 *            `window` is the clear middle of its frames (shares of the
 *            frame), and it goes with that window's centre on the pawn's,
 *            `cells` cells wide (placeAround). Its one place takes no
 *            `place`. Its bars are measured as a cover's are (coverOver):
 *            on a pawn, its own one too, or on a thing in play, the render
 *            stops. The board cuts what passes its edge.
 *   tail     false: a picture tied to a pawn has no tail; it takes the
 *            place nearest the pawn all the same, and its ring says who
 *            emotes it (Nil, 2026-11-01, CASES C45: "the arrows/triangles
 *            on the green screen memes are ugly. the laughing man without
 *            arrow worked well"). Every green-screen cut-out (gs-*).
 *   places   where it may go, in the order they are tried: "board" (its
 *            form's places on the board, overlayPlaces), "margin" (the
 *            left margin, at its size's shape) and "caption" (the
 *            caption's place, at the board bar's size). Default: board.
 *   tint     "grey": the board turns grey under it while it shows.
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
 *            EDL may cut it shorter, never hold it longer. `audio`: the clip
 *            keeps its own sound (audio.wav, pinned by the manifest), and an
 *            EDL must say whether it plays ("own") or not ("muted", with a
 *            meme "sound" if it wants one).
 */
export const OVERLAY_FORMS = ["clip", "panel", "bar", "cover"];

/**
 * The most of a pawn's box, or of a thing in play, that a cover clip's
 * pixels may hide on one frame (the mean alpha over the box, 0..1). Speed
 * lines and confetti pass over a pawn; a piece of confetti does not hide
 * it, a curtain does.
 */
export const COVER_HIDE_SHARE = 0.25;

/** The whole board: a cover clip's one place. */
export const COVER_PLACE = {
  where: "board",
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  scale: 1,
  full: { x: 0, y: 0, w: 1, h: 1 },
};

/** The places an asset may take (`places`). */
export const PLACE_KINDS = ["board", "margin", "caption"];
/** The places off the board: the stage measures their room. */
export const OFF_BOARD = ["margin", "caption"];

/**
 * The death cards: on the winning ply, the finish slot's sound starts as
 * one opens, not at the ending (Wall Game Director, 2026-10-30: the "wah
 * wah" over WASTED is the loser's finish, and it fills the silence after
 * the catch).
 */
export const DEATH_CARDS = ["wasted", "you-died", "resign-flag"];

/** The cards the stage draws (stage.html paintOverlay, visual-memes.md). */
export const CARDS = [
  "wasted",
  "resign-flag",
  "you-died",
  "eternity-later",
  "mission-passed",
  "uno-reverse",
  "directed-by",
];

/**
 * Where the image files are: in the ignored overlays folder, which the
 * worktrees and the release checkout link to the main checkout's and the
 * kit sync copies (sync-render-kit.sh).
 */
export const VISUAL_MEME_DIR = "assets/overlays/visual-memes";

/**
 * The box of an outline (points in a picture's pixels) as shares of the
 * picture: an outlined image's crop.
 * @param {[number, number][]} outline
 * @param {[number, number]} pixels
 */
export const outlineCrop = (outline, [pw, ph]) => {
  const xs = outline.map(([x]) => x);
  const ys = outline.map(([, y]) => y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return {
    x: x0 / pw,
    y: y0 / ph,
    w: (Math.max(...xs) - x0) / pw,
    h: (Math.max(...ys) - y0) / ph,
  };
};

/**
 * Track C (visual-memes.md, Director Rewriter, 2026-10-30): the cut-outs of
 * three public-domain paintings, outlined in their pixels by Video Editor
 * (renderer), 2026-10-30. The wanderer and his rock top; Saturn's head,
 * hands and the body he eats, down to the hands (the legs below read as a
 * thin strip); Medusa's face and snakes, a circle inside the shield.
 * @type {[number, number][]}
 */
const WANDERER_OUTLINE = [
  [600, 560],
  [625, 543],
  [665, 550],
  [668, 615],
  [720, 650],
  [752, 695],
  [772, 770],
  [772, 830],
  [745, 865],
  [742, 975],
  [790, 1040],
  [815, 1150],
  [530, 1150],
  [518, 1060],
  [522, 960],
  [520, 900],
  [538, 800],
  [546, 720],
  [565, 660],
  [600, 628],
  [597, 590],
];

/** @type {[number, number][]} */
const SATURN_OUTLINE = [
  [420, 290],
  [520, 280],
  [580, 330],
  [640, 420],
  [700, 520],
  [840, 700],
  [880, 900],
  [860, 1010],
  [800, 1150],
  [560, 1150],
  [420, 1100],
  [250, 1050],
  [230, 900],
  [250, 700],
  [250, 500],
  [300, 370],
  [360, 300],
];

/** @type {[number, number][]} */
const MEDUSA_OUTLINE = [
  [1060, 625],
  [1045, 736],
  [1002, 840],
  [934, 929],
  [845, 997],
  [741, 1040],
  [630, 1055],
  [519, 1040],
  [415, 997],
  [326, 929],
  [258, 840],
  [215, 736],
  [200, 625],
  [215, 514],
  [258, 410],
  [326, 321],
  [415, 253],
  [519, 210],
  [630, 195],
  [741, 210],
  [845, 253],
  [934, 321],
  [1002, 410],
  [1045, 514],
];

/**
 * The Scream's figure: its head, its hands and its upper body, outlined in
 * the painting's pixels (the full figure's dark coat runs into the dark
 * bridge, so the bust is the part that reads; Video Editor (renderer),
 * 2026-10-30). Its bottom fades out.
 * @type {[number, number][]}
 */
const SCREAM_OUTLINE = [
  [680, 774],
  [722, 782],
  [752, 804],
  [768, 838],
  [780, 880],
  [786, 940],
  [788, 1000],
  [786, 1060],
  [792, 1120],
  [800, 1180],
  [806, 1250],
  [514, 1250],
  [518, 1180],
  [524, 1120],
  [534, 1066],
  [564, 1016],
  [568, 964],
  [568, 904],
  [576, 852],
  [594, 814],
  [620, 788],
  [650, 776],
];

/**
 * @typedef {{
 *   form: "clip" | "panel" | "bar" | "cover",
 *   draw:
 *     | "toast"
 *     | "loading"
 *     | "compare"
 *     | "reactor"
 *     | "whitebar"
 *     | "sequence"
 *     | "card"
 *     | "image"
 *     | "redraw",
 *   card?: string,
 *   image?: { file: string, pixels: [number, number], sha256: string, crop: { x: number, y: number, w: number, h: number }, outline?: [number, number][], fade?: number },
 *   redraw?: string,
 *   seat?: true,
 *   pawn?: true,
 *   pieces?: string[],
 *   around?: { window: { x0: number, y0: number, x1: number, y1: number }, cells: number },
 *   places?: ("board" | "margin" | "caption")[],
 *   tint?: "grey",
 *   nilOk?: string | null,
 *   motion?: "shock" | "laugh" | "stare",
 *   chars?: number,
 *   text: "required" | "optional" | "none",
 *   line?: string,
 *   shows?: string,
 *   seconds: number | null,
 *   size?: { w: number, h: number },
 *   small?: { w: number, h: number },
 *   sequence?: { dir: string, fps: number, frames: number, sha256: string, audio?: true },
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
    places: ["board", "caption"],
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
  /*
    Visual memes, Track A (visual-memes.md, Wall Game Director,
    2026-10-30): known memes' cards, drawn by the stage in our own art. The
    look of a known meme is the joke, so the claim risk is LOW, not None.
  */
  wasted: {
    form: "panel",
    draw: "card",
    card: "wasted",
    text: "none",
    shows: "WASTED",
    seconds: 1.6,
    size: { w: 0.95, h: 0.2 },
    places: ["board", "caption"],
    tint: "grey",
    source: "drawn by us (stage.html), the look of GTA's death screen",
    claim: "LOW: our own drawing of a known game screen",
    likeness: "None",
    rating: null,
  },
  "you-died": {
    form: "panel",
    draw: "card",
    card: "you-died",
    text: "none",
    shows: "YOU DIED",
    seconds: 1.8,
    size: { w: 0.95, h: 0.2 },
    places: ["board", "caption"],
    tint: "grey",
    source: "drawn by us (stage.html), the look of Dark Souls' death screen",
    claim: "LOW: our own drawing of a known game screen",
    likeness: "None",
    rating: null,
  },
  "eternity-later": {
    form: "panel",
    draw: "card",
    card: "eternity-later",
    text: "none",
    shows: "ONE ETERNITY LATER",
    seconds: 2.1,
    size: { w: 0.8, h: 0.2 },
    places: ["caption", "board"],
    source: "drawn by us (stage.html), the look of SpongeBob's time cards",
    claim: "LOW: our own drawing of a known title card",
    likeness: "None",
    rating: null,
  },
  "mission-passed": {
    form: "panel",
    draw: "card",
    card: "mission-passed",
    text: "none",
    shows: "MISSION PASSED RESPECT +",
    seconds: 2.1,
    size: { w: 0.9, h: 0.2 },
    places: ["caption", "board"],
    source: "drawn by us (stage.html), the look of GTA's mission screen",
    claim: "LOW: our own drawing of a known game screen",
    likeness: "None",
    rating: null,
  },
  /*
    The resign ending's death card (Nil, 2026-11-01, ask 084f7f40, CASES
    C42: "maybe we could also use those but with some resign animation
    like a flag or something (and showing remaining idstances to make clear
    that it's lost)"). "<Bot|Human> resigns" near the resigner's pawn, and a
    small white flag rises and waves beside each pawn of the side that
    resigned (Nil, 2026-11-01, ask 3d2f28e7: "what if we make both pawns
    weave the resign flag?"); the race counter flashes while it shows. Only
    on a game the record says was resigned (end-reason).
  */
  "resign-flag": {
    form: "clip",
    draw: "card",
    card: "resign-flag",
    text: "none",
    line: "{loser} resigns",
    seconds: 2.2,
    pawn: true,
    // No pointer: "<Bot|Human> resigns" already names the side, and the
    // tail is the blue triangle Nil called ugly (Wall Game Director,
    // 2026-11-01, on the 1102d proof; CASES C45).
    tail: false,
    // No small size: its words are the only ones on the board that say
    // how the game ended (render vet, 2026-11-01, v-2026-11-01-8).
    // The words alone: at this size they are as large as when the card
    // also held the flag (62 of 350 at 0.36 high).
    size: { w: 0.38, h: 0.155 },
    places: ["board"],
    source: "drawn by us (stage.html), white flags and words",
    claim: "None",
    likeness: "None",
    rating: null,
  },
  "uno-reverse": {
    form: "clip",
    draw: "card",
    card: "uno-reverse",
    seat: true,
    text: "none",
    seconds: 1.4,
    size: { w: 0.28, h: 0.42 },
    small: { w: 0.22, h: 0.33 },
    places: ["board", "margin"],
    source: "drawn by us (stage.html), a reverse card in the seat's colour",
    claim: "LOW: our own drawing of a known card game's card",
    likeness: "None",
    rating: null,
  },
  "directed-by": {
    form: "panel",
    draw: "card",
    card: "directed-by",
    text: "optional",
    chars: 24,
    // The side that "made" the disaster, never a real person's name (Wall
    // Game Director, 2026-10-30: the show's real director's name is MEDIUM).
    line: "{red}",
    shows: "Directed by",
    seconds: 2.4,
    size: { w: 0.95, h: 0.24 },
    places: ["board", "caption"],
    source: "drawn by us (stage.html), the look of a TV show's end credit",
    claim: "LOW: our own drawing of a known credit",
    likeness:
      "LOW: names a seat ({red} or {blue}); a real person's name in its text is MEDIUM and needs Nil's OK",
    rating: null,
  },
  /*
    Visual memes, Track B (visual-memes.md): pictures from the web, each
    with its origin page and risks there. Only the preview's three are
    here; a HIGH one gets our own redraw instead (Wall Game PM, 2026-10-30).
    Nil, 2026-10-30 (C20): the-scream may go in posted videos;
    smudge-cat and monkey-puppet got no OK.
  */
  "the-scream": {
    form: "clip",
    draw: "image",
    image: {
      file: "the-scream.jpg",
      pixels: [1280, 1589],
      sha256:
        "2fcbcc4554496812fe37c4bc9c6da2ee45da98ce9d5c21de271f7ef3b3431a34",
      crop: outlineCrop(SCREAM_OUTLINE, [1280, 1589]),
      outline: SCREAM_OUTLINE,
      fade: 0.13,
    },
    pawn: true,
    // No pointer (Nil, 2026-11-01, C45: the triangles are ugly; Wall Game
    // Director, script v-2026-11-01-7 v2.3).
    tail: false,
    text: "none",
    seconds: 1.4,
    size: { w: 0.25, h: 0.41 },
    small: { w: 0.2, h: 0.33 },
    places: ["board"],
    source:
      "Edvard Munch, The Scream, 1893, National Gallery of Norway (Wikimedia Commons), public domain",
    claim:
      "LOW: public domain; some countries limit reuse of a photo of an artwork",
    likeness: "LOW",
    nilOk: "Nil, 2026-10-30 (ask 695dd417, CASES.md C20)",
    rating: null,
  },
  "smudge-cat": {
    form: "clip",
    draw: "image",
    image: {
      file: "smudge-cat.jpg",
      pixels: [1080, 608],
      sha256:
        "72af31ff33298ce7a45003d07dc4f3e74c2b83f0eaf43e5c1328282accfc9a96",
      // The table cat only: the file's right half (its left half is
      // another photo of the cat).
      crop: { x: 0.52, y: 0, w: 0.48, h: 1 },
    },
    text: "none",
    seconds: 1.4,
    size: { w: 0.34, h: 0.4 },
    small: { w: 0.26, h: 0.31 },
    pawn: true,
    places: ["board"],
    source:
      "Smudge the cat, first posted 2018-06-19 on Tumblr; owner probably @smudge_lord, not confirmed",
    claim: "MEDIUM: a private owner's photo",
    likeness: "LOW: the cat half only",
    nilOk: null,
    rating: null,
  },
  "monkey-puppet": {
    form: "clip",
    draw: "image",
    image: {
      file: "monkey-puppet.png",
      pixels: [680, 450],
      sha256:
        "c0dd08960b30afb33f1a34f2528905d39fd492cc11d2362fcc3d666944972566",
      crop: { x: 0, y: 0, w: 1, h: 1 },
    },
    text: "none",
    seconds: 1.6,
    size: { w: 0.5, h: 0.33 },
    small: { w: 0.39, h: 0.26 },
    pawn: true,
    places: ["board"],
    source:
      'the puppet Kento, Japanese children\'s TV "Ōkiku Naru Ko" (1959-1988); meme from 2016-05-05',
    claim: "MEDIUM: a TV frame, owner unknown",
    likeness: "LOW: a puppet",
    nilOk: null,
    rating: null,
  },
  /*
    Visual memes, Track C (visual-memes.md, Director Rewriter,
    2026-10-30): public-domain paintings from Wikimedia Commons, each with
    its sound (Nil, C23) and next to the pawn that feels it (C20). LOW
    claim and likeness, so no OK is needed; medusa and saturn are dark, and
    the Director judges each against the video's mood.
  */
  "great-wave": {
    form: "clip",
    draw: "image",
    image: {
      file: "great-wave.jpg",
      pixels: [1280, 884],
      sha256:
        "3e07c53f3ef84a42399c86e40b1b33a450ad2aa767d044589f950b66a03a5d41",
      // The wave, the boats and Fuji: the print's left part, without its
      // paper margin (a rectangle: the print has no figure to cut out).
      crop: { x: 28 / 1280, y: 100 / 884, w: 872 / 1280, h: 758 / 884 },
    },
    pawn: true,
    pieces: ["mouse"],
    text: "none",
    seconds: 1.4,
    size: { w: 0.38, h: 0.33 },
    small: { w: 0.3, h: 0.26 },
    places: ["board"],
    source:
      "Hokusai, The Great Wave off Kanagawa, about 1831, the Met's print DP141063 (Wikimedia Commons), CC0",
    claim: "LOW: public domain (the Met's CC0 photo of the print)",
    likeness: "LOW",
    nilOk: null,
    rating: null,
  },
  wanderer: {
    form: "clip",
    draw: "image",
    image: {
      file: "wanderer.jpg",
      pixels: [1280, 1639],
      sha256:
        "97b0a5a0ea20deaa9a6f7fd310fdc7dfc6b80b43bd243b31aad5a6acce1aaa34",
      crop: outlineCrop(WANDERER_OUTLINE, [1280, 1639]),
      outline: WANDERER_OUTLINE,
      fade: 0.13,
    },
    pawn: true,
    pieces: ["mouse"],
    text: "none",
    seconds: 1.4,
    size: { w: 0.2, h: 0.41 },
    small: { w: 0.16, h: 0.33 },
    places: ["board"],
    source:
      "Caspar David Friedrich, Wanderer above the Sea of Fog, 1818, Hamburger Kunsthalle (Wikimedia Commons), public domain",
    claim:
      "LOW: public domain; some countries limit reuse of a photo of an artwork",
    likeness: "LOW",
    nilOk: null,
    rating: null,
  },
  medusa: {
    form: "clip",
    draw: "image",
    image: {
      file: "medusa.jpg",
      pixels: [1280, 1312],
      sha256:
        "b5aeb18245111188a0de347e296057e3a775e8b5fc387c8aa7334b5f990ff930",
      crop: outlineCrop(MEDUSA_OUTLINE, [1280, 1312]),
      outline: MEDUSA_OUTLINE,
    },
    pawn: true,
    text: "none",
    seconds: 1.4,
    size: { w: 0.32, h: 0.32 },
    small: { w: 0.26, h: 0.26 },
    places: ["board"],
    source:
      "Caravaggio, Medusa, 1597, Uffizi (Wikimedia Commons, Google Art Project), public domain",
    claim:
      "LOW: public domain; some countries limit reuse of a photo of an artwork",
    likeness: "LOW",
    nilOk: null,
    rating: null,
  },
  saturn: {
    form: "clip",
    draw: "image",
    image: {
      file: "saturn.jpg",
      pixels: [1280, 2351],
      sha256:
        "8079619101d0780a75815ed32349876f40da602f0ae29ddd386c10861781ec19",
      crop: outlineCrop(SATURN_OUTLINE, [1280, 2351]),
      outline: SATURN_OUTLINE,
      fade: 0.13,
    },
    pawn: true,
    pieces: ["cat"],
    text: "none",
    seconds: 1.4,
    size: { w: 0.3, h: 0.4 },
    small: { w: 0.24, h: 0.32 },
    places: ["board"],
    source:
      "Francisco de Goya, Saturn Devouring His Son, 1819-1823, Prado (Wikimedia Commons), public domain",
    claim:
      "LOW: public domain; some countries limit reuse of a photo of an artwork",
    likeness: "LOW",
    nilOk: null,
    rating: null,
  },
  /*
    The redraws (visual-memes.md "Redraws"; Nil, 2026-10-30, C20: redraw
    surprised-pikachu and this-is-fine): the joke of a HIGH picture with
    the seat's own pawn art and props the stage draws. Our pawn art is a
    one-line drawing per skin, so a redraw cannot give it a new face: the
    props and the motion carry the joke.
  */
  "surprised-mouse": {
    form: "clip",
    draw: "redraw",
    redraw: "surprised",
    pawn: true,
    pieces: ["mouse"],
    text: "none",
    seconds: 1.2,
    size: { w: 0.3, h: 0.3 },
    small: { w: 0.24, h: 0.24 },
    places: ["board"],
    source:
      "drawn by us (stage.html): the seat's own mouse, the deadpan close-up of surprised Pikachu",
    claim: "LOW: our own drawing of a known meme's layout",
    likeness: "None",
    rating: null,
  },
  "this-is-fine-mouse": {
    form: "clip",
    draw: "redraw",
    redraw: "this-is-fine",
    pawn: true,
    pieces: ["mouse"],
    text: "none",
    shows: "this is fine",
    seconds: 2.4,
    size: { w: 0.4, h: 0.38 },
    small: { w: 0.32, h: 0.3 },
    places: ["board"],
    source:
      "drawn by us (stage.html): the seat's own mouse with a cup in flames, the joke of K.C. Green's comic",
    claim: "LOW: our own drawing of a known meme's joke",
    likeness: "None",
    rating: null,
  },
  "scream-mouse": {
    form: "clip",
    draw: "redraw",
    redraw: "scream",
    pawn: true,
    pieces: ["mouse"],
    text: "none",
    seconds: 1.4,
    size: { w: 0.3, h: 0.38 },
    small: { w: 0.24, h: 0.3 },
    places: ["board"],
    source:
      "drawn by us (stage.html): the seat's own mouse in The Scream's pose and sky (Munch, 1893, public domain)",
    claim: "LOW: our own drawing after a public-domain painting",
    likeness: "None",
    rating: null,
  },
  /*
    POINTING-PAWNS (visual-memes.md, for spiderman-point; Wall Game
    Director, 2026-10-31, R2): the standoff's two pawns face each other in
    a band, each with a drawn arm that points at the other, a mirror pose;
    the arms jab in turn on the beats of pointing-2 (2.8 s). The EDL's
    `seat` is the cat's seat; the other pawn is the piece that cat hunts.
    Not used in a posted video before Nil has seen a still (the Director's
    ask): our earlier redraws of known memes did not land (C23).
  */
  "pointing-pawns": {
    form: "panel",
    draw: "redraw",
    redraw: "pointing",
    seat: true,
    text: "none",
    seconds: 2.8,
    size: { w: 0.9, h: 0.28 },
    places: ["board"],
    source:
      "drawn by us (stage.html): the standoff's own two pawns in the mirror pose of Spider-Man pointing at Spider-Man",
    claim: "LOW: our own drawing of a known meme's layout",
    likeness: "None",
    rating: null,
  },
  /*
    Green-screen clips, keyed by prepare-overlay-clip.mjs on 2026-10-31.
    Their risks come from the Director Rewriter's source checks
    (meme-pack.md "Source checks", director repo b75d3cb and facaf65): Nil's
    meme pack grants no license, so a pack clip is LOW only with no owner
    trace; curtain-open and confetti are Pixabay's replacements (Pixabay
    Content License, no credit).
  */
  "curtain-open": {
    form: "cover",
    draw: "sequence",
    text: "none",
    seconds: 3,
    sequence: {
      dir: "curtain-open",
      fps: 30,
      frames: 90,
      sha256:
        "3f4f7c0de05c691fd863ae658d4e65152f272fbc3c2931c527317befc5d968cc",
    },
    source:
      "Pixabay 30680, Opening Curtain, green screen, play (shahsb_27, 2019; https://pixabay.com/videos/opening-curtain-green-screen-play-30680/), 4.3-10.3 s at 2x, keyed at similarity 0.08 (its dark folds are near its yellow-green); no sound",
    claim: "LOW: Pixabay Content License",
    likeness: "None",
    rating: null,
  },
  /*
    A band of fire along the bottom of the board, for a move that destroys
    the other side (Nil, 2026-11-01, via Wall Game PM: "you can also put
    this at the time the move is played (with anticipation and slow zoom
    maybe), then one of the others after while it's showing the new
    distance path"). Nil's clip has no blast and no sound: 25 s of flames
    along the bottom of its frame. Four time-shifted copies of 2.0-3.5 s
    stand side by side, a quarter of the frame high, so the flames stay in
    the board's lowest 17% (under the row 2/3 line on 8 rows; Wall Game
    Director, 2026-11-01: never over the walls the boom points at). They
    rise from below over 0.3 s and sink over the last 0.3 s. Its sound is
    the event's (boom-4 in the script).
  */
  "gs-fire": {
    form: "cover",
    draw: "sequence",
    text: "none",
    seconds: 1.5,
    sequence: {
      dir: "gs-fire",
      fps: 30,
      frames: 45,
      sha256:
        "86c5a628d4dee25d3ab644073d15c6d7c87831ee4a83358bdfc3222144f2ea45",
    },
    source:
      "Nil's clip, 2026-11-01: Explosion Fire Burn.wmv (origin not known), 2.0-3.5 s, the flames cut out, four copies side by side, keyed at 0x29BC19; its track is silent",
    claim: "MEDIUM: a clip of unknown origin",
    likeness: "None",
    nilOk:
      'Nil, for this clip: "you can also put this at the time the move is played (with anticipation and slow zoom maybe), then one of the others after while it\'s showing the new distance path" (Nil to Wall Game PM, 2026-11-01 about 10:15 UTC)',
    rating: null,
  },
  /*
    Chalk equations floating over the board, the "thinking" meme, for a
    zoom onto the human's cat just before the human's good move (Nil,
    2026-11-01, to the Wall Game Director: "this meme with a zoom in on
    the cat can be before a good move (by human, not bot), save it for a
    different video"). 2.0-4.5 s of Nil's clip; its track is silent.
  */
  "gs-math": {
    form: "cover",
    draw: "sequence",
    text: "none",
    seconds: 2.533,
    sequence: {
      dir: "gs-math",
      fps: 30,
      frames: 76,
      sha256:
        "7bc446650b96dbda989679a408b1003298e4dcad7ea1ddf23babc6d506a0e481",
    },
    source:
      "Nil's clip, 2026-11-01: 4K Math Background Greenscreen effect Chromakey Copyright free.mp4 (origin not known; its name says copyright free), 2.0-4.5 s, keyed; its track is silent",
    claim: "MEDIUM: a clip of unknown origin, said to be copyright free",
    likeness: "None",
    nilOk:
      'Nil, for this clip: "this meme with a zoom in on the cat can be before a good move (by human, not bot), save it for a different video" (Nil to the Wall Game Director, 2026-11-01)',
    rating: null,
  },
  // Three free Pixabay clips for the commonest labels with no gs clip
  // (meme-list.md "Green-screen coverage", step 2 cycle 3, C55; source
  // checks in meme-pack.md batch 4, Director Rewriter, 2026-11-03). Each
  // is silent: its move's line names the sound.
  "gs-siren": {
    form: "clip",
    draw: "sequence",
    text: "none",
    // The light turns red and blue and its rays pulse: 2 flashes a second.
    seconds: 2,
    pawn: true,
    tail: false,
    pieces: ["mouse"],
    // 570x504: the light and its rays (trimmed to their box).
    size: { w: 0.24, h: 0.212 },
    small: { w: 0.19, h: 0.168 },
    places: ["board"],
    sequence: {
      dir: "gs-siren",
      fps: 30,
      frames: 60,
      sha256:
        "5c32fe51bfc144b0d331e056b6d5eb8d9365f5c59a80dab33b475184f41dc5d6",
    },
    source:
      "Pixabay 283687, Police siren alarm green screen (fspik_now, 2025-06-04; https://pixabay.com/videos/police-siren-alarm-green-screen-283687/), 0.5-2.5 s, the light cut out (crop 1200:1000:360:60, trimmed), keyed at 0x08BE08; no audio track",
    claim: "LOW: Pixabay Content License",
    likeness: "None",
    rating: null,
  },
  "gs-jail-bars": {
    form: "clip",
    draw: "sequence",
    text: "none",
    // The bars stand still round the mouse: their drop-in (0-0.85 s of
    // the source) swept over the window, so it hid the mouse and its walls.
    seconds: 2.533,
    pawn: true,
    tail: false,
    pieces: ["mouse"],
    // 540x540: one cell of the grid and the bars round it. It goes round
    // the mouse: its clear window (x 100-438, y 115-453 of 540, measured
    // on its last frame) 1.35 cells wide, so the walls on the mouse's
    // cell edges show inside it, clear of the bars (Wall Game Director,
    // 2026-11-03: on a box-in they are the cause of the joke; at 1.25 the
    // bars lay on them). Its bars then hide 41% of a pawn in a next cell
    // and 30% of one in a diagonal cell, so such a pawn stops the render;
    // only a cage under 1.19 cells clears them, and it lies on the walls.
    around: {
      window: { x0: 100 / 540, y0: 115 / 540, x1: 439 / 540, y1: 454 / 540 },
      cells: 1.35,
    },
    size: { w: 0.25, h: 0.25 },
    small: { w: 0.2, h: 0.2 },
    places: ["board"],
    sequence: {
      dir: "gs-jail-bars",
      fps: 30,
      frames: 76,
      sha256:
        "d1fbbe1f4f959aef9ee575477bd1acdc4008d554b5ba117e9ced98e5a74c6195",
    },
    source:
      "Pixabay 93536, Jail prison calaboose cell (miukia_aki, 2021-10-31; https://pixabay.com/videos/jail-prison-calaboose-cell-qued-93536/), 0.85-3.35 s (the bars at rest), a square of the grid (crop 1080:1080:225:0), keyed at 0x00FF00; its track is silent and not kept",
    claim: "LOW: Pixabay Content License",
    likeness: "None",
    rating: null,
  },
  "gs-tumbleweed": {
    form: "cover",
    draw: "sequence",
    text: "none",
    // It rolls in at the left and out at the right along the board's
    // bottom row (the lowest 27% of the board; about 1.5 cells tall on an
    // 8x8 board, Wall Game Director, 2026-11-03: one cell "reads as a
    // brown spot at phone size"). A cover hides nothing: a pawn on that
    // row, or a thing in play there, stops the render.
    seconds: 3.167,
    sequence: {
      dir: "gs-tumbleweed",
      fps: 30,
      frames: 95,
      sha256:
        "916a066f171abe2ab1b1af15c791f6ce49144668366899cb2158adc1646764a6",
    },
    source:
      "Pixabay 244299, Tumbleweed greenscreen (u_7x9jx9u7vt, 2024-12-01; https://pixabay.com/videos/tumbleweed-tumble-weed-greenscreen-244299/), the whole 10.2 s at 3.2x, the frame scaled 1.26x and cut to its middle 1920 px (it rolls in and out past the sides), put at the bottom of a square of its own green (pad 1920:1920:0:558), keyed at 0x01BE21, similarity 0.08 (0.15 ate its strands); no sound",
    claim: "LOW: Pixabay Content License",
    likeness: "None",
    rating: null,
  },
  confetti: {
    form: "cover",
    draw: "sequence",
    text: "none",
    seconds: 2,
    sequence: {
      dir: "confetti",
      fps: 30,
      frames: 60,
      sha256:
        "84e211a54eb50fed0f495f4daac9d124121a8e0062a3038653eaac671c7f0051",
    },
    source:
      "Pixabay 219897, Confetti paper green screen (2024; https://pixabay.com/videos/confetti-paper-green-screen-fun-219897/), 0.5-2.5 s (the burst building: its middle covers 10-13% of the frame and hid the winner in the proof), keyed at similarity 0.08 (its teal pieces come out pale blue); no sound",
    claim: "LOW: Pixabay Content License",
    likeness: "None",
    rating: null,
  },
  "curtain-open-pack": {
    form: "cover",
    draw: "sequence",
    text: "none",
    seconds: 3.233,
    sequence: {
      dir: "curtain-open-pack",
      fps: 30,
      frames: 97,
      sha256:
        "dedafb03dc42e2f9ea43cd271fbab75fc336d5f946a55bebc6efb2d325d33f2d",
    },
    source:
      "Nil's meme pack: Green Screen/Curtain Opening Effect - Green Screen Royalty Free Footage.mp4 (a YouTube download), 1.5-8 s at 2x; no sound",
    claim:
      'MEDIUM: "Royalty Free" is the uploader\'s own claim; its title form matches a channel whose terms ask for a subscribe and a link for commercial use',
    likeness: "None",
    nilOk: null,
    rating: null,
  },
  "confetti-pack": {
    form: "cover",
    draw: "sequence",
    text: "none",
    seconds: 3,
    sequence: {
      dir: "confetti-pack",
      fps: 30,
      frames: 90,
      sha256:
        "80ec5af06dcf9c449ffcdd78a5f721bdde17bacffee029ab8b04b4c54105f55a",
    },
    source:
      "Nil's meme pack: Green Screen/Confetti.mp4 (a YouTube download of 2018), 0.5-3.5 s; no sound",
    claim:
      "MEDIUM: its likeliest upload links to a Shutterstock listing, so it may be a stock clip",
    likeness: "None",
    nilOk: null,
    rating: null,
  },
  "rec-frame": {
    form: "cover",
    draw: "sequence",
    text: "none",
    seconds: 4,
    // A camera frame round the whole board: "caught in 4K" (meme-pack.md
    // Batch 2, gs-rec-frame; Wall Game PM, 2026-10-31): on a self-trap, or
    // on the punish of a turn with costShown, with clang-1 or bruh-1.
    sequence: {
      dir: "rec-frame",
      fps: 30,
      frames: 120,
      sha256:
        "486a572afcec23862cb49469256b7562b7666ff767cb6b2b13a5e3d5041a8156",
    },
    source:
      "Nil's meme pack: Green Screen/Camera Hud REC More Complex.mp4 (8.8 s, 1280x720, sha256 cf699c8ca4ed5c31), 0-4 s; made square for the board: its left and right 360 px side by side (the corner brackets, REC and its dot, the battery); its bottom line (ISO 200 ... 30 FPS) left out, as a cover clip stays inside the board and the line lay over row 1 and its letters (Wall Game Director, 2026-10-31); silent",
    claim: "LOW: a generic camera HUD (Director Rewriter, cc298af)",
    likeness: "None",
    rating: null,
  },
  "stupid-stamp": {
    form: "clip",
    draw: "sequence",
    text: "none",
    seconds: 1.533,
    // 384x212 after the trim: the stamp alone, cut after the hand has left
    // (Wall Game Director, 2026-10-31: "about 2x bigger", held for its
    // beat only). Its pop is the landing; our own thud goes with it.
    // Beside the mover's pawn, with a tail to it, as meme-list.md says
    // (f00bf5b6 item 16: v-2026-10-31-2 ply 8 put it in a free place).
    pawn: true,
    size: { w: 0.3, h: 0.166 },
    small: { w: 0.24, h: 0.133 },
    places: ["board"],
    sequence: {
      dir: "stupid-stamp",
      fps: 30,
      frames: 46,
      sha256:
        "a1abd0abf1b4ce5a00c0a9f3a87cf50bc8e8c9775df65bd9586fdd799e1d25fd",
    },
    source:
      "Nil's meme pack: Green Screen/Stupid Stamp - Chroma Key Template [Mpgun.com].mp4 (a YouTube download), 1.9-3.4 s, trimmed to its art; its own thud is not kept",
    claim: "LOW: a generic word stamp, no owner trace; its thud muted",
    likeness: "None",
    rating: null,
  },
  /*
    Four green-screen cut-outs from Nil's meme pack (Nil, 2026-11-01, CASES
    C43: "Why don't you use the green screen memes i gave you ... so many
    opportunities"; the Wall Game Director's picks). Each emotes a pawn,
    like the-scream: beside it, with a ring and a tail in its seat's
    colour. Keyed by prepare-overlay-clip.mjs, trimmed to the art; the
    lines they go on are in meme-list.md. HIGH claim and likeness: nilOk
    records Nil's own words for each clip; a clip that gets a claim leaves
    the list (C43).
  */
  "gs-jjj-laugh": {
    form: "clip",
    draw: "sequence",
    text: "none",
    // The whole clip: he laughs from the first frame to the last. The
    // source's last frame is empty, so it is cut: held through the fade,
    // it took him off 0.35 s before his ring (render vet, 2026-11-01,
    // v-2026-11-01-8 at 24.85 s).
    seconds: 2.867,
    pawn: true,
    tail: false,
    // Big enough that his face reads on a phone, even at the small size
    // (Wall Game Director, 2026-11-01, on the 1102b proof).
    size: { w: 0.4, h: 0.28 },
    small: { w: 0.34, h: 0.24 },
    places: ["board"],
    sequence: {
      dir: "gs-jjj-laugh",
      fps: 30,
      frames: 86,
      sha256:
        "d493dcc246b7f098b7ff6f95731f14bbc45a22ca7a04c28cb2341863486d12f6",
      audio: true,
    },
    source:
      "Nil's meme pack: Green Screen/Green Screen - Man Laughing Peter Parker.mp4 (J. K. Simmons as J. Jonah Jameson, Spider-Man, 2002), 0-2.87 s (its empty last frame cut), its laugh kept",
    claim: "HIGH: a film clip (Sony Pictures), with its audio",
    likeness: "HIGH: a real actor's face",
    nilOk:
      'Nil, for this clip: "this one when the opponent makes a mistake" (Nil, chat to the Wall Game Director, 2026-11-01 02:53 UTC, CASES C43, sending the four clips: "Why don\'t you use the green screen memes i gave you, i just lookned at them and see so many opportunities")',
    rating: null,
  },
  /*
    The laughing-crying man ("Ngaaaa"), for a move that destroys the other
    side (Nil, 2026-11-01, via Wall Game PM: "on that wall that increased
    distance to 35 moves, you could have played one of these green screen
    memes. save them for occasions like this like when you get destroyed by
    a move"). Cut to 0.5-3.0 s: Whisper finds no words there; a possible
    word comes at 5.8 s.
  */
  "gs-laugh-cry": {
    form: "clip",
    draw: "sequence",
    text: "none",
    seconds: 2.5,
    pawn: true,
    tail: false,
    // Head and shoulders, as large as JJJ's, so the face reads on a phone.
    size: { w: 0.4, h: 0.252 },
    small: { w: 0.34, h: 0.214 },
    places: ["board"],
    sequence: {
      dir: "gs-laugh-cry",
      fps: 30,
      frames: 75,
      sha256:
        "7f2ef0b24d1c567a3c6c72243385a37633377ef70b7e3b4e4a28ae21d2e30898",
      audio: true,
    },
    source:
      "Nil's clip, 2026-11-01: Green Screen - Ortua - Meinangis - Ngaaaaaaaaa (origin not known), 0.5-3.0 s, its black bars cropped, its voice kept",
    claim: "MEDIUM: a clip of unknown origin, with its audio",
    likeness: "HIGH: a real person's face",
    nilOk:
      'Nil, for this clip: "on that wall that increased distance to 35 moves, you could have played one of these green screen memes. save them for occasions like this like when you get destroyed by a move" (Nil to Wall Game PM, 2026-11-01 about 10:05 UTC)',
    rating: null,
  },
  /*
    A man with his hands on his head, shocked, for a move that destroys
    the other side (Nil, 2026-11-01, via Wall Game PM, with gs-laugh-cry:
    "save them for occasions like this like when you get destroyed by a
    move"). 0-1.0 s: he leaves the frame after it. Its track is silent, so
    the event names its sound. The source's file name is not used on any
    surface (Wall Game PM, 2026-11-01).
  */
  "gs-hands-on-head": {
    form: "clip",
    draw: "sequence",
    text: "none",
    seconds: 1,
    pawn: true,
    tail: false,
    size: { w: 0.4, h: 0.225 },
    small: { w: 0.34, h: 0.191 },
    places: ["board"],
    sequence: {
      dir: "gs-hands-on-head",
      fps: 30,
      frames: 30,
      sha256:
        "7ef8ba0454ff8ce332dd3cfbfd901dd3b51c55c21fd8cdd0578c253154f67cfc",
    },
    source:
      "Nil's clip, 2026-11-01: a man with his hands on his head, on green (origin not known), 0-1.0 s; its track is silent",
    claim: "MEDIUM: a clip of unknown origin",
    likeness: "HIGH: a real person's face",
    nilOk:
      'Nil, for this clip: "save them for occasions like this like when you get destroyed by a move" (Nil to Wall Game PM, 2026-11-01 about 10:05 UTC)',
    rating: null,
  },
  /*
    Squidward dancing, as "bm" (bad manners) after a good move (Nil,
    2026-11-01, to the Wall Game Director: "use this as "bm" after a good
    move"): beside the pawn of the side that made it. The whole clip;
    its track is silent, so the event names its sound.
  */
  "gs-squidward-bm": {
    form: "clip",
    draw: "sequence",
    text: "none",
    seconds: 3.867,
    pawn: true,
    tail: false,
    size: { w: 0.161, h: 0.36 },
    small: { w: 0.134, h: 0.3 },
    places: ["board"],
    sequence: {
      dir: "gs-squidward-bm",
      fps: 30,
      frames: 116,
      sha256:
        "5e644a02302c3c04f1e5e6a2e5037c202c47eb18cdf8964fa7da720ce3262ee0",
    },
    source:
      "Nil's clip, 2026-11-01: squidward twerking.mp4 (SpongeBob SquarePants, Nickelodeon), the whole 3.87 s, keyed; its track is silent",
    claim: "HIGH: a TV cartoon clip (Nickelodeon / Paramount)",
    likeness: "None",
    nilOk: `Nil, for this clip: "use this as "bm" after a good move" (Nil to the Wall Game Director, 2026-11-01)`,
    rating: null,
  },
  "gs-confused-travolta": {
    form: "clip",
    draw: "sequence",
    text: "none",
    // He looks one way, then the other, and opens his hand.
    seconds: 2.467,
    pawn: true,
    tail: false,
    // 316x352: the letterbox cut leaves the screen's soft edge out, which
    // keyed to a thin line down the right side (render vet, 2026-11-01,
    // v-2026-11-01-4 at 14.5 s); the box keeps his old height.
    size: { w: 0.264, h: 0.294 },
    small: { w: 0.211, h: 0.235 },
    places: ["board"],
    sequence: {
      dir: "gs-confused-travolta",
      fps: 30,
      frames: 74,
      sha256:
        "a35e58d652f96f3a4c26bf6783a496926379149e05d5ee68c5f5b08120e63b09",
    },
    source:
      "Nil's meme pack: Green Screen/Green Screen - Orang Bertanya Sendiri!!.mp4 (John Travolta, Pulp Fiction, 1994), letterbox cut inside the screen's soft edge (crop 834:670:222:26), 1.1-3.55 s, silent",
    claim: "HIGH: a film clip (Miramax)",
    likeness: "HIGH: a real actor's face",
    nilOk:
      'Nil, for this clip: "this one when the opponent makes amove that doesn\'t make sense" (Nil, chat to the Wall Game Director, 2026-11-01 02:53 UTC, CASES C43, sending the four clips: "Why don\'t you use the green screen memes i gave you, i just lookned at them and see so many opportunities")',
    rating: null,
  },
  "gs-terio-ooh": {
    form: "clip",
    draw: "sequence",
    text: "none",
    seconds: 2.533,
    pawn: true,
    tail: false,
    size: { w: 0.19, h: 0.41 },
    small: { w: 0.15, h: 0.33 },
    places: ["board"],
    sequence: {
      dir: "gs-terio-ooh",
      fps: 30,
      frames: 76,
      sha256:
        "a7e2d693a75bdf47e4d1614385629c0b8f93f6cc12baaa415b845321febca608",
    },
    source:
      "Nil's meme pack: Green Screen/Fat_Kid_Terio_In_Popeyes_Ooh_GREEN_SCREEN.mp4 (the 2014 \"ooh kill 'em\" Vine), 3.0-5.5 s; the pack's copy has no sound",
    claim: "HIGH: a viral video of a private person",
    likeness: "HIGH: a real child's face",
    nilOk:
      'Nil, for this clip: "this one when you blunder but the opponent doesn\'t realize" (Nil, chat to the Wall Game Director, 2026-11-01 02:53 UTC, CASES C43, sending the four clips: "Why don\'t you use the green screen memes i gave you, i just lookned at them and see so many opportunities")',
    rating: null,
  },
  "gs-crying-man": {
    form: "clip",
    draw: "sequence",
    text: "none",
    seconds: 2.5,
    pawn: true,
    tail: false,
    size: { w: 0.3, h: 0.31 },
    small: { w: 0.24, h: 0.25 },
    places: ["board"],
    sequence: {
      dir: "gs-crying-man",
      fps: 30,
      frames: 75,
      sha256:
        "ba4a9d269bbfa11e0fa0f4c457e49f81ee2df6f6c7e73fc868935b39b7c28d6a",
      audio: true,
    },
    source:
      "Nil's meme pack: Green Screen/crying green screen man.mp4, 5.0-7.5 s (his loudest sobbing), its sobbing kept",
    claim: "HIGH: a viral video of a private person, with its audio",
    likeness: "HIGH: a real person's face",
    nilOk:
      'Nil, for this clip: "thes one when yuo blunder" (Nil, chat to the Wall Game Director, 2026-11-01 02:53 UTC, CASES C43, sending the four clips: "Why don\'t you use the green screen memes i gave you, i just lookned at them and see so many opportunities")',
    rating: null,
  },
};

/** The pawn types an EDL names (shared/domain/pawns.ts PawnType). */
export const PAWN_PIECES = ["cat", "mouse", "home", "elephant", "dog"];

/**
 * An EDL's pawn ("red mouse"): its seat and piece, or null when it is not
 * one.
 * @param {unknown} pawn
 * @returns {{ seat: "red" | "blue", piece: string } | null}
 */
export const parsePawn = (pawn) => {
  const m =
    typeof pawn === "string" ? /^(red|blue) ([a-z]+)$/.exec(pawn) : null;
  return m && PAWN_PIECES.includes(m[2])
    ? { seat: /** @type {"red" | "blue"} */ (m[1]), piece: m[2] }
    : null;
};

/**
 * The places `asset` may take, in order (`places`, board by default).
 * @param {{ places?: ("board" | "margin" | "caption")[] }} asset
 * @returns {("board" | "margin" | "caption")[]}
 */
export const placesOf = (asset) => asset.places ?? ["board"];

/** Whether an EDL must name the seat of `asset` (`seat` in the EDL). */
export const takesSeat = (asset) =>
  PORTRAIT_DRAWS.includes(asset.draw) || asset.seat === true;

/**
 * The risk level of a risk line ("None", or "LOW", "MEDIUM", "HIGH" and
 * why), as its first word.
 * @param {string} risk
 */
export const riskLevel = (risk) => risk.split(/[\s:]/)[0];

/**
 * Whether a daily video may show `asset` only with Nil's OK for it (Wall
 * Game PM's risk rule, 2026-10-30: MEDIUM and HIGH need Nil's explicit OK
 * per image; a preview is never posted and may show it): its claim or
 * likeness is MEDIUM or HIGH and `nilOk` records no OK.
 * @param {{ claim: string, likeness: string, nilOk?: string | null }} asset
 */
export const needsNilOk = (asset) =>
  [asset.claim, asset.likeness].some((r) =>
    ["MEDIUM", "HIGH"].includes(riskLevel(r)),
  ) && !asset.nilOk;

/** Whether an EDL must name the pawn that emotes `asset` (`pawn`). */
export const takesPawn = (asset) => asset.pawn === true;

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
/**
 * A place off the board (placeOverlay), which hides nothing on the board:
 * "caption", the board bar's width and height on the caption's line, or
 * "margin", the left margin at the shape of the asset's size (w by h of
 * the board). The stage measures both in the frame.
 * @typedef {{ where: "caption" | "margin", x: number, w: number, h: number, scale: 1, full: null }} OffPlace
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
 *
 * With `middles`, a clip also has the middle of each edge at each size,
 * after its corners (a picture a pawn emotes, placeNear: Wall Game
 * Director, 2026-10-30, a pawn boxed in a corner has a free place nearer
 * it there).
 * @param {{ form: "clip" | "panel" | "bar" | "cover", size?: { w: number, h: number }, small?: { w: number, h: number } }} asset
 * @param {(scale: number) => Reach} reach
 * @param {{ middles?: boolean }} [options]
 * @returns {Place[]}
 */
export const overlayPlaces = (asset, reach, { middles = false } = {}) => {
  if (asset.form === "cover") return [COVER_PLACE];
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
    // The whole art centred on the edge.
    const midX = (1 - w * (1 + r.left + r.right)) / 2 + r.left * w;
    const midY = (1 - h * (1 + r.top + r.bottom)) / 2 + r.top * h;
    return [
      place("bottom-right", right, bottom),
      place("bottom-left", left, bottom),
      place("top-right", right, top),
      place("top-left", left, top),
      ...(middles
        ? [
            place("bottom-middle", midX, bottom),
            place("top-middle", midX, top),
            place("right-middle", right, midY),
            place("left-middle", left, midY),
          ]
        : []),
    ];
  };
  return [...corners(asset.size), ...(asset.small ? corners(asset.small) : [])];
};

/**
 * The places a picture a pawn emotes may take (overlayPlaces with
 * `middles`), which an EDL may name as its `place` (Wall Game Director,
 * 2026-10-30: the director picks the side when the nearest place tells the
 * story worse). overlays.test.ts checks them against overlayPlaces.
 */
export const PAWN_PLACES = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
  "bottom-middle",
  "top-middle",
  "right-middle",
  "left-middle",
];

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
 * The off-board place `kind` of `asset`: the caption's at the board bar's
 * size (the bar's first place), the margin at the shape of its size.
 * @param {{ form: "clip" | "panel" | "bar" | "cover", size?: { w: number, h: number } }} asset
 * @param {"caption" | "margin"} kind
 * @returns {OffPlace}
 */
export const offBoardPlace = (asset, kind) => {
  if (kind === "caption") {
    const { x, w, h } = overlayPlaces({ form: "bar" }, NO_REACH)[0];
    return { where: "caption", x, w, h, scale: 1, full: null };
  }
  const { w, h } = asset.size;
  return { where: "margin", x: 0, w, h, scale: 1, full: null };
};

/**
 * The first place for `asset`, in the order of its `places`: a board place
 * whose whole art (`full`) overlaps none of the `busy` boxes (in the board
 * as shown, 0..1), or an off-board place that has room (`offRoom(kind)` is
 * null; else it says what stops it). A bar takes the caption's place when
 * no board place is free, and the caption hides while it shows (Wall Game
 * Director, 2026-10-30: the last line replaces the stale caption, and the
 * credit stays under it). Null when no place is free.
 * @param {{ form: "clip" | "panel" | "bar" | "cover", size?: { w: number, h: number }, places?: string[] }} asset
 * @param {{ x0: number, y0: number, x1: number, y1: number }[]} busy
 * @param {(scale: number) => Reach} reach
 * @param {(kind: "caption" | "margin") => string | null} offRoom
 * @returns {Place | OffPlace | null}
 */
export const placeOverlay = (asset, busy, reach, offRoom) => {
  for (const kind of placesOf(asset)) {
    if (kind === "board") {
      const free = overlayPlaces(asset, reach).find(
        (p) => coveredBy(p.full, busy).length === 0,
      );
      if (free) return free;
    } else if (offRoom(kind) === null) {
      return offBoardPlace(asset, kind);
    }
  }
  return null;
};

/** How far a tail stops short of its pawn's centre, in cells: off the pawn and its cell. */
export const TAIL_GAP = 0.62;
/** A tail's width where it leaves its picture, in cells; it narrows to its tip. */
export const TAIL_WIDTH = 0.42;
/** How far a tail starts inside its picture's box, in cells, so it tucks under the art. */
export const TAIL_TUCK = 0.35;

/**
 * The tail of a picture tied to a pawn (`pawn`): on the line from the
 * middle of its art (`full`) to the pawn's centre, from TAIL_TUCK cells
 * inside the art's box (the stage draws it under the picture) to TAIL_GAP
 * cells short of the pawn, in the board (0..1). It starts at the box's
 * edge, not its middle, so it is TAIL_WIDTH wide where it shows (the proof
 * of 2026-10-30: from the middle, a long tail showed as a needle). Null
 * when the pawn is too near for one past the box.
 * @param {{ x: number, y: number, w: number, h: number }} full
 * @param {{ x: number, y: number }} pawn
 * @param {{ x: number, y: number }} pitch a cell's size in the board
 * @returns {{ from: { x: number, y: number }, to: { x: number, y: number } } | null}
 */
export const tailOf = (full, pawn, pitch) => {
  const mid = { x: full.x + full.w / 2, y: full.y + full.h / 2 };
  // In cells, from the middle.
  const dx = (pawn.x - mid.x) / pitch.x;
  const dy = (pawn.y - mid.y) / pitch.y;
  const d = Math.hypot(dx, dy);
  // Where the line leaves the box, as a distance from the middle.
  const exit = Math.min(
    dx === 0 ? Infinity : (full.w / 2 / pitch.x) * (d / Math.abs(dx)),
    dy === 0 ? Infinity : (full.h / 2 / pitch.y) * (d / Math.abs(dy)),
  );
  const start = Math.max(0, exit - TAIL_TUCK);
  const end = d - TAIL_GAP;
  if (end <= exit) return null;
  const at = (k) => ({
    x: mid.x + (dx / d) * k * pitch.x,
    y: mid.y + (dy / d) * k * pitch.y,
  });
  return { from: at(start), to: at(end) };
};

/**
 * A tail as the stage draws it: a wedge TAIL_WIDTH cells wide at its start,
 * to a point at its tip, as three points in the board (0..1).
 * @param {{ from: { x: number, y: number }, to: { x: number, y: number } }} tail
 * @param {{ x: number, y: number }} pitch
 * @returns {[number, number][]}
 */
export const tailPoints = (tail, pitch) => {
  const dx = (tail.to.x - tail.from.x) / pitch.x;
  const dy = (tail.to.y - tail.from.y) / pitch.y;
  const d = Math.hypot(dx, dy);
  const half = TAIL_WIDTH / 2;
  const px = (-dy / d) * half * pitch.x;
  const py = (dx / d) * half * pitch.y;
  return [
    [tail.from.x + px, tail.from.y + py],
    [tail.to.x, tail.to.y],
    [tail.from.x - px, tail.from.y - py],
  ];
};

/**
 * The boxes that the part of `tail` past its art (`full`) overlaps: the
 * tail as discs of its width along it, every 1/32 of its length.
 * @template {{ x0: number, y0: number, x1: number, y1: number }} B
 * @param {{ from: { x: number, y: number }, to: { x: number, y: number } }} tail
 * @param {{ x: number, y: number, w: number, h: number }} full
 * @param {B[]} boxes
 * @param {{ x: number, y: number }} pitch
 * @returns {B[]}
 */
export const tailHits = (tail, full, boxes, pitch) => {
  const hits = new Set();
  const steps = 32;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = tail.from.x + (tail.to.x - tail.from.x) * t;
    const y = tail.from.y + (tail.to.y - tail.from.y) * t;
    if (x > full.x && x < full.x + full.w && y > full.y && y < full.y + full.h)
      continue;
    const half = (TAIL_WIDTH / 2) * (1 - t);
    const disc = {
      x: x - half * pitch.x,
      y: y - half * pitch.y,
      w: 2 * half * pitch.x,
      h: 2 * half * pitch.y,
    };
    for (const b of coveredBy(disc, boxes)) hits.add(b);
  }
  return [...hits];
};

/**
 * How near another pawn's centre a tail's tip may end, in cells: nearer,
 * the tip points at two pawns (VR1 and Wall Game PM, 2026-10-30, review
 * 102 N2: a tip between the red mouse and the blue cat).
 */
export const TIP_CLEAR = 1;

/**
 * Why a place of a picture tied to a pawn cannot take it: what its whole
 * art overlaps of the `busy` boxes, what its tail overlaps, and each other
 * pawn (`others`) whose centre is under TIP_CLEAR cells from the tail's
 * tip. With `crossWalls`, a tail may cross a wall of the move (a busy box
 * with `wall`). Empty when the place is free.
 * @param {Place} p
 * @param {{ from: { x: number, y: number }, to: { x: number, y: number } } | null} tail
 * @param {{ x0: number, y0: number, x1: number, y1: number, what: string, wall?: boolean }[]} busy
 * @param {{ x: number, y: number, what: string }[]} others
 * @param {{ x: number, y: number }} pitch
 * @param {{ crossWalls?: boolean }} [options]
 * @returns {string[]}
 */
export const nearFaults = (
  p,
  tail,
  busy,
  others,
  pitch,
  { crossWalls = false } = {},
) => {
  const under = coveredBy(p.full, busy);
  if (under.length > 0) return [...new Set(under.map((b) => b.what))];
  if (!tail) return [];
  const crossed = tailHits(tail, p.full, busy, pitch).filter(
    (b) => !(crossWalls && b.wall),
  );
  if (crossed.length > 0)
    return [
      `its tail crosses ${[...new Set(crossed.map((b) => b.what))].join(", ")}`,
    ];
  return others
    .filter(
      (o) =>
        Math.hypot((o.x - tail.to.x) / pitch.x, (o.y - tail.to.y) / pitch.y) <
        TIP_CLEAR,
    )
    .map((o) => `its tip is next to the ${o.what}`);
};

/**
 * The length of a tail past its art, in cells; 0 for no tail (the pawn is
 * next to the art).
 * @param {{ from: { x: number, y: number }, to: { x: number, y: number } } | null} tail
 * @param {{ x: number, y: number }} pitch
 */
export const tailLength = (tail, pitch) =>
  tail
    ? Math.max(
        0,
        Math.hypot(
          (tail.to.x - tail.from.x) / pitch.x,
          (tail.to.y - tail.from.y) / pitch.y,
        ) - TAIL_TUCK,
      )
    : 0;

/**
 * Whether a clip tied to a pawn stands next to it (Nil, 2026-11-05, C59:
 * "it's better if the green screen memes appear next to the piece emoting
 * it"): a green-screen clip with no tail. A cage (`around`) has its own place.
 * @param {{ draw?: string, tail?: boolean, around?: unknown }} asset
 */
export const standsBeside = (asset) =>
  asset.draw === "sequence" && asset.tail === false && !asset.around;

/**
 * The places beside a pawn for a clip that stands next to it
 * (standsBeside), at either size: its whole art (`full`) touches the
 * pawn's cell on one side, left or right of it standing on the cell's row,
 * centred on it or hanging from its top, or above or below it, centred or
 * at either end of the cell, slid along that side to stay inside the
 * board. Named "beside-<side>". In no order (placeNear ranks them).
 * @param {{ size: { w: number, h: number }, small?: { w: number, h: number } }} asset
 * @param {(scale: number) => Reach} reach
 * @param {{ x: number, y: number }} pawn its centre in the board
 * @param {{ x: number, y: number }} pitch a cell's size in the board
 * @returns {Place[]}
 */
export const besidePlaces = (asset, reach, pawn, pitch) => {
  const cell = {
    x0: pawn.x - pitch.x / 2,
    y0: pawn.y - pitch.y / 2,
    x1: pawn.x + pitch.x / 2,
    y1: pawn.y + pitch.y / 2,
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const out = [];
  for (const size of [asset.size, ...(asset.small ? [asset.small] : [])]) {
    const { w, h } = size;
    const scale = w / asset.size.w;
    const r = reach(scale);
    const fw = w * (1 + r.left + r.right);
    const fh = h * (1 + r.top + r.bottom);
    const fit = (where, fx, fy) => {
      if (fx < INSET - 1e-9 || fx + fw > 1 - INSET + 1e-9) return;
      if (fy < INSET - 1e-9 || fy + fh > 1 - INSET + 1e-9) return;
      out.push({
        where,
        x: fx + r.left * w,
        y: fy + r.top * h,
        w,
        h,
        scale,
        full: { x: fx, y: fy, w: fw, h: fh },
      });
    };
    const slideY = (fy) => clamp(fy, INSET, 1 - INSET - fh);
    const slideX = (fx) => clamp(fx, INSET, 1 - INSET - fw);
    for (const fy of [cell.y1 - fh, pawn.y - fh / 2, cell.y0]) {
      fit("beside-left", cell.x0 - fw, slideY(fy));
      fit("beside-right", cell.x1, slideY(fy));
    }
    for (const fx of [pawn.x - fw / 2, cell.x0, cell.x1 - fw]) {
      fit("beside-top", slideX(fx), cell.y0 - fh);
      fit("beside-bottom", slideX(fx), cell.y1);
    }
  }
  return out;
};

/**
 * The place of a picture tied to a pawn (`pawn`; Nil, 2026-10-30, C20:
 * "it should be clear who is emoting"): of its board places at either
 * size, corners and edge middles, that nearFaults finds free, the one with
 * the shortest tail, the big size first when two are as short (review 102
 * N2: a small place near the pawn before a big place far from it). A
 * place whose art or tail covers a wall on the board (`walls`, old or new)
 * comes only after every place that covers none (Wall Game Director,
 * 2026-10-30: old walls are the game too; a bottom-middle picture hid
 * red's walls; Director Rewriter, the same day: saturn's tip lay on an
 * old wall).
 * Only
 * when no place has a clear tail, one whose tail crosses walls of the move
 * and nothing else, never a pawn or the hunt; `over` names those walls,
 * and the stage draws them over the tail, so a box stays whole (Wall Game
 * Director, 2026-10-30: a mouse boxed in a corner). With `place` (one of
 * PAWN_PLACES, the EDL's), only that place is tried, at either size, under
 * the same faults; a wall it covers is the director's choice. With its
 * tail (null when the pawn is too near for one), or null when no place is
 * free. `onWall` says that its art or tail covers a wall (every free
 * place did, or the EDL named it). A clip that stands beside its pawn
 * (standsBeside) takes only the places beside it (besidePlaces), nearest
 * first, never a far free place, and no EDL place.
 * @param {{ form: "clip", size: { w: number, h: number }, small?: { w: number, h: number }, tail?: boolean }} asset
 * @param {{ x0: number, y0: number, x1: number, y1: number, what: string, wall?: boolean }[]} busy
 * @param {(scale: number) => Reach} reach
 * @param {{ x: number, y: number }} pawn its centre in the board as shown
 * @param {{ x: number, y: number, what: string }[]} others the centres of the other pawns
 * @param {{ x: number, y: number }} pitch a cell's size in the board
 * @param {{ walls?: { x0: number, y0: number, x1: number, y1: number }[], place?: string }} [options] every wall on the board as shown, and the place the EDL names
 * @returns {(Place & { tail: { from: { x: number, y: number }, to: { x: number, y: number }, points: [number, number][] } | null, over: { x0: number, y0: number, x1: number, y1: number }[], onWall: boolean }) | null}
 */
export const placeNear = (
  asset,
  busy,
  reach,
  pawn,
  others,
  pitch,
  { walls = [], place } = {},
) => {
  const beside = standsBeside(asset);
  const candidates = beside
    ? besidePlaces(asset, reach, pawn, pitch)
    : overlayPlaces(asset, reach, { middles: true }).filter(
        (p) => place === undefined || p.where === place,
      );
  const ranked = candidates
    .map((p) => {
      // With no tail (`tail: false`), the tail it would have still ranks
      // the places by nearness.
      const line = tailOf(p.full, pawn, pitch);
      const tail = asset.tail === false ? null : line;
      return {
        p,
        tail,
        onWall:
          coveredBy(p.full, walls).length > 0 ||
          (tail !== null && tailHits(tail, p.full, walls, pitch).length > 0)
            ? 1
            : 0,
        // Beside: the art's middle nearest the pawn.
        length: beside
          ? Math.hypot(
              (p.full.x + p.full.w / 2 - pawn.x) / pitch.x,
              (p.full.y + p.full.h / 2 - pawn.y) / pitch.y,
            )
          : tailLength(line, pitch),
      };
    })
    .sort(
      (a, b) =>
        a.onWall - b.onWall || a.length - b.length || b.p.scale - a.p.scale,
    );
  for (const crossWalls of [false, true]) {
    for (const { p, tail, onWall } of ranked) {
      if (nearFaults(p, tail, busy, others, pitch, { crossWalls }).length > 0)
        continue;
      // The walls its tail crosses, each once (a box per frame shown).
      const over =
        crossWalls && tail
          ? [
              ...new Map(
                tailHits(tail, p.full, busy, pitch)
                  .filter((b) => b.wall)
                  .map((b) => [
                    [b.x0, b.y0, b.x1, b.y1].join(),
                    { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
                  ]),
              ).values(),
            ]
          : [];
      return {
        ...p,
        tail: tail && { ...tail, points: tailPoints(tail, pitch) },
        over,
        onWall: onWall === 1,
      };
    }
  }
  return null;
};

/**
 * The place of a cage round a pawn (`around`): its window's centre on the
 * pawn's centre, the window `cells` cells wide and high. No tail and no
 * wall under a tail; what its bars hide is measured from its pixels
 * (render-game-video.mjs placeOverlays), not here.
 * @param {{ around: { window: { x0: number, y0: number, x1: number, y1: number }, cells: number } }} asset
 * @param {{ x: number, y: number }} pawn its centre in the board as shown
 * @param {{ x: number, y: number }} pitch a cell's size in the board
 */
export const placeAround = (
  { around: { window: win, cells } },
  pawn,
  pitch,
) => {
  const w = (cells * pitch.x) / (win.x1 - win.x0);
  const h = (cells * pitch.y) / (win.y1 - win.y0);
  const x = pawn.x - ((win.x0 + win.x1) / 2) * w;
  const y = pawn.y - ((win.y0 + win.y1) / 2) * h;
  return {
    where: "around",
    x,
    y,
    w,
    h,
    scale: 1,
    full: { x, y, w, h },
    tail: null,
    over: [],
    onWall: false,
  };
};

/**
 * The loading bar's percent for a hunter `steps` from its target: 99% one
 * step away, one less per step further, never under 96% (the model video's
 * "96%... 98%... 99%").
 * @param {number} steps
 */
export const loadingPercent = (steps) =>
  Math.max(96, Math.min(99, 100 - Math.max(1, steps)));
