/**
 * The shoot pass's pure parts (Wall Game Director, 2026-10-26: renders were
 * one frame at a time). The renderer composes every image first and records
 * its state; then N Chromium processes, one per part, take the screenshots.
 * N pages in ONE browser do not run faster (measured on the 4090: 1 page
 * 7.4 fps, 8 pages 9.1 fps), because one browser draws its pages in turn; N
 * browsers scale almost linearly (4: 28.9 fps, 8: 56.7 fps).
 */

/**
 * Split `count` images into at most `workers` contiguous parts of nearly
 * equal size, as [from, to) pairs in order. Contiguous, so each worker
 * meets a board image in the same order as a serial run.
 *
 * A part starts only where `canStartAt(i)` holds: at a rest image, with no
 * effect on screen. Chromium's compositor keeps history across frames (an
 * element whose transform has been animating can get its own layer, and its
 * text is then smoothed differently), so a worker that started inside an
 * effect drew 8 frames of a "scared" bubble differently from a serial run
 * (2026-10-26, 845 images, split at image 423). Each boundary moves forward
 * to the next image where a part may start; parts that would be empty are
 * dropped.
 *
 * @param {number} count
 * @param {number} workers
 * @param {(i: number) => boolean} [canStartAt]
 * @returns {[number, number][]}
 */
export function partsOf(count, workers, canStartAt = () => true) {
  const n = Math.max(1, Math.min(workers, count));
  const starts = [0];
  for (let w = 1; w < n; w += 1) {
    let i = Math.max(Math.round((w * count) / n), starts.at(-1) + 1);
    while (i < count && !canStartAt(i)) i += 1;
    if (i < count) starts.push(i);
  }
  return starts.map((from, w) => [from, starts[w + 1] ?? count]);
}

/**
 * Every file:// URL in a stage state, at any depth, without repeats. A worker
 * loads them all before its first screenshot: the stage sets an image's src
 * and does not wait for it, and a fresh browser has none of them yet.
 *
 * @param {unknown[]} states
 * @returns {string[]}
 */
export function fileUrlsIn(states) {
  const urls = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      if (v.startsWith("file://")) urls.add(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  states.forEach(walk);
  return [...urls];
}

/**
 * Whether an image may start a part: a plain position, with no effect on
 * screen. Two facts must agree. The renderer labels an image "move" only
 * for a position held between effects; and its state must be exactly
 * `plainState`, the plain state of its board (playState with nothing added),
 * so no effect field (zoom, freeze, beat, stamp, trap, race flash, cell
 * effect, VS overlay, ending, rewind, or any later one) is on it. The label
 * alone is not enough because nothing else checks it; the state alone is not
 * enough because a stamp's first frames, before its word lands, have the
 * plain state but are part of the stamp.
 *
 * @param {{ kind: string | undefined, state: unknown }} shot
 * @param {unknown} plainState
 */
export function isRestShot({ kind, state }, plainState) {
  return (
    kind === "move" && JSON.stringify(state) === JSON.stringify(plainState)
  );
}
