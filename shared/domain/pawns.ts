/**
 * Accessors for `GamePawns`, the per-variant live pawn shape.
 *
 * Consumers should go through these rather than narrowing the union themselves.
 * Almost every call site wants one of two things - the cell of a given player's
 * pawn of a given type, or a deep copy - and both are one function here.
 */

import type {
  Cell,
  GamePawnType,
  GamePawns,
  PawnFamily,
  PawnType,
  PlayerId,
  Pawn,
  Variant,
} from "./game-types";

/**
 * Whether a player can ever move a pawn of this type.
 *
 * A classic home is drawn on the board and appears in `boardPawns`, but it is
 * a goal marker rather than something anyone moves. Interaction code must ask
 * this rather than testing for "mouse": before homes were typed honestly they
 * rode along in the mouse slot, so a mouse-only guard happened to cover them.
 */
export const isMovablePawnType = (
  type: PawnType | "wall",
): type is GamePawnType =>
  type === "dog" || type === "cat" || type === "mouse" || type === "elephant";

/**
 * Which live pawn shape a variant uses. Exhaustive over `Variant`: adding a
 * member to that union without deciding its pawn family is a compile error.
 */
export function pawnFamilyForVariant(variant: Variant): PawnFamily {
  switch (variant) {
    case "standard":
      return "standard";
    case "animal-cycle":
      return "animal-cycle";
    case "classic":
      return "classic";
    case "survival":
      return "survival";
    default: {
      const exhaustive: never = variant;
      throw new Error(`Unhandled variant: ${String(exhaustive)}`);
    }
  }
}

const cloneCell = (cell: Cell): Cell => [cell[0], cell[1]];

/**
 * The cell of a player's pawn, or undefined when that variant has no such pawn
 * (a classic player has no mouse; a survival player 1 has no mouse either).
 * Use where absence is meaningful; otherwise prefer `requirePawnCell`.
 */
export function pawnCell(
  pawns: GamePawns,
  playerId: PlayerId,
  type: PawnType,
): Cell | undefined {
  switch (pawns.kind) {
    case "animal-cycle":
      if (playerId === 1 && type === "cat") return pawns.pawns[1].cat;
      if (playerId === 1 && type === "elephant") return pawns.pawns[1].elephant;
      if (playerId === 2 && type === "mouse") return pawns.pawns[2].mouse;
      if (playerId === 2 && type === "dog") return pawns.pawns[2].dog;
      return undefined;
    case "standard":
      if (type === "cat") return pawns.pawns[playerId].cat;
      if (type === "mouse") return pawns.pawns[playerId].mouse;
      return undefined;
    case "classic":
      if (type === "cat") return pawns.pawns[playerId].cat;
      if (type === "home") return pawns.pawns[playerId].home;
      return undefined;
    case "survival":
      // Survival puts one cat and one mouse on the board: the cat is player 1's
      // and the mouse is player 2's. Neither player owns the other pawn.
      if (playerId === 1 && type === "cat") return pawns.cat;
      if (playerId === 2 && type === "mouse") return pawns.mouse;
      return undefined;
  }
}

/** True when this variant gives that player a pawn of that type. */
export function hasPawn(
  pawns: GamePawns,
  playerId: PlayerId,
  type: PawnType,
): boolean {
  return pawnCell(pawns, playerId, type) !== undefined;
}

/**
 * Like `pawnCell` but for sites that know the pawn exists. Throws rather than
 * returning undefined, so a variant/pawn mismatch surfaces at its source
 * instead of as an undefined read somewhere downstream.
 */
export function requirePawnCell(
  pawns: GamePawns,
  playerId: PlayerId,
  type: PawnType,
): Cell {
  const cell = pawnCell(pawns, playerId, type);
  if (!cell) {
    throw new Error(
      `Player ${playerId} has no ${type} pawn in a ${pawns.kind} game`,
    );
  }
  return cell;
}

/**
 * A copy of `pawns` with one pawn moved. Throws if that player has no pawn of
 * that type - it never silently no-ops, and never manufactures a slot that the
 * variant does not have.
 *
 * `type` is a `GamePawnType`, not a `PawnType`, so a classic home cannot be
 * moved through here at all. That exclusion has to live in the signature: a
 * home is a pawn the variant genuinely HAS, so `requirePawnCell` would happily
 * accept it and the goal would slide across the board.
 */
