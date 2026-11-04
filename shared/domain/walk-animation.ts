/**
 * How a hunter's walk is drawn and animated: the one source for the game
 * board (frontend board.tsx) and the game videos (scripts/game-video), so
 * the two cannot drift (Nil, 2026-11-04: "it was supposed to be the same
 * animation as in the videos").
 *
 * A walk is a dotted trail in its player's colour, from the hunter to its
 * target. It draws itself from the hunter, a step at a time; once whole, a
 * disc beside the target shows its steps. At the start of a game both
 * walks play in turn (the opening walks), then fade.
 *
 * Places are fractions of the board: x of its width, y of its height (0..1
 * each). Lengths along a walk and sizes are in board units, 1000 a board,
 * as the video's walk layer draws them in a 1000x1000 box stretched over
 * the board: on a board that is not square, a unit across and a unit down
 * differ, on the site as in the video. A cell's size (`cell`) is the cell
 * pitch across, as a fraction of the board's width.
 */

/** A place on the board, as fractions of its width and height. */
export interface WalkPoint {
  x: number;
  y: number;
}

/** A pawn as drawn: its centre and its size, as fractions of the board. */
export interface WalkPawnBox extends WalkPoint {
  w: number;
  h: number;
}

/** A walk drawn up to `drawn` (0..1) of its length. */
export interface WalkLine {
  /** The centres of its cells, the hunter's first and the target's last. */
  points: readonly WalkPoint[];
  /** The centres of the cells on the walk where another pawn stands. */
  holes?: readonly WalkPoint[];
  /**
   * A walk from before a move, stopped by the move's wall: it ends short
   * of the wall, on no pawn, and shows no number.
   */
  cut?: boolean;
  drawn: number;
}

/** Board units in a board, across. */
export const WALK_BOARD_UNITS = 1000;

/** The gap between two dots of a walk, in board units. */
export const WALK_DOT_GAP = 52;
/** A dot's radius in the player's colour, in board units. */
export const WALK_DOT_RADIUS = 13.5;
/** The dark rim under each dot: a disc of this radius, in board units. */
export const WALK_DOT_RIM_RADIUS = 20;
/** The colour of the dots' rim and the number disc's ring. */
export const WALK_RIM_COLOR = "#0b0f1c";
/** The number's disc: its radius in cells. */
export const WALK_DISC_RADIUS_CELLS = 0.3;
/** The number's disc: its dark ring's width, in board units. */
export const WALK_DISC_RING = 8;

/**
 * A walk draws from the hunter in walkDrawSeconds: WALK_STEP_SECONDS a
 * step, at least WALK_DRAW_MIN_SECONDS, at most WALK_DRAW_MAX_SECONDS, so
 * the steps can be counted (Wall Game Director, 2026-10-29). It fades out
 * in WALK_FADE_SECONDS.
 */
export const WALK_STEP_SECONDS = 0.06;
export const WALK_DRAW_MIN_SECONDS = 0.45;
export const WALK_DRAW_MAX_SECONDS = 0.9;
export const WALK_FADE_SECONDS = 0.3;

/**
 * The opening walks: the next one starts WALK_INTRO_GAP_SECONDS after the
 * one before has drawn its last step, while that one shows its number; the
 * last one shows its number WALK_INTRO_HOLD_SECONDS, its fade included
 * (Wall Game Director, 2026-10-29: the hold was 0.6 s, too short to take
 * the number in).
 */
export const WALK_INTRO_GAP_SECONDS = 0.5;
export const WALK_INTRO_HOLD_SECONDS = 1;

/** How long a walk (its cells, the hunter's first) takes to draw. */
export const walkDrawSeconds = (points: readonly unknown[]): number =>
  Math.min(
    WALK_DRAW_MAX_SECONDS,
    Math.max(WALK_DRAW_MIN_SECONDS, (points.length - 1) * WALK_STEP_SECONDS),
  );

/** When one opening walk plays, in seconds from the first one's start. */
export interface WalkTiming {
  start: number;
  /** How long it takes to draw (walkDrawSeconds). */
  draw: number;
  /** When its fade starts. */
  fadeAt: number;
}

