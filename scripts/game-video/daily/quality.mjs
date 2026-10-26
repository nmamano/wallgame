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
  for (const m of log.matchAll(
    /\bt:\s*([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+)/g,
  )) {
    const value = Number(m[2]);
    if (value > maxMomentary) {
      maxMomentary = value;
      maxMomentaryAt = Number(m[1]);
    }
  }
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const integrated = summary.match(/I:\s*(-?[\d.]+) LUFS/);
  const peak = summary.match(/Peak:\s*(-?[\d.]+|-inf) dBFS/);
  if (!integrated || maxMomentaryAt === null) {
    throw new Error("ffmpeg gave no loudness summary");
  }
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
