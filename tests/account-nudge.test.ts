/**
 * The post-game account nudge: who gets offered an account, who does not, and
 * what a finish consumes even when nobody is offered anything.
 *
 * No browser needed: both storages are injected, which is also the only way to
 * reach the interesting failures. A real `localStorage` cannot be asked to
 * accept a write and silently drop it, and that case is precisely the one that
 * would turn a nudge shown once into a nudge shown after every game.
 *
 * The suppression reasons are asserted rather than just "nothing was shown".
 * Two rules that both suppress are indistinguishable from a boolean, so a
 * boolean assertion would keep passing with one of them broken.
 */

import { describe, it, expect } from "bun:test";
import {
  isPlayedGameFinish,
  markShownThisSession,
  recordFinishAndDecide,
  recordPlayedGame,
  type GameFinish,
} from "../frontend/src/lib/account-nudge";
import type { IdStorage } from "../frontend/src/lib/anonymous-id";
import type { PlayerId } from "../shared/domain/game-types";

const FIRST_GAME_KEY = "wall-game-first-finished-game";
const SHOWN_KEY = "wall-game-account-nudge-shown";

/** An ordinary storage that remembers what it is told. */
function workingStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    /** For asserting on what a run left behind, or did not. */
    dump: () => Object.fromEntries(map),
  };
}

/** Storage that throws on contact, as some privacy modes do. */
function throwingStorage(): IdStorage {
  return {
    getItem: () => {
      throw new Error("access denied");
    },
    setItem: () => {
      throw new Error("access denied");
    },
  };
}

/**
 * Storage that accepts every write and keeps none of them - the failure a real
 * `localStorage` cannot be asked to perform, and the one that would quietly
 * make every game look like this browser's first.
 */
function lyingStorage(): IdStorage {
  const dropped = new Map<string, string>();
  return {
    getItem: () => null,
    setItem: (key, value) => {
      dropped.set(key, value);
    },
  };
}

/** A finished game this viewer played and won. */
function playedFinish(overrides: Partial<GameFinish> = {}): GameFinish {
  return {
    gameStatus: "finished",
    result: { reason: "capture", winner: 1 as PlayerId },
    hasSeat: true,
    isReadOnly: false,
    isPuzzle: false,
    ...overrides,
  };
}

describe("isPlayedGameFinish", () => {
  it("accepts a counted finish this viewer played", () => {
    expect(isPlayedGameFinish(playedFinish())).toBe(true);
  });

  it("rejects a game still being played", () => {
    expect(
      isPlayedGameFinish(playedFinish({ gameStatus: "playing", result: null })),
    ).toBe(false);
  });

  it("rejects an aborted game", () => {
    expect(isPlayedGameFinish(playedFinish({ gameStatus: "aborted" }))).toBe(
      false,
    );
  });

  it("rejects a finish that has no result yet", () => {
    expect(isPlayedGameFinish(playedFinish({ result: null }))).toBe(false);
  });

  it("rejects an uncounted result, which is never written to past games", () => {
    expect(
      isPlayedGameFinish(playedFinish({ result: { reason: "aborted" } })),
    ).toBe(false);
  });

  it("rejects a viewer with no seat", () => {
    expect(isPlayedGameFinish(playedFinish({ hasSeat: false }))).toBe(false);
  });

  it("rejects a spectator or replay", () => {
    expect(isPlayedGameFinish(playedFinish({ isReadOnly: true }))).toBe(false);
  });

  it("rejects a puzzle", () => {
    expect(isPlayedGameFinish(playedFinish({ isPuzzle: true }))).toBe(false);
  });
});

describe("recordPlayedGame", () => {
  it("records the first game and says so", () => {
    const storage = workingStorage();

    expect(recordPlayedGame("game-1", storage)).toBe("first");
    expect(storage.dump()[FIRST_GAME_KEY]).toBe("game-1");
  });

  it("still says first when the same game is handed in again", () => {
    const storage = workingStorage({ [FIRST_GAME_KEY]: "game-1" });

    // A reload of a finished game is not a second game.
    expect(recordPlayedGame("game-1", storage)).toBe("first");
  });

  it("says not-first for any later game", () => {
    const storage = workingStorage({ [FIRST_GAME_KEY]: "game-1" });

    expect(recordPlayedGame("game-2", storage)).toBe("not-first");
    // And leaves the original marker alone.
    expect(storage.dump()[FIRST_GAME_KEY]).toBe("game-1");
  });

  it("says unknown when there is no storage at all", () => {
    expect(recordPlayedGame("game-1", undefined)).toBe("unknown");
  });

  it("says unknown when storage throws", () => {
    expect(recordPlayedGame("game-1", throwingStorage())).toBe("unknown");
  });

  it("says unknown when storage accepts the write and drops it", () => {
    expect(recordPlayedGame("game-1", lyingStorage())).toBe("unknown");
  });
});

describe("markShownThisSession", () => {
  it("claims the session's one nudge", () => {
    const storage = workingStorage();

    expect(markShownThisSession(storage)).toBe("marked");
    expect(storage.dump()[SHOWN_KEY]).toBe("1");
  });

  it("reports a session that has already had one", () => {
    const storage = workingStorage({ [SHOWN_KEY]: "1" });

    expect(markShownThisSession(storage)).toBe("already-shown");
  });

  it("reports unavailable for missing, throwing and lying storage", () => {
    expect(markShownThisSession(undefined)).toBe("unavailable");
    expect(markShownThisSession(throwingStorage())).toBe("unavailable");
    expect(markShownThisSession(lyingStorage())).toBe("unavailable");
  });
});

