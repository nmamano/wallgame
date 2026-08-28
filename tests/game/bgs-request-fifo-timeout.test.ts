import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from "bun:test";
import type {
  EngineRequestV3,
  EngineResponseV3,
} from "../../shared/custom-bot/engine-api";
import type {
  BotConfig,
  BgsConfig,
} from "../../shared/contracts/custom-bot-protocol";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import type { EngineProcess } from "../../official-custom-bot-client/src/engine-runner";
import { BotClient } from "../../official-custom-bot-client/src/ws-client";
import type { PlayerId } from "../../shared/domain/game-types";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:9/unused";

const timers = jest as typeof jest & {
  useFakeTimers(): void;
  advanceTimersByTime(ms: number): void;
  useRealTimers(): void;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

class ControlledEngine {
  readonly alive = true;
  readonly exitStatus: number | null = null;
  readonly sessions = new Map<string, { ply: number; history: string[] }>();
  readonly events: string[] = [];
  private readonly held = new Map<string, Deferred<EngineResponseV3>[]>();
  readonly heldTypes = new Set<EngineRequestV3["type"]>();

  send(request: EngineRequestV3): Promise<EngineResponseV3> {
    this.events.push(`${request.type}:${request.bgsId}`);
    if (this.heldTypes.has(request.type)) {
      const gate = deferred<EngineResponseV3>();
      const waiting = this.held.get(request.type) ?? [];
      waiting.push(gate);
      this.held.set(request.type, waiting);
      return gate.promise;
    }
    return Promise.resolve(this.respond(request));
  }

  release(type: EngineRequestV3["type"], request: EngineRequestV3): void {
    const gate = this.held.get(type)?.shift();
    if (!gate) throw new Error(`no held ${type}`);
    gate.resolve(this.respond(request));
  }

  heldCount(type: EngineRequestV3["type"]): number {
    return this.held.get(type)?.length ?? 0;
  }

  kill(): void {
    return undefined;
  }
  onExit(): void {
    return undefined;
  }
  recentStderr(): string[] {
    return [];
  }

  private respond(request: EngineRequestV3): EngineResponseV3 {
    const id = request.bgsId;
    switch (request.type) {
      case "start_game_session":
        this.sessions.set(id, { ply: 0, history: [] });
        return {
          type: "game_session_started",
          bgsId: id,
          success: true,
          error: "",
        };
      case "end_game_session":
        this.sessions.delete(id);
        return {
          type: "game_session_ended",
          bgsId: id,
          success: true,
          error: "",
        };
      case "evaluate_position": {
        const session = this.sessions.get(id);
        const live = session?.ply === request.expectedPly;
        return {
          type: "evaluate_response",
          bgsId: id,
          ply: request.expectedPly,
          evaluation: 0,
          bestMove: live ? "---" : "",
          success: live,
          error: live ? "" : "engine session or ply mismatch",
        };
      }
      case "apply_move": {
        const session = this.sessions.get(id);
        const live = session?.ply === request.expectedPly;
        if (live) {
          session.history.push(request.move);
          session.ply += 1;
        }
        return {
          type: "move_applied",
          bgsId: id,
          ply: live ? session.ply : (session?.ply ?? request.expectedPly),
          success: live,
          error: live ? "" : "engine session or ply mismatch",
        };
      }
    }
  }
}

interface ClientInternals {
  engines: Map<string, EngineProcess>;
  sessionRoutes: Map<string, string>;
  ws: WebSocket | null;
  startEngines(): Promise<void>;
  startPingLoop(): void;
}

let server: ReturnType<typeof Bun.serve>;
let client: BotClient;
let engine: ControlledEngine;
let startBgsSession: typeof import("../../server/routes/custom-bot-socket").startBgsSession;
let requestEvaluation: typeof import("../../server/routes/custom-bot-socket").requestEvaluation;
let applyBgsMove: typeof import("../../server/routes/custom-bot-socket").applyBgsMove;
let endBgsSession: typeof import("../../server/routes/custom-bot-socket").endBgsSession;
let timeoutMs: number;
let getBgs: typeof import("../../server/games/bgs-store").getBgs;
let clearBgs: typeof import("../../server/games/bgs-store").clearAll;
let clearBots: typeof import("../../server/games/custom-bot-store").clearAll;
let addActiveGame: typeof import("../../server/games/custom-bot-store").addActiveGame;
let removeActiveGame: typeof import("../../server/games/custom-bot-store").removeActiveGame;
let createGameSession: typeof import("../../server/games/store").createGameSession;
let setBotCompositeId: typeof import("../../server/games/store").setBotCompositeId;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let getSession: typeof import("../../server/games/store").getSession;
let getResetPromise: typeof import("../../server/games/bgs-store").getResetPromise;
let resyncBgsFromHistory: typeof import("../../server/routes/game-socket").resyncBgsFromHistory;
const createdGameIds: string[] = [];

const BOT_ID = "timeout-client:engine";
const config: BgsConfig = {
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
  initialState: buildStandardInitialState(8, 8),
};
const bot: BotConfig = {
  botId: "engine",
  name: "Timeout Engine",
  username: null,
  variants: {
    standard: {
      boardWidth: { min: 5, max: 12 },
      boardHeight: { min: 5, max: 10 },
      recommended: [{ boardWidth: 8, boardHeight: 8 }],
    },
  },
};

const flushIo = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await new Promise<void>(setImmediate);
};

