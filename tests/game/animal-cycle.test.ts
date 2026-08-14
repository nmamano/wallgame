import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import { buildAnimalCycleInitialState } from "../../shared/domain/animal-cycle-setup";
import {
  moveFromStandardNotation,
  moveToStandardNotation,
} from "../../shared/domain/standard-notation";
import type {
  AnimalCycleInitialState,
  Cell,
  GameConfiguration,
  GamePawnType,
  Move,
  PlayerId,
} from "../../shared/domain/game-types";
import { pawnCell } from "../../shared/domain/pawns";
import {
  clearAllSessions,
  handleEvaluatePosition,
  handleStartGameSession,
} from "../../official-custom-bot-client/src/dumb-bot";

const config = (
  pawns: AnimalCycleInitialState["pawns"] = buildAnimalCycleInitialState(8, 8)
    .pawns,
): GameConfiguration => ({
  variant: "animal-cycle",
  boardWidth: 8,
  boardHeight: 8,
  rated: false,
  timeControl: {
    initialSeconds: 180,
    incrementSeconds: 2,
    preset: "blitz",
  },
  variantConfig: { pawns, walls: [] },
});

const act = (
  state: GameState,
  playerId: PlayerId,
  actions: Move["actions"],
): GameState =>
  state.applyGameAction({
    kind: "move",
    move: { actions },
    playerId,
    timestamp: 1_000,
  });

const to = (type: GamePawnType, target: Cell) => ({ type, target }) as const;

interface CaptureCase {
  name: string;
  playerId: PlayerId;
  mover: GamePawnType;
  from: Cell;
  target: Cell;
  winner: PlayerId;
  pawns: AnimalCycleInitialState["pawns"];
}

const legalCaptures: CaptureCase[] = [
  {
    name: "Dog captures Cat",
    playerId: 1,
    mover: "dog",
    from: [2, 1],
    target: [2, 2],
    winner: 1,
    pawns: {
      p1: { dog: [2, 1], mouse: [7, 0] },
      p2: { cat: [2, 2], elephant: [7, 7] },
    },
  },
  {
    name: "Cat captures Mouse",
    playerId: 2,
    mover: "cat",
    from: [2, 2],
    target: [2, 1],
    winner: 2,
    pawns: {
      p1: { dog: [0, 0], mouse: [2, 1] },
      p2: { cat: [2, 2], elephant: [7, 7] },
    },
  },
  {
    name: "Mouse captures Elephant",
    playerId: 1,
    mover: "mouse",
    from: [2, 1],
    target: [2, 2],
    winner: 1,
    pawns: {
      p1: { dog: [0, 0], mouse: [2, 1] },
      p2: { cat: [0, 7], elephant: [2, 2] },
    },
  },
  {
    name: "Elephant captures Dog",
    playerId: 2,
    mover: "elephant",
    from: [2, 2],
    target: [2, 1],
    winner: 2,
    pawns: {
      p1: { dog: [2, 1], mouse: [7, 0] },
      p2: { cat: [0, 7], elephant: [2, 2] },
    },
  },
];

const preyOntoPredator: CaptureCase[] = [
  {
    name: "Cat moves onto Dog; Dog owner wins",
    playerId: 2,
    mover: "cat",
    from: [2, 2],
    target: [2, 1],
    winner: 1,
    pawns: {
      p1: { dog: [2, 1], mouse: [7, 0] },
      p2: { cat: [2, 2], elephant: [7, 7] },
    },
  },
  {
    name: "Mouse moves onto Cat; Cat owner wins",
    playerId: 1,
    mover: "mouse",
    from: [2, 1],
    target: [2, 2],
    winner: 2,
    pawns: {
      p1: { dog: [0, 0], mouse: [2, 1] },
      p2: { cat: [2, 2], elephant: [7, 7] },
    },
  },
  {
    name: "Elephant moves onto Mouse; Mouse owner wins",
    playerId: 2,
    mover: "elephant",
    from: [2, 2],
    target: [2, 1],
    winner: 1,
    pawns: {
      p1: { dog: [0, 0], mouse: [2, 1] },
      p2: { cat: [0, 7], elephant: [2, 2] },
    },
  },
  {
    name: "Dog moves onto Elephant; Elephant owner wins",
    playerId: 1,
    mover: "dog",
    from: [2, 1],
    target: [2, 2],
    winner: 2,
    pawns: {
      p1: { dog: [2, 1], mouse: [7, 0] },
      p2: { cat: [0, 7], elephant: [2, 2] },
    },
  },
];

