/**
 * The soundtrack's filter graph, and how loud each meme sound plays over
 * the rest of it.
 *
 * The renderer mixes the cues (move clicks, meme sounds) and the music with
 * mixGraph. The same graph, given only part of the cues, rebuilds one part
 * of the mix on its own: one meme sound alone, or the bed (the music and
 * every cue that is not a meme sound). memeLoudness measures each meme
 * sound's loudest 400 ms (EBU R128 momentary loudness) against the bed over
 * the same 400 ms. That is the question Nil answers by ear ("the baby cry
 * and the initial shotgun, are a bit too loud", 2026-10-26), and it does not
 * move when the clicks or the music get quieter, as a comparison with the
 * whole mix does (Wall Game PM, 2026-10-26: the same FAHHH went from 5.2 LU
 * to 7.7 LU over the whole mix when the clicks went 8 dB down).
 */
import { spawnSync } from "node:child_process";

/**
 * @typedef {{ file: string, gain: number, at: number, rate: number,
 *             meme: string | null }} Cue
 * @typedef {{ file: string, start: number, endAt: number, bed: number,
 *             volume: number, fadeIn: number, fadeOut: number }} Music
 *   One track's part of the music: the renderer gives one per music cue.
 */

const FORMAT =
  "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";

/**
 * The filter graph of the mix, before the limiter: `inputs` for ffmpeg, and
 * `chains` that end in the label [mix], totalSeconds long.
 *
 * Each music part starts at `start`, from the start of its file, and its
 * fade COMPLETES at `endAt`. The fade goes to `bed` (a share of the level)
 * rather than to silence when bed > 0: a linear ramp from 1 to bed over the
 * fade, then bed to the end. With bed 0 it is a plain fade. The parts add
 * up, so where one fades out as the next fades in, that is the crossfade.
 * One part gives the same graph as before there were cues.
 * @param {{ cues: Cue[], totalSeconds: number, music: Music[] }} mix
 */
export const mixGraph = ({ cues, totalSeconds, music }) => {
  if (cues.length === 0 && music.length === 0) {
    throw new Error("nothing to mix");
  }
  const end = totalSeconds.toFixed(3);
  const inputs = cues.flatMap((e) => ["-i", e.file]);
  const chains = cues.map(
    (e, i) =>
      `[${i}:a]${FORMAT},` +
      // A rate above 1 plays the sound higher and shorter.
      (e.rate === 1
        ? ""
        : `asetrate=${Math.round(44100 * e.rate)},aresample=44100,`) +
      `adelay=${Math.round(Math.max(0, e.at) * 1000)}:all=1,volume=${e.gain}[a${i}]`,
  );
  // The effects bus. Every cue lands here.
  if (cues.length > 0) {
    chains.push(
      cues.map((_, i) => `[a${i}]`).join("") +
        `amix=inputs=${cues.length}:normalize=0:dropout_transition=0,` +
        `apad,atrim=0:${end}${music.length > 0 ? "[fx]" : "[mix]"}`,
    );
  }
  if (music.length === 0) return { inputs, chains };
  // The music bus: one part goes straight to it, several are mixed first.
  const toMix = cues.length > 0 ? "[mus]" : `,apad,atrim=0:${end}[mix]`;
  const one = music.length === 1;
  music.forEach((part, k) => {
    const musicSeconds = totalSeconds - part.start;
    const fadeOutAt = Math.max(0, part.endAt - part.start - part.fadeOut);
    const a = fadeOutAt.toFixed(3);
    const b = (fadeOutAt + part.fadeOut).toFixed(3);
    const fadeOut =
      part.bed > 0
        ? `volume='if(lt(t,${a}),1,if(lt(t,${b}),1-(1-${part.bed})*(t-${a})/${part.fadeOut},${part.bed}))':eval=frame,`
        : `afade=t=out:st=${a}:d=${part.fadeOut},`;
    inputs.push("-i", part.file);
    chains.push(
      `[${cues.length + k}:a]${FORMAT},` +
        `atrim=0:${musicSeconds.toFixed(3)},` +
        `afade=t=in:st=0:d=${part.fadeIn},` +
        fadeOut +
        `volume=${part.volume},adelay=${Math.round(part.start * 1000)}:all=1` +
        (one ? toMix : `[m${k}]`),
    );
  });
  if (!one) {
    chains.push(
      music.map((_, k) => `[m${k}]`).join("") +
        `amix=inputs=${music.length}:normalize=0:dropout_transition=0` +
        (cues.length > 0 ? "[mus]" : `,apad,atrim=0:${end}[mix]`),
    );
  }
  if (cues.length > 0) {
    chains.push(`[fx][mus]amix=inputs=2:normalize=0:dropout_transition=0[mix]`);
  }
  return { inputs, chains };
};

