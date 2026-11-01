/**
 * A ply as wallgame.io's move list numbers it: both players' turns share one
 * number, "4." for the first player and "4..." for the second
 * (formattedHistory in frontend/src/hooks/use-game-page-controller.ts). Every
 * "move N" a person reads (the daily app's facts, the semantics tables, the
 * flashback's MOVE N) uses this count; ply + 1 is only arithmetic.
 * @param {number} ply 0-based index into the game's move list
 * @returns {number}
 */
export const siteMoveNumber = (ply) => Math.floor(ply / 2) + 1;
/**
 * @param {number} ply
 * @returns {string}
 */
export const siteMove = (ply) =>
  `${siteMoveNumber(ply)}${ply % 2 === 0 ? "." : "..."}`;
