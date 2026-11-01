/**
 * The name mask of the daily video (Nil, 2026-11-01, ask d3c35245: "Yes,
 * ALL games, no names"; 2026-10-29: "we should never show "Normal Bot" or
 * "Guest Ibex""). A daily frame names a seat only "Bot", "Human", "Red" or
 * "Blue" (edl.mjs dailySeatNames). The renderer gives the stage only those
 * names, and checks every daily frame with shownNames: a human seat's own
 * name (a member's account or a guest's) anywhere in the frame's state stops
 * the render. The state holds what changes from frame to frame (the names,
 * the caption, the overlay texts, the call to action, file paths); the
 * stage's fixed words are not in it.
 */

/**
 * The human seats' names that `state` carries, as whole words and in any
 * case; [] when it carries none. A name shorter than 3 characters is not
 * looked for: it would match ordinary words.
 * @param {unknown} state a stage state, as the renderer sends it
 * @param {string[]} names the human seats' display names
 * @returns {string[]}
 */
export const shownNames = (state, names) => {
  const text = JSON.stringify(state);
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
