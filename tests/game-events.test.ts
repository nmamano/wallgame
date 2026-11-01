/**
 * The `game_first_move` event (task 8ec46ee4): sent once per game id, only
 * after this browser's seated player made their own first move, which this
 * page saw happen; never for a spectator, a replay, a puzzle or a browser with
 * no seat; with variant, opponent and board, and no user or game id. And
 * `eval_bar_on` (task 72e72e0c) describes the game the same way.
 */

import { describe, it, expect } from "bun:test";
import {
  EVAL_BAR_ON_EVENT,
  GAME_FIRST_MOVE_EVENT,
  gameParams,
  firstMovePhase,
  hasMoved,
  takeFirstMoveEvent,
  type FirstMoveView,
} from "../frontend/src/lib/game-events";
import type { PlayerId } from "../shared/domain/game-types";

/** An ordinary storage that remembers what it is told. */
function workingStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

/** A state with `moves` moves made and `turn` on turn. */
function state(moves: number, turn: PlayerId) {
  return {
    history: Array.from({ length: moves }, () => ({})),
    turn,
    config: { variant: "standard", boardWidth: 8, boardHeight: 8 },
  } as unknown as NonNullable<FirstMoveView["state"]>;
}

/** Player 1 is this browser's seat; it moves first. */
function view(over: Partial<FirstMoveView> = {}): FirstMoveView {
  return {
    gameId: "g1",
    state: state(1, 2),
    playerId: 1,
    isReadOnly: false,
    isPuzzle: false,
    opponent: "bot",
    ...over,
  };
}

describe("hasMoved", () => {
  it("knows who moved from the turn: turns alternate", () => {
    expect(hasMoved(state(0, 1), 1)).toBe(false);
    // One move, player 1 on turn: the opponent moved first.
    expect(hasMoved(state(1, 1), 1)).toBe(false);
    expect(hasMoved(state(1, 2), 1)).toBe(true);
    expect(hasMoved(state(2, 1), 1)).toBe(true);
    expect(hasMoved(state(2, 2), 2)).toBe(true);
  });
});

describe("game_first_move", () => {
  it("is named for GA4 (snake_case, at most 40 characters)", () => {
    expect(GAME_FIRST_MOVE_EVENT).toBe("game_first_move");
    expect(GAME_FIRST_MOVE_EVENT.length).toBeLessThanOrEqual(40);
  });

  it("is sent after the seated player's own first move, with three params and no id", () => {
    const params = takeFirstMoveEvent({
      view: view({ opponent: "human" }),
      sawBefore: true,
      session: workingStorage(),
    });
    expect(params).toEqual({
      variant: "standard",
      opponent: "human",
      board: "8x8",
    });
  });

  it("is sent once per game id: a second look or a new first move after a takeback sends nothing", () => {
    const session = workingStorage();
    expect(
      takeFirstMoveEvent({ view: view(), sawBefore: true, session }),
    ).not.toBeNull();
    expect(
      takeFirstMoveEvent({ view: view(), sawBefore: true, session }),
    ).toBeNull();
    // Another game (a rematch has a new id) is its own.
    expect(
      takeFirstMoveEvent({
        view: view({ gameId: "g2" }),
        sawBefore: true,
        session,
      }),
    ).not.toBeNull();
  });

  it("is not sent for a game already under way when the page opened (a reload, a second tab)", () => {
    expect(
      takeFirstMoveEvent({
        view: view(),
        sawBefore: false,
        session: workingStorage(),
      }),
    ).toBeNull();
  });

  it("is not sent after the opponent's first move alone", () => {
    const v = view({ state: state(1, 1) });
    expect(firstMovePhase(v)).toBe("before");
    expect(
      takeFirstMoveEvent({
        view: v,
        sawBefore: true,
        session: workingStorage(),
      }),
    ).toBeNull();
  });

  it("is never sent to a spectator, a replay, a puzzle or a browser with no seat", () => {
    for (const over of [
      { isReadOnly: true }, // spectator or replay
      { isPuzzle: true },
      { playerId: null },
      { state: null },
    ] as Partial<FirstMoveView>[]) {
      expect(firstMovePhase(view(over))).toBe("none");
      expect(
        takeFirstMoveEvent({
          view: view(over),
          sawBefore: true,
          session: workingStorage(),
        }),
      ).toBeNull();
    }
  });

  it("is still sent once when session storage refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(
      takeFirstMoveEvent({ view: view(), sawBefore: true, session: refusing }),
    ).not.toBeNull();
    expect(
      takeFirstMoveEvent({ view: view(), sawBefore: true, session: undefined }),
    ).not.toBeNull();
  });
});

describe("eval_bar_on", () => {
  it("is named for GA4 and describes the game as game_first_move does", () => {
    expect(EVAL_BAR_ON_EVENT).toBe("eval_bar_on");
    expect(EVAL_BAR_ON_EVENT.length).toBeLessThanOrEqual(40);
    expect(
      gameParams({ variant: "classic", boardWidth: 9, boardHeight: 7 }),
    ).toEqual({ variant: "classic", board: "9x7" });
  });
});

describe("game_first_move before the snapshot (Reviewer 1, L1)", () => {
  it("waits, unmarked, while the opponent is not known; then sends once", () => {
    const session = workingStorage();
    const unknown = view({ opponent: null });
    expect(firstMovePhase(unknown)).toBe("after");
    expect(
      takeFirstMoveEvent({ view: unknown, sawBefore: true, session }),
    ).toBeNull();
    // The snapshot comes: the bot game is counted as one, once.
    expect(
      takeFirstMoveEvent({ view: view(), sawBefore: true, session }),
    ).toEqual({ variant: "standard", opponent: "bot", board: "8x8" });
    expect(
      takeFirstMoveEvent({ view: view(), sawBefore: true, session }),
    ).toBeNull();
  });
});
