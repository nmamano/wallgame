import { describe, expect, it } from "bun:test";
import type {
  EngineRequestV3,
  EngineResponseV3,
} from "../../shared/custom-bot/engine-api";
import type {
  BotConfig,
  CustomBotServerMessage,
  StartGameSessionMessage,
} from "../../shared/contracts/custom-bot-protocol";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import type { EngineProcess } from "./engine-runner";
import { BotClient } from "./ws-client";

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

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const until = async (
  label: string,
  predicate: () => boolean,
): Promise<void> => {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`did not observe ${label}`);
};

class RecordingSocket {
  readonly sent: Record<string, unknown>[] = [];
  readonly readyState = 1;

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
}

class DeferredSessionEngine {
  readonly events: string[] = [];
  readonly sessions = new Set<string>();
  readonly oldEnd = deferred<EngineResponseV3>();
  readonly earlyEvaluate = deferred<EngineResponseV3>();
  readonly alive = true;
  readonly exitStatus: number | null = null;
  endReleased = false;
  earlyEvaluateStarted = false;

  async send(request: EngineRequestV3): Promise<EngineResponseV3> {
    const id = request.bgsId;
    switch (request.type) {
      case "start_game_session":
        this.events.push(`start:${id}`);
        this.sessions.add(id);
        return {
          type: "game_session_started",
          bgsId: id,
          success: true,
          error: "",
        };
      case "end_game_session":
        this.events.push(`end-begin:${id}`);
        return this.oldEnd.promise;
      case "evaluate_position": {
        this.events.push(`evaluate-begin:${id}`);
        if (!this.endReleased) {
          this.earlyEvaluateStarted = true;
          return this.earlyEvaluate.promise;
        }
        return this.evaluateNow(id, request.expectedPly);
      }
      case "apply_move":
        this.events.push(`apply:${id}`);
        return {
          type: "move_applied",
          bgsId: id,
          ply: request.expectedPly + 1,
          success: this.sessions.has(id),
          error: this.sessions.has(id) ? "" : "engine session not found",
        };
    }
  }

  releaseOldEnd(id: string): void {
    this.endReleased = true;
    this.sessions.delete(id);
    this.events.push(`end-complete:${id}`);
    this.oldEnd.resolve({
      type: "game_session_ended",
      bgsId: id,
      success: true,
      error: "",
    });
    if (this.earlyEvaluateStarted) {
      this.earlyEvaluate.resolve(this.evaluateNow(id, 0));
    }
  }

  private evaluateNow(id: string, ply: number): EngineResponseV3 {
    const live = this.sessions.has(id);
    this.events.push(`${live ? "evaluate-live" : "evaluate-dead"}:${id}`);
    return {
      type: "evaluate_response",
      bgsId: id,
      ply,
      evaluation: 0,
      bestMove: live ? "a1" : "",
      success: live,
      error: live ? "" : "engine session not found",
    };
  }
}

interface ClientInternals {
  ws: RecordingSocket;
  state: "waiting";
  engines: Map<string, EngineProcess>;
  sessionRoutes: Map<string, string>;
  handleMessage(data: string): void;
}

const BOT_ID = "fifo-engine";
const BGS_ID = "reused-bgs";
const bot: BotConfig = {
  botId: BOT_ID,
  name: "FIFO Engine",
  username: null,
  variants: {
    standard: {
      boardWidth: { min: 5, max: 12 },
      boardHeight: { min: 5, max: 10 },
      recommended: [{ boardWidth: 8, boardHeight: 8 }],
    },
  },
};

const startMessage = (): StartGameSessionMessage => ({
  type: "start_game_session",
  bgsId: BGS_ID,
  botId: BOT_ID,
  config: {
    variant: "standard",
    boardWidth: 8,
    boardHeight: 8,
    initialState: buildStandardInitialState(8, 8),
  },
});

const dispatch = (
  client: ClientInternals,
  message: CustomBotServerMessage,
): void => {
  client.handleMessage(JSON.stringify(message));
};

const response = (socket: RecordingSocket, type: string, occurrence: number) =>
  socket.sent.filter((frame) => frame.type === type)[occurrence];

