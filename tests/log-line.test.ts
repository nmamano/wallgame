/**
 * The one-line log format of server/log-line.ts (board task 0e0087af).
 */
import { describe, expect, it, spyOn } from "bun:test";
import { LOG_MOVE_DETAIL, logDetail, logLine } from "../server/log-line";

const captureInfo = (run: () => void): unknown[][] => {
  const info = spyOn(console, "info").mockImplementation(() => undefined);
  try {
    run();
    return info.mock.calls;
  } finally {
    info.mockRestore();
  }
};

describe("logLine", () => {
  it("prints the tag and key=value pairs as one string, skipping undefined", () => {
    const calls = captureInfo(() =>
      logLine("[custom-bot-ws] move_applied handled", {
        bgsId: "XetPEIOn",
        ply: 4,
        success: true,
        error: undefined,
        requestMs: 12,
      }),
    );
    expect(calls).toEqual([
      [
        "[custom-bot-ws] move_applied handled bgsId=XetPEIOn ply=4 success=true requestMs=12",
      ],
    ]);
  });

  it("quotes a value with spaces, quotes or equals signs, and serialises objects", () => {
    const calls = captureInfo(() =>
      logLine("[ws] move processed", {
        move: "Ma2.>c2",
        note: 'two words and a "quote"',
        pair: "a=b",
        cells: [1, 2],
      }),
    );
    expect(calls[0][0]).toBe(
      '[ws] move processed move=Ma2.>c2 note="two words and a \\"quote\\"" pair="a=b" cells=[1,2]',
    );
  });
});

describe("logDetail", () => {
  it("is off in the committed tree", () => {
    // The detail is most of the log under bot load; it must never ship on.
    expect(LOG_MOVE_DETAIL).toBe(false);
    const debug = spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      logDetail("[broadcast]", { sessionId: "g1" });
      expect(debug).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
    }
  });
});
