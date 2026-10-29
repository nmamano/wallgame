/**
 * Where a stamp word goes on the board (Wall Game PM audit item 4: "NOPE"
 * covered both cats it was about). Of three bands - the top, the middle and
 * the bottom of the board - the word takes the one where its box covers the
 * least of what the move is about; on a tie, the band where it slams in
 * from the largest size (Wall Game Director, 2026-10-29: a flat slam is a
 * weak beat), then the band farther from the move's cell, and then the
 * earlier band.
 *
 * The word slams in from `punchFrom` times its size down to it, grown
 * about its centre. Its `pop` is the largest size, from 1 to punchFrom, at
 * which it covers nothing it does not cover at rest; the stage starts the
 * slam there (Wall Game Director, 2026-10-29: "WALLED" on 8FroT1GU ply 12
 * covered a third of the red mouse for two frames as it popped).
 *
 * Every box is [x0, y0, x1, y1] on the board image (0..1).
 *   size      {w, h}: the word's box at rest, measured (stage.html
 *             __stampBox), as a share of the board
 *   pad       the board image's margin around the grid (0..1)
 *   avoid     the boxes the word should not hide: the pawns the page drew
 *             (their measured boxes), the move's cell and walls
 *   cellArea  the area of one cell, so `covered` reads in cells
 *   focus     {x, y}: the centre of the move's cell, or null
 *   punchFrom how big the slam starts (stage.html punch at its start)
 *
 * Returns { at: the word's centre {x, y}, band, covered: the area it hides,
 * in cells, pop }.
 */
export const stampSpot = ({ size, pad, avoid, cellArea, focus, punchFrom }) => {
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
    // The word, grown by s about its centre, reaches box b once s passes
    // both of its distances to b over its half sizes; a box it covers at
    // rest sets no limit.
    const reach = ([x0, y0, x1, y1]) => {
      const dx = Math.max(x0 - 0.5, 0.5 - x1, 0);
      const dy = Math.max(y0 - y, y - y1, 0);
      const s = Math.max(dx / (size.w / 2), dy / (size.h / 2));
      return s >= 1 ? s : Infinity;
    };
    const pop = Math.min(punchFrom, ...avoid.map(reach));
    const away = focus ? Math.abs(focus.y - y) : 0;
    const same = (a, b) => Math.abs(a - b) <= 1e-9;
    if (
      !best ||
      covered < best.covered - 1e-9 ||
      (same(covered, best.covered) &&
        (pop > best.pop + 1e-9 ||
          (same(pop, best.pop) && away > best.away + 1e-9)))
    ) {
      best = { at: { x: 0.5, y }, band, covered, pop, away };
    }
  }
  return {
    at: best.at,
    band: best.band,
    covered: best.covered,
    pop: best.pop,
  };
};
