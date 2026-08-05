/**
 * The shape of an anonymous player id.
 *
 * One definition, used by the browser that mints the id, by the request
 * schemas that accept it, and (as a native `uuid` column) by the database that
 * stores it. Three validations that could drift are worse than one that cannot.
 *
 * **This id is correlation telemetry. It is not authentication, and it is not
 * evidence about anything else on its row.** It comes from the visitor's own
 * browser, so anyone can send anything - which is fine for counting how many
 * distinct people played and whether they came back, and useless for anything
 * that must not be forged. It sits beside `user_id` on rows where the player
 * was signed in; that adjacency is what lets us ask "did this guest later make
 * an account", and it does NOT make the id a claim about that account.
 * Contrast `games.puzzle_id`, which is written only from the row the server
 * itself resolved - that is what unforgeable looks like, and this is not it.
 */

/** A canonical v4 UUID: lowercase hex, version nibble 4, variant 8/9/a/b. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isAnonymousId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/** The pattern itself, for request schemas that validate rather than narrow. */
export const ANONYMOUS_ID_PATTERN = UUID_V4;
