import { describe, expect, it } from "bun:test";
import { persistThenBroadcastFinish } from "../../server/games/finish-sequence";

/**
 * Puzzle completion (S-G3) is derived from the persisted game, so the client
 * must never learn a game is over before the row that proves it exists. The
 * bot-move finish path used to broadcast first, which meant a player could
 * return to the puzzle list and find their fresh solve missing.
 */

describe("finishing a game durably", () => {
  it("persists before it broadcasts", async () => {
    const order: string[] = [];

    await persistThenBroadcastFinish({
      persist: async () => {
        // Resolve on a later tick, so a broadcast that merely happens not to
        // be awaited would still be caught.
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("persist");
      },
      broadcast: () => order.push("broadcast"),
      onPersistError: () => order.push("error"),
    });

    expect(order).toEqual(["persist", "broadcast"]);
  });

  it("still broadcasts when persistence fails, and reports the failure", async () => {
    const order: string[] = [];
    const failure = new Error("database unavailable");
    let reported: unknown = null;

    await persistThenBroadcastFinish({
      persist: () => Promise.reject(failure),
      broadcast: () => order.push("broadcast"),
      onPersistError: (error) => {
        reported = error;
        order.push("error");
      },
    });

    // The game really did end; clients must not be left on a live board just
    // because the write failed.
    expect(order).toEqual(["error", "broadcast"]);
    expect(reported).toBe(failure);
  });
});
