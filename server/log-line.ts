/**
 * Per-move detail on the game and bot paths: every socket broadcast, every
 * eval-bar update, every timer that was scheduled. Off by default because
 * under bot load it was most of the log (task 0e0087af, 2026-11-03: 97,768
 * lines in 30 minutes for 56 bot games) and it hid the real events. Set it to
 * true in a local tree to trace one game step by step.
 */
export const LOG_MOVE_DETAIL = false;

const formatValue = (value: unknown): string =>
  typeof value === "string" && /^[^\s"=]+$/.test(value)
    ? value
    : JSON.stringify(value);

/**
 * One log line: the tag, then key=value for each field that is not undefined.
 * console.info with an object prints one line per field, which is what made a
 * routine event cost five to fifteen lines.
 */
export const logLine = (tag: string, fields: Record<string, unknown>): void => {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  console.info([tag, ...pairs].join(" "));
};

/** A detail line: printed only when LOG_MOVE_DETAIL is on. */
export const logDetail = (
  tag: string,
  fields: Record<string, unknown>,
): void => {
  if (LOG_MOVE_DETAIL) console.debug(tag, fields);
};
