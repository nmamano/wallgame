/**
 * A pawn may not step to a neighbour and back inside one submitted move.
 *
 * The rule "a pawn cannot immediately return to its previous cell" lived in
 * `applyMove` all along, but it compared against `this.previousPawnPosition` —
 * a field that is seeded only from a custom-setup turn and cleared at the end of
 * every move, and never updated between the two actions of one move. So for a
 * complete two-action move the rule was inert, and `applyMove` ACCEPTED a move
 * the game rules forbid. ACCEPTED, never legal: the engine has refused these
 * moves all along, which is the whole defect.
 *
 * Two things followed, and both are pinned below.
 *
 *   1. `moveToStandardNotation` writes a pawn's LAST target and drops the path.
 *      For a backtrack the last target is the cell the pawn already stands on,
 *      so the term names a square nothing moved to. The function's own comment
 *      depends on this being impossible. Four stored rows carry that term and
 *      cannot be replayed at all — they throw "Invalid move distance", because
 *      the term reads back as one action of distance 0.
 *   2. The server sends that same collapsed notation to the bot engine, the
 *      engine finds no path of length 0, and the server forfeits the game FOR
 *      THE BOT (`bgs-update-failed-after-human-move`). 17 bot games were ended
 *      that way between 2026-02-18 and 2026-08-09. The player saw a bot resign
 *      for no reason.
 *
 * The four sequences below are the real ones, lifted from the production rows
 * (board task 59a8c5a2; investigation in `showcase-500-investigation.md` Part 3,
 * artifacts captured 2026-08-09). `via` is an on-board neighbour that `applyMove`
 * accepted before this fix — checked on-board deliberately, because at the time
 * `applyMove` had no bounds check and would otherwise have accepted a step off
 * the edge. It has one now (board task d39862b4), so an off-board `via` would be
 * refused for the wrong reason; on-board is still what these cases need.
 */

import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import {
  moveFromStandardNotation,
  moveToStandardNotation,
} from "../../shared/domain/standard-notation";
import { timeControlConfigFromPreset } from "../../shared/domain/game-utils";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { requirePawnCell } from "../../shared/domain/pawns";
import type {
  Cell,
  GameConfiguration,
  GameInitialState,
  GamePawnType,
  Move,
  PlayerId,
  Variant,
} from "../../shared/domain/game-types";

const NO_RETURN = "A pawn cannot immediately return to its previous cell";

interface Incident {
  gameId: string;
  variant: Variant;
  board: number;
  pawn: GamePawnType;
  /** The term the stored row ends with — the one that names an occupied cell. */
  storedTerm: string;
  /** Where that pawn stood, and still stands after the backtrack. */
  home: Cell;
  /** The neighbour it stepped to and back from. */
  via: Cell;
  /** Every move of the real game except the last. */
  prefix: string[];
  initialState: GameInitialState;
}

const STANDARD_PAWNS = {
  pawns: {
    p1: { cat: [0, 0], mouse: [7, 0] },
    p2: { cat: [0, 7], mouse: [7, 7] },
  },
  walls: [],
} as unknown as GameInitialState;

const CLASSIC_PAWNS = {
  pawns: {
    p1: { cat: [0, 0], home: [7, 7] },
    p2: { cat: [0, 7], home: [7, 0] },
  },
  walls: [],
} as unknown as GameInitialState;

