/**
 * Where the replay page draws the board, on the captured board image.
 *
 * The page lays the cells out as a CSS grid with a gap BETWEEN cells and
 * none outside them (frontend board.tsx), so the cells do not fill the grid
 * box evenly: from one cell to the next is a pitch of cell + gap, and a wall
 * sits in the middle of a gap. A coordinate u in cells, where an integer is
 * the line between two cells and u + 0.5 is a cell's centre, is at
 * left - gap/2 + u * pitch. The old map, pad + u / cols * span, took the
 * pitch to be grid / cols: right in the middle of the board, a quarter gap
 * off two cells from the edge and half a gap at the rim (Wall Game PM,
 * 2026-10-26: the cold open's glow sat off its wall). The map is now built
 * from the cells the page drew.
 */

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ vertical: boolean, x: number, y: number }} SiteWall
 *   the centre of a wall the page drew, in the board image (0..1)
 */

/**
 * The map from cells to the board image, from the page's first (top left)
 * and last (bottom right) cell and the capture clip, all in css px.
 * @param {{ clip: Rect, first: Rect, last: Rect, cols: number, rows: number }} m
 */
export const boardGrid = ({ clip, first, last, cols, rows }) => {
  if (cols < 2 || rows < 2) throw new Error("a board has at least 2x2 cells");
  const pitchX = (last.x - first.x) / (cols - 1);
  const pitchY = (last.y - first.y) / (rows - 1);
  const gapX = pitchX - first.width;
  const gapY = pitchY - first.height;
  if (!(gapX >= 0 && gapY >= 0)) {
    throw new Error(
      `the page's cells overlap (pitch ${pitchX}x${pitchY}, cell ${first.width}x${first.height})`,
    );
  }
  return {
    cols,
    rows,
    /** Cell column u (0..cols) as a fraction of the image width. */
    x: (u) => (first.x - clip.x - gapX / 2 + u * pitchX) / clip.width,
    /** Cell row v (0..rows, 0 at the top) as a fraction of the image height. */
    y: (v) => (first.y - clip.y - gapY / 2 + v * pitchY) / clip.height,
    /** One cell plus one gap, as fractions of the image. */
    pitchX: pitchX / clip.width,
    pitchY: pitchY / clip.height,
  };
};

/**
 * Whether a highlight line ([x1, y1, x2, y2], 0..1) lies on a wall the page
 * drew: a wall of the same direction whose centre is within `tolerance` of
 * the line's centre on each axis.
 * @param {[number, number, number, number]} line
 * @param {SiteWall[]} walls
 * @param {{ x: number, y: number }} tolerance
 */
export const onSiteWall = ([x1, y1, x2, y2], walls, tolerance) => {
  const vertical = Math.abs(x2 - x1) < Math.abs(y2 - y1);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  return walls.some(
    (w) =>
      w.vertical === vertical &&
      Math.abs(w.x - cx) <= tolerance.x &&
      Math.abs(w.y - cy) <= tolerance.y,
  );
};
