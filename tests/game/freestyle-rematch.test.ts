import { describe, expect, it, beforeAll } from "bun:test";
import type { PartialGameConfiguration } from "../../server/games/store";

/**
 * Freestyle is deliberately randomized, so a rematch gets a brand-new starting
 * position rather than replaying the previous board from the other side.
 *
 * The board used to alternate: odd rematches reused the previous layout so both
 * players saw the same position from each seat, and only even ones refreshed.
 * A test that merely counted distinct layouts would still pass under that rule,
 * so this compares each rematch against its immediate predecessor - the pairing
 * made exactly that comparison equal.
 *
 * As in `aborted-game-session.test.ts`, a dummy DATABASE_URL is enough because
 * nothing here issues a query.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

// Bound after DATABASE_URL is set, following the pattern in tests/integration.
let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let resignGame: typeof import("../../server/games/store").resignGame;
let createRematchSession: typeof import("../../server/games/store").createRematchSession;

beforeAll(async () => {
  const store = await import("../../server/games/store");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  resignGame = store.resignGame;
  createRematchSession = store.createRematchSession;
});

const randomStartConfig = (): PartialGameConfiguration => ({
  boardHeight: 10,
  boardWidth: 12,
  rated: false,
  variant: "standard",
  randomStart: true,
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
});

const startedSession = (config: PartialGameConfiguration) => {
  const { session } = createGameSession({
    config,
    matchType: "friend",
    hostDisplayName: "Host",
    hostIsPlayer1: true,
  });
  joinGameSession({ id: session.id, displayName: "Friend" });
  return session;
};

const finish = (id: string) =>
  resignGame({ id, playerId: 1, timestamp: Date.now() });

/** The generated board, as a value that can be compared for equality. */
const layoutOf = (config: { variantConfig?: unknown }) =>
  JSON.stringify(config.variantConfig);

describe("Random Start rematch", () => {
  it("generates a new starting position for every rematch in the series", () => {
    const first = startedSession(randomStartConfig());
    finish(first.id);

    const layouts = [layoutOf(first.config)];
    let currentId = first.id;

    // Three rematches: under the old alternating rule the first one reused the
    // opening board, so the very first comparison below caught it.
    for (let rematch = 0; rematch < 3; rematch += 1) {
      const { newSession } = createRematchSession(currentId);
      layouts.push(layoutOf(newSession.config));
      finish(newSession.id);
      currentId = newSession.id;
    }

    for (let index = 1; index < layouts.length; index += 1) {
      expect(layouts[index]).not.toBe(layouts[index - 1]);
    }
    // Every layout is a real generated board, not an absent one compared equal.
    expect(layouts.every((layout) => layout && layout.length > 2)).toBe(true);
  });

  it("keeps replaying the same board for variants that are not randomized", () => {
    const first = startedSession({
      ...randomStartConfig(),
      variant: "standard",
      randomStart: false,
    });
    finish(first.id);

    const { newSession } = createRematchSession(first.id);
    expect(layoutOf(newSession.config)).toBe(layoutOf(first.config));
  });

  it("refreshes Animal Cycle Random Start but preserves fixed Animal Cycle", () => {
    const randomized = startedSession({
      ...randomStartConfig(),
      variant: "animal-cycle",
    });
    finish(randomized.id);
    const { newSession: randomRematch } = createRematchSession(randomized.id);
    expect(layoutOf(randomRematch.config)).not.toBe(
      layoutOf(randomized.config),
    );

    const fixed = startedSession({
      ...randomStartConfig(),
      variant: "animal-cycle",
      randomStart: false,
    });
    finish(fixed.id);
    const { newSession: fixedRematch } = createRematchSession(fixed.id);
    expect(layoutOf(fixedRematch.config)).toBe(layoutOf(fixed.config));
  });

  it("gives Classic Random Start a fresh generated state on rematch", () => {
    const first = startedSession({
      ...randomStartConfig(),
      variant: "classic",
    });
    finish(first.id);

    const { newSession } = createRematchSession(first.id);
    expect(newSession.config.variant).toBe("classic");
    expect(newSession.config.randomStart).toBe(true);
    expect(layoutOf(newSession.config)).not.toBe(layoutOf(first.config));
  });

  it("normalizes legacy Freestyle and refreshes it on rematch", () => {
    const legacy = startedSession({
      ...randomStartConfig(),
      variant: "freestyle",
      randomStart: undefined,
    });
    expect(legacy.config.variant).toBe("standard");
    expect(legacy.config.randomStart).toBe(true);
    finish(legacy.id);
    const { newSession } = createRematchSession(legacy.id);
    expect(layoutOf(newSession.config)).not.toBe(layoutOf(legacy.config));
  });
});