describe("per-bgsId client FIFO", () => {
  it("keeps a replacement route and engine session after a delayed old End", async () => {
    const engine = new DeferredSessionEngine();
    const socket = new RecordingSocket();
    const client = new BotClient({
      serverUrl: "http://test.invalid",
      clientId: "fifo-test",
      bots: [bot],
      engineCommands: new Map([[BOT_ID, "injected-test-engine"]]),
    }) as unknown as ClientInternals;
    client.ws = socket;
    client.state = "waiting";
    client.engines = new Map([[BOT_ID, engine as unknown as EngineProcess]]);

    dispatch(client, startMessage());
    await until("initial Start", () => engine.sessions.has(BGS_ID));

    engine.events.length = 0;
    socket.sent.length = 0;
    dispatch(client, { type: "end_game_session", bgsId: BGS_ID });
    await until("old End begin", () =>
      engine.events.includes(`end-begin:${BGS_ID}`),
    );

    dispatch(client, startMessage());
    dispatch(client, {
      type: "evaluate_position",
      bgsId: BGS_ID,
      expectedPly: 0,
    });
    await flush();

    const startOvertookEnd = engine.events.includes(`start:${BGS_ID}`);
    const earlyEvaluateStarted = engine.events.includes(
      `evaluate-begin:${BGS_ID}`,
    );

    engine.releaseOldEnd(BGS_ID);
    await until(
      "replacement Start and pre-cleanup Evaluate responses",
      () =>
        socket.sent.filter((frame) => frame.type === "game_session_started")
          .length >= 1 &&
        socket.sent.filter((frame) => frame.type === "evaluate_response")
          .length >= 1,
    );

    dispatch(client, {
      type: "evaluate_position",
      bgsId: BGS_ID,
      expectedPly: 0,
    });
    await until(
      "post-cleanup Evaluate response",
      () =>
        socket.sent.filter((frame) => frame.type === "evaluate_response")
          .length >= 2,
    );

    const failures: string[] = [];
    if (startOvertookEnd) {
      failures.push(
        "ORDER: old End began -> replacement Start completed before old End cleanup",
      );
    }
    if (
      earlyEvaluateStarted &&
      response(socket, "evaluate_response", 0)?.success !== true
    ) {
      failures.push(
        "DEAD_SESSION_BRANCH: Evaluate dispatched before stale cleanup used the route but the old End destroyed the replacement engine session",
      );
    }
    if (!client.sessionRoutes.has(BGS_ID)) {
      failures.push(
        "ROUTE_SURVIVAL: stale End cleanup deleted the replacement route",
      );
    }
    if (!engine.sessions.has(BGS_ID)) {
      failures.push(
        "ENGINE_SESSION_SURVIVAL: stale End destroyed the replacement engine session",
      );
    }
    if (response(socket, "evaluate_response", 1)?.success !== true) {
      failures.push(
        "NO_ROUTE_BRANCH: Evaluate dispatched after stale cleanup received a false no-route failure",
      );
    }
    if (failures.length > 0) throw new Error(failures.join("\n"));

    expect(engine.events).toEqual([
      `end-begin:${BGS_ID}`,
      `end-complete:${BGS_ID}`,
      `start:${BGS_ID}`,
      `evaluate-begin:${BGS_ID}`,
      `evaluate-live:${BGS_ID}`,
      `evaluate-begin:${BGS_ID}`,
      `evaluate-live:${BGS_ID}`,
    ]);
  });

  it("preserves built-in and unavailable responder contracts", async () => {
    const builtInSocket = new RecordingSocket();
    const builtIn = new BotClient({
      serverUrl: "http://test.invalid",
      clientId: "built-in-test",
      bots: [bot],
      engineCommands: new Map(),
    }) as unknown as ClientInternals;
    builtIn.ws = builtInSocket;
    builtIn.state = "waiting";

    dispatch(builtIn, startMessage());
    dispatch(builtIn, {
      type: "evaluate_position",
      bgsId: BGS_ID,
      expectedPly: 0,
    });
    dispatch(builtIn, { type: "end_game_session", bgsId: BGS_ID });
    await until("built-in FIFO replies", () => builtInSocket.sent.length === 3);
    expect(
      builtInSocket.sent.map((frame) => [frame.type, frame.success]),
    ).toEqual([
      ["game_session_started", true],
      ["evaluate_response", true],
      ["game_session_ended", true],
    ]);
    expect(builtIn.sessionRoutes.has(BGS_ID)).toBe(false);

    const unavailableSocket = new RecordingSocket();
    const unavailable = new BotClient({
      serverUrl: "http://test.invalid",
      clientId: "unavailable-test",
      bots: [bot],
      engineCommands: new Map([[BOT_ID, "missing-test-engine"]]),
    }) as unknown as ClientInternals;
    unavailable.ws = unavailableSocket;
    unavailable.state = "waiting";

    dispatch(unavailable, startMessage());
    dispatch(unavailable, {
      type: "evaluate_position",
      bgsId: BGS_ID,
      expectedPly: 0,
    });
    dispatch(unavailable, { type: "end_game_session", bgsId: BGS_ID });
    await until(
      "unavailable FIFO replies",
      () => unavailableSocket.sent.length === 3,
    );
    expect(
      unavailableSocket.sent.map((frame) => [
        frame.type,
        frame.success,
        frame.error,
      ]),
    ).toEqual([
      [
        "game_session_started",
        false,
        `the engine for ${BOT_ID} failed to start`,
      ],
      ["evaluate_response", false, "no session route for this bgsId"],
      ["game_session_ended", false, "no session route for this bgsId"],
    ]);
  });
});