const until = async (
  label: string,
  predicate: () => boolean,
): Promise<void> => {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await flushIo();
  }
  throw new Error(`did not observe ${label}`);
};

async function start(id: string): Promise<void> {
  await startBgsSession(BOT_ID, id, id, config);
  expect(getBgs(id)?.status).toBe("ready");
  expect(engine.sessions.has(id)).toBe(true);
}

beforeAll(async () => {
  const appModule = await import("../../server/app");
  const socketModule = await import("../../server/routes/custom-bot-socket");
  const bgsStore = await import("../../server/games/bgs-store");
  const botStore = await import("../../server/games/custom-bot-store");
  const gameStore = await import("../../server/games/store");
  const gameSocket = await import("../../server/routes/game-socket");
  startBgsSession = socketModule.startBgsSession;
  requestEvaluation = socketModule.requestEvaluation;
  applyBgsMove = socketModule.applyBgsMove;
  endBgsSession = socketModule.endBgsSession;
  timeoutMs = socketModule.BGS_REQUEST_TIMEOUT_MS;
  getBgs = bgsStore.getBgs;
  clearBgs = bgsStore.clearAll;
  clearBots = botStore.clearAll;
  addActiveGame = botStore.addActiveGame;
  removeActiveGame = botStore.removeActiveGame;
  createGameSession = gameStore.createGameSession;
  setBotCompositeId = gameStore.setBotCompositeId;
  applyPlayerMove = gameStore.applyPlayerMove;
  getSession = gameStore.getSession;
  getResetPromise = bgsStore.getResetPromise;
  resyncBgsFromHistory = gameSocket.resyncBgsFromHistory;

  const { app, websocket } = appModule.createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  engine = new ControlledEngine();
  client = new BotClient({
    serverUrl: `http://localhost:${server.port}`,
    clientId: "timeout-client",
    bots: [bot],
    engineCommands: new Map([["engine", "injected"]]),
  });
  const internals = client as unknown as ClientInternals;
  internals.engines = new Map([["engine", engine as unknown as EngineProcess]]);
  internals.startEngines = () => Promise.resolve();
  internals.startPingLoop = () => undefined;
  await client.connect();
});

afterEach(() => {
  timers.useRealTimers();
  engine.heldTypes.clear();
  clearBgs();
  for (const id of createdGameIds.splice(0)) removeActiveGame(BOT_ID, id);
});

