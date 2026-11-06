/**
 * The moment a revision changed, as a clip for Nil's review ask (Nil,
 * 2026-11-01, CASES C54: "if i ask you for a revision on a specific change
 * ... you can show me only the relevant snippet for the revision. your
 * goal is to give me only what i need for each decision").
 *
 * The Director names what changed when it directs the list after Nil's
 * Revise (crew.mjs direct --changed --what), and the render's own timeline
 * (render-game-video.mjs: each ply's move and each event's span, in
 * seconds) gives where that is in the video. The full video stays the
 * item's: posting, the vet and the Director's tools read it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";

/** Seconds before the first changed beat, so its move reads. */
export const CLIP_LEAD_IN = 2;

/** The longest `--what` line: one line of an ask. */
export const CHANGED_WHAT_MAX = 200;

/**
 * What a revision changed: "all" (the whole video), or plies (each with
 * all its beats), beats (one ply's events by name: an asset, a kind or a
 * sound, such as "20:resign-flag"), and the end card.
 * @typedef {{ plies: "all" } | { plies: number[], beats: { ply: number, name: string }[], end: boolean }} ChangedScope
 * @typedef {ChangedScope & { what: string }} Changed
 * @typedef {{ ply: number, kind?: string, form?: string, asset?: string, sound?: string }} ListEvent
 */

/**
 * `--changed` as the Director writes it: "all", or with commas plies
 * ("20"), beats ("20:resign-flag") and "end". Throws on anything else.
 * @param {string} text
 * @returns {ChangedScope}
 */
export const parseChanged = (text) => {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 1 && parts[0] === "all") return { plies: "all" };
  if (parts.length === 0) throw new Error("--changed names nothing");
  /** @type {number[]} */
  const plies = [];
  /** @type {{ ply: number, name: string }[]} */
  const beats = [];
  let end = false;
  for (const p of parts) {
    const beat = /^(\d+):([a-z0-9-]+)$/.exec(p);
    if (p === "end") end = true;
    else if (/^\d+$/.test(p)) plies.push(Number(p));
    else if (beat) beats.push({ ply: Number(beat[1]), name: beat[2] });
    else {
      throw new Error(
        `--changed: "${p}" is not a ply ("20"), a beat ("20:resign-flag"), "end" or "all" (alone)`,
      );
    }
  }
  return { plies: [...new Set(plies)].sort((a, b) => a - b), beats, end };
};

/** Whether the list's event is the beat's: its asset, kind or sound. */
const isBeat = (
  /** @type {ListEvent} */ e,
  /** @type {{ ply: number, name: string }} */ b,
) => e.ply === b.ply && [e.asset, e.kind, e.sound].includes(b.name);

/**
 * Why `changed` cannot go with this list, or null: plies of the game, each
 * beat an event of the list on its ply, and one line of what.
 * @param {any} changed
 * @param {number} lastPly the game's last ply
 * @param {ListEvent[]} events the list's events
 */
export const changedProblem = (changed, lastPly, events) => {
  if (!changed || typeof changed !== "object") return "changed is missing";
  const what = changed.what;
  if (typeof what !== "string" || !what.trim() || what.includes("\n")) {
    return "changed needs `what`: one line that says what changed";
  }
  if (what.length > CHANGED_WHAT_MAX) {
    return `changed.what is ${what.length} characters; at most ${CHANGED_WHAT_MAX}`;
  }
  if (changed.plies === "all") return null;
  if (
    !Array.isArray(changed.plies) ||
    !Array.isArray(changed.beats) ||
    typeof changed.end !== "boolean"
  ) {
    return 'changed.plies is "all", or plies, beats and end';
  }
  if (!changed.plies.length && !changed.beats.length && !changed.end) {
    return "changed names no ply, no beat and not the end";
  }
  const bad = [...changed.plies, ...changed.beats.map((b) => b.ply)].filter(
    (p) => !Number.isInteger(p) || p < 0 || p > lastPly,
  );
  if (bad.length) {
    return `changed names ${bad.join(", ")}: the game's plies are 0 to ${lastPly}`;
  }
  const missing = changed.beats.filter(
    (b) => !events.some((e) => isBeat(e, b)),
  );
  if (missing.length) {
    return `the list has no ${missing.map((b) => `${b.name} on ply ${b.ply}`).join(", ")} (a beat is an asset, kind or sound of an event on its ply)`;
  }
  return null;
};

