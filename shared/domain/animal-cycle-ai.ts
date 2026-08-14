import type {
  Action,
  Cell,
  GamePawnType,
  GamePawns,
  Move,
  PlayerId,
} from "./game-types";
import { cellEq } from "./game-utils";
import { animalCycleTeammateCell } from "./animal-cycle";

type AnimalCyclePawns = Extract<GamePawns, { kind: "animal-cycle" }>;

interface GridView {
  distance: (a: Cell, b: Cell) => number;
  accessibleNeighbors: (cell: Cell) => Cell[];
}

const optionsFor = (
  pawns: AnimalCyclePawns,
  playerId: PlayerId,
): { type: GamePawnType; from: Cell; prey: Cell; predator: Cell }[] =>
  playerId === 1
    ? [
        {
          type: "dog",
          from: pawns.pawns[1].dog,
          prey: pawns.pawns[2].cat,
          predator: pawns.pawns[2].elephant,
        },
        {
          type: "mouse",
          from: pawns.pawns[1].mouse,
          prey: pawns.pawns[2].elephant,
          predator: pawns.pawns[2].cat,
        },
      ]
    : [
        {
          type: "cat",
          from: pawns.pawns[2].cat,
          prey: pawns.pawns[1].mouse,
          predator: pawns.pawns[1].dog,
        },
        {
          type: "elephant",
          from: pawns.pawns[2].elephant,
          prey: pawns.pawns[1].dog,
          predator: pawns.pawns[1].mouse,
        },
      ];

/** A deterministic, training-free policy for explicitly advertised naive bots. */
export function computeAnimalCycleNaiveMove(
  grid: GridView,
  pawns: AnimalCyclePawns,
  playerId: PlayerId,
): Move {
  let best: { action: Action; score: number } | undefined;

  for (const piece of optionsFor(pawns, playerId)) {
    const teammate = animalCycleTeammateCell(pawns, playerId, piece.type);
    const reachable = new Map<string, Cell>();
    for (const first of grid.accessibleNeighbors(piece.from)) {
      if (cellEq(first, teammate)) continue;
      reachable.set(`${first[0]}:${first[1]}`, first);
      for (const second of grid.accessibleNeighbors(first)) {
        if (!cellEq(second, piece.from) && !cellEq(second, teammate)) {
          reachable.set(`${second[0]}:${second[1]}`, second);
        }
      }
    }

    for (const target of reachable.values()) {
      // Moving prey onto its predator loses immediately, so the naive policy
      // never volunteers that move unless the target is also its own prey.
      if (cellEq(target, piece.predator) && !cellEq(target, piece.prey))
        continue;
      const distance = grid.distance(target, piece.prey);
      if (distance < 0) continue;
      const score = cellEq(target, piece.prey) ? -1_000 : distance;
      if (!best || score < best.score) {
        best = { action: { type: piece.type, target }, score };
      }
    }
  }

  return best ? { actions: [best.action] } : { actions: [] };
}
