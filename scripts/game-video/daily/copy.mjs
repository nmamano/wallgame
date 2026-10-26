/**
 * Wall Game Growth's copy block: the text that each platform posts with the
 * daily video.
 *
 * WHO WRITES WHAT (Nil, 2026-10-26, through Wall Game PM). The Director owns
 * the video and its on-video caption. Wall Game Growth writes all post text
 * and posts. The flow: the Director picks, directs, renders and checks, then
 * sends Growth a copy request; Growth gives the app its block (crew.mjs
 * copy); the Director's ask shows the stored block; on Nil's yes, Growth
 * posts that approved block (crew.mjs post).
 *
 * THE BLOCK is eight lines, each the exact text that posts (format by Growth
 * Lead, ~/nil/growth/posting/README.md and wallgame.md):
 *
 *   X: <post text>
 *   YouTube title: <title>
 *   YouTube description: <description>
 *   TikTok: <caption>
 *   Instagram: <caption>
 *   Facebook: <caption>
 *   Bluesky: <post text>
 *   Threads: <post text>
 *
 * The app adds " #Shorts" to the YouTube title, and nothing else to any line.
 * TikTok takes no caption through the API: Nil pastes it in the inbox draft,
 * so the ask shows it. The limits are checked here, when the block comes in,
 * so an ask never shows a text that cannot post.
 */
import { createHash } from "node:crypto";
import { textProblems } from "./candidate.mjs";
import { findUrls, textLimitProblems } from "./post-limits.mjs";

/**
 * The one link a post may carry, per platform (measurement plan,
 * 2026-10-25; Growth Lead, 2026-10-26).
 * @param {string} platform
 */
export const trackedLink = (platform) =>
  `https://wallgame.io/?utm_source=${platform}&utm_medium=social&utm_campaign=daily-video`;

/** Where the YouTube description sends people. */
export const YOUTUBE_LINK = trackedLink("youtube");

/** developers.facebook.com/docs/threads/posts, read 2026-10-26. */
export const THREADS_MAX_LINKS = 5;

/** X's limit for a free account, in its weighted count (xWeight). */
export const X_MAX_CHARS = 280;
export const YOUTUBE_TITLE_MAX_CHARS = 100;
/** The YouTube Data API's limit for snippet.description, in UTF-8 bytes. */
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;
/** What the app adds to the YouTube title. */
export const SHORTS_TAG = " #Shorts";
/** Growth's cap for both (posting/tiktok.md, posting/instagram.md). */
export const CAPTION_MAX_CHARS = 2200;
/** Instagram's limit since 2025-12-18 (posting/instagram.md). */
export const INSTAGRAM_MAX_HASHTAGS = 5;

/** The block's labels, in its order, and the field each one fills. */
export const COPY_LINES = [
  ["X", "x"],
  ["YouTube title", "youtubeTitle"],
  ["YouTube description", "youtubeDescription"],
  ["TikTok", "tiktok"],
  ["Instagram", "instagram"],
  ["Facebook", "facebook"],
  ["Bluesky", "bluesky"],
  ["Threads", "threads"],
];

/** Growth's name for the style it wrote the block in, e.g. growth-copy-1. */
export const COPY_VERSION = /^[a-z0-9-]{1,40}$/;

/**
 * @typedef {{ x: string, youtubeTitle: string, youtubeDescription: string,
 *   tiktok: string, instagram: string, facebook: string, bluesky: string,
 *   threads: string }} CopyTexts
 * @typedef {CopyTexts & { version: string }} Copy  a stored block
 */

const chars = (text) => [...text].length;

/**
 * X's weighted length (twitter-text v3): a code point counts 1 in the
 * ranges below and 2 elsewhere, and an emoji counts 2 however many code
 * points it has. A grapheme with an emoji counts 2 here; the other code
 * points count one by one. A keycap or flag can count a little more than X
 * counts it, which is the safe side: X refuses a long post only after the
 * other platforms have posted (Wall Game Worker 1, 2026-10-26).
 */
const X_LIGHT = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
const EMOJI = /\p{Extended_Pictographic}/u;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
export const xWeight = (text) =>
  [...segmenter.segment(text)].reduce(
    (sum, { segment }) =>
      sum +
      (EMOJI.test(segment)
        ? 2
        : [...segment].reduce((w, ch) => {
            const cp = /** @type {number} */ (ch.codePointAt(0));
            return w + (X_LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2);
          }, 0)),
    0,
  );

/** A URL, or a bare domain that X and others make into one. */
const LINK = /https?:\/\/|www\.|\.(io|com|gg|net|org)\b/i;

/**
 * The eight texts of a block, or the reasons it is not one. Blank lines and
 * the space around a line are ignored; every other line must be one label
 * and its text, and each label must come once.
 * @returns {{ copy: CopyTexts | null, problems: string[] }}
 */
