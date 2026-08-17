import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import {
  DRAIN_SENTINEL_PATH,
  DRAIN_TTL_MS,
  NEW_GAMES_PAUSED_MESSAGE,
} from "../../server/games/drain";
import type {
  GameConfiguration,
  Move,
  PlayerId,
} from "../../shared/domain/game-types";
import type { GameCreateResponse } from "../../shared/contracts/games";

/**
 * The drain, driven through the real HTTP app: new games are refused, the game
 * already being played is not, and a sentinel nobody re-touches lapses.
 *
 * The sentinel is a real file at the real path this server reads, so this test
 * exercises the shipped mechanism rather than a stand-in. It is removed before
 * and after the run: left behind, it would refuse every game the rest of the
 * suite tries to create - which is itself a small demonstration of why the TTL
 * exists.
 */

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl = "";
let store: typeof import("../../server/games/store");
let drainError: typeof import("../../server/games/drain").NewGamesPausedError;

const CONFIG: GameConfiguration = {
  boardHeight: 8,
  boardWidth: 8,
  rated: false,
  variant: "standard",
  randomStart: false,
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
  variantConfig: {
    pawns: {
      p1: { cat: [0, 0], mouse: [7, 7] },
      p2: { cat: [0, 7], mouse: [7, 0] },
    },
    walls: [],
  },
};

/** An opening that is legal for either seat, as in match-tracking.test.ts. */
const openingMove = (playerId: PlayerId): Move =>
  playerId === 1
    ? {
        actions: [
          { type: "cat", target: [0, 1] },
          { type: "mouse", target: [6, 0] },
        ],
      }
    : {
        actions: [
          { type: "cat", target: [0, 6] },
          { type: "mouse", target: [6, 7] },
        ],
      };

const drainOn = (touchedAtMs = Date.now()) => {
  writeFileSync(DRAIN_SENTINEL_PATH, "");
  const seconds = touchedAtMs / 1000;
  utimesSync(DRAIN_SENTINEL_PATH, seconds, seconds);
};

const drainOff = () => rmSync(DRAIN_SENTINEL_PATH, { force: true });

const createGameOverHttp = () =>
  fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: {
        variant: CONFIG.variant,
        randomStart: CONFIG.randomStart,
        boardWidth: CONFIG.boardWidth,
        boardHeight: CONFIG.boardHeight,
        rated: CONFIG.rated,
        timeControl: CONFIG.timeControl,
      },
      matchType: "friend",
      hostDisplayName: "host",
      hostIsPlayer1: true,
    }),
  });

const readDrainEndpoint = async () => {
  const response = await fetch(`${baseUrl}/api/games/drain`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    draining: boolean;
    expiresAtMs: number | null;
    gamesInFlight: number;
  };
};

