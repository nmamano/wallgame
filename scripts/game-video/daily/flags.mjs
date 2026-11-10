/**
 * The flags of crew.mjs's commands, checked before a command runs (task
 * 8a9ea73f, Wall Game Director, 2026-11-08: `pick ... --dry-run` ignored
 * the flag it did not know and made 3 real items). As edl.mjs refuses an
 * unknown field, crew.mjs refuses an unknown flag or a stray word, so a
 * typo or a wished-for flag stops the command before it changes anything.
 *
 * A command's flags are one line of names: a plain name takes a value
 * (`--item ID`), a name with "!" is a switch (`--wait`), and a name with
 * "*" takes a value and may repeat (`--edl F --edl G`).
 */

/**
 * @typedef {"value" | "switch" | "list"} FlagKind
 */

/**
 * A command's flag line as a map of name to kind.
 * @param {string} line
 * @returns {Map<string, FlagKind>}
 */
export const parseFlagLine = (line) =>
  new Map(
    line
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => {
        const m = /^([a-z][a-z0-9-]*)([!*]?)$/.exec(word);
        if (!m) throw new Error(`a flag line holds names, got "${word}"`);
        const kind = m[2] === "!" ? "switch" : m[2] === "*" ? "list" : "value";
        return [m[1], /** @type {FlagKind} */ (kind)];
      }),
  );

/**
 * Every fault of a command's words against its flags, as lines; empty when
 * they are all good. `words` are the words after the command's name.
 * @param {string} command
 * @param {string[]} words
 * @param {Map<string, FlagKind>} spec
 * @returns {string[]}
 */
export const flagFaults = (command, words, spec) => {
  const faults = [];
  const seen = new Set();
  const takes = () =>
    spec.size === 0
      ? `${command} takes no flags`
      : `${command} takes ${[...spec.keys()].map((n) => `--${n}`).join(", ")}`;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!word.startsWith("--")) {
      faults.push(`"${word}" is not a flag or a flag's value; ${takes()}`);
      continue;
    }
    const name = word.slice(2);
    const kind = spec.get(name);
    if (!kind) {
      faults.push(`${command} has no flag --${name}; ${takes()}`);
      continue;
    }
    if (kind !== "list" && seen.has(name)) {
      faults.push(`--${name} is given twice`);
    }
    seen.add(name);
    if (kind === "switch") continue;
    const value = words[i + 1];
    if (value === undefined || /^--[a-z]/.test(value)) {
      faults.push(`--${name} needs a value`);
      continue;
    }
    i += 1;
  }
  return faults;
};