/**
 * The span of the video that shows the change, in seconds of the full
 * video, or null for the whole video: "all", a clip that would start in
 * the intro, or one longer than half the video. It starts CLIP_LEAD_IN before the earliest
 * changed beat and ends with the last one. A ply is its move and all its
 * events (an explain's build-up comes before its move), and ends with
 * them, or at the next move when it has none; a beat is its own events
 * only. The end card (from the ending's bar), or a changed last ply,
 * runs to the video's end.
 * @param {{ moves: { ply: number, at: number }[], events: { index: number, ply: number, start: number, end: number }[] }} timeline
 * @param {ChangedScope} changed
 * @param {number} duration the video's seconds
 * @param {ListEvent[]} events the list's events (timeline events index it)
 * @returns {{ from: number, to: number } | null}
 */
export const changedSpan = (timeline, changed, duration, events) => {
  if (changed.plies === "all") return null;
  const lastPly = Math.max(...timeline.moves.map((m) => m.ply));
  const starts = [];
  const ends = [];
  for (const ply of changed.plies) {
    const move = timeline.moves.find((m) => m.ply === ply);
    const spans = timeline.events.filter((e) => e.ply === ply);
    if (move) starts.push(move.at);
    for (const e of spans) starts.push(e.start);
    if (ply === lastPly) ends.push(duration);
    else if (spans.length) ends.push(Math.max(...spans.map((e) => e.end)));
    else {
      const next = timeline.moves.find((m) => m.ply > ply);
      ends.push(next ? next.at : duration);
    }
  }
  for (const beat of changed.beats) {
    for (const e of timeline.events) {
      if (events[e.index] && isBeat(events[e.index], beat)) {
        starts.push(e.start);
        ends.push(e.end);
      }
    }
  }
  if (changed.end) {
    // The end card (Wall Game Director, 2026-11-01: the GG card and the
    // last line, not the last move's beats): from the ending's bar, which
    // the card opens with; with no bar, from the end of the last ply's
    // beats, or from its move when it has none.
    const lastSpans = timeline.events.filter((e) => e.ply === lastPly);
    const bar = lastSpans.find((e) => events[e.index]?.form === "bar");
    const last = timeline.moves.find((m) => m.ply === lastPly);
    starts.push(
      bar
        ? bar.start
        : lastSpans.length
          ? Math.max(...lastSpans.map((e) => e.end))
          : (last?.at ?? duration),
    );
    ends.push(duration);
  }
  if (!starts.length) return null;
  // To a tenth of a second, outward, so no frame of the change is lost.
  const span = {
    from: Math.floor(Math.max(0, Math.min(...starts) - CLIP_LEAD_IN) * 10) / 10,
    to: Math.ceil(Math.min(duration, Math.max(...ends)) * 10) / 10,
  };
  /*
    The whole video, not a clip, when the clip would start in the intro
    (before ply 0's move lands) or run over half the video (Nil, 2026-11-06,
    on BIn's clip of 0.4-29.7 s of 44.7 s: "what you sent is not a full
    video. start is missing and end is missing"; Wall Game Director's rule).
    A clip that cut the intro or most of the video reads as a broken video.
  */
  const firstMove = timeline.moves.find((m) => m.ply === 0);
  if (firstMove && span.from < firstMove.at) return null;
  if (span.to - span.from > duration / 2) return null;
  return span;
};

/**
 * What changed, in words: "the whole video", or "ply 20, resign-flag on
 * ply 18, the end card".
 * @param {ChangedScope} changed
 */
export const changedLabel = (changed) =>
  changed.plies === "all"
    ? "the whole video"
    : [
        ...changed.plies.map((p) => `ply ${p}`),
        ...changed.beats.map((b) => `${b.name} on ply ${b.ply}`),
        ...(changed.end ? ["the end card"] : []),
      ].join(", ");

/**
 * The clip's file: next to the video, named by its span, so a second sync
 * of the same ask finds it.
 * @param {string} video
 * @param {{ from: number, to: number }} span
 */
export const clipPath = (video, span) =>
  video.replace(/\.mp4$/, "") +
  `-changed-${span.from.toFixed(1)}-${span.to.toFixed(1)}.mp4`;

/**
 * Cuts the span out of the video (frame-exact: re-encoded, sound kept) and
 * returns the clip's path. An existing clip of the same span is kept.
 * @param {string} video
 * @param {{ from: number, to: number }} span
 */
export const cutClip = (video, span) => {
  const out = clipPath(video, span);
  if (existsSync(out)) return out;
  const tmp = out.replace(/\.mp4$/, ".part.mp4");
  const r = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-ss",
      String(span.from),
      "-to",
      String(span.to),
      "-i",
      video,
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      tmp,
    ],
    { encoding: "utf8" },
  );
  if (r.error) throw new Error(`ffmpeg could not start: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `ffmpeg failed (exit ${r.status}): ${(r.stderr ?? "").trim().split("\n").at(-1)}`,
    );
  }
  renameSync(tmp, out);
  return out;
};
