/**
 * The meme sounds of the daily look, by key (Nil, 2026-10-25: the trending
 * ones, the "FUAHHH" and the famous shotgun, as the WallzGame Short does).
 *
 * THEY ARE NOT IN THE REPOSITORY. They are other people's clips from public
 * meme sound sites, and this repository is public; the files live in the
 * gitignored assets/meme-sounds/<key>.mp3, and the page each came from is in
 * scripts/game-video/meme-sounds.md. Agents cannot hear, so there are several
 * candidates per sound and Nil picks by ear.
 *
 * Each entry is the clip's own level as uploaded, measured 2026-10-26 with
 * ffmpeg ebur128=peak=true: `lufs` is its loudest 400 ms (momentary max) and
 * `truePeak` its true peak in dBTP. The uploads differ by 23 dB, so the gain
 * is DERIVED from these and one target, never set by hand: memeGain brings a
 * clip to MEME_TARGET_LUFS, or lower when that would put its true peak over
 * MEME_TRUE_PEAK_CEILING.
 *
 * WHY THESE TARGETS. Nil, 2026-10-26, on the Director's N42PHQnw video: some
 * sounds were "too loud and annoying". Measured in the eeFSMEmL render the
 * same day, the bed (music and move clicks) sat near -22 LUFS momentary and
 * every meme sound, levelled to -16 LUFS, landed near -15: 7 dB over it. At
 * -21 a meme sound lands about 2 dB over the bed: heard, not jumping out.
 *
 * The renderer mixes from this table and the edit decision list (edl.mjs)
 * accepts exactly its keys, so a sound the director names always exists.
 */
export const MEME_SOUNDS = {
  "fuahhh-1": { lufs: -22.7, truePeak: -15.1 },
  "fuahhh-2": { lufs: -15.8, truePeak: -9.4 },
  "fuahhh-3": { lufs: -9.0, truePeak: -1.5 },
  "shotgun-1": { lufs: -0.3, truePeak: 6.9 },
  "shotgun-2": { lufs: -12.9, truePeak: -3.2 },
  "shotgun-3": { lufs: -18.8, truePeak: -3.3 },
  "shotgun-4": { lufs: -14.0, truePeak: -6.7 },
  "win-1": { lufs: -6.8, truePeak: -0.7 },
  "win-2": { lufs: -14.4, truePeak: -4.3 },
  "scared-1": { lufs: -11.7, truePeak: -5.0 },
  "scared-2": { lufs: -11.3, truePeak: -6.4 },
  "scared-3": { lufs: -8.9, truePeak: -0.9 },
  "laugh-1": { lufs: -8.6, truePeak: -1.4 },
  "laugh-2": { lufs: 0.4, truePeak: 2.3 },
  "laugh-3": { lufs: -12.3, truePeak: 0.2 },
};

/** Where every meme sound sits on its own, before the mix. */
export const MEME_TARGET_LUFS = -21;
export const MEME_TRUE_PEAK_CEILING = -10;

/** The linear gain that brings clip `key` to the target, within the ceiling. */
export const memeGain = (key) => {
  const { lufs, truePeak } = MEME_SOUNDS[key];
  const db = Math.min(
    MEME_TARGET_LUFS - lufs,
    MEME_TRUE_PEAK_CEILING - truePeak,
  );
  return 10 ** (db / 20);
};