export function withPawnCell(
  pawns: GamePawns,
  playerId: PlayerId,
  type: GamePawnType,
  cell: Cell,
): GamePawns {
  requirePawnCell(pawns, playerId, type);
  const next = clonePawns(pawns);
  const moved = cloneCell(cell);
  switch (next.kind) {
    case "animal-cycle":
      if (playerId === 1 && type === "cat") next.pawns[1].cat = moved;
      else if (playerId === 1 && type === "elephant")
        next.pawns[1].elephant = moved;
      else if (playerId === 2 && type === "mouse") next.pawns[2].mouse = moved;
      else if (playerId === 2 && type === "dog") next.pawns[2].dog = moved;
      return next;
    case "standard":
      if (type === "cat") next.pawns[playerId].cat = moved;
      else next.pawns[playerId].mouse = moved;
      return next;
    case "classic":
      // Only a cat reaches this line: "home" is excluded by the signature and
      // "mouse" has already thrown in requirePawnCell. Assigning `cat`
      // outright, rather than falling through an `else` onto `home`, keeps the
      // goal unreachable even if either of those guards is later loosened.
      next.pawns[playerId].cat = moved;
      return next;
    case "survival":
      if (type === "cat") next.cat = moved;
      else next.mouse = moved;
      return next;
  }
}

/**
 * A deep copy. Cell arrays are copied too, so a snapshot never shares mutable
 * coordinates with the live state it was taken from.
 */
export function clonePawns(pawns: GamePawns): GamePawns {
  switch (pawns.kind) {
    case "animal-cycle":
      return {
        kind: "animal-cycle",
        pawns: {
          1: {
            cat: cloneCell(pawns.pawns[1].cat),
            elephant: cloneCell(pawns.pawns[1].elephant),
          },
          2: {
            mouse: cloneCell(pawns.pawns[2].mouse),
            dog: cloneCell(pawns.pawns[2].dog),
          },
        },
      };
    case "standard":
      return {
        kind: "standard",
        pawns: {
          1: {
            cat: cloneCell(pawns.pawns[1].cat),
            mouse: cloneCell(pawns.pawns[1].mouse),
          },
          2: {
            cat: cloneCell(pawns.pawns[2].cat),
            mouse: cloneCell(pawns.pawns[2].mouse),
          },
        },
      };
    case "classic":
      return {
        kind: "classic",
        pawns: {
          1: {
            cat: cloneCell(pawns.pawns[1].cat),
            home: cloneCell(pawns.pawns[1].home),
          },
          2: {
            cat: cloneCell(pawns.pawns[2].cat),
            home: cloneCell(pawns.pawns[2].home),
          },
        },
      };
    case "survival":
      return {
        kind: "survival",
        cat: cloneCell(pawns.cat),
        mouse: cloneCell(pawns.mouse),
      };
  }
}

/**
 * Everything the board draws, in a stable order.
 *
 * This is a rendering projection, not a list of movable pawns: a classic home
 * is included because the board shows it, and it is honestly typed "home" so
 * no caller has to remap it. Movability is a separate question, answered by
 * `GamePawnType`, which excludes "home".
 */
export function boardPawns(pawns: GamePawns): Pawn[] {
  switch (pawns.kind) {
    case "animal-cycle":
      return [
        { playerId: 1, type: "cat", cell: pawns.pawns[1].cat },
        { playerId: 1, type: "elephant", cell: pawns.pawns[1].elephant },
        { playerId: 2, type: "mouse", cell: pawns.pawns[2].mouse },
        { playerId: 2, type: "dog", cell: pawns.pawns[2].dog },
      ];
    case "standard":
      return [
        { playerId: 1, type: "cat", cell: pawns.pawns[1].cat },
        { playerId: 1, type: "mouse", cell: pawns.pawns[1].mouse },
        { playerId: 2, type: "cat", cell: pawns.pawns[2].cat },
        { playerId: 2, type: "mouse", cell: pawns.pawns[2].mouse },
      ];
    case "classic":
      return [
        { playerId: 1, type: "cat", cell: pawns.pawns[1].cat },
        { playerId: 1, type: "home", cell: pawns.pawns[1].home },
        { playerId: 2, type: "cat", cell: pawns.pawns[2].cat },
        { playerId: 2, type: "home", cell: pawns.pawns[2].home },
      ];
    case "survival":
      return [
        { playerId: 1, type: "cat", cell: pawns.cat },
        { playerId: 2, type: "mouse", cell: pawns.mouse },
      ];
  }
}
