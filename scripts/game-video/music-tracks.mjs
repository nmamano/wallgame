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
 */
export const MUSIC_TRACKS = [
  {
    file: "song1.mp3",
    title: "Deja Vus (2nd loop) - YannZ",
    slug: "deja-vus",
    license: "ok-with-credit",
    credit: "Deja Vus by YannZ (CC BY 4.0)",
  },
  {
    file: "song2.mp3",
    title: "Tea For Two - Aaron Paul Low",
    slug: "tea-for-two",
    license: "blocked-until-nil",
    credit: "Tea For Two by Aaron Paul Low (Uppbeat)",
  },
  {
    file: "song3.mp3",
    title: "A Legend - Ian Aisling",
    slug: "a-legend",
    license: "blocked-until-nil",
    credit: "A Legend by Ian Aisling (Uppbeat)",
  },
  {
    file: "song4.mp3",
    title: "Skippy Mr. Sunshine - Fernweh Goldfish",
    slug: "skippy",
    license: "blocked-until-nil",
    credit: "Skippy Mr. Sunshine by Fernweh Goldfish (Uppbeat)",
  },
];

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