afterAll(async () => {
  client.close();
  clearBgs();
  clearBots();
  await server.stop(true);
});

describe("real BGS request deadlines with client FIFO", () => {
  it("uses the production 10,000ms value", () => {
    expect(timeoutMs).toBe(10_000);
  });

  for (const delay of [9_999, 10_000, 10_001]) {
    it(`Evaluate at ${delay}ms uses the real pending resolver`, async () => {
      const id = `eval-${delay}`;
      await start(id);
      timers.useFakeTimers();
      engine.heldTypes.add("evaluate_position");
      const result = requestEvaluation(BOT_ID, id, 0);
      const observed = result.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await until(
        "held Evaluate",
        () => engine.heldCount("evaluate_position") === 1,
      );

      timers.advanceTimersByTime(delay);
      await flushIo();
      if (delay < timeoutMs) {
        engine.release("evaluate_position", {
          type: "evaluate_position",
          bgsId: id,
          expectedPly: 0,
        });
        const outcome = await observed;
        expect(outcome.kind).toBe("resolved");
        if (outcome.kind === "resolved") {
          expect(outcome.value).toMatchObject({ success: true });
        }
      } else {
        const outcome = await observed;
        expect(outcome.kind).toBe("rejected");
        if (outcome.kind === "rejected") {
          expect(String(outcome.error)).toContain("evaluate_position timeout");
        }
        engine.release("evaluate_position", {
          type: "evaluate_position",
          bgsId: id,
          expectedPly: 0,
        });
        await flushIo();
      }
      expect(getBgs(id)?.pendingRequest).toBeNull();
    });
  }

  for (const delay of [9_999, 10_000, 10_001]) {
    it(`End at ${delay}ms cannot clean up after replacement Start`, async () => {
      const id = `end-${delay}`;
      await start(id);
      timers.useFakeTimers();
      engine.heldTypes.add("end_game_session");
      const ended = endBgsSession(BOT_ID, id);
      await until("held End", () => engine.heldCount("end_game_session") === 1);
      timers.advanceTimersByTime(delay);
      await flushIo();

      if (delay < timeoutMs) {
        engine.release("end_game_session", {
          type: "end_game_session",
          bgsId: id,
        });
        await ended;
      } else {
        await ended;
      }
      expect(getBgs(id)).toBeUndefined();

      const replacement = startBgsSession(BOT_ID, id, id, config);
      if (delay >= timeoutMs) {
        engine.release("end_game_session", {
          type: "end_game_session",
          bgsId: id,
        });
      }
      engine.heldTypes.clear();
      await replacement;
      expect(engine.sessions.has(id)).toBe(true);
      // The boundary under test is complete. Return to real timers before the
      // survival probe so WebSocket I/O is not coupled to fake-clock teardown.
      timers.useRealTimers();
      const survival = await requestEvaluation(BOT_ID, id, 0);
      expect(survival).toMatchObject({ success: true });
    });
  }

  for (const delay of [9_999, 10_000, 10_001]) {
    it(`drain ${delay}ms then End ${delay}ms use separate real deadlines`, async () => {
      const id = `drain-${delay}`;
      await start(id);
      timers.useFakeTimers();
      engine.heldTypes.add("evaluate_position");
      engine.heldTypes.add("end_game_session");
      const evaluation = requestEvaluation(BOT_ID, id, 0);
      const evaluationOutcome = evaluation.then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      await until(
        "held drained Evaluate",
        () => engine.heldCount("evaluate_position") === 1,
      );
      const drainStartedAt = Date.now();
      const ended = endBgsSession(BOT_ID, id);
      expect(String(await evaluationOutcome)).toContain(
        "Request cancelled - session ending",
      );

      timers.advanceTimersByTime(delay);
      await flushIo();
      if (delay < timeoutMs) {
        engine.release("evaluate_position", {
          type: "evaluate_position",
          bgsId: id,
          expectedPly: 0,
        });
      } else {
        // The server has completed its drain timeout, but the client FIFO still
        // correctly waits for the old engine call. Deliver that late response
        // so the already-sent End can advance to the engine.
        engine.release("evaluate_position", {
          type: "evaluate_position",
          bgsId: id,
          expectedPly: 0,
        });
      }
      await until(
        "End sent only after drain",
        () => engine.heldCount("end_game_session") === 1,
      );
      const endSentAt = Date.now();

      timers.advanceTimersByTime(delay);
      await flushIo();
      if (delay < timeoutMs) {
        engine.release("end_game_session", {
          type: "end_game_session",
          bgsId: id,
        });
      }
      await ended;
      expect(getBgs(id)).toBeUndefined();
      expect(Date.now() - endSentAt).toBe(delay);
      expect(Date.now() - drainStartedAt).toBe(delay * 2);

      const replacement = startBgsSession(BOT_ID, id, id, config);
      if (delay >= timeoutMs) {
        engine.release("end_game_session", {
          type: "end_game_session",
          bgsId: id,
        });
      }
      engine.heldTypes.clear();
      await replacement;
      timers.useRealTimers();
      const survival = await requestEvaluation(BOT_ID, id, 0);
      expect(survival).toMatchObject({ success: true });
      expect(engine.sessions.has(id)).toBe(true);
    });
  }
});

