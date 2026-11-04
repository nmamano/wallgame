import { describe, expect, it } from "bun:test";
import { GameState } from "../../../shared/domain/game-state";
import type {
  Action,
  Cell,
  GameConfiguration,
  WallPosition,
} from "../../../shared/domain/game-types";
import { buildStandardInitialState } from "../../../shared/domain/standard-setup";
import { computeLastMoveDiffs } from "./gameViewModel";
import { pawnMoveArrows } from "./move-arrows";

const standard = (walls: WallPosition[] = []): GameConfiguration => ({
  timeControl: { initialSeconds: 600, incrementSeconds: 0, preset: "rapid" },
  variant: "standard",
  randomStart: false,
  rated: false,
  boardWidth: 5,
  boardHeight: 5,
  variantConfig: { ...buildStandardInitialState(5, 5), walls },
});

/** Player 1's cat (a5, [0,0]) steps to [1,0] and then to [1,1]: down first. */
const downThenRight: Action[] = [
  { type: "cat", target: [1, 0] },
  { type: "cat", target: [1, 1] },
];

/** The corner of the last-move arrow once the cat's move is played. */
const playedCorner = (config: GameConfiguration, target: Cell) =>
  computeLastMoveDiffs(
    new GameState(config, 0).applyGameAction({
      kind: "move",
      playerId: 1,
      move: { actions: [{ type: "cat", target }] },
      timestamp: 1,
    }),
  )![0].via;

describe("pawnMoveArrows", () => {
  it("turns a premoved diagonal 2-step around a wall, as the played move does", () => {
    // The wall right of a5 shuts the row corner b5, so the cat turns at a4.
    const config = standard([{ cell: [0, 0], orientation: "vertical" }]);
    const arrows = pawnMoveArrows(
      new GameState(config, 0),
      downThenRight,
      1,
      "premoved",
    );
    expect(arrows).toEqual([
      { from: [0, 0], to: [1, 1], via: [1, 0], type: "premoved" },
    ]);
    expect(arrows[0].via).toEqual(playedCorner(config, [1, 1]));
  });

  it("turns at the rule's corner, not the clicked one, when both are open", () => {
    // Clicked down first, but the played move's arrow turns along the row
    // first (moveArrowCorner), so the premove arrow does too.
    const config = standard();
    const [arrow] = pawnMoveArrows(
      new GameState(config, 0),
      downThenRight,
      1,
      "staged",
    );
    expect(arrow.via).toEqual([0, 1]);
    expect(arrow.via).toEqual(playedCorner(config, [1, 1]));
  });

  it("gives a straight move no corner", () => {
    const [arrow] = pawnMoveArrows(
      new GameState(standard(), 0),
      [
        { type: "cat", target: [0, 1] },
        { type: "cat", target: [0, 2] },
      ],
      1,
      "best-move",
    );
    expect(arrow).toEqual({ from: [0, 0], to: [0, 2], type: "best-move" });
  });
});
