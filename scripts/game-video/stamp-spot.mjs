/**
 * Where a stamp word goes on the board (Wall Game PM audit item 4: "NOPE"
 * covered both cats it was about). Of three bands - the top, the middle and
 * the bottom of the board - the word takes the one where its box covers the
 * least of what the move is about; on a tie, the band farther from the
 * move's cell wins, and then the earlier band.
 *
 * Every box is [x0, y0, x1, y1] on the board image (0..1).
 *   size      {w, h}: the word's box at rest, measured (stage.html
 *             __stampBox), as a share of the board
 *   pad       the board image's margin around the grid (0..1)
 *   avoid     the boxes the word should not hide: the pawns the page drew
 *             (their measured boxes), the move's cell and walls
 *   cellArea  the area of one cell, so `covered` reads in cells
 *   focus     {x, y}: the centre of the move's cell, or null
 *
 * Returns { at: the word's centre {x, y}, band, covered: the area it hides,
 * in cells }.
 */
export const stampSpot = ({ size, pad, avoid, cellArea, focus }) => {
  const overlap = (a, b) =>
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  let best = null;
  for (const [band, y] of [
    ["top", pad + size.h / 2],
    ["middle", 0.5],
    ["bottom", 1 - pad - size.h / 2],
  ]) {
    const box = [
      0.5 - size.w / 2,
      y - size.h / 2,
      0.5 + size.w / 2,
      y + size.h / 2,
    ];
    const covered =
      avoid.reduce((sum, b) => sum + overlap(box, b), 0) / cellArea;
    const away = focus ? Math.abs(focus.y - y) : 0;
    if (
      !best ||
      covered < best.covered - 1e-9 ||
      (Math.abs(covered - best.covered) <= 1e-9 && away > best.away + 1e-9)
    ) {
      best = { at: { x: 0.5, y }, band, covered, away };
    }
  }
  return { at: best.at, band: best.band, covered: best.covered };
};