/**
 * ffmpeg's ebur128 log as its momentary windows (one per 100 ms; the window
 * is the 400 ms that ends at t) and the true peak of the summary. A window
 * of digital silence reads "M: nan" (or -inf): it is silence, -Infinity,
 * not a missing window (2026-10-29: VX with its music off, a bed of pure
 * silence under the finish sound, failed every render: "the bed has no
 * window at 37.2 s").
 * @param {string} log
 */
export const parseMomentary = (log) => {
  const windows = [
    ...log.matchAll(
      /\bt:\s*([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+|-inf|nan)/g,
    ),
  ].map((m) => ({
    t: Number(m[1]),
    m: m[2] === "-inf" || m[2] === "nan" ? -Infinity : Number(m[2]),
  }));
  const at = log.lastIndexOf("Summary:");
  const peak =
    at >= 0 ? log.slice(at).match(/Peak:\s*(-?[\d.]+|-inf) dBFS/) : null;
  if (windows.length === 0 || !peak) {
    throw new Error("ffmpeg gave no loudness windows");
  }
  const integrated = log.slice(at).match(/\bI:\s*(-?[\d.]+|-inf|nan) LUFS/);
  return {
    windows,
    truePeakDbtp: peak[1] === "-inf" ? -Infinity : Number(peak[1]),
    integratedLufs:
      !integrated || integrated[1] === "-inf" || integrated[1] === "nan"
        ? -Infinity
        : Number(integrated[1]),
  };
};

/** ebur128 shows silence near -120 LUFS; below this a part is silent. */
const SILENT_LUFS = -70;
const tenth = (x) => Math.round(x * 10) / 10;

/**
 * One meme sound against the bed: the meme's loudest window, and the bed's
 * window that ends at the same t. Both logs come from the same timeline, so
 * their windows line up. A bed that is silent there gives no overLU: there
 * is nothing to stand over.
 * @param {{ key: string, at: number }} cue
 * @param {ReturnType<typeof parseMomentary>} meme
 * @param {ReturnType<typeof parseMomentary> | null} bed  null: no bed at all
 */
export const memeOverBed = (cue, meme, bed) => {
  const loudest = meme.windows.reduce((a, b) => (b.m > a.m ? b : a));
  if (!(loudest.m > SILENT_LUFS)) {
    throw new Error(
      `meme sound ${cue.key} at ${cue.at.toFixed(2)} s is silent`,
    );
  }
  const under = bed?.windows.find((w) => Math.abs(w.t - loudest.t) < 0.05);
  if (bed && !under) {
    throw new Error(`the bed has no window at ${loudest.t} s`);
  }
  const bedLufs = under && under.m > SILENT_LUFS ? tenth(under.m) : null;
  return {
    key: cue.key,
    at: tenth(cue.at),
    // The window ends at t, so the loud part is the 400 ms before it.
    loudestAt: tenth(Math.max(0, loudest.t - 0.4)),
    memeLufs: tenth(loudest.m),
    bedLufs,
    overLU: bedLufs === null ? null : tenth(loudest.m - bedLufs),
    truePeakDbtp: tenth(meme.truePeakDbtp),
  };
};

/**
 * Run one part of the mix through ebur128; `tail` is a filter chain that
 * goes between [mix] and the measure (it ends in a comma).
 */
const measurePart = (ffmpeg, graph, tail = "") => {
  const run = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      ...graph.inputs,
      "-filter_complex",
      [...graph.chains, `[mix]${tail}ebur128=peak=true[m]`].join(";"),
      "-map",
      "[m]",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    throw new Error(
      `ffmpeg could not measure a part of the mix: ${String(run.stderr).trim().split("\n").at(-1)}`,
    );
  }
  return parseMomentary(run.stderr);
};

