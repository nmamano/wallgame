import { beforeAll, describe, expect, it } from "bun:test";

process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
let store: typeof import("../../server/games/store");
beforeAll(async () => {
  store = await import("../../server/games/store");
});

function game(finished = true) {
  const { session } = store.createGameSession({
    config: {
      boardWidth: 8,
      boardHeight: 8,
      variant: "standard",
      rated: false,
      timeControl: {
        initialSeconds: 0,
        incrementSeconds: 0,
        preset: "unlimited",
      },
    },
    matchType: "friend",
    hostIsPlayer1: true,
  });
  store.joinGameSession({ id: session.id, displayName: "Fixture" });
  if (finished)
    store.resignGame({ id: session.id, playerId: 1, timestamp: Date.now() });
  return session;
}

function sweep(
  session: ReturnType<typeof game>,
  overrides: Partial<Parameters<typeof store.releaseEndedSessions>[0]> = {},
) {
  return store.releaseEndedSessions({
    now: session.updatedAt + store.ENDED_SESSION_RETENTION_MS,
    hasConnections: (id) => id !== session.id,
    finalize: () => Promise.resolve(),
    onError: (_id, error) => {
      throw error;
    },
    ...overrides,
  });
}

describe("ended game session retention", () => {
  it("releases ended sessions only after finalization", async () => {
    const session = game();
    let saved = false;
    expect(
      await sweep(session, {
        finalize: (s) => {
          expect(store.getSession(s.id)).toBe(session);
          saved = true;
          return Promise.resolve();
        },
      }),
    ).toBe(1);
    expect(saved).toBe(true);
    expect(() => store.getSession(session.id)).toThrow(
      "Game session not found",
    );
  });

  it("retains live games and the reconnect/rematch grace period", async () => {
    const live = game(false);
    expect(await sweep(live)).toBe(0);
    const ended = game();
    expect(
      await sweep(ended, {
        now: ended.updatedAt + store.ENDED_SESSION_RETENTION_MS - 1,
      }),
    ).toBe(0);
    expect(store.getSession(live.id)).toBe(live);
    expect(store.getSession(ended.id)).toBe(ended);
  });

  it("protects player and spectator connections", async () => {
    const session = game();
    session.players.host.connected = true;
    expect(await sweep(session)).toBe(0);
    session.players.host.connected = false;
    expect(await sweep(session, { hasConnections: () => true })).toBe(0);
    expect(store.getSession(session.id)).toBe(session);
  });

  it("retains failed saves and retries them", async () => {
    const session = game();
    let failures = 0;
    expect(
      await sweep(session, {
        finalize: () => Promise.reject(new Error("database unavailable")),
        onError: () => {
          failures++;
        },
      }),
    ).toBe(0);
    expect(failures).toBe(1);
    expect(store.getSession(session.id)).toBe(session);
    expect(await sweep(session)).toBe(1);
  });

  it("protects reconnects while a save is pending", async () => {
    const session = game();
    const pending = Promise.withResolvers<void>();
    let saving = false;
    const cleanup = sweep(session, {
      finalize: () => {
        saving = true;
        return pending.promise;
      },
    });
    expect(saving).toBe(true);
    expect(store.getSession(session.id)).toBe(session);
    session.players.joiner.connected = true;
    pending.resolve();
    expect(await cleanup).toBe(0);
    expect(store.getSession(session.id)).toBe(session);
  });

  it("protects a rematch created during finalization", async () => {
    const session = game();
    expect(
      await sweep(session, {
        finalize: () => {
          store.createRematchSession(session.id);
          // Ensure a distinct timestamp even on a sub-millisecond test run.
          session.updatedAt++;
          return Promise.resolve();
        },
      }),
    ).toBe(0);
    expect(store.getSession(session.nextGameId!).status).not.toBe("completed");
  });

  it("releases cancelled lobbies too", async () => {
    const session = game(false);
    store.cancelGameSession({
      id: session.id,
      token: session.players.host.token,
    });
    expect(await sweep(session)).toBe(1);
  });

  it("does not accumulate completed sessions across batches", async () => {
    const baseline = store.sessionMemoryStats().sessions;
    for (let batch = 0; batch < 3; batch++) {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) ids.add(game().id);
      expect(
        await store.releaseEndedSessions({
          now: Date.now() + store.ENDED_SESSION_RETENTION_MS,
          hasConnections: (id) => !ids.has(id),
          finalize: () => Promise.resolve(),
          onError: (_id, error) => {
            throw error;
          },
        }),
      ).toBe(100);
      expect(store.sessionMemoryStats().sessions).toBe(baseline);
    }
  });
});
