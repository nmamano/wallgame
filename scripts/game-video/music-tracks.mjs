/**
 * What each song file actually is, decoded from its ID3 tags 2026-08-19 and
 * recorded in credits.txt. The filenames say nothing, so this is the only way
 * a render can label its own track - and the only way to name one, since the
 * site's random start means there is no "first" song.
 *
 * The renderer plays from this table and an EDL's `music` (edl.mjs) names
 * one of its slugs.
 *
 * `license` is whether a video posted by the Wall Game accounts may play the
 * track, and `credit` the words the video and its post must carry. The
 * sources and quotes behind each are in MUSIC-LICENSES.md (checked
 * 2026-10-28):
 *
 *   ok               may play, no credit needed
 *   ok-with-credit   may play, with `credit` on the video and in the post
 *   blocked-until-nil
 *                    may not play until Nil answers the open question in
 *                    MUSIC-LICENSES.md
 *
 * The renderer refuses a track that may not play, and so does the daily
 * app's direct (routes.mjs).
 *
 * `lufs` is how loud the track is: its integrated loudness (EBU R128) over
 * its first MUSIC_MEASURE_SECONDS, the part a video plays, measured
 * 2026-10-28 (music-tracks.test.ts measures it again). The renderer plays
 * every track at one level with musicGain, so a quiet track is not lost
 * under the clicks and a loud one does not bury them.
 */
export const MUSIC_TRACKS = [
  {
    file: "song1.mp3",
    title: "Deja Vus (2nd loop) - YannZ",
    slug: "deja-vus",
    lufs: -17.3,
    license: "ok-with-credit",
    credit: "Deja Vus by YannZ (CC BY 4.0)",
  },
  {
    file: "song2.mp3",
    title: "Tea For Two - Aaron Paul Low",
    slug: "tea-for-two",
    lufs: -22.2,
    license: "blocked-until-nil",
    credit: "Tea For Two by Aaron Paul Low (Uppbeat)",
  },
  {
    file: "song3.mp3",
    title: "A Legend - Ian Aisling",
    slug: "a-legend",
    lufs: -15.0,
    license: "blocked-until-nil",
    credit: "A Legend by Ian Aisling (Uppbeat)",
  },
  {
    file: "song4.mp3",
    title: "Skippy Mr. Sunshine - Fernweh Goldfish",
    slug: "skippy",
    lufs: -15.7,
    license: "blocked-until-nil",
    credit: "Skippy Mr. Sunshine by Fernweh Goldfish (Uppbeat)",
  },
];

/** How much of each track `lufs` measures: a video plays its start. */
export const MUSIC_MEASURE_SECONDS = 60;

/**
 * The level every track plays at: deja-vus's, the track of every video Nil
 * has approved, so those videos sound the same as before.
 */
export const MUSIC_REFERENCE_LUFS = -17.3;

/**
 * The gain that brings a track to MUSIC_REFERENCE_LUFS: 1 for deja-vus,
 * and 1 for a track given by path (hand renders), which has no `lufs`.
 * @param {{ lufs?: number }} track
 */
export const musicGain = (track) =>
  track.lufs === undefined
    ? 1
    : 10 ** ((MUSIC_REFERENCE_LUFS - track.lufs) / 20);

/** Whether a video may play the track (its `license`, above). */
export const mayPlay = (track) =>
  track.license === "ok" || track.license === "ok-with-credit";

/**
 * The game's own sounds (move clicks, start, finish) in every video:
 * JDSherbert's packs, whose LICENSE.pdf asks for a visible credit.
 */
export const SOUNDS_CREDIT = "Sounds: JDSherbert";

/**
 * The credit a video carries for its soundtrack, as the lines it shows over
 * the ending: one per track that played, in play order, "Music: " before the
 * first and the game sounds' credit after the last. No tracks (a silent bed)
 * credits the sounds only. A track given by path has no license record, so
 * its title stands in for a credit (hand renders only).
 * @param {{ credit?: string, title: string }[]} tracks
 * @returns {string[]}
 */
export const creditLines = (tracks) =>
  tracks.length === 0
    ? [SOUNDS_CREDIT]
    : tracks.map(
        (t, i) =>
          (i === 0 ? "Music: " : "") +
          (t.credit ?? t.title) +
          (i === tracks.length - 1 ? ` · ${SOUNDS_CREDIT}` : ""),
      );

/** The same credit as one line of text, for the post (creditLines). */
export const creditLine = (tracks) => creditLines(tracks).join(", ");