/**
 * Each meme sound of the mix against the bed, in cue order.
 * @param {{ ffmpeg: string, cues: Cue[], totalSeconds: number,
 *           music: Music[] }} mix
 */
export const memeLoudness = ({ ffmpeg, cues, totalSeconds, music }) => {
  const memes = cues.filter((c) => c.meme !== null);
  if (memes.length === 0) return { memes: [] };
  const bedCues = cues.filter((c) => c.meme === null);
  const bed =
    bedCues.length > 0 || music.length > 0
      ? measurePart(ffmpeg, mixGraph({ cues: bedCues, totalSeconds, music }))
      : null;
  return {
    memes: memes.map((c) =>
      memeOverBed(
        { key: c.meme, at: c.at },
        measurePart(ffmpeg, mixGraph({ cues: [c], totalSeconds, music: [] })),
        bed,
      ),
    ),
  };
};

/*
  The master ("feed level", option B of an A/B that Nil did not answer; the
  Wall Game Director chose it, 2026-10-29): the whole mix goes to about
  MASTER_LUFS integrated with a true peak at most MASTER_MAX_TRUE_PEAK, the
  level of the feed it plays in.
  Two passes: measure the mix, then one linear gain to the target and a
  true-peak limiter. A linear gain keeps every relative level of the mix
  (each meme over its bed, the stings, the capture hits); one-pass dynamic
  loudnorm would pump the bed under the memes. The limiter runs at 4x the
  sample rate, so its sample peak is the true peak, and it stops at
  MASTER_LIMIT_DBTP, under the gate, because the AAC encode lifts the peaks:
  measured 2026-10-29 on VX, a limit at -1.5 dBTP came out at -0.7 dBTP,
  one at -2.0 at -1.4 dBTP (masterRetryLimit when a mix overshoots more).
  The limiter also takes loudness away: a mix with no music and loud
  peaks (screams, yells) came out at -15.1 LUFS, under the gate (2026-10-29,
  VX-IPenv with "music": []). So an encode under the target by more than
  MASTER_MAKEUP_BELOW gets the shortfall as more gain (masterRetry), and the
  limiter keeps the peaks: at most MASTER_ENCODES encodes in all.
  The AAC overshoot does not shrink steadily with the limit: measured
  2026-10-30 on v-2026-10-30-5 (a boom-3 hit), the master before AAC was
  exactly at each limit, and after AAC a limit at -2.0 came out at -0.7,
  one at -2.5 at -0.1 and one at -3.6 at -2.8 dBTP. That mix needs a gain
  step, two peak steps and a gain step again, so MASTER_ENCODES leaves
  room for five.
*/
export const MASTER_LUFS = -14;
/** A master outside these LUFS, or over this true peak, fails the render. */
export const MASTER_LUFS_RANGE = [-15, -13];
export const MASTER_MAX_TRUE_PEAK = -1;
export const MASTER_LIMIT_DBTP = -2;
export const MASTER_MAKEUP_BELOW = 0.5;
export const MASTER_ENCODES = 5;
/*
  The master's AAC bitrate. At 160k the encode cut the highs that the
  limiter's peaks are made of, and lifted the true peak by up to 5.6 dB:
  v-2026-11-01-3 (FTFHyntE, no music, gain 13.6 dB) took five encodes down
  to a limit of -6.5 dBTP and ended at -16.7 LUFS, so the render stopped.
  The same list at 256k: -14.5 LUFS, true peak -1.8 dBTP, in one encode
  (the 4090, 2026-11-01). About 0.7 MB more for a 60 s video.
*/
export const MASTER_AAC_BITRATE = "256k";
const OVERSAMPLE = 4;

/**
 * The master's filters for a mix that measures `mixLufs` integrated: the
 * gain to MASTER_LUFS (plus `makeupDb`, what an earlier encode's limiter
 * took away), then the true-peak limiter. No auto level (alimiter
 * `level`), which would lift the limited peaks back to 0 dBFS.
 * @param {number} mixLufs
 * @param {number} limitDbtp
 * @param {number} makeupDb
 */
