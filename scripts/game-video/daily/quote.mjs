/**
 * Text quoted line by line, for a message or a terminal: Nil's review notes
 * in the director's message (review.mjs) and in crew.mjs. Its own module,
 * so crew.mjs does not import the review page's module (Video Reviewer 2,
 * 2026-10-28).
 */

/**
 * Text as quote lines, word for word: "> " before each of its lines (an
 * empty line is "> "), so a message shows Nil's paragraphs as he wrote
 * them (Nil, 2026-10-28: "I'm seeing a bunch of "\n" right now").
 */
export const quoteLines = (text, indent = "") =>
  text.split(/\r?\n/).map((line) => `${indent}> ${line}`);
