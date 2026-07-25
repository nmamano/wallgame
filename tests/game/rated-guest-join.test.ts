import { describe, expect, it, beforeAll } from "bun:test";
import type { PartialGameConfiguration } from "../../server/games/store";

/**
 * Rated games are only played between logged-in players.
 *
 * The host side is already enforced when a game is created (a logged-out
 * creator cannot switch Rated on). This pins down the joiner side: a guest is
 * refused the seat, and is told so before they ever click Join.
 *
 * Nothing here touches the database, but `store.ts` reaches the db module
 * transitively, and that module reads DATABASE_URL when it is imported. A
 * dummy URL is enough - `postgres()` does not connect until a query runs.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

// Bound after DATABASE_URL is set, following the pattern in tests/integration.
let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let resolveGameAccess: typeof import("../../server/games/store").resolveGameAccess;
let ratedRequiresLoginMessage: string;

beforeAll(async () => {
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  resolveGameAccess = store.resolveGameAccess;
  ratedRequiresLoginMessage = store.RATED_REQUIRES_LOGIN_MESSAGE;
});

const RATED: PartialGameConfiguration = {
  boardHeight: 8,
  boardWidth: 8,
  rated: true,
  variant: "standard",
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
};

const CASUAL: PartialGameConfiguration = { ...RATED, rated: false };

const createSession = (
  config: PartialGameConfiguration,
  hostAuthUserId?: string,
) =>
  createGameSession({
    config,
    matchType: "friend",
    hostDisplayName: "Host",
    hostIsPlayer1: true,
    hostAuthUserId,
  }).session;

describe("joining a rated game", () => {
  it("refuses a guest and leaves the seat open", () => {
    const session = createSession(RATED, "auth|host");

    expect(() =>
      joinGameSession({ id: session.id, displayName: "Guest" }),
    ).toThrow(ratedRequiresLoginMessage);

    // The seat must still be free for a logged-in player to take.
    expect(session.players.joiner.ready).toBe(false);
    expect(session.config.rated).toBe(true);
  });

  it("seats a logged-in joiner", () => {
    const session = createSession(RATED, "auth|host");

    const result = joinGameSession({
      id: session.id,
      displayName: "Friend",
      authUserId: "auth|friend",
    });

    expect(result.kind).toBe("player");
    expect(session.players.joiner.ready).toBe(true);
    expect(session.players.joiner.authUserId).toBe("auth|friend");
  });

  it("still lets a guest join a casual game", () => {
    const session = createSession(CASUAL, "auth|host");

    const result = joinGameSession({
      id: session.id,
      displayName: "Guest",
    });

    expect(result.kind).toBe("player");
    expect(session.players.joiner.ready).toBe(true);
    expect(session.players.joiner.authUserId).toBeUndefined();
  });
});

describe("resolving access to a rated game", () => {
  it("tells a guest to make an account instead of offering the seat", () => {
    const session = createSession(RATED, "auth|host");

    const access = resolveGameAccess({ id: session.id });

    expect(access.kind).toBe("waiting");
    if (access.kind === "waiting") {
      expect(access.reason).toBe("rated-requires-login");
    }
  });

  it("offers the open seat to a logged-in visitor", () => {
    const session = createSession(RATED, "auth|host");

    const access = resolveGameAccess({
      id: session.id,
      authUserId: "auth|someone-else",
    });

    expect(access.kind).toBe("waiting");
    if (access.kind === "waiting") {
      expect(access.reason).toBeUndefined();
    }
  });

  it("offers the open seat to a guest on a casual game", () => {
    const session = createSession(CASUAL, "auth|host");

    const access = resolveGameAccess({ id: session.id });

    expect(access.kind).toBe("waiting");
    if (access.kind === "waiting") {
      expect(access.reason).toBeUndefined();
    }
  });
});
