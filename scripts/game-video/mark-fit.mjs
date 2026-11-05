/**
 * Whether a mark or an opening name fits where the renderer puts it: the
 * pure measures behind the render's stops and lint lines (name-covers-pawn,
 * mark-cut), apart from the stage so they can be tested (Wall Game PM,
 * 2026-11-05, on review 151: a false hit of name-covers-pawn stops every
 * daily video).
 *
 * Boxes are fractions of the board image: a measured box is {x, y, w, h},
 * a pawn or wall box is {x0, y0, x1, y1}. `pitchX` and `pitchY` are one
 * cell's pitch in the same units.
 */

/** Under a hundredth of a cell into another box, a box only touches it. */
export const TOUCH_CELLS = 0.01;

/**
 * How far past the board's edge a mark may reach, as a part of the board,
 * before it reads as cut (a hair of anti-aliasing is not a cut).
 */
export const EDGE_CUT = 0.002;

/**
 * How far box `b` goes into box `k`, in cells: the lesser of its two
 * overlaps, 0 or less when they are apart.
 * @param {{ x: number, y: number, w: number, h: number }} b
 * @param {{ x0: number, y0: number, x1: number, y1: number }} k
 * @param {number} pitchX
 * @param {number} pitchY
 */
export const depthInto = (b, k, pitchX, pitchY) =>
  Math.min(
    (Math.min(b.x + b.w, k.x1) - Math.max(b.x, k.x0)) / pitchX,
    (Math.min(b.y + b.h, k.y1) - Math.max(b.y, k.y0)) / pitchY,
  );

/**
 * Whether a measured box runs off the board's square (0..1 on each axis)
 * by more than EDGE_CUT.
 * @param {{ x: number, y: number, w: number, h: number }} box
 */
export const cutByEdge = (box) =>
  box.x < -EDGE_CUT ||
  box.y < -EDGE_CUT ||
  box.x + box.w > 1 + EDGE_CUT ||
  box.y + box.h > 1 + EDGE_CUT;

/**
 * The box of an opening name's letters at its rest size: `letterWidth`
 * (a letter's width over its height) times `size` per letter, centred on
 * x; from a letter's height over the baseline y to 0.2 of it under it.
 * @param {{ text: string, x: number, y: number, size: number }} paint
 * @param {number} letterWidth
 */
export const nameBox = (paint, letterWidth) => {
  const half = (letterWidth * paint.size * paint.text.length) / 2;
  return {
    x: paint.x - half,
    y: paint.y - paint.size,
    w: 2 * half,
    h: paint.size * 1.2,
  };
};

/**
 * The first pawn whose box the name's letters go into by more than
 * TOUCH_CELLS, or undefined. Pawns are {x, y, w, h} with (x, y) the centre,
 * as the page drew them.
 * @template {{ x: number, y: number, w: number, h: number }} P
 * @param {{ text: string, x: number, y: number, size: number }} paint
 * @param {P[]} pawns
 * @param {{ letterWidth: number, pitchX: number, pitchY: number }} grid
 * @returns {P | undefined}
 */
export const pawnUnderName = (paint, pawns, grid) => {
  const box = nameBox(paint, grid.letterWidth);
  return pawns.find(
    (p) =>
      depthInto(
        box,
        {
          x0: p.x - p.w / 2,
          y0: p.y - p.h / 2,
          x1: p.x + p.w / 2,
          y1: p.y + p.h / 2,
        },
        grid.pitchX,
        grid.pitchY,
      ) > TOUCH_CELLS,
  );
};