describe("recordFinishAndDecide", () => {
  /** The common case: a signed-out player finishing their first game. */
  function guestRun(
    overrides: {
      gameId?: string;
      finish?: GameFinish;
      authSettled?: boolean;
      isLoggedIn?: boolean;
      durable?: ReturnType<typeof workingStorage>;
      session?: ReturnType<typeof workingStorage>;
    } = {},
  ) {
    const durable = overrides.durable ?? workingStorage();
    const session = overrides.session ?? workingStorage();
    const decision = recordFinishAndDecide({
      gameId: overrides.gameId ?? "game-1",
      finish: overrides.finish ?? playedFinish(),
      authSettled: overrides.authSettled ?? true,
      isLoggedIn: overrides.isLoggedIn ?? false,
      durable,
      session,
    });
    return { decision, durable, session };
  }

  it("shows the nudge after a guest's first counted game", () => {
    const { decision, durable, session } = guestRun();

    expect(decision).toEqual({ show: true });
    expect(durable.dump()[FIRST_GAME_KEY]).toBe("game-1");
    // Marked BEFORE the caller shows anything, which is what makes React's
    // double-invoked effect harmless.
    expect(session.dump()[SHOWN_KEY]).toBe("1");
  });

  it("shows nothing twice in one session, even for the same game", () => {
    const durable = workingStorage();
    const session = workingStorage();

    const first = guestRun({ durable, session }).decision;
    const second = guestRun({ durable, session }).decision;

    expect(first).toEqual({ show: true });
    expect(second).toEqual({
      show: false,
      because: "already-shown-this-session",
    });
  });

  it("shows nothing on a later game", () => {
    const durable = workingStorage({ [FIRST_GAME_KEY]: "game-1" });

    const { decision, session } = guestRun({ gameId: "game-2", durable });

    expect(decision).toEqual({ show: false, because: "not-first-game" });
    expect(session.dump()[SHOWN_KEY]).toBeUndefined();
  });

  it("waits for the signed-in check to settle before deciding", () => {
    const durable = workingStorage();
    const session = workingStorage();

    // isLoggedIn is false while the user query is pending, so this is exactly
    // the state a signed-in player is in for the first render.
    const pending = guestRun({ authSettled: false, durable, session }).decision;
    expect(pending).toEqual({ show: false, because: "auth-unsettled" });
    expect(session.dump()[SHOWN_KEY]).toBeUndefined();

    // The finish was still counted while we waited, so settling does not have
    // to reconstruct it.
    expect(durable.dump()[FIRST_GAME_KEY]).toBe("game-1");

    const settled = guestRun({ durable, session }).decision;
    expect(settled).toEqual({ show: true });
  });

  it("never offers an account to someone who has one", () => {
    const { decision, session } = guestRun({ isLoggedIn: true });

    expect(decision).toEqual({ show: false, because: "signed-in" });
    expect(session.dump()[SHOWN_KEY]).toBeUndefined();
  });

  it("consumes the first game when a signed-in player plays it", () => {
    const durable = workingStorage();

    guestRun({ isLoggedIn: true, durable });
    // Signing out later must not present a veteran as a brand-new visitor.
    const afterSignOut = guestRun({ gameId: "game-2", durable }).decision;

    expect(durable.dump()[FIRST_GAME_KEY]).toBe("game-1");
    expect(afterSignOut).toEqual({ show: false, because: "not-first-game" });
  });

  it.each([
    ["a spectator", playedFinish({ hasSeat: false, isReadOnly: true })],
    ["a replay", playedFinish({ isReadOnly: true })],
    ["a puzzle", playedFinish({ isPuzzle: true })],
    ["an aborted game", playedFinish({ result: { reason: "aborted" } })],
  ])("does not let %s consume the first game", (_label, finish) => {
    const durable = workingStorage();

    const { decision } = guestRun({ finish, durable });

    expect(decision).toEqual({ show: false, because: "not-a-played-game" });
    // The key stays clean, so the next game this browser really plays is
    // still its first.
    expect(durable.dump()[FIRST_GAME_KEY]).toBeUndefined();
    const next = guestRun({ gameId: "game-2", durable }).decision;
    expect(next).toEqual({ show: true });
  });

  it("shows nothing when durable storage cannot be used", () => {
    const decision = recordFinishAndDecide({
      gameId: "game-1",
      finish: playedFinish(),
      authSettled: true,
      isLoggedIn: false,
      durable: undefined,
      session: workingStorage(),
    });

    expect(decision).toEqual({ show: false, because: "storage-unavailable" });
  });

  it("shows nothing when the session mark cannot be kept", () => {
    // Without a session mark, "at most once per session" is unenforceable —
    // and the failure mode of guessing is nudging after every single game.
    const decision = recordFinishAndDecide({
      gameId: "game-1",
      finish: playedFinish(),
      authSettled: true,
      isLoggedIn: false,
      durable: workingStorage(),
      session: throwingStorage(),
    });

    expect(decision).toEqual({ show: false, because: "storage-unavailable" });
  });
});
