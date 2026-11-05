/**
 * Convert timed timeline items to exact cumulative CFR frame ranges. With
 * `sample`, a draft at a lower rate than the timeline was made for: an item
 * that gets no frame is left out (it is never shot), not an error.
 */
export function allocateFrameRanges(timeline, fps, { sample = false } = {}) {
  const ranges = [];
  let endFrame = 0;
  let seconds = 0;
  for (const [timelineIndex, item] of timeline.entries()) {
    seconds += item.seconds;
    const targetEndFrame = Math.round(seconds * fps);
    if (targetEndFrame <= endFrame) {
      if (sample) continue;
      throw new Error(`timeline item ${timelineIndex} has zero frames`);
    }
    ranges.push({
      timelineIndex,
      kind: item.kind,
      ply: item.ply,
      startFrame: endFrame,
      endFrame: targetEndFrame,
      source: item.file,
    });
    endFrame = targetEndFrame;
  }
  return ranges;
}

/**
 * How long a ply rests after its EDL events: until its pace is used up,
 * counted from the move's landing, and never less than `minRest` (the
 * effects' own rest). An event that runs past the pace (an explain, a
 * mark) keeps its own time and gets only `minRest`. v-2026-10-30-10's
 * ply 12 held 0.6 s of its 1.6 s, because its only event was a sound and
 * the rest ignored the pace (its vet, 2026-10-30).
 * @param {{ landedAt: number, pace: number, now: number, minRest: number }} t seconds
 */
export function restAfterEvents({ landedAt, pace, now, minRest }) {
  return Math.max(minRest, landedAt + pace - now);
}

/**
 * RESULT.timeline: when each move, EDL event and sound happens in the
 * output MP4, in seconds from its first frame, to 0.01 s. The daily app
 * copies it into the render record and builds the event strips on it.
 *
 * A move and an event start on a frame, so their seconds are snapped to the
 * frame allocateFrameRanges gives them: round(seconds * fps). A sound starts
 * at its exact second in the mix, so it is only rounded.
 *
 * - moves: [{ ply, at }]: `at` is the first frame that shows the position
 *   after the move. The board does not slide, so a move has one time.
 * - events: [{ index, ply, kind, start, end }]: `index` is the event's place
 *   in edl.events; `end` is the first frame after it (a "sound" event has
 *   no frames, so its end is its start). A freeze and a lead zoom start
 *   before their move's `at`.
 * - sounds: [{ name, role, start, event }], in time order: every cue the mix
 *   holds. `name` is the sound's own name ("pawn", "wall", "seeya-3",
 *   "vs-b-riser", a music slug); `role` is "move", "cold-open" (the click
 *   of the cold open's move, which is not in `moves`), "event", "vs",
 *   "finish", "shake", "win" or "music"; `event` is the edl.events index of
 *   an "event" sound, else null.
 *
 * @param {{
 *   moves: { ply: number, at: number }[],
 *   events: { index: number, ply: number, kind: string, start: number, end: number }[],
 *   sounds: { name: string, role: string, start: number, event: number | null }[],
 *   fps: number,
 * }} input
 */
export function videoTimeline({ moves, events, sounds, fps }) {
  const onFrame = (t) => Number((Math.round(t * fps) / fps).toFixed(2));
  return {
    moves: moves.map(({ ply, at }) => ({ ply, at: onFrame(at) })),
    events: [...events]
      .sort((a, b) => a.index - b.index)
      .map(({ index, ply, kind, start, end }) => ({
        index,
        ply,
        kind,
        start: onFrame(start),
        end: onFrame(end),
      })),
    sounds: [...sounds]
      .sort((a, b) => a.start - b.start)
      .map(({ name, role, start, event }) => ({
        name,
        role,
        start: Number(start.toFixed(2)),
        event,
      })),
  };
}
