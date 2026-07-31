import { describe, expect, it, beforeAll } from "bun:test";
import type { WSContext } from "hono/ws";

/**
 * A seat is a single `connected` boolean, but it can have several websockets at
 * once: the player opened a second tab, or a reconnect's socket opened before
 * the old one's close was delivered. `onClose` used to report the seat gone on
 * the first close regardless.
 *
 * That was cosmetic until unlimited games started arming an abandonment timer
 * off the same boolean - at which point a seat wrongly marked gone is resigned
 * 30 minutes later while its player is still playing in the other tab.
 *
 * The websocket handlers need a live server and a database, so this drives the
 * decision `onClose` makes rather than the socket lifecycle around it.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

let seatHasOtherSocket: typeof import("../../server/routes/game-socket").seatHasOtherSocket;
type SessionSocket = Parameters<typeof seatHasOtherSocket>[1];

beforeAll(async () => {
  const socketModule = await import("../../server/routes/game-socket");
  seatHasOtherSocket = socketModule.seatHasOtherSocket;
});

let nextId = 0;
/** A socket entry, minus the websocket context the decision never looks at. */
const socketFor = (socketToken: string | undefined): SessionSocket =>
  ({
    ctx: {} as WSContext,
    sessionId: "game-1",
    socketToken,
    role: "host",
    id: `socket-${(nextId += 1)}`,
  }) as SessionSocket;

describe("a seat with more than one socket", () => {
  it("stays held while another tab has the same seat open", () => {
    const firstTab = socketFor("seat-token");
    const secondTab = socketFor("seat-token");

    // The closing socket is removed from the set before the decision is made.
    expect(seatHasOtherSocket(new Set([secondTab]), firstTab)).toBe(true);
  });

  it("is released when its last socket closes", () => {
    const onlyTab = socketFor("seat-token");

    expect(seatHasOtherSocket(new Set(), onlyTab)).toBe(false);
  });

  it("is not held by the opponent's socket", () => {
    const mine = socketFor("my-token");
    const opponent = socketFor("their-token");

    expect(seatHasOtherSocket(new Set([opponent]), mine)).toBe(false);
  });

  it("is not held by a spectator, which carries no seat token", () => {
    const seatless = socketFor(undefined);
    const otherSeatless = socketFor(undefined);

    // Two absent tokens must not compare equal into "someone still holds it".
    expect(seatHasOtherSocket(new Set([otherSeatless]), seatless)).toBe(false);
  });

  it("does not count the closing socket as its own replacement", () => {
    const closing = socketFor("seat-token");

    // Defensive: correct even if the entry is still in the set when asked.
    expect(seatHasOtherSocket(new Set([closing]), closing)).toBe(false);
  });
});