const wallMove = (column: number) => ({
  actions: [
    {
      type: "wall" as const,
      target: [0, column] as [number, number],
      wallOrientation: "vertical" as const,
    },
    {
      type: "wall" as const,
      target: [2, column] as [number, number],
      wallOrientation: "vertical" as const,
    },
  ],
});

const playWallTurn = (id: string, playerId: PlayerId, column: number): void => {
  applyPlayerMove({
    id,
    playerId,
    move: wallMove(column),
    timestamp: Date.now(),
  });
};

const createBotGame = async (): Promise<string> => {
  const { session } = createGameSession({
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
    hostDisplayName: "Human",
    hostIsPlayer1: true,
    joinerConfig: { type: "bot", displayName: "Timeout Engine" },
  });
  session.players.joiner.ready = true;
  session.status = "ready";
  setBotCompositeId(session.id, "joiner", BOT_ID);
  addActiveGame(
    BOT_ID,
    session.id,
    session.players.joiner.playerId,
    session.players.host.displayName,
  );
  playWallTurn(session.id, 1, 0);
  playWallTurn(session.id, 2, 1);
  await startBgsSession(BOT_ID, session.id, session.id, config);
  createdGameIds.push(session.id);
  return session.id;
};

describe("client-only rapid resync convergence", () => {
  const assertConverged = async (
    id: string,
    newestHistoryLength: number,
  ): Promise<void> => {
    const liveGame = getSession(id);
    const liveBgs = getBgs(id);
    const liveEngine = engine.sessions.get(id);
    expect(liveGame.gameState.status).toBe("playing");
    expect(liveGame.gameState.result).toBeUndefined();
    expect(liveBgs?.currentPly).toBe(newestHistoryLength);
    expect(liveEngine?.ply).toBe(newestHistoryLength);
    expect(liveEngine?.history).toHaveLength(newestHistoryLength);
    expect(liveBgs?.pendingRequest).toBeNull();
    expect(getResetPromise(id)).toBeNull();

    // Advance every real state by one move before probing the resolver with an
    // Evaluate. Evaluating the already-recorded final ply twice would append a
    // duplicate server history entry and hide the probe behind a mismatch WARN.
    const probeMove = wallMove(4);
    playWallTurn(id, 1, 4);
    await applyBgsMove(
      BOT_ID,
      id,
      newestHistoryLength,
      moveToStandardNotation(probeMove, 8),
    );
    expect(getBgs(id)?.currentPly).toBe(newestHistoryLength + 1);
    expect(engine.sessions.get(id)?.ply).toBe(newestHistoryLength + 1);
    const historyBeforeProbe = getBgs(id)?.history.length;
    expect(historyBeforeProbe).toBe(newestHistoryLength + 1);
    const postResync = await requestEvaluation(
      BOT_ID,
      id,
      newestHistoryLength + 1,
    );
    expect(postResync).toMatchObject({ success: true });
    expect(getBgs(id)?.history.length).toBe((historyBeforeProbe ?? 0) + 1);
    expect(engine.sessions.get(id)?.ply).toBe(newestHistoryLength + 1);
  };

  it("takeback keeps only the newest history after overlapping rebuilds", async () => {
    const id = await createBotGame();
    engine.heldTypes.add("end_game_session");

    const oldHistoryLength = getSession(id).gameState.history.length;
    const older = resyncBgsFromHistory(id, BOT_ID, "takeback");
    await until(
      "takeback first End",
      () => engine.heldCount("end_game_session") === 1,
    );

    playWallTurn(id, 1, 2);
    playWallTurn(id, 2, 3);
    const newestHistoryLength = getSession(id).gameState.history.length;
    // Known-bad value control: a rebuild that owns the first snapshot would
    // finish two plies stale. This must stay unequal before the newer owner
    // is allowed to converge the real BGS below.
    expect(oldHistoryLength).toBe(newestHistoryLength - 2);

    const newer = resyncBgsFromHistory(id, BOT_ID, "takeback");
    engine.release("end_game_session", {
      type: "end_game_session",
      bgsId: id,
    });
    let newerSettled = false;
    void newer.finally(() => {
      newerSettled = true;
    });
    await until(
      "takeback replacement End or route-absent acknowledgement",
      () => engine.heldCount("end_game_session") === 1 || newerSettled,
    );
    if (engine.heldCount("end_game_session") === 1) {
      engine.release("end_game_session", {
        type: "end_game_session",
        bgsId: id,
      });
    }
    engine.heldTypes.clear();

    await Promise.all([older, newer]);
    await assertConverged(id, newestHistoryLength);
  });

  it("replacement attach carries and converges a game during another resync", async () => {
    const id = await createBotGame();
    const oldInternals = client as unknown as ClientInternals;
    expect(oldInternals.sessionRoutes.has(id)).toBe(true);
    engine.heldTypes.add("end_game_session");
    const older = resyncBgsFromHistory(id, BOT_ID, "takeback");
    await until(
      "reattach first End",
      () => engine.heldCount("end_game_session") === 1,
    );

    playWallTurn(id, 1, 2);
    playWallTurn(id, 2, 3);
    const newestHistoryLength = getSession(id).gameState.history.length;
    const olderReset = getResetPromise(id);
    expect(olderReset).not.toBeNull();

    timers.useFakeTimers();
    oldInternals.ws?.close();
    await until(
      "old client discardSessionBookkeeping",
      () => oldInternals.sessionRoutes.size === 0,
    );
    // The old engine response can finish the same client's FIFO after route
    // cleanup. Its socket is down, so the server's old resolver stays pending
    // until the actual reattach owner drains it at the production timeout.
    engine.release("end_game_session", {
      type: "end_game_session",
      bgsId: id,
    });
    timers.advanceTimersByTime(5_000);
    await until(
      "same BotClient replacement attach and carried-game owner",
      () => {
        const current = getResetPromise(id);
        return current !== null && current !== olderReset;
      },
    );
    timers.advanceTimersByTime(timeoutMs);
    await until(
      "reattach completed rebuild",
      () =>
        getResetPromise(id) === null &&
        getBgs(id)?.currentPly === newestHistoryLength,
    );
    engine.heldTypes.clear();
    await older;
    timers.useRealTimers();
    expect(oldInternals.sessionRoutes.has(id)).toBe(true);
    await assertConverged(id, newestHistoryLength);
  });
});