export const parseCopy = (text) => {
  const labels = new Map(COPY_LINES);
  /** @type {Record<string, string>} */
  const copy = {};
  const problems = [];
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const at = line.indexOf(":");
      const field = at > 0 ? labels.get(line.slice(0, at)) : undefined;
      if (!field) {
        problems.push(
          `line ${i + 1} does not start with one of ${COPY_LINES.map(([l]) => `"${l}:"`).join(", ")}`,
        );
        return;
      }
      if (field in copy) {
        problems.push(`line ${i + 1}: "${line.slice(0, at)}" comes twice`);
        return;
      }
      copy[field] = line.slice(at + 1).trim();
    });
  for (const [label, field] of COPY_LINES) {
    if (!(field in copy)) problems.push(`no "${label}:" line`);
    else if (!copy[field]) problems.push(`the "${label}:" line is empty`);
  }
  return problems.length
    ? { copy: null, problems }
    : { copy: /** @type {CopyTexts} */ (copy), problems };
};

/**
 * Reasons a parsed block cannot post, or an empty list. `players` are the
 * game's playerNames (candidate.mjs).
 * @param {CopyTexts} copy
 * @param {string} gameId
 * @param {string[]} [players]
 */
export const copyProblems = (copy, gameId, players = []) => {
  const problems = textProblems(
    Object.fromEntries(
      COPY_LINES.map(([label, field]) => [label, copy[field]]),
    ),
    gameId,
    players,
  );
  if (xWeight(copy.x) > X_MAX_CHARS) {
    problems.push(
      `X is over ${X_MAX_CHARS} in X's count (an emoji or a non-Latin letter counts 2)`,
    );
  }
  // A URL in the text makes an X post cost $0.20 instead of $0.015 (task
  // e8d26610, Nil's decision of 2026-10-25), and X also reads bare domains.
  if (LINK.test(copy.x)) problems.push("X must not hold a link");
  // Growth's playbook: Instagram has no link (it is not clickable there).
  if (LINK.test(copy.instagram)) {
    problems.push("Instagram must not hold a link");
  }
  if (/#shorts\b/i.test(copy.youtubeTitle)) {
    problems.push(`YouTube title must not hold #Shorts: the app adds it`);
  }
  if (chars(copy.youtubeTitle + SHORTS_TAG) > YOUTUBE_TITLE_MAX_CHARS) {
    problems.push(
      `YouTube title is over ${YOUTUBE_TITLE_MAX_CHARS} characters with the "${SHORTS_TAG.trim()}" the app adds`,
    );
  }
  const bytes = Buffer.byteLength(copy.youtubeDescription, "utf8");
  if (bytes > YOUTUBE_DESCRIPTION_MAX_BYTES) {
    problems.push(
      `YouTube description is ${bytes} bytes; YouTube takes at most ${YOUTUBE_DESCRIPTION_MAX_BYTES}`,
    );
  }
  if (!copy.youtubeDescription.includes(YOUTUBE_LINK)) {
    problems.push(
      `YouTube description must hold the tracked link ${YOUTUBE_LINK}`,
    );
  }
  for (const [label, field] of [
    ["TikTok", "tiktok"],
    ["Instagram", "instagram"],
  ]) {
    if (chars(copy[field]) > CAPTION_MAX_CHARS) {
      problems.push(`${label} is over ${CAPTION_MAX_CHARS} characters`);
    }
  }
  // Growth Lead, 2026-10-26: Bluesky carries the tracked link; Facebook
  // and Threads start without one, and a link there is not refused. On all
  // three, a link must be the platform's tracked link, or the post log could
  // not tell where a visit came from.
  for (const [label, field] of COPY_LINES.filter(([, f]) =>
    ["facebook", "bluesky", "threads"].includes(f),
  )) {
    problems.push(...textLimitProblems(field, copy[field]));
    const urls = findUrls(copy[field]);
    // A bare "wallgame.io" becomes a link on these platforms too, but not
    // the tracked one: look for it in the text around the full URLs.
    const rest = urls.reduceRight(
      (text, { start, end }) => text.slice(0, start) + " " + text.slice(end),
      copy[field],
    );
    if (urls.some(({ url }) => url !== trackedLink(field)) || LINK.test(rest)) {
      problems.push(`${label} may hold only the link ${trackedLink(field)}`);
    }
  }
  if (findUrls(copy.threads).length > THREADS_MAX_LINKS) {
    problems.push(`Threads takes at most ${THREADS_MAX_LINKS} links`);
  }
  const tags = copy.instagram.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (tags.length > INSTAGRAM_MAX_HASHTAGS) {
    problems.push(
      `Instagram has ${tags.length} hashtags; at most ${INSTAGRAM_MAX_HASHTAGS} are allowed`,
    );
  }
  return problems;
};

/**
 * The block as Growth wrote it: the eight labelled lines, in order.
 * @param {CopyTexts} copy
 */
export const copyLines = (copy) =>
  COPY_LINES.map(([label, field]) => `${label}: ${copy[field]}`);

/**
 * The hash that binds an ask and an approval to a block: its eight texts
 * and its version, nothing else.
 * @param {Copy} copy
 */
export const copySha256 = (copy) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        ...COPY_LINES.map(([, field]) => copy[field]),
        copy.version,
      ]),
    )
    .digest("hex");

/**
 * What each platform posts, from an approved block.
 * @param {CopyTexts} copy
 */
export const postTexts = (copy) => ({
  x: copy.x,
  youtubeTitle: copy.youtubeTitle + SHORTS_TAG,
  youtubeDescription: copy.youtubeDescription,
  tiktok: copy.tiktok,
  instagram: copy.instagram,
  facebook: copy.facebook,
  bluesky: copy.bluesky,
  threads: copy.threads,
});