export const masterFilters = (
  mixLufs,
  limitDbtp = MASTER_LIMIT_DBTP,
  makeupDb = 0,
) => {
  if (!(mixLufs > SILENT_LUFS)) {
    throw new Error(
      `the mix is silent (${mixLufs} LUFS), so it has no master gain`,
    );
  }
  const gainDb = tenth(MASTER_LUFS - mixLufs + makeupDb);
  const limit = 10 ** (limitDbtp / 20);
  return {
    gainDb,
    filters:
      `volume=${gainDb}dB,aresample=${44100 * OVERSAMPLE},` +
      `alimiter=limit=${limit.toFixed(4)}:level=0:latency=1,aresample=44100`,
  };
};

/**
 * Integrated loudness of the mix that `graph` builds, after `tail`.
 * @param {string} ffmpeg
 * @param {{ inputs: string[], chains: string[] }} graph  ends in [mix]
 * @param {string} tail  filters after [mix], each ending in a comma
 */
export const mixIntegrated = (ffmpeg, graph, tail) =>
  measurePart(ffmpeg, graph, tail).integratedLufs;

/**
 * The master as a listener gets it: the integrated loudness and true peak
 * of the encoded track, and the gain that the master gave.
 * @param {string} ffmpeg
 * @param {string} file
 * @param {number} gainDb
 */
export const measureMaster = (ffmpeg, file, gainDb) => {
  const m = measurePart(ffmpeg, {
    inputs: ["-i", file],
    chains: ["[0:a]anull[mix]"],
  });
  return {
    gainDb,
    lufs: tenth(m.integratedLufs),
    truePeakDbtp: tenth(m.truePeakDbtp),
  };
};

/**
 * The limit for one more encode of a master whose encoded true peak went
 * over the gate: lower by the overshoot, and 0.2 dB more.
 * @param {number} limitDbtp  the limit of the encode that overshot
 * @param {number} truePeakDbtp  its encoded true peak
 */
export const masterRetryLimit = (limitDbtp, truePeakDbtp) =>
  tenth(limitDbtp - (truePeakDbtp - MASTER_MAX_TRUE_PEAK) - 0.2);

/**
 * The settings of one more encode of a master, or null when this one is
 * done: a true peak over the gate lowers the limit (masterRetryLimit); else
 * a loudness under MASTER_LUFS by more than MASTER_MAKEUP_BELOW adds the
 * shortfall to the gain. The caller stops after MASTER_ENCODES encodes and
 * leaves the rest to masterFault.
 * @param {{ limitDbtp: number, makeupDb: number }} settings  of the encode
 * @param {{ lufs: number, truePeakDbtp: number }} master  its measure
 * @returns {{ limitDbtp: number, makeupDb: number, why: string } | null}
 */
export const masterRetry = (
  { limitDbtp, makeupDb },
  { lufs, truePeakDbtp },
) => {
  if (truePeakDbtp > MASTER_MAX_TRUE_PEAK) {
    const limit = masterRetryLimit(limitDbtp, truePeakDbtp);
    return {
      limitDbtp: limit,
      makeupDb,
      why: `the encode lifted the master's true peak to ${truePeakDbtp} dBTP; encoding again with the limit at ${limit} dBTP`,
    };
  }
  if (lufs < MASTER_LUFS - MASTER_MAKEUP_BELOW) {
    const makeup = tenth(makeupDb + MASTER_LUFS - lufs);
    return {
      limitDbtp,
      makeupDb: makeup,
      why: `the limiter took the master to ${lufs} LUFS; encoding again with ${makeup} dB more gain`,
    };
  }
  return null;
};

/**
 * Encode the master until masterRetry is done, at most MASTER_ENCODES
 * times, and return the last encode's measure.
 * @template {{ lufs: number, truePeakDbtp: number }} M
 * @param {(settings: { limitDbtp: number, makeupDb: number }) => M} encode
 * @param {(line: string) => void} log
 * @returns {M}
 */
