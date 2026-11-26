/**
 * The puzzle events (task 7db1b18a): `puzzle_start` per accepted launch,
 * `puzzle_solved` once per game this page saw won, both with puzzle_kind and,
 * after a /go/<n> landing, video_item; never a user or game id.
 */

import { describe, it, expect } from "bun:test";
import {
  PUZZLE_SOLVED_EVENT,
  PUZZLE_START_EVENT,
  puzzleEventKind,
  puzzleParams,
  puzzleSolvedPhase,
  rememberVideoItem,
  takePuzzleSolvedEvent,
  videoItemOf,
  type PuzzleSolvedView,
} from "../frontend/src/lib/puzzle-events";
import { videoPuzzleTarget } from "../shared/domain/video-puzzles";
import type { PuzzleRef } from "../shared/domain/game-types";

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

/** A storage that refuses every access, as some privacy modes do. */
const refusingStorage = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("SecurityError");
  },
};

const SAVED: PuzzleRef = { kind: "saved", puzzleId: "row-id" };
const VIDEO: PuzzleRef = { kind: "game", gameId: "EDP5pYum", ply: 38 };

/** The query of the page a /go/<n> link opens, built by the server's own rule. */
const goQuery = (n: number) => videoPuzzleTarget(n).split("?")[1];

describe("the event names", () => {
  it("are snake_case GA4 names", () => {
    for (const name of [PUZZLE_START_EVENT, PUZZLE_SOLVED_EVENT]) {
      expect(name).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    }
  });
});

describe("puzzleEventKind", () => {
  it("calls a stored game's position video and a numbered puzzle saved", () => {
    expect(puzzleEventKind(VIDEO)).toBe("video");
    expect(puzzleEventKind(SAVED)).toBe("saved");
  });
});

describe("videoItemOf", () => {
  it("reads the item of every /go/<n> link", () => {
    expect(videoItemOf(`?${goQuery(1)}`)).toBe("v-2026-11-22-1");
    expect(videoItemOf(goQuery(2))).toBe("v-2026-11-25-3");
  });

  it("needs every tag /go adds, not only a utm_content", () => {
    expect(videoItemOf("?utm_content=v-2026-11-22-1")).toBeNull();
    expect(
      videoItemOf("?utm_source=ads&utm_medium=cta&utm_content=summer"),
    ).toBeNull();
  });

  it("is null for the untagged /go and for no query", () => {
    expect(videoItemOf(`?${videoPuzzleTarget(999).split("?")[1]}`)).toBeNull();
    expect(videoItemOf("")).toBeNull();
  });
});

describe("puzzleParams", () => {
  it("names only the kind when the tab did not land through /go/<n>", () => {
    expect(puzzleParams(SAVED, workingStorage())).toEqual({
      puzzle_kind: "saved",
    });
  });

  it("adds the video item of the tab's /go/<n> landing", () => {
    const session = workingStorage();
    rememberVideoItem(`?${goQuery(1)}`, session);

    expect(puzzleParams(VIDEO, session)).toEqual({
      puzzle_kind: "video",
      video_item: "v-2026-11-22-1",
    });
  });

  it("keeps the item over later loads, and takes a newer landing's", () => {
    const session = workingStorage();
    rememberVideoItem(`?${goQuery(1)}`, session);
    rememberVideoItem("", session); // the game page, reloaded
    expect(puzzleParams(VIDEO, session).video_item).toBe("v-2026-11-22-1");

    rememberVideoItem(`?${goQuery(2)}`, session);
    expect(puzzleParams(VIDEO, session).video_item).toBe("v-2026-11-25-3");
  });

  it("still describes the puzzle when storage is refused", () => {
    rememberVideoItem(`?${goQuery(1)}`, refusingStorage);
    expect(puzzleParams(VIDEO, refusingStorage)).toEqual({
      puzzle_kind: "video",
    });
    expect(puzzleParams(VIDEO, undefined)).toEqual({ puzzle_kind: "video" });
  });

  it("carries no user or game id", () => {
    const session = workingStorage();
    rememberVideoItem(`?${goQuery(1)}`, session);
    const params = puzzleParams(VIDEO, session);

    expect(Object.keys(params).sort()).toEqual(["puzzle_kind", "video_item"]);
    expect(JSON.stringify(params)).not.toContain("EDP5pYum");
  });
});

