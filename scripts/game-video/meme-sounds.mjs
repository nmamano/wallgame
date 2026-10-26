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
 * The value is the gain that levels the clip to -16 LUFS at its loudest
 * 400 ms (ffmpeg ebur128 momentary max, measured 2026-10-26), because the
 * uploads differ by 22 dB: one is boosted until it clips. In the mix that puts
 * a meme sound about 11 dB over a move click and 6 dB over the old capture
 * sting, which is the point of it.
 *
 * The renderer mixes from this table and the edit decision list (edl.mjs)
 * accepts exactly its keys, so a sound the director names always exists.
 */
export const MEME_SOUND_GAINS = {
  "fuahhh-1": 2.16,
  "fuahhh-2": 0.98,
  "fuahhh-3": 0.45,
  "shotgun-1": 0.16,
  "shotgun-2": 0.7,
  "shotgun-3": 1.38,
  "shotgun-4": 0.79,
  "win-1": 0.35,
  "win-2": 0.83,
  "scared-1": 0.61,
  "scared-2": 0.58,
  "scared-3": 0.44,
  "laugh-1": 0.43,
  "laugh-2": 0.15,
  "laugh-3": 0.65,
};