/**
 * When each opening walk plays, in the order given (the first mover's
 * first): it draws in walkDrawSeconds; the next starts
 * WALK_INTRO_GAP_SECONDS after it, and it fades as the next one has drawn,
 * so its number shows the whole time; the last shows
 * WALK_INTRO_HOLD_SECONDS, its fade included.
 */
export const introWalkPlan = (
  walks: readonly { points: readonly unknown[] }[],
): WalkTiming[] => {
  let at = 0;
  const plan = walks.map((w) => {
    const timing = { start: at, draw: walkDrawSeconds(w.points), fadeAt: 0 };
    at = timing.start + timing.draw + WALK_INTRO_GAP_SECONDS;
    return timing;
  });
  plan.forEach((timing, k) => {
    const next = plan[k + 1];
    timing.fadeAt = next
      ? next.start + next.draw
      : timing.start +
        timing.draw +
        WALK_INTRO_HOLD_SECONDS -
        WALK_FADE_SECONDS;
  });
  return plan;
};

/** When the opening walks are over: the last one has faded. */
export const introWalkSeconds = (plan: readonly WalkTiming[]): number =>
  plan.length === 0
    ? 0
    : Math.max(...plan.map((p) => p.fadeAt)) + WALK_FADE_SECONDS;

const span01 = (v: number) => Math.max(0, Math.min(1, v));

/** How much of a walk is drawn `t` seconds into the opening (0..1). */
export const walkDrawnAt = (timing: WalkTiming, t: number): number =>
  t < timing.start ? 0 : span01((t - timing.start) / timing.draw);

/** A walk's opacity `t` seconds into the opening (0..1). */
export const walkAlphaAt = (timing: WalkTiming, t: number): number =>
  1 - span01((t - timing.fadeAt) / WALK_FADE_SECONDS);

/**
 * The part of a walk drawn so far, `drawn` (0..1) of its length from the
 * hunter, as a polyline: the hunter's centre, each whole step's end, and
 * the point the drawing has reached. Its i-th segment lies on the walk's
 * i-th step. The video's wall check reads the same polyline as the dots.
 */
export const walkDrawnPolyline = (
  points: readonly WalkPoint[],
  drawn: number,
): WalkPoint[] => {
  if (points.length === 0) return [];
  const seg = points.slice(1).map((q, i) => {
    const a = points[i];
    return Math.hypot(q.x - a.x, q.y - a.y);
  });
  let left = seg.reduce((x, y) => x + y, 0) * Math.min(1, drawn);
  const pts: WalkPoint[] = [points[0]];
  for (let i = 0; i < seg.length && left > 0; i++) {
    const a = points[i];
    const q = points[i + 1];
    const f = Math.min(1, left / seg[i]);
    pts.push({ x: a.x + (q.x - a.x) * f, y: a.y + (q.y - a.y) * f });
    left -= seg[i];
  }
  return pts;
};

/**
 * The dots of a walk drawn up to `line.drawn` of its length: a dot every
 * WALK_DOT_GAP from the hunter, as a dash of 0 with round caps drew them,
 * and none on a cell where a pawn stands (the hunter's, the target's and
 * the holes, `cell` wide), so the walk starts and ends at their edges
 * (Nil, 2026-10-28: overlays never cover the pawns). `cell` is a cell's
 * size, as a fraction of the board.
 */
export const walkDots = (line: WalkLine, cell: number): WalkPoint[] => {
  const { points } = line;
  if (line.drawn <= 0 || points.length === 0) return [];
  const pts = walkDrawnPolyline(points, line.drawn);
  const holes = [
    points[0],
    ...(line.cut ? [] : [points[points.length - 1]]),
    ...(line.holes ?? []),
  ];
  const dots: WalkPoint[] = [];
  let next = 0;
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const q = pts[i];
    const len = Math.hypot(
      (q.x - a.x) * WALK_BOARD_UNITS,
      (q.y - a.y) * WALK_BOARD_UNITS,
    );
    for (; next <= run + len + 1e-6; next += WALK_DOT_GAP) {
      const f = len > 0 ? (next - run) / len : 0;
      const dot = { x: a.x + (q.x - a.x) * f, y: a.y + (q.y - a.y) * f };
      const onPawn = holes.some(
        (h) =>
          Math.abs(dot.x - h.x) < cell / 2 && Math.abs(dot.y - h.y) < cell / 2,
      );
      if (!onPawn) dots.push(dot);
    }
    run += len;
  }
  return dots;
};