export const runMaster = (encode, log) => {
  let settings = { limitDbtp: MASTER_LIMIT_DBTP, makeupDb: 0 };
  let master = encode(settings);
  for (let n = 1; n < MASTER_ENCODES; n += 1) {
    const next = masterRetry(settings, master);
    if (!next) break;
    log(next.why);
    settings = { limitDbtp: next.limitDbtp, makeupDb: next.makeupDb };
    master = encode(settings);
  }
  return master;
};

/*
  Silence, as a viewer hears it: the final track under SILENCE_FLOOR_DBFS
  for SILENCE_DETECT_SECONDS or more (ffmpeg silencedetect). From the VS
  hit to the first move a gap may last OPENING_SILENCE_SECONDS, after that
  SILENCE_SECONDS (Wall Game Director, 2026-10-29). One floor for the
  render's measure, `crew.mjs audio` and the render vet (Wall Game PM,
  2026-10-29: the lint and the vet measured on two floors and disagreed
  near the limit).
*/
export const SILENCE_FLOOR_DBFS = -45;
export const SILENCE_DETECT_SECONDS = 0.6;
export const SILENCE_SECONDS = 1.5;
export const OPENING_SILENCE_SECONDS = 0.6;
export const SILENCE_FILTER = `silencedetect=noise=${SILENCE_FLOOR_DBFS}dB:d=${SILENCE_DETECT_SECONDS}`;

const hundredth = (x) => Math.round(x * 100) / 100;

/**
 * silencedetect's lines as [{start, end, seconds}]; an open one ends at
 * `end`.
 * @param {string} stderr
 * @param {number} end
 */
export const parseSilences = (stderr, end) => {
  /** @type {{ start: number, end: number }[]} */
  const out = [];
  /** @type {number | null} */
  let start = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start: ([-\d.]+)/.exec(line);
    if (s) start = Number(s[1]);
    const e = /silence_end: ([-\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  if (start !== null) out.push({ start, end });
  return out.map((g) => ({
    start: hundredth(g.start),
    end: hundredth(g.end),
    seconds: hundredth(g.end - g.start),
  }));
};

/**
 * The silences of an encoded track that lasts `seconds`.
 * @param {string} ffmpeg
 * @param {string} file
 * @param {number} seconds
 */
export const measureSilences = (ffmpeg, file, seconds) => {
  const run = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      SILENCE_FILTER,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    throw new Error(
      `ffmpeg could not find the silences: ${String(run.stderr).trim().split("\n").at(-1)}`,
    );
  }
  return parseSilences(run.stderr, seconds);
};

/**
 * The silences over the rules, each with the rule it breaks: over
 * SILENCE_SECONDS anywhere, or over OPENING_SILENCE_SECONDS inside the
 * opening [VS sound, first move] (null: a video without the daily opening).
 * @param {{ start: number, end: number, seconds: number }[]} gaps
 * @param {[number, number] | null} opening
 */
export const silencesOverRules = (gaps, opening) =>
  gaps.flatMap((g) => {
    if (g.seconds > SILENCE_SECONDS) return [{ ...g, rule: SILENCE_SECONDS }];
    const inOpening = opening
      ? Math.min(g.end, opening[1]) - Math.max(g.start, opening[0])
      : 0;
    return inOpening > OPENING_SILENCE_SECONDS
      ? [{ ...g, seconds: hundredth(inOpening), rule: OPENING_SILENCE_SECONDS }]
      : [];
  });

/**
 * Why a master fails the gate, or null when it passes.
 * @param {{ lufs: number, truePeakDbtp: number }} master
 */
export const masterFault = ({ lufs, truePeakDbtp }) => {
  const [lo, hi] = MASTER_LUFS_RANGE;
  if (!(lufs >= lo && lufs <= hi)) {
    return `the master is ${lufs} LUFS, outside ${lo} to ${hi} LUFS`;
  }
  if (!(truePeakDbtp <= MASTER_MAX_TRUE_PEAK)) {
    return `the master's true peak is ${truePeakDbtp} dBTP, over ${MASTER_MAX_TRUE_PEAK} dBTP`;
  }
  return null;
};
