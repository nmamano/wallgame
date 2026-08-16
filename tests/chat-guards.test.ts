/**
 * The two guards every chat message passes through, which had ZERO coverage
 * until the 2026-08-16 test-suite audit flagged them: game-socket.ts runs
 * `canSendMessage` (rate limit) and then `moderateMessage` (length, then
 * profanity) before a message reaches anyone. Both are abuse-facing and
 * user-visible, and a regression in either is invisible to every other test.
 *
 * Compare tests/game/anonymous-write-limiter.test.ts, which asks the same two
 * questions of the other in-memory limiter: does the cap hold, and does the
 * map leak. Here the leak answer is the disconnect hook - game-socket.ts
 * calls `clearRateLimitEntry` when a socket goes away, so the map is bounded
 * by LIVE sockets. The clear test below pins that mechanism: if disconnect
 * stopped clearing, a reconnecting socket would inherit a stale stamp.
 *
 * The rate limiter reads Date.now() directly, so these tests replace it with
 * a hand-advanced clock rather than sleeping through real windows.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { MAX_MESSAGE_LENGTH, moderateMessage } from "../server/chat/moderation";
import {
  canSendMessage,
  clearRateLimitEntry,
} from "../server/chat/rate-limiter";

describe("chat moderation", () => {
  it("allows an ordinary message", () => {
    expect(moderateMessage("good game! rematch?")).toEqual({ allowed: true });
  });

  it("refuses profanity, naming the moderation code the client renders", () => {
    expect(moderateMessage("fuck this game")).toEqual({
      allowed: false,
      code: "MODERATION",
    });
  });

  it("catches the obfuscations the transformers exist for", () => {
    // Case and repeated letters are the two cheapest evasions; if the
    // recommended transformer set were dropped from the matcher, these are
    // what would silently start passing.
    expect(moderateMessage("FuCk").allowed).toBe(false);
    expect(moderateMessage("fuuuck").allowed).toBe(false);
  });

  it("allows exactly the limit and refuses one past it", () => {
    expect(moderateMessage("a".repeat(MAX_MESSAGE_LENGTH))).toEqual({
      allowed: true,
    });
    expect(moderateMessage("a".repeat(MAX_MESSAGE_LENGTH + 1))).toEqual({
      allowed: false,
      code: "TOO_LONG",
    });
  });

  it("reports an over-long profane message as TOO_LONG, not MODERATION", () => {
    // Pins the check order. The client shows the code to the sender; telling
    // them to shorten a message is actionable, and the profanity check will
    // still catch the content if they resend it under the limit.
    const message = `fuck ${"a".repeat(MAX_MESSAGE_LENGTH)}`;
    expect(moderateMessage(message)).toEqual({
      allowed: false,
      code: "TOO_LONG",
    });
  });
});

describe("chat rate limiter", () => {
  const realDateNow = Date.now;

  afterEach(() => {
    Date.now = realDateNow;
    clearRateLimitEntry("socket-a");
    clearRateLimitEntry("socket-b");
  });

  const atTime = (ms: number) => {
    Date.now = () => ms;
  };

  it("allows one message per second and refuses the burst", () => {
    atTime(10_000);
    expect(canSendMessage("socket-a")).toBe(true);
    expect(canSendMessage("socket-a")).toBe(false);
    atTime(10_999);
    expect(canSendMessage("socket-a")).toBe(false);
    atTime(11_000);
    expect(canSendMessage("socket-a")).toBe(true);
  });

  it("does not let a refused attempt extend the window", () => {
    // If a refusal updated the stamp, hammering the button would lock the
    // sender out forever instead of for one second.
    atTime(10_000);
    expect(canSendMessage("socket-a")).toBe(true);
    atTime(10_500);
    expect(canSendMessage("socket-a")).toBe(false);
    atTime(11_000);
    expect(canSendMessage("socket-a")).toBe(true);
  });

  it("limits sockets independently", () => {
    atTime(10_000);
    expect(canSendMessage("socket-a")).toBe(true);
    expect(canSendMessage("socket-b")).toBe(true);
    expect(canSendMessage("socket-a")).toBe(false);
  });

  it("clearing an entry frees the socket immediately", () => {
    // The disconnect path: game-socket.ts clears the entry when a socket goes
    // away. A reconnect gets a fresh window rather than a stale stamp - and
    // this delete is also what keeps the map bounded by live sockets.
    atTime(10_000);
    expect(canSendMessage("socket-a")).toBe(true);
    clearRateLimitEntry("socket-a");
    expect(canSendMessage("socket-a")).toBe(true);
  });
});
