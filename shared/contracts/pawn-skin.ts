import { z } from "zod";
import { isBuiltInPawnStyle, type PawnStyleType } from "../domain/pawn-styles";

/**
 * A pawn skin that a player or a bot sends: "default", or a pawn file the site
 * ships (see builtInPawnPath). The server sends the skin to the opponent and
 * to spectators, and stores it for replays, so a free string here would be a
 * URL that every viewer's browser loads (board task 6a245eee).
 */
export const pawnSkinError = (type: PawnStyleType): string =>
  `must be "default" or the name of one of the site's ${type} pawns`;

export const pawnSkinSchema = (type: PawnStyleType) =>
  z
    .string()
    .trim()
    .max(64)
    .refine((skin) => isBuiltInPawnStyle(skin, type), {
      error: pawnSkinError(type),
    });
