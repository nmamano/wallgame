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
 */

const FORMAT =
  "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";

/**
 * The filter graph of the mix, before the limiter: `inputs` for ffmpeg, and
 * `chains` that end in the label [mix], totalSeconds long.
 *
 * The music starts at `start` and its fade COMPLETES at `endAt`. The fade
 * goes to `bed` (a share of the level) rather than to silence when bed > 0:
 * a linear ramp from 1 to bed over the fade, then bed to the end. With bed 0
 * it is a plain fade.
 * @param {{ cues: Cue[], totalSeconds: number, music: Music | null }} mix
 */
export const mixGraph = ({ cues, totalSeconds, music }) => {
  if (cues.length === 0 && !music) throw new Error("nothing to mix");
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
        `apad,atrim=0:${end}${music ? "[fx]" : "[mix]"}`,
    );
  }
  if (music) {
    const musicSeconds = totalSeconds - music.start;
    const fadeOutAt = Math.max(0, music.endAt - music.start - music.fadeOut);
    const a = fadeOutAt.toFixed(3);
    const b = (fadeOutAt + music.fadeOut).toFixed(3);
    const fadeOut =
      music.bed > 0
        ? `volume='if(lt(t,${a}),1,if(lt(t,${b}),1-(1-${music.bed})*(t-${a})/${music.fadeOut},${music.bed}))':eval=frame,`
        : `afade=t=out:st=${a}:d=${music.fadeOut},`;
    inputs.push("-i", music.file);
    chains.push(
      `[${cues.length}:a]${FORMAT},` +
        `atrim=0:${musicSeconds.toFixed(3)},` +
        `afade=t=in:st=0:d=${music.fadeIn},` +
        fadeOut +
        `volume=${music.volume},adelay=${Math.round(music.start * 1000)}:all=1` +
        (cues.length > 0 ? "[mus]" : `,apad,atrim=0:${end}[mix]`),
    );
    if (cues.length > 0) {
      chains.push(
        `[fx][mus]amix=inputs=2:normalize=0:dropout_transition=0[mix]`,
      );
    }
  }
  return { inputs, chains };
};

/**
 * ffmpeg's ebur128 log as its momentary windows (one per 100 ms; the window
 * is the 400 ms that ends at t) and the true peak of the summary.
 * @param {string} log
 */
export const parseMomentary = (log) => {
  const windows = [
    ...log.matchAll(
      /\bt:\s*([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+|-inf)/g,
    ),
  ].map((m) => ({
    t: Number(m[1]),
    m: m[2] === "-inf" ? -Infinity : Number(m[2]),
  }));
  const at = log.lastIndexOf("Summary:");
  const peak =
    at >= 0 ? log.slice(at).match(/Peak:\s*(-?[\d.]+|-inf) dBFS/) : null;
  if (windows.length === 0 || !peak) {
    throw new Error("ffmpeg gave no loudness windows");
  }
  return {
    windows,
    truePeakDbtp: peak[1] === "-inf" ? -Infinity : Number(peak[1]),
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

/** Run one part of the mix through ebur128. */
const measurePart = (ffmpeg, graph) => {
  const run = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      ...graph.inputs,
      "-filter_complex",
      [...graph.chains, "[mix]ebur128=peak=true[m]"].join(";"),
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
 *           music: Music | null }} mix
 */
export const memeLoudness = ({ ffmpeg, cues, totalSeconds, music }) => {
  const memes = cues.filter((c) => c.meme !== null);
  if (memes.length === 0) return { memes: [] };
  const bedCues = cues.filter((c) => c.meme === null);
  const bed =
    bedCues.length > 0 || music
      ? measurePart(ffmpeg, mixGraph({ cues: bedCues, totalSeconds, music }))
      : null;
  return {
    memes: memes.map((c) =>
      memeOverBed(
        { key: c.meme, at: c.at },
        measurePart(ffmpeg, mixGraph({ cues: [c], totalSeconds, music: null })),
        bed,
      ),
    ),
  };
};