const INCIDENTS: Incident[] = [
  {
    gameId: "KqQmog6n",
    variant: "standard",
    board: 8,
    pawn: "cat",
    storedTerm: "Cc8",
    home: [0, 2],
    via: [1, 2],
    prefix: [
      "Ca6",
      "Ch6",
      "Cc6",
      ">c6.^c5",
      "Cb5",
      ">b5.^b4",
      "Ca4",
      ">a4.^a3",
      "Cb5",
      "Ch4",
      "Cb6.^h3",
      "Cf4",
      "Cb7.^f3",
      "Ce4.>b7",
      "Cc8",
      "Ce2",
    ],
    initialState: STANDARD_PAWNS,
  },
  {
    gameId: "rlC_1u9E",
    variant: "freestyle",
    board: 8,
    pawn: "mouse",
    storedTerm: "Ma8",
    home: [0, 0],
    via: [1, 0],
    prefix: [
      "Cc7",
      "Cg6",
      "Cd8",
      ">d8.^d7",
      "Cb8",
      "Cf6.^b7",
      "Ca7",
      "Cd6",
      "Ma8",
      "Cb6",
    ],
    initialState: {
      pawns: {
        p1: { cat: [0, 1], mouse: [2, 0] },
        p2: { cat: [0, 6], mouse: [2, 7] },
      },
      walls: [
        { cell: [1, 2], orientation: "horizontal" },
        { cell: [1, 5], orientation: "horizontal" },
        { cell: [3, 0], orientation: "horizontal" },
        { cell: [3, 7], orientation: "horizontal" },
        { cell: [5, 3], orientation: "horizontal" },
        { cell: [5, 4], orientation: "horizontal" },
        { cell: [6, 0], orientation: "horizontal" },
        { cell: [6, 7], orientation: "horizontal" },
      ],
    } as unknown as GameInitialState,
  },
  {
    gameId: "sMdVlUWP",
    variant: "classic",
    board: 8,
    pawn: "cat",
    storedTerm: "Cc6",
    home: [2, 2],
    via: [1, 2],
    prefix: [
      ">c6.^d5",
      "Ch6",
      ">d6.^d6",
      "Ch4",
      "Ca6",
      "Ch2",
      "Ca4",
      "Cg1",
      ">g2.>g1",
      "Ce1",
      ">a2.>a1",
      ">a4.^a3",
      "Cb5",
      ">b5.^b4",
      "Cc6",
      "Cc1",
      "^b1.^c1",
      "Cd2",
      "Cd7",
      "Cb2",
      ">b3.^b2",
      ">d8.>d7",
      "Cc6",
      "Cc3",
    ],
    initialState: CLASSIC_PAWNS,
  },
  {
    gameId: "gGw2b90Z",
    variant: "classic",
    board: 8,
    pawn: "cat",
    storedTerm: "Ce3",
    home: [5, 4],
    via: [4, 4],
    prefix: [
      "Ca6",
      "Cg8.>g1",
      "Cb5",
      "Cg6",
      ">f6.^g5",
      "Ch5",
      "Cc4",
      "Cf5",
      "Ce4",
      "Cf3",
      "Cg4",
      "Cf1",
      "Ch4.^f1",
      "^g2.^h2",
      "Cg3",
      ">f3.>f2",
      "Cf4",
      "Cd1",
      ">a2.>a1",
      ">e4.^f3",
      "Ce5",
      "Cb1",
      "Ce3",
      "Cb3",
    ],
    initialState: CLASSIC_PAWNS,
  },
];

const configFor = (incident: Incident): GameConfiguration => ({
  variant: incident.variant,
  randomStart: false,
  timeControl: timeControlConfigFromPreset("unlimited"),
  rated: false,
  boardWidth: incident.board,
  boardHeight: incident.board,
  variantConfig: incident.initialState,
});

/** Replay a stored move list the way `assembleReplayGame` does. */
const replay = (config: GameConfiguration, moves: string[]): GameState => {
  let state = new GameState(config, 0);
  moves.forEach((notation, index) => {
    state = state.applyGameAction({
      kind: "move",
      move: moveFromStandardNotation(notation, config.boardHeight),
      playerId: state.turn,
      timestamp: index + 1,
    });
  });
  return state;
};

const backtrackMove = (incident: Incident): Move => ({
  actions: [
    { type: incident.pawn, target: incident.via },
    { type: incident.pawn, target: incident.home },
  ],
});

describe("a backtrack inside one submitted move", () => {
  for (const incident of INCIDENTS) {
    describe(`${incident.gameId} (${incident.variant})`, () => {
      it("is refused", () => {
        const config = configFor(incident);
        const state = replay(config, incident.prefix);

        expect(() =>
          state.applyGameAction({
            kind: "move",
            move: backtrackMove(incident),
            playerId: state.turn,
            timestamp: 10_000,
          }),
        ).toThrow(NO_RETURN);
      });

      it("leaves the game exactly as it was", () => {
        const config = configFor(incident);
        const state = replay(config, incident.prefix);
        const turnBefore = state.turn;

        try {
          state.applyGameAction({
            kind: "move",
            move: backtrackMove(incident),
            playerId: state.turn,
            timestamp: 10_000,
          });
        } catch {
          // The refusal is asserted above. Here the point is what it did NOT do.
        }

        // `applyGameAction` works on a clone, so the refusal cannot half-write
        // the caller's state. Pinned because the whole class is a write that
        // should never have happened.
        expect(state.history).toHaveLength(incident.prefix.length);
        expect(state.moveCount).toBe(incident.prefix.length);
        expect(state.turn).toBe(turnBefore);
        expect(state.status).toBe("playing");
      });

      it("would have written the stored term that cannot be replayed", () => {
        // This is why refusing it matters, rather than merely being correct.
        // The move collapses to a term naming the cell the pawn already stands
        // on, which is byte-for-byte the term the stored row ends with.
        const collapsed = moveToStandardNotation(
          backtrackMove(incident),
          incident.board,
        );
        expect(collapsed).toBe(incident.storedTerm);

        // Read back, that term is one action of distance zero — the production
        // failure. Pinned so the link between the two is not folklore.
        const reparsed = moveFromStandardNotation(collapsed, incident.board);
        expect(reparsed.actions).toHaveLength(1);
        expect(reparsed.actions[0].target).toEqual(incident.home);

        const config = configFor(incident);
        const state = replay(config, incident.prefix);
        expect(() =>
          state.applyGameAction({
            kind: "move",
            move: reparsed,
            playerId: state.turn,
            timestamp: 10_000,
          }),
        ).toThrow("Invalid move distance");
      });

      it("collides with the same pawn's previous term, as the stored rows do", () => {
        // The fingerprint that identifies an affected row: the last term equals
        // the same seat's previous term for that pawn, because a backtrack ends
        // where the previous turn left the pawn.
        const head = incident.pawn === "cat" ? "C" : "M";
        const seat = incident.prefix.length % 2;
        const previous = incident.prefix
          .filter((_, index) => index % 2 === seat)
          .flatMap((ply) => ply.split("."))
          .filter((term) => term.startsWith(head))
          .at(-1);
        expect(previous).toBe(incident.storedTerm);
      });
    });
  }
});

