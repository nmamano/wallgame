import { describe, expect, it, beforeAll } from "bun:test";
import type { PartialGameConfiguration } from "../../server/games/store";
import { pickGuestName, guestAnimals } from "../../server/games/guest-names";

/**
 * Guests used to all be called "Guest", so a game between two of them said
 * "Guest won by resignation" and nobody could tell which one. Each guest now
 * gets an animal, assigned by the session - the only place that can see both
 * seats, and so the only place that can keep their names apart.
 *
 * The names are drawn at random, so nothing here asserts on a chosen animal:
 * the properties are the literal "Guest " prefix, membership in the pool, and
 * the distinctness that the whole feature exists for. The prefix is spelled out
 * rather than imported, so a change to the format has to be made here too
 * instead of both sides moving together and the assertion proving nothing.
 *
 * As in `rated-guest-join.test.ts`, a dummy DATABASE_URL is enough: `store.ts`
 * pulls in the db module, which reads the variable on import but does not
 * connect until a query runs, and nothing here issues one.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

// Bound after DATABASE_URL is set, following the pattern in tests/integration.
let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let resignGame: typeof import("../../server/games/store").resignGame;
let createRematchSession: typeof import("../../server/games/store").createRematchSession;
let assignSpectatorGuestName: typeof import("../../server/games/store").assignSpectatorGuestName;
let releaseSpectatorGuestName: typeof import("../../server/games/store").releaseSpectatorGuestName;

beforeAll(async () => {
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  resignGame = store.resignGame;
  createRematchSession = store.createRematchSession;
  assignSpectatorGuestName = store.assignSpectatorGuestName;
  releaseSpectatorGuestName = store.releaseSpectatorGuestName;
});

const CASUAL: PartialGameConfiguration = {
  boardHeight: 8,
  boardWidth: 8,
  rated: false,
  variant: "standard",
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
};

/**
 * Asserts the literal shape a guest name must have, and that the animal came
 * from the pool. "Guest" alone, "Player 1" and "Friend" all fail it - which is
 * what every guest seat was called before this feature.
 */
const expectGuestName = (name: string) => {
  const match = /^Guest ([A-Za-z]+)$/.exec(name);
  expect(match, `${name} is not of the form "Guest <Animal>"`).not.toBeNull();
  expect(guestAnimals).toContain(match![1]);
};

/** A guest host, as the routes create one: no account, no requested name. */
const guestHostSession = () =>
  createGameSession({
    config: CASUAL,
    matchType: "friend",
    hostIsPlayer1: true,
  }).session;

describe("pickGuestName", () => {
  it("builds a name from the pool", () => {
    expectGuestName(pickGuestName());
  });

  it("never repeats a name already in use", () => {
    // Leave exactly one animal free and draw many times: any leak of a taken
    // name shows up immediately rather than once in forty runs.
    const free = guestAnimals[0];
    const taken = guestAnimals.slice(1).map((animal) => `Guest ${animal}`);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(pickGuestName(taken)).toBe(`Guest ${free}`);
    }
  });

  it("compares taken names trimmed and case-insensitively", () => {
    const free = guestAnimals[0];
    const taken = guestAnimals
      .slice(1)
      .map((animal) => `  guest ${animal.toUpperCase()}  `);

    expect(pickGuestName(taken)).toBe(`Guest ${free}`);
  });

  it("keeps producing unused names after the pool is exhausted", () => {
    const taken = guestAnimals.map((animal) => `Guest ${animal}`);

    const overflow = pickGuestName(taken);

    expect(overflow).toMatch(/^Guest [A-Za-z]+ 1$/);
    // And the overflow names do not collide with each other either.
    expect(pickGuestName([...taken, overflow])).not.toBe(overflow);
  });
});