/** Where a walk's number goes, and whether it found a clear place. */
export interface WalkDisc {
  at: WalkPoint;
  /** Its radius, in board units. */
  radius: number;
  /**
   * False when no side of the target was free (on the board, off the walk
   * and off every pawn): the video's lint calls it walk-number-crowded.
   */
  clear: boolean;
}

/**
 * Where a whole walk shows its steps: a disc beside the target, across the
 * walk's last step (towards the board's middle first), or else ahead of
 * it, on the first side that is on the board, off the walk and off every
 * pawn, so the disc covers neither the target nor the walk. `pawns` is
 * every pawn the board shows, as drawn. Null while the walk draws, and for
 * a cut walk (the walk it counted is gone).
 */
export const walkDisc = (
  line: WalkLine,
  cell: number,
  pawns: readonly WalkPawnBox[],
): WalkDisc | null => {
  const { points } = line;
  if (line.drawn < 1 || line.cut || points.length === 0) return null;
  const tip = points[points.length - 1];
  const prev = points[points.length - 2] ?? tip;
  const vertical = Math.abs(tip.y - prev.y) > Math.abs(tip.x - prev.x);
  const toMid = (v: number) => (v < 0.5 ? 1 : -1);
  const ahead = { x: Math.sign(tip.x - prev.x), y: Math.sign(tip.y - prev.y) };
  const sides = (
    vertical
      ? [
          { x: toMid(tip.x), y: 0 },
          { x: -toMid(tip.x), y: 0 },
        ]
      : [
          { x: 0, y: toMid(tip.y) },
          { x: 0, y: -toMid(tip.y) },
        ]
  ).concat([ahead]);
  const away = (c: WalkPoint) => (q: WalkPoint) =>
    Math.hypot(q.x - c.x, q.y - c.y) > 0.3 * cell;
  const cellOf = (d: WalkPoint) => ({
    x: tip.x + d.x * cell,
    y: tip.y + d.y * cell,
  });
  const noPawn = (d: WalkPoint) => pawns.every(away(cellOf(d)));
  const free = (d: WalkPoint) => {
    const c = cellOf(d);
    return (
      c.x > 0 &&
      c.x < 1 &&
      c.y > 0 &&
      c.y < 1 &&
      points.every(away(c)) &&
      noPawn(d)
    );
  };
  const freeSide = sides.find(free);
  const side = freeSide ?? sides.find(noPawn) ?? sides[0];
  // Clear of the walk's own target too: its pawn as drawn, plus the disc
  // and its ring (render vet, 2026-10-30: at a fixed 0.55 cell, the ring
  // cut the feet of the mouse below it by 7-8 px).
  const target = pawns.find((q) => !away(tip)(q));
  // The disc's outer edge: its radius and half its ring.
  const rim =
    WALK_DISC_RADIUS_CELLS * cell + WALK_DISC_RING / 2 / WALK_BOARD_UNITS;
  const reach = target
    ? (side.x !== 0 ? target.w : target.h) / 2 + rim + 0.03 * cell
    : 0;
  const out = Math.max(0.55 * cell, reach);
  // Whole on the board, even on a side that faces its edge.
  const inside = (v: number) => Math.min(1 - rim, Math.max(rim, v));
  return {
    at: { x: inside(tip.x + out * side.x), y: inside(tip.y + out * side.y) },
    radius: WALK_DISC_RADIUS_CELLS * cell * WALK_BOARD_UNITS,
    clear: freeSide !== undefined,
  };
};