describe("stored-history mode", () => {
  // Rows written before the rule was tightened hold backtracks, and replay
  // applies the same rules. 20 stored rows would stop replaying without this
  // mode (measured 2026-08-09, 23 backtrack plies across 20 games). Replay is a
  // reader, not a referee: its job is to show what happened.
  const config: GameConfiguration = {
    variant: "standard",
    randomStart: false,
    timeControl: timeControlConfigFromPreset("unlimited"),
    rated: false,
    boardWidth: 8,
    boardHeight: 8,
    variantConfig: buildStandardInitialState(8, 8),
  };

  /** p1's cat steps to a neighbour and straight back. */
  const p1Backtrack = (from: Cell, via: Cell): Move => ({
    actions: [
      { type: "cat", target: via },
      { type: "cat", target: from },
    ],
  });

  const catCell = (state: GameState, player: PlayerId): Cell =>
    requirePawnCell(state.pawns, player, "cat");

  it("is off by default, so live play refuses a backtrack", () => {
    const state = new GameState(config, 0);
    const from = catCell(state, 1);
    expect(() =>
      state.applyGameAction({
        kind: "move",
        move: p1Backtrack(from, [from[0] + 1, from[1]]),
        playerId: 1,
        timestamp: 1,
      }),
    ).toThrow(NO_RETURN);
  });

  it("survives clone, so a relaxed state accepts a backtrack at all", () => {
    // `applyGameAction` validates on `this.clone()`, and `clone()` rebuilds the
    // state through the constructor. If the mode were not carried through that
    // constructor call it would be dropped on EVERY apply, and this throws.
    const state = new GameState(config, 0, {
      allowStoredHistoryBacktracks: true,
    });
    const from = catCell(state, 1);
    const next = state.applyGameAction({
      kind: "move",
      move: p1Backtrack(from, [from[0] + 1, from[1]]),
      playerId: 1,
      timestamp: 1,
    });
    expect(next.history).toHaveLength(1);
    expect(catCell(next, 1)).toEqual(from);
  });

  it("survives a second consecutive apply, so the returned clone keeps it too", () => {
    const state = new GameState(config, 0, {
      allowStoredHistoryBacktracks: true,
    });
    const p1From = catCell(state, 1);
    const afterP1 = state.applyGameAction({
      kind: "move",
      move: p1Backtrack(p1From, [p1From[0] + 1, p1From[1]]),
      playerId: 1,
      timestamp: 1,
    });

    const p2From = catCell(afterP1, 2);
    const afterP2 = afterP1.applyGameAction({
      kind: "move",
      move: {
        actions: [
          { type: "cat", target: [p2From[0] + 1, p2From[1]] },
          { type: "cat", target: p2From },
        ],
      },
      playerId: 2,
      timestamp: 2,
    });

    expect(afterP2.history).toHaveLength(2);
    expect(catCell(afterP2, 2)).toEqual(p2From);
  });

  it("relaxes only the within-move rule, never the seeded one", () => {
    // A custom-setup turn that already spent one pawn action seeds
    // `previousPawnPosition`. That restriction is a real rule about a real
    // previous move, and stored-history mode must not touch it.
    const seeded: GameConfiguration = {
      variant: "custom-setup-standard",
      randomStart: false,
      timeControl: timeControlConfigFromPreset("unlimited"),
      rated: false,
      boardWidth: 8,
      boardHeight: 8,
      variantConfig: {
        pawns: {
          p1: { cat: [3, 3], mouse: [7, 0] },
          p2: { cat: [0, 7], mouse: [7, 7] },
        },
        walls: [],
        turn: {
          playerId: 1,
          actionsTaken: [{ type: "cat", source: [3, 2], target: [3, 3] }],
        },
      } as unknown as GameInitialState,
    };

    const state = new GameState(seeded, 0, {
      allowStoredHistoryBacktracks: true,
    });
    expect(() =>
      state.applyGameAction({
        kind: "move",
        move: { actions: [{ type: "cat", target: [3, 2] }] },
        playerId: 1,
        timestamp: 1,
      }),
    ).toThrow(NO_RETURN);
  });
});
