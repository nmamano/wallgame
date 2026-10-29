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

/** One renderer fault or note as one line. */
export const lintLine = (f) =>
  `ply ${f.ply ?? "-"}, ${Number(f.at).toFixed(1)} s, ${f.kind}: ${f.message}`;

/** What stops the list: the app's errors and the renderer's stopping faults. */
export const lintStops = (rec) => [
  ...rec.errors,
  ...(rec.lint?.faults ?? []).filter((f) => f.stops).map(lintLine),
];

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
    `lint: ${stops.length ? `${stops.length} fault(s) stop the list` : "nothing stops the list"}${rec.skipped ? ` (the renderer did not lint: ${rec.skipped})` : ""}`,
    ...rec.errors.map((e) => `  STOP ${e}`),
    ...(rec.lint?.faults ?? [])
      .filter((f) => f.stops)
      .map((f) => `  STOP ${lintLine(f)}`),
    ...lintNotes(rec).map((l) => `  ${l}`),
    ...(counts
      ? [
          `  ${counts.seconds} s; events: ${tally(counts.events)}; overlays: ${tally(counts.overlays)}; sounds: ${tally(counts.sounds)}`,
        ]
      : []),
  ];
};
