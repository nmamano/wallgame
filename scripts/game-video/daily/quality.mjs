/**
 * Measured checks on a rendered daily video, beside the director's own look
 * at the contact sheet (quality audit, info/daily-video-quality.md). The app
 * measures each render when it lands; the check step refuses an ask for a
 * render that fails one.
 *
 *   loudness   the loudest momentary loudness (400 ms) minus the integrated
 *              loudness of the whole mix: how far the loudest sting stands
 *              out over the music (Nil, 2026-10-26: "the baby cry and the
 *              initial shotgun, are a bit too loud").
 *   safeArea   each box the renderer measured in the page (board, caption,
 *              race counter, goal line) lies inside SAFE_AREA (edl.mjs),
 *              where the apps paint no buttons or captions (audit item 3).
 *   captionLines
 *              each caption beat (the caption and the payoff) is one line as
 *              the page wraps it (stage.html __captionText): a two-line beat
 *              makes the board smaller for the whole video (DIRECTOR.md,
 *              measured 2026-10-26: 720 px against 785 px).
 */
import { execFile } from "node:child_process";

/**
 * The loudest sting may stand this far over the integrated loudness of the
 * mix. Measured 2026-10-26: N42PHQnw, whose opening shotgun Nil found "a bit
 * too loud", is 6.5 LU over its mix at 1.1 s; XMaenOP1 7.9 LU; eeFSMEmL
 * (EDL v4) 5.2 LU; the six-effects demo after the quieter memes 4.7 LU.
 * Nil confirms the limit by ear.
 */
export const MAX_STING_OVER_MIX_LU = 6;

/**
 * @typedef {{
 *   integratedLufs: number,
 *   maxMomentaryLufs: number,
 *   maxMomentaryAt: number,
 *   truePeakDbfs: number | null,
 * }} Loudness
 */

/**
 * The integrated, loudest momentary and true peak loudness, from ffmpeg's
 * ebur128 log (one line per 100 ms at the default info level, then a summary).
 * @param {string} log
 * @returns {Loudness}
 */
export const parseEbur128 = (log) => {
  let maxMomentary = -Infinity;
  let maxMomentaryAt = null;
  let windows = 0;
  for (const m of log.matchAll(
    /\bt:\s*([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+|-inf)/g,
  )) {
    windows += 1;
    const value = m[2] === "-inf" ? -Infinity : Number(m[2]);
    if (value > maxMomentary) {
      maxMomentary = value;
      maxMomentaryAt = Number(m[1]);
    }
  }
  const at = log.lastIndexOf("Summary:");
  const integrated =
    at >= 0 ? log.slice(at).match(/I:\s*(-?[\d.]+) LUFS/) : null;
  const peak =
    at >= 0 ? log.slice(at).match(/Peak:\s*(-?[\d.]+|-inf) dBFS/) : null;
  if (!integrated || windows === 0) {
    throw new Error("ffmpeg gave no loudness summary");
  }
  if (maxMomentaryAt === null) throw new Error("the video is silent");
  return {
    integratedLufs: Number(integrated[1]),
    maxMomentaryLufs: maxMomentary,
    // The window ends at t, so the loud sound is in the 400 ms before it.
    maxMomentaryAt,
    truePeakDbfs: peak ? Number(peak[1]) : null,
  };
};

/** Measure a video's loudness with the ffmpeg on PATH. */
export const measureLoudness = (videoPath) =>
  new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        videoPath,
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (err) {
          return reject(
            new Error(`ffmpeg could not measure the loudness: ${err.message}`),
          );
        }
        try {
          resolve(parseEbur128(stderr));
        } catch (e) {
          reject(e);
        }
      },
    );
  });

/**
 * The loudness verdict on one measurement.
 * @param {Loudness} m
 */
export const loudnessVerdict = (m) => {
  const over = Math.round((m.maxMomentaryLufs - m.integratedLufs) * 10) / 10;
  const ok = over <= MAX_STING_OVER_MIX_LU;
  return {
    ok,
    ...m,
    stingOverMixLu: over,
    note: ok
      ? `the loudest moment (${m.maxMomentaryAt.toFixed(1)} s) is ${over} LU over the mix`
      : `the loudest moment (${m.maxMomentaryAt.toFixed(1)} s) is ${over} LU over the mix, more than ${MAX_STING_OVER_MIX_LU}: drop or change the sound there`,
  };
};

const inside = (box, area) =>
  box.x >= area.x &&
  box.y >= area.y &&
  box.x + box.w <= area.x + area.w &&
  box.y + box.h <= area.y + area.h;

const span = (b) => `x ${b.x}-${b.x + b.w}, y ${b.y}-${b.y + b.h}`;

/**
 * The safe-area verdict on the layout a render reported:
 * `{frame: {w, h}, boxes: {name: {x, y, w, h}}}`, measured in the page at
 * rest. Every daily render reports one, with the board in it; a render
 * without one fails, so a renderer that stops measuring cannot pass.
 * @param {{ frame?: { w: number, h: number },
 *           boxes?: Record<string, { x: number, y: number, w: number, h: number }> } | undefined} layout
 * @param {{ w: number, h: number }} frame
 * @param {{ x: number, y: number, w: number, h: number }} area
 */
export const safeAreaVerdict = (layout, frame, area) => {
  const fail = (note) => ({ ok: false, note });
  if (!layout?.boxes?.board) return fail("the render reported no layout");
  if (layout.frame?.w !== frame.w || layout.frame?.h !== frame.h) {
    return fail(
      `the frame is ${layout.frame?.w}x${layout.frame?.h}, not ${frame.w}x${frame.h}`,
    );
  }
  const outside = Object.entries(layout.boxes).filter(
    ([, box]) => !inside(box, area),
  );
  return outside.length === 0
    ? {
        ok: true,
        note: `${Object.keys(layout.boxes).join(", ")} inside the safe area`,
      }
    : fail(
        outside
          .map(([name, box]) => `${name} (${span(box)}) is outside`)
          .join("; ") + ` the safe area (${span(area)})`,
      );
};

/**
 * One line per caption beat, inside its box. `layout.captionText` is the
 * renderer's measure of each beat, { caption?, payoff? } of { lines, width }
 * with the widest line in px; `layout.boxes` has a box of the same name. One
 * long word cannot wrap: it stays one line and runs past the box (Worker 2,
 * 2026-10-26: 31 W's measured 1 line, 1743 px in a 918 px slot), so the
 * width counts too. A render that did not measure fails, as safeArea does.
 */
export const captionLinesVerdict = (layout) => {
  const beats = layout?.captionText;
  if (!beats) {
    return {
      ok: false,
      note: "the render reported no caption line count; the render kit may be older than the measure, so tell the Wall Game PM",
    };
  }
  const entries = Object.entries(beats);
  if (entries.length === 0) return { ok: true, note: "no caption" };
  const said = ([name, b]) =>
    `${name} ${b.lines} line${b.lines === 1 ? "" : "s"}, ${b.width} of ${layout.boxes?.[name]?.w ?? "?"} px`;
  const bad = entries.filter(([name, b]) => {
    const box = layout.boxes?.[name]?.w;
    return b.lines !== 1 || !box || b.width > box;
  });
  return bad.length === 0
    ? { ok: true, note: entries.map(said).join("; ") }
    : {
        ok: false,
        note: `${bad.map(said).join("; ")}: each beat must be one line inside its box; shorten it, direct again and render --force`,
      };
};
