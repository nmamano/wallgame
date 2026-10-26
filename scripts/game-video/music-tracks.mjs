/**
 * What each song file actually is, decoded from its ID3 tags 2026-08-19 and
 * recorded in credits.txt. The filenames say nothing, so this is the only way
 * a render can label its own track - and the only way to name one, since the
 * site's random start means there is no "first" song.
 *
 * The renderer plays from this table and an EDL's `music` (edl.mjs) names
 * one of its slugs.
 */
export const MUSIC_TRACKS = [
  { file: "song1.mp3", title: "Deja Vus (2nd loop) - YannZ", slug: "deja-vus" },
  {
    file: "song2.mp3",
    title: "Tea For Two - Aaron Paul Low",
    slug: "tea-for-two",
  },
  { file: "song3.mp3", title: "A Legend - Ian Aisling", slug: "a-legend" },
  {
    file: "song4.mp3",
    title: "Skippy Mr. Sunshine - Fernweh Goldfish",
    slug: "skippy",
  },
];
