/**
 * The name mask of the daily video (Nil, 2026-11-01, ask d3c35245: "Yes,
 * ALL games, no names"; 2026-10-29: "we should never show "Normal Bot" or
 * "Guest Ibex""). A daily frame names a seat only "Bot", "Human", "Red" or
 * "Blue" (edl.mjs dailySeatNames). The renderer gives the stage only those
 * names, and checks every daily frame with shownNames: a human seat's own
 * name (a member's account or a guest's) anywhere in the frame's state stops
 * the render. The state holds what changes from frame to frame (the names,
 * the caption, the overlay texts, the call to action, file paths); the
 * stage's fixed words are not in it. The render kit's own folder is the one
 * text not looked in (`ignore`): its path (/home/nilo/nil/...) holds "nil",
 * Nil's account name (z5S6UPIi, 2026-11-01: every frame of his game stopped
 * on it). Every other path, URL and text is read (Wall Game PM, 2026-11-01:
 * the guard stays strict for every other name).
 */

/**
 * The human seats' names that `state` carries, as whole words and in any
 * case; [] when it carries none. A name shorter than 3 characters is not
 * looked for: it would match ordinary words.
 * @param {unknown} state a stage state, as the renderer sends it
 * @param {string[]} names the human seats' display names
 * @param {string[]} [ignore] texts taken out before the search: the render
 *   kit's own folder
 * @returns {string[]}
 */
export const shownNames = (state, names, ignore = []) => {
  const text = ignore
    .filter((t) => t.length > 0)
    .reduce((s, t) => s.split(t).join(" "), JSON.stringify(state));
  return names.filter((name) => {
    const n = name.trim();
    if (n.length < 3) return false;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
      "iu",
    ).test(text);
  });
};
