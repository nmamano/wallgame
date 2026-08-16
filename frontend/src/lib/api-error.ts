/**
 * Turns an API error body into a sentence a player can read.
 *
 * The `error` field of an error body is NOT always a string, and the callers
 * that assumed it was printed the literal text "[object Object]" to the player
 * (board c8e27470; reproduced against a local server on 2026-08-16 by creating
 * an Animal Cycle game whose saved board was too small). A route that fails
 * `zValidator` answers with the ZodError itself:
 *
 *   {"success":false,"error":{"name":"ZodError","message":"[ ...issues... ]"}}
 *
 * The issue list is the useful part - the server had already written
 * "Animal Cycle Random Start requires both board dimensions to be at least 4."
 * and the client threw it away. This module keeps it.
 *
 * Only the issue MESSAGES are shown. A Zod issue also carries its `path`, but
 * a path is a field name in a request body, which tells a player nothing they
 * can act on.
 */

/** One entry of the JSON array that a serialized ZodError carries as `message`. */
interface ZodIssueLike {
  message?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The issue messages of a serialized ZodError, or null when `error` is not one.
 *
 * Returning null rather than an empty string keeps "not a ZodError" apart from
 * "a ZodError that explained nothing"; both fall back, but only the second is
 * worth noticing if it ever shows up.
 */
const zodIssueMessages = (error: unknown): string | null => {
  if (!isRecord(error) || typeof error.message !== "string") {
    return null;
  }
  let issues: unknown;
  try {
    issues = JSON.parse(error.message);
  } catch {
    // A non-JSON message is still a message: a plain Error serializes this way.
    return error.message.trim() || null;
  }
  if (!Array.isArray(issues)) {
    return null;
  }
  const messages = issues
    .map((issue: ZodIssueLike) =>
      isRecord(issue) && typeof issue.message === "string"
        ? issue.message.trim()
        : "",
    )
    .filter((message) => message.length > 0);
  // Two failing fields can carry the same complaint; saying it twice reads
  // like two separate problems.
  const unique = [...new Set(messages)];
  return unique.length > 0 ? unique.join(" ") : null;
};

/**
 * @param body the parsed error body, or null when it could not be parsed
 * @param status the HTTP status, used only for the last-resort text
 * @param statusText the HTTP status text, likewise
 */
export const messageFromApiErrorBody = (
  body: unknown,
  status: number,
  statusText: string,
): string => {
  const error = isRecord(body) ? body.error : undefined;

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  const fromZod = zodIssueMessages(error);
  if (fromZod) {
    return fromZod;
  }

  return `Request failed: ${status} ${statusText}`;
};
