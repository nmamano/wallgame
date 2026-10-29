/**
 * The lint of a list (Wall Game Director's R1, 2026-10-29): the app's own
 * checks (routes.mjs listChecks) and the renderer's --lint, which composes
 * the list from the 4090's capture and stops before the shoot pass, so it
 * makes no image and no view. The renderer's faults are {kind, ply, at,
 * stops, message}, in the video's order (edl.mjs LINT_KINDS: a kind stops a
 * render, warns, or is a note); its notes are {kind, ply, at, message}.
 *
 * A lint record (GET /api/daily/lint): {state: queued|running|done|failed,
 * errors: [the app's checks], skipped: why the renderer did not lint (no
 * capture yet) | null, lint: {faults, notes, counts} | null, timings,
 * error}. These helpers are the one reading of it, for the app and crew.
 */
import { RECAPTURE_KINDS } from "../edl.mjs";

/** One renderer fault or note as one line. */
export const lintLine = (f) =>
  `ply ${f.ply ?? "-"}, ${Number(f.at).toFixed(1)} s, ${f.kind}: ${f.message}`;

/** A stopping fault of the game's capture, which a live render mends. */
const recaptures = (f) => f.stops && RECAPTURE_KINDS.includes(f.kind);

/**
 * What stops the list: the app's errors and the renderer's stopping
 * faults, except those a live capture mends (lintRecapture).
 */
export const lintStops = (rec) => [
  ...rec.errors,
  ...(rec.lint?.faults ?? [])
    .filter((f) => f.stops && !recaptures(f))
    .map(lintLine),
];

/**
 * The faults of the game's capture (edl.mjs RECAPTURE_KINDS): direct still
 * stores the list, and its render captures the game live (one view).
 */
export const lintRecapture = (rec) =>
  (rec.lint?.faults ?? []).filter(recaptures).map(lintLine);

/** What the director should read and may keep: warnings and notes. */
export const lintNotes = (rec) => [
  ...(rec.lint?.faults ?? [])
    .filter((f) => !f.stops)
    .map((f) => `WARN ${lintLine(f)}`),
  ...(rec.lint?.notes ?? []).map((n) => `NOTE ${lintLine(n)}`),
];

/** The lines crew prints for a finished lint. */
export const lintReport = (rec) => {
  const stops = lintStops(rec);
  const counts = rec.lint?.counts;
  const tally = (o) =>
    Object.entries(o ?? {})
      .map(([k, n]) => `${k} ${n}`)
      .join(", ") || "none";
  return [
    `lint: ${stops.length ? `${stops.length} fault(s) stop the list` : "nothing stops the list"}${!stops.length && lintRecapture(rec).length ? "; its render captures the game live (one view)" : ""}${rec.skipped ? ` (the renderer did not lint: ${rec.skipped})` : ""}`,
    ...rec.errors.map((e) => `  STOP ${e}`),
    ...(rec.lint?.faults ?? [])
      .filter((f) => f.stops && !recaptures(f))
      .map((f) => `  STOP ${lintLine(f)}`),
    ...lintRecapture(rec).map((l) => `  LIVE ${l}`),
    ...lintNotes(rec).map((l) => `  ${l}`),
    ...(counts
      ? [
          `  ${counts.seconds} s; events: ${tally(counts.events)}; overlays: ${tally(counts.overlays)}; sounds: ${tally(counts.sounds)}`,
        ]
      : []),
  ];
};
