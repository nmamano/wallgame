/**
 * How Bluesky, Threads and Mastodon count the length of a post's text. Each
 * platform counts in its own way, so the copy-block intake and the posters
 * use these functions, and the two cannot disagree.
 *
 * Read 2026-10-26:
 *   Bluesky  app.bsky.feed.post lexicon (bluesky-social/atproto,
 *            packages/api/lexicons/app/bsky/feed/post.json): text has
 *            maxGraphemes 300 and maxLength 3000 (UTF-8 bytes).
 *   Threads  developers.facebook.com/docs/threads/posts, "Limits": "Text
 *            posts are limited to 500 characters. Emojis are counted as the
 *            number of UTF-8 bytes."
 *   Mastodon docs.joinmastodon.org/user/posting: 500 characters by default,
 *            and a link counts as 23 characters. The code
 *            (mastodon/mastodon app/validators/status_length_validator.rb)
 *            counts grapheme clusters and puts 23 characters in place of
 *            each URL. A server can raise the limit
 *            (configuration.statuses.max_characters of /api/v2/instance);
 *            500 is the default and our server is not chosen yet.
 */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const graphemes = (text) => [...segmenter.segment(text)].map((s) => s.segment);
const utf8Bytes = (text) => new TextEncoder().encode(text).length;

/**
 * The URLs in a text, with their UTF-16 positions. A URL ends at white space;
 * a final . , ; : ! ? ) " or ' is punctuation of the sentence, not the URL.
 * @param {string} text
 * @returns {{ url: string, start: number, end: number }[]}
 */
export const findUrls = (text) =>
  [...text.matchAll(/https?:\/\/\S+/g)].map((m) => {
    const url = m[0].replace(/[.,;:!?)"']+$/, "");
    return { url, start: m.index, end: m.index + url.length };
  });

export const BLUESKY_MAX_GRAPHEMES = 300;
export const BLUESKY_MAX_BYTES = 3000;
export const THREADS_MAX_CHARACTERS = 500;
export const MASTODON_MAX_CHARACTERS = 500;
export const MASTODON_URL_CHARACTERS = 23;

export const blueskyLength = (text) => graphemes(text).length;

/**
 * Threads: one per character, and an emoji as its UTF-8 bytes. The page does
 * not say how it counts other non-ASCII characters (an accented letter, for
 * example), so this counts every non-ASCII grapheme as its UTF-8 bytes. That
 * can only over-count, so a text that passes here passes on Threads.
 */
export const threadsLength = (text) =>
  graphemes(text).reduce(
    (n, g) =>
      n + ([...g].every((c) => c.charCodeAt(0) < 128) ? 1 : utf8Bytes(g)),
    0,
  );

export const mastodonLength = (text) => {
  let rest = text;
  for (const { start, end } of findUrls(text).reverse()) {
    rest =
      rest.slice(0, start) +
      "x".repeat(MASTODON_URL_CHARACTERS) +
      rest.slice(end);
  }
  return graphemes(rest).length;
};

/** The problems of `text` on `platform`, as sentences; [] when it can post. */
export const textLimitProblems = (platform, text) => {
  const over = (n, max, unit) => [
    `${platform} text is ${n} ${unit}; the limit is ${max}`,
  ];
  if (platform === "bluesky") {
    const n = blueskyLength(text);
    if (n > BLUESKY_MAX_GRAPHEMES) {
      return over(n, BLUESKY_MAX_GRAPHEMES, "characters (graphemes)");
    }
    const bytes = utf8Bytes(text);
    if (bytes > BLUESKY_MAX_BYTES) {
      return over(bytes, BLUESKY_MAX_BYTES, "UTF-8 bytes");
    }
    return [];
  }
  if (platform === "threads") {
    const n = threadsLength(text);
    return n > THREADS_MAX_CHARACTERS
      ? over(
          n,
          THREADS_MAX_CHARACTERS,
          "characters (an emoji counts its bytes)",
        )
      : [];
  }
  if (platform === "mastodon") {
    const n = mastodonLength(text);
    return n > MASTODON_MAX_CHARACTERS
      ? over(n, MASTODON_MAX_CHARACTERS, "characters (a link counts 23)")
      : [];
  }
  return [];
};
