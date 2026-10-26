/**
 * The meme sounds of the daily look, by key (Nil, 2026-10-25: the trending
 * ones, the "FUAHHH" and the famous shotgun, as the WallzGame Short does).
 *
 * THEY ARE NOT IN THE REPOSITORY. They are other people's clips from public
 * sound sites, and this repository is public; the files live in the
 * gitignored assets/meme-sounds/<key>.mp3, and the page each came from is in
 * scripts/game-video/meme-sounds.md. Agents cannot hear, so there are several
 * candidates per sound and Nil picks by ear, on the app's /daily/sounds page
 * (daily/sounds.mjs). The key without its number is the family.
 *
 * Each entry is the clip's own level as uploaded, measured 2026-10-26 with
 * ffmpeg ebur128=peak=true: `lufs` is its loudest 400 ms (momentary max) and
 * `truePeak` its true peak in dBTP. A clip shorter than 400 ms is measured
 * with silence after it, so the window holds all of it. The uploads differ by
 * 29 dB, so the gain
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
  // Original sound effects, CC0 on freesound.org (meme-sounds.md).
  "boom-1": { lufs: -19.8, truePeak: -10.6 },
  "boom-2": { lufs: -10.1, truePeak: -0.1 },
  "boom-3": { lufs: -27.2, truePeak: -14.1 },
  "oof-1": { lufs: -18.5, truePeak: -1.2 },
  "oof-2": { lufs: -17.4, truePeak: -7.8 },
  "bruh-1": { lufs: -16.9, truePeak: -9.3 },
  "bruh-2": { lufs: -12.6, truePeak: -0.3 },
  "scratch-1": { lufs: -10.6, truePeak: -1.2 },
  "scratch-2": { lufs: -7.3, truePeak: 0.8 },
  "scratch-3": { lufs: -28.7, truePeak: -18.2 },
  "airhorn-1": { lufs: -13.7, truePeak: -4.8 },
  "airhorn-2": { lufs: -4.0, truePeak: -0.2 },
  "airhorn-3": { lufs: -11.9, truePeak: -4.5 },
  "letsgo-1": { lufs: -14.7, truePeak: -1.3 },
  "letsgo-2": { lufs: -13.8, truePeak: -5.7 },
  "trombone-1": { lufs: -10.2, truePeak: -3.2 },
  "trombone-2": { lufs: -17.4, truePeak: -8.7 },
  "trombone-3": { lufs: -10.8, truePeak: -0.8 },
  "sting-1": { lufs: -12.6, truePeak: -1.1 },
  "sting-2": { lufs: -11.6, truePeak: -0.2 },
  "sting-3": { lufs: -27.4, truePeak: -17.1 },
  "ding-1": { lufs: -14.3, truePeak: -1.2 },
  "ding-2": { lufs: -17.5, truePeak: -5.6 },
  "ding-3": { lufs: -18.9, truePeak: -9.8 },
  "ooh-1": { lufs: -10.0, truePeak: -0.3 },
  "ooh-2": { lufs: -9.5, truePeak: -0.6 },
  "ooh-3": { lufs: -19.5, truePeak: -11.7 },
};

/**
 * The moment of the game that each family is for: the Director's guide and
 * the listening page's headings. Every key's family is here
 * (daily/sounds.test.ts).
 */
export const MEME_FAMILIES = {
  fuahhh: "a big save or a big blunder",
  shotgun: "a hard hit: the VS card, the finish",
  win: "the win",
  scared: "the mouse is scared: danger",
  laugh: "the mouse laughs: relief after the save",
  boom: "a reveal (the vine boom)",
  oof: "a blunder",
  bruh: "a blunder",
  scratch: "freeze: stop and look at this",
  airhorn: "the win",
  letsgo: "the win",
  trombone: "the loss",
  sting: "the trap closes",
  ding: "a good move",
  ooh: "a close call",
};

/**
 * What a listener should weigh besides the sound: the clips that
 * meme-sounds.md rates as a high claim risk, and the WEAKER rows, whose page
 * does not say how the sound was made. The listening page and `crew.mjs
 * sounds` show these.
 * @type {Record<string, string>}
 */
export const MEME_SOURCE_NOTES = {
  "win-2": "high claim risk: a Rockstar Games music sting",
  "shotgun-1": "high claim risk: names Fortnite (Epic Games)",
  "shotgun-4": "high claim risk: probably the Fortnite blast",
  "laugh-1": "high claim risk: a clip of The Simpsons",
  "boom-2": "weaker source: the page does not say how it was made",
  "bruh-1": "weaker source: may copy the famous bruh clip",
  "bruh-2": "weaker source: the page does not say how it was made",
  "scratch-3": "weaker source: built from sounds the page does not name",
  "airhorn-1": "weaker source: the page does not say how it was made",
  "airhorn-2": "weaker source: the page does not say how it was made",
  "ooh-2": "weaker source: the page does not say how it was made",
  "ooh-3": "weaker source: the page does not say how it was made",
};

/** "boom-2" -> "boom". @type {(key: string) => string} */
export const memeFamily = (key) => key.replace(/-\d+$/, "");

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

/**
 * The clip's loudest 400 ms after memeGain, in LUFS: what a video plays. The
 * renderer takes a further 3 dB off the scared events and the VS card.
 * @type {(key: keyof typeof MEME_SOUNDS) => number}
 */
export const memeLevel = (key) =>
  MEME_SOUNDS[key].lufs + 20 * Math.log10(memeGain(key));