const countSpectatableGames = async () => {
  const response = await fetch(`${baseUrl}/api/games/live`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { games: unknown[] };
  return body.games.length;
};

beforeAll(async () => {
  drainOff();
  ({ container } = await setupEphemeralDb());
  const { createApp } = await import("../../server/app");
  store = await import("../../server/games/store");
  drainError = (await import("../../server/games/drain")).NewGamesPausedError;
  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}, 120_000);

afterAll(async () => {
  drainOff();
  await server?.stop(true);
  await teardownEphemeralDb(container);
});

describe("a drain refuses new games and leaves the live ones alone", () => {
  let inFlightId = "";

  it("takes a game before the drain starts", async () => {
    const response = await createGameOverHttp();
    expect(response.status).toBe(201);
    const body = (await response.json()) as GameCreateResponse;
    inFlightId = body.gameId;
    store.joinGameSession({ id: inFlightId, displayName: "joiner" });
    store.applyPlayerMove({
      id: inFlightId,
      playerId: 1,
      move: openingMove(1),
      timestamp: Date.now(),
    });
  });

  it("refuses the next one with the message the player reads", async () => {
    drainOn();
    const response = await createGameOverHttp();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: NEW_GAMES_PAUSED_MESSAGE });
  });

  it("lets the game already under way carry on", () => {
    // The point of the whole feature. A refusal must cost the players who are
    // mid-game nothing at all.
    const state = store.applyPlayerMove({
      id: inFlightId,
      playerId: 2,
      move: openingMove(2),
      timestamp: Date.now(),
    });
    expect(state.status).toBe("playing");
    expect(state.moveCount).toBe(2);
  });

  it("answers the deploy poll with both halves at once", async () => {
    // A whole second, so the expiry can be asserted exactly: the filesystem
    // keeps sub-second times here, and a fractional touch would only turn this
    // into a test of rounding.
    const touchedAt = Math.floor(Date.now() / 1000) * 1000;
    drainOn(touchedAt);
    const body = await readDrainEndpoint();
    expect(body.draining).toBe(true);
    expect(body.expiresAtMs).toBe(touchedAt + DRAIN_TTL_MS);
    // The game from the first test is still being played, so a deploy that
    // trusted "drain is on" alone would restart over it.
    expect(body.gamesInFlight).toBeGreaterThanOrEqual(1);
  });

  it("refuses a rematch through the same door", () => {
    store.resignGame({
      id: inFlightId,
      playerId: 1,
      timestamp: Date.now(),
    });
    expect(() => store.createRematchSession(inFlightId)).toThrow(drainError);
  });

  it("stops counting a finished game as live", async () => {
    const body = await readDrainEndpoint();
    expect(body.gamesInFlight).toBe(0);
  });

  /**
   * Reviewer 1's second finding, 2026-08-17, and the race it closes.
   *
   * A friend lobby sits at "waiting" until the invited player arrives, and Nil
   * ruled that joining one stays allowed during a drain. The first count only
   * counted "ready" and "in-progress", so the gate could read zero with a lobby
   * open - and the friend who joined a second later lost the game to the
   * restart. My own runbook claimed such a lobby was "already counted", which
   * was simply false.
   *
   * All four claims are asserted in one test because they only mean anything
   * together: counted before, joinable during, still counted after.
   */
  it("counts a waiting lobby, and still lets the friend join it", async () => {
    drainOff();
    const response = await createGameOverHttp();
    expect(response.status).toBe(201);
    const lobby = (await response.json()) as GameCreateResponse;
    expect(lobby.snapshot.status).toBe("waiting");

    // Counted while it is only a lobby: nobody is playing yet, but somebody is
    // about to be.
    expect((await readDrainEndpoint()).gamesInFlight).toBe(1);
    // And invisible to spectators, which is why the live list cannot be the
    // deploy gate.
    expect(await countSpectatableGames()).toBe(0);

    drainOn();
    // Nil's ruling: the invited friend is not turned away mid-invite.
    const joinResponse = await fetch(
      `${baseUrl}/api/games/${lobby.gameId}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "invited friend" }),
      },
    );
    expect(joinResponse.status).toBe(200);

    // Still counted after the transition the race depended on.
    const afterJoin = await readDrainEndpoint();
    expect(afterJoin.draining).toBe(true);
    expect(afterJoin.gamesInFlight).toBe(1);
    expect(await countSpectatableGames()).toBe(1);

    store.cancelGameSession({ id: lobby.gameId, token: lobby.hostToken });
    expect((await readDrainEndpoint()).gamesInFlight).toBe(0);
  });

  /**
   * Reviewer 1's first finding, 2026-08-17, and the control that keeps it fixed.
   *
   * A puzzle attempt is hidden from the live list because it is solo practice,
   * not spectator content. A restart destroys it anyway. The first version of
   * this feature counted the spectator set, so the drain would have reported an
   * empty site while somebody was mid-puzzle - and a deploy would have taken
   * their attempt away.
   *
   * The two readings are asserted TOGETHER on purpose: either predicate alone
   * looks right, and only the pair shows they select different sets.
   */
  it("counts a puzzle attempt that /live is right to hide", async () => {
    // The attempt has to start before the drain does, like the real case: a
    // player mid-puzzle when ops decides to deploy.
    drainOff();
    const { session, hostToken } = store.createGameSession({
      config: CONFIG,
      matchType: "friend",
      hostDisplayName: "solver",
      hostIsPlayer1: true,
      puzzleId: "harness-puzzle",
    });
    store.joinGameSession({ id: session.id, displayName: "puzzle bot" });
    drainOn();

    const body = await readDrainEndpoint();
    expect(body.draining).toBe(true);
    // What the deploy gate reads: someone would lose something.
    expect(body.gamesInFlight).toBe(1);
    // What a spectator may watch: nothing. Both are correct at once.
    expect(await countSpectatableGames()).toBe(0);

    store.cancelGameSession({ id: session.id, token: hostToken });
    expect((await readDrainEndpoint()).gamesInFlight).toBe(0);
  });
});

describe("a forgotten drain heals itself", () => {
  it("lapses once the sentinel is older than the TTL", async () => {
    drainOn(Date.now() - DRAIN_TTL_MS - 60_000);
    const body = await readDrainEndpoint();
    expect(body).toEqual({
      draining: false,
      expiresAtMs: null,
      gamesInFlight: 0,
    });
    const response = await createGameOverHttp();
    expect(response.status).toBe(201);
    const created = (await response.json()) as GameCreateResponse;
    store.cancelGameSession({
      id: created.gameId,
      token: created.hostToken,
    });
  });

  it("takes games again as soon as the sentinel is removed", async () => {
    drainOn();
    expect((await createGameOverHttp()).status).toBe(503);
    drainOff();
    const response = await createGameOverHttp();
    expect(response.status).toBe(201);
    const created = (await response.json()) as GameCreateResponse;
    store.cancelGameSession({
      id: created.gameId,
      token: created.hostToken,
    });
  });
});