describe("naming a seat", () => {
  it("gives a guest host an animal", () => {
    expectGuestName(guestHostSession().players.host.displayName);
  });

  it("ignores a name a guest host asks for", () => {
    // The store is the authority, not whichever caller happened to sanitize its
    // input. If honouring this were left to the route, a caller that forgot
    // would seat a guest under a registered player's name.
    const { session } = createGameSession({
      config: CASUAL,
      matchType: "friend",
      hostIsPlayer1: true,
      hostDisplayName: "Beana",
    });

    expect(session.players.host.displayName).not.toBe("Beana");
    expectGuestName(session.players.host.displayName);
  });

  it("ignores a name a guest joiner asks for", () => {
    const session = guestHostSession();

    joinGameSession({ id: session.id, displayName: "Beana" });

    expect(session.players.joiner.displayName).not.toBe("Beana");
    expectGuestName(session.players.joiner.displayName);
  });

  it("gives the two guests in one game different animals", () => {
    const session = guestHostSession();
    joinGameSession({ id: session.id });

    const host = session.players.host.displayName;
    const joiner = session.players.joiner.displayName;

    expectGuestName(host);
    expectGuestName(joiner);
    expect(host).not.toBe(joiner);
  });

  it("names a guest playing a bot, and leaves the bot its own name", () => {
    // The bot route builds a session the same way, so the host must be named
    // without the store branching on who the opponent is.
    const { session } = createGameSession({
      config: CASUAL,
      matchType: "friend",
      hostIsPlayer1: true,
      joinerConfig: { type: "bot", displayName: "Hard Bot" },
    });

    expectGuestName(session.players.host.displayName);
    expect(session.players.joiner.displayName).toBe("Hard Bot");
  });

  it("leaves a logged-in seat its account name", () => {
    const { session } = createGameSession({
      config: CASUAL,
      matchType: "friend",
      hostIsPlayer1: true,
      hostDisplayName: "Beana",
      hostAuthUserId: "auth|beana",
    });
    joinGameSession({
      id: session.id,
      displayName: "Nil",
      authUserId: "auth|nil",
    });

    expect(session.players.host.displayName).toBe("Beana");
    expect(session.players.joiner.displayName).toBe("Nil");
  });

  it("keeps an unclaimed seat's placeholder", () => {
    // Nobody has taken the seat yet, so there is no guest to name; the UI shows
    // it as an open seat.
    expect(guestHostSession().players.joiner.displayName).toBe("Friend");
  });

  it("carries both names into a rematch", () => {
    const session = guestHostSession();
    joinGameSession({ id: session.id });
    const before = [
      session.players.host.displayName,
      session.players.joiner.displayName,
    ];
    resignGame({ id: session.id, playerId: 1, timestamp: Date.now() });

    const { newSession } = createRematchSession(session.id);

    // The seats swap sides, so the pair is compared as a set.
    expect(
      [
        newSession.players.host.displayName,
        newSession.players.joiner.displayName,
      ].sort(),
    ).toEqual([...before].sort());
  });
});

describe("naming a spectator", () => {
  it("gives a spectator a name that shadows neither player", () => {
    const session = guestHostSession();
    joinGameSession({ id: session.id });

    const spectator = assignSpectatorGuestName(session.id, "socket-1");

    expectGuestName(spectator);
    expect(spectator).not.toBe(session.players.host.displayName);
    expect(spectator).not.toBe(session.players.joiner.displayName);
  });

  it("keeps the same name for the same socket, and differs between sockets", () => {
    const session = guestHostSession();

    const first = assignSpectatorGuestName(session.id, "socket-1");

    expect(assignSpectatorGuestName(session.id, "socket-1")).toBe(first);
    expect(assignSpectatorGuestName(session.id, "socket-2")).not.toBe(first);
  });

  it("hands a name back when the socket closes", () => {
    // Names are handed out per connection, so without this a long-running game
    // would hold one for every spectator who ever passed through and run the
    // pool dry for the ones actually watching.
    const session = guestHostSession();
    assignSpectatorGuestName(session.id, "socket-1");
    assignSpectatorGuestName(session.id, "socket-2");

    releaseSpectatorGuestName(session.id, "socket-1");

    expect([...session.spectatorGuestNames.keys()]).toEqual(["socket-2"]);
  });

  it("gives every spectator of a busy game a distinct name", () => {
    // More arrivals than there are animals: the pool has to keep producing
    // unused names rather than start repeating.
    const session = guestHostSession();
    joinGameSession({ id: session.id });

    const names = new Set<string>();
    for (let socket = 0; socket < guestAnimals.length + 5; socket += 1) {
      names.add(assignSpectatorGuestName(session.id, `socket-${socket}`));
    }

    expect(names.size).toBe(guestAnimals.length + 5);
    expect(names.has(session.players.host.displayName)).toBe(false);
    expect(names.has(session.players.joiner.displayName)).toBe(false);
  });

  it("starts a rematch with no spectator names held over", () => {
    const session = guestHostSession();
    joinGameSession({ id: session.id });
    assignSpectatorGuestName(session.id, "socket-1");
    resignGame({ id: session.id, playerId: 1, timestamp: Date.now() });

    const { newSession } = createRematchSession(session.id);

    expect(newSession.spectatorGuestNames.size).toBe(0);
  });
});