describe("Animal Cycle", () => {
  it.each([
    { boardWidth: 8, boardHeight: 8 },
    { boardWidth: 5, boardHeight: 10 },
  ])(
    "starts each player's animals in opposite corners on a $boardWidth x $boardHeight board",
    ({ boardWidth, boardHeight }) => {
      expect(buildAnimalCycleInitialState(boardWidth, boardHeight)).toEqual({
        pawns: {
          p1: {
            dog: [boardHeight - 1, 0],
            mouse: [0, boardWidth - 1],
          },
          p2: {
            cat: [0, 0],
            elephant: [boardHeight - 1, boardWidth - 1],
          },
        },
        walls: [],
      });
    },
  );

  for (const edge of legalCaptures) {
    it(`ends immediately when action 1 creates ${edge.name}`, () => {
      const before = new GameState(config(edge.pawns), 0);
      before.turn = edge.playerId;
      const after = act(before, edge.playerId, [to(edge.mover, edge.target)]);

      expect(after.status).toBe("finished");
      expect(after.result).toEqual({ winner: edge.winner, reason: "capture" });
      expect(after.turn).toBe(edge.playerId);
      expect(after.history).toHaveLength(1);
      expect(after.history[0].move.actions).toEqual([
        to(edge.mover, edge.target),
      ]);
    });
  }

  for (const edge of preyOntoPredator) {
    it(edge.name, () => {
      const before = new GameState(config(edge.pawns), 0);
      before.turn = edge.playerId;
      const after = act(before, edge.playerId, [to(edge.mover, edge.target)]);

      // Winner derives from predator ownership, never from the moving prey.
      expect(after.result).toEqual({ winner: edge.winner, reason: "capture" });
      expect(after.result?.winner).not.toBe(edge.playerId);
    });
  }

  it("does not treat Dog and Mouse teammate overlap as a capture", () => {
    const state = new GameState(
      config({
        p1: { dog: [2, 1], mouse: [2, 2] },
        p2: { cat: [0, 7], elephant: [7, 7] },
      }),
      0,
    );
    const after = act(state, 1, [to("dog", [2, 2])]);
    expect(after.status).toBe("playing");
    expect(after.result).toBeUndefined();
  });

  it("does not treat Cat and Elephant teammate overlap as a capture", () => {
    const state = new GameState(
      config({
        p1: { dog: [0, 0], mouse: [7, 0] },
        p2: { cat: [2, 2], elephant: [2, 1] },
      }),
      0,
    );
    state.turn = 2;
    const after = act(state, 2, [to("elephant", [2, 2])]);
    expect(after.status).toBe("playing");
    expect(after.result).toBeUndefined();
  });

  it("keeps action 1's predator owner as winner and omits hostile action 2", () => {
    const state = new GameState(
      config({
        p1: { dog: [2, 1], mouse: [4, 1] },
        p2: { cat: [2, 2], elephant: [4, 2] },
      }),
      0,
    );
    const after = act(state, 1, [to("dog", [2, 2]), to("mouse", [4, 2])]);

    expect(after.result).toEqual({ winner: 1, reason: "capture" });
    expect(pawnCell(after.pawns, 1, "mouse")).toEqual([4, 1]);
    expect(after.history[0].move.actions).toEqual([to("dog", [2, 2])]);
    expect(moveToStandardNotation(after.history[0].move, 8)).toBe("Dc6");
    expect(() => act(after, 1, [])).toThrow("Game is not playing");
  });

  it("keeps the stationary predator owner when prey action 1 precedes a reversing action 2", () => {
    const pawns: AnimalCycleInitialState["pawns"] = {
      p1: { dog: [2, 1], mouse: [3, 2] },
      p2: { cat: [2, 2], elephant: [7, 7] },
    };
    const state = new GameState(config(pawns), 0);
    const after = act(state, 1, [to("mouse", [2, 2]), to("dog", [2, 2])]);

    // Action 1 moves P1's prey onto P2's stationary Cat. P2 wins as the
    // predator owner. If action 2 ran, P1's Dog would capture that Cat and
    // displace the first result.
    expect(after.result).toEqual({ winner: 2, reason: "capture" });
    expect(pawnCell(after.pawns, 1, "mouse")).toEqual([2, 2]);
    expect(pawnCell(after.pawns, 1, "dog")).toEqual([2, 1]);
    expect(after.history[0].move.actions).toEqual([to("mouse", [2, 2])]);
    expect(moveToStandardNotation(after.history[0].move, 8)).toBe("Mc6");

    const replay = new GameState(config(pawns), 0);
    const replayed = act(replay, 1, moveFromStandardNotation("Mc6", 8).actions);
    expect(replayed.result).toEqual({ winner: 2, reason: "capture" });
    expect(pawnCell(replayed.pawns, 1, "dog")).toEqual([2, 1]);
    expect(replayed.history[0].move.actions).toEqual([to("mouse", [2, 2])]);
  });

  it("records both actions when action 2 is the first capture", () => {
    const state = new GameState(
      config({
        p1: { dog: [2, 0], mouse: [4, 1] },
        p2: { cat: [2, 2], elephant: [4, 2] },
      }),
      0,
    );
    const after = act(state, 1, [to("dog", [2, 1]), to("mouse", [4, 2])]);
    expect(after.result).toEqual({ winner: 1, reason: "capture" });
    expect(after.history[0].move.actions).toHaveLength(2);
  });

  it("round-trips Dog and Elephant notation", () => {
    const move: Move = {
      actions: [to("dog", [2, 2]), to("elephant", [4, 3])],
    };
    const notation = moveToStandardNotation(move, 8);
    expect(notation).toBe("Dc6.Ed4");
    expect(moveFromStandardNotation(notation, 8)).toEqual(move);
  });

  it("lets the built-in naive bot choose either owned animal and take a capture", () => {
    clearAllSessions();
    const initialState: AnimalCycleInitialState = {
      pawns: {
        p1: { dog: [0, 0], mouse: [7, 0] },
        p2: { cat: [0, 2], elephant: [7, 7] },
      },
      walls: [],
    };
    const started = handleStartGameSession({
      type: "start_game_session",
      bgsId: "animal-cycle-naive",
      botId: "naive-cycle",
      config: {
        variant: "animal-cycle",
        boardWidth: 8,
        boardHeight: 8,
        initialState,
      },
    });
    expect(started.success).toBe(true);

    const evaluated = handleEvaluatePosition({
      type: "evaluate_position",
      bgsId: "animal-cycle-naive",
      expectedPly: 0,
    });
    expect(evaluated.success).toBe(true);
    expect(evaluated.bestMove).toBe("Dc8");
  });
});
