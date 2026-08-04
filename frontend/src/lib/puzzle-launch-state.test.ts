import { describe, expect, it } from "bun:test";

import {
  puzzleLaunchReducer,
  initialPuzzleLaunchState,
  type PuzzleLaunchEvent,
  type PuzzleLaunchState,
} from "./puzzle-launch-state";

/**
 * The rule: a failed launch must never retry itself.
 *
 * This is worth a state machine and a test because the failure is invisible.
 * The launch lives in an effect whose dependencies are all derived from live
 * queries, so it re-runs on renders nobody triggered deliberately — a
 * background refetch, an unrelated query settling. If a failure re-armed the
 * page, one of those renders would call the same rejected bot again while the
 * error card sat on screen, and the player would neither have asked for it nor
 * seen it.
 *
 * `armed` is therefore the ONLY thing the effect consults. Rendering an error
 * is a consequence, never the reason not to launch.
 */

const run = (events: PuzzleLaunchEvent[]): PuzzleLaunchState =>
  events.reduce(puzzleLaunchReducer, initialPuzzleLaunchState);

/** Renders that nobody asked for; the machine must not move. */
const unrelatedRerenders: PuzzleLaunchEvent[] = [];

describe("puzzle launch permission", () => {
  it("starts armed, so a puzzle a bot can play launches on arrival", () => {
    expect(initialPuzzleLaunchState).toEqual({ armed: true, error: null });
  });

  it("spends the permission when a launch goes out", () => {
    // Guards the older bug too: two renders in flight must not mint two games.
    expect(run([{ type: "launch-started" }])).toEqual({
      armed: false,
      error: null,
    });
  });

  it("STAYS disarmed after a rejection", () => {
    // The blocker this file exists for.
    expect(
      run([
        { type: "launch-started" },
        {
          type: "launch-failed",
          message: "That bot cannot play this position",
        },
      ]),
    ).toEqual({
      armed: false,
      error: "That bot cannot play this position",
    });
  });

  it("does not re-arm across any number of unrelated rerenders", () => {
    // A rerender is not an event: query updates, refetches settling, a parent
    // re-rendering. None of them may hand the permission back.
    const afterFailure = run([
      { type: "launch-started" },
      { type: "launch-failed", message: "Bot not found or not connected" },
    ]);
    const later = unrelatedRerenders.reduce(puzzleLaunchReducer, afterFailure);
    expect(later.armed).toBe(false);
    expect(later.error).toBe("Bot not found or not connected");
  });

  it("re-arms ONLY when the player asks", () => {
    const retried = run([
      { type: "launch-started" },
      { type: "launch-failed", message: "nope" },
      { type: "retry-requested" },
    ]);
    expect(retried).toEqual({ armed: true, error: null });
  });

  it("never re-arms when the player takes the authored line instead", () => {
    // There is nothing to launch, and re-arming would race the scripted board.
    expect(
      run([
        { type: "launch-started" },
        { type: "launch-failed", message: "nope" },
        { type: "authored-chosen" },
      ]),
    ).toEqual({ armed: false, error: null });
  });

  it("hands a fresh permission to a different puzzle", () => {
    // "Next" reuses the component, so without this the next puzzle would
    // inherit a spent permission and never start at all.
    expect(
      run([
        { type: "launch-started" },
        { type: "launch-failed", message: "nope" },
        { type: "puzzle-changed" },
      ]),
    ).toEqual({ armed: true, error: null });
  });

  it("clears a stale error when the puzzle changes", () => {
    expect(
      run([
        { type: "launch-started" },
        { type: "launch-failed", message: "nope" },
        { type: "puzzle-changed" },
      ]).error,
    ).toBeNull();
  });

  it("a second failure after a retry is still terminal", () => {
    // The loop has to close: retry, fail, and we are disarmed again rather
    // than oscillating.
    expect(
      run([
        { type: "launch-started" },
        { type: "launch-failed", message: "first" },
        { type: "retry-requested" },
        { type: "launch-started" },
        { type: "launch-failed", message: "second" },
      ]),
    ).toEqual({ armed: false, error: "second" });
  });
});