const view = (over: Partial<PuzzleSolvedView> = {}): PuzzleSolvedView => ({
  gameId: "g1",
  puzzle: SAVED,
  state: { status: "playing", result: undefined },
  playerId: 1,
  isReadOnly: false,
  ...over,
});
const won = {
  status: "finished" as const,
  result: { winner: 1 as const, reason: "capture" as const },
};
const lost = {
  status: "finished" as const,
  result: { winner: 2 as const, reason: "capture" as const },
};

describe("puzzleSolvedPhase", () => {
  it("follows a puzzle game of this browser's own", () => {
    expect(puzzleSolvedPhase(view())).toBe("playing");
    expect(puzzleSolvedPhase(view({ state: won }))).toBe("won");
    expect(puzzleSolvedPhase(view({ state: lost }))).toBe("over");
  });

  it("does not call the bot's resignation a solve", () => {
    // The server resigns for a bot whose engine or client failed; a bot
    // never resigns by choice.
    const forfeit = {
      status: "finished" as const,
      result: {
        winner: 1 as const,
        reason: "resignation" as const,
        resignCause: "bot-forfeit" as const,
      },
    };
    expect(puzzleSolvedPhase(view({ state: forfeit }))).toBe("over");
    expect(
      takePuzzleSolvedEvent({
        view: view({ state: forfeit }),
        sawPlaying: true,
        session: workingStorage(),
      }),
    ).toBeNull();
  });

  it("is none for an ordinary game, a spectator, a replay or no seat", () => {
    for (const other of [
      view({ puzzle: null, state: won }),
      view({ isReadOnly: true, state: won }),
      view({ playerId: null, state: won }),
      view({ state: null }),
    ]) {
      expect(puzzleSolvedPhase(other)).toBe("none");
    }
  });
});

describe("takePuzzleSolvedEvent", () => {
  it("is due once when the page saw the game in play and then won", () => {
    const session = workingStorage();

    const first = takePuzzleSolvedEvent({
      view: view({ state: won }),
      sawPlaying: true,
      session,
    });
    const again = takePuzzleSolvedEvent({
      view: view({ state: won }),
      sawPlaying: true,
      session,
    });

    expect(first).toEqual({ puzzle_kind: "saved" });
    expect(again).toBeNull();
  });

  it("is not due for a game already won when the page opened", () => {
    expect(
      takePuzzleSolvedEvent({
        view: view({ state: won }),
        sawPlaying: false,
        session: workingStorage(),
      }),
    ).toBeNull();
  });

  it("is not due for a loss", () => {
    expect(
      takePuzzleSolvedEvent({
        view: view({ state: lost }),
        sawPlaying: true,
        session: workingStorage(),
      }),
    ).toBeNull();
  });

  it("counts each game of the tab once, a Retry included", () => {
    const session = workingStorage();
    const take = (gameId: string) =>
      takePuzzleSolvedEvent({
        view: view({ gameId, state: won }),
        sawPlaying: true,
        session,
      });

    expect(take("g1")).not.toBeNull();
    expect(take("g2")).not.toBeNull();
    expect(take("g1")).toBeNull();
  });

  it("still sends when storage is refused", () => {
    expect(
      takePuzzleSolvedEvent({
        view: view({ puzzle: VIDEO, state: won }),
        sawPlaying: true,
        session: refusingStorage,
      }),
    ).toEqual({ puzzle_kind: "video" });
  });
});
