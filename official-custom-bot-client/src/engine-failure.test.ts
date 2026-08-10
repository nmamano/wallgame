/**
 * A configured bot whose engine is not running must not be advertised, and must
 * never be answered by the built-in bot under its own name (board task
 * 5f302c24).
 *
 * TWO FAILURE SHAPES, AND THEY ARE NOT THE SAME BUG. Measured on 2026-08-10:
 *
 *   A. MISSING BINARY. `Bun.spawn` throws synchronously, so nothing lands in
 *      the client's engine map. Before the fix, `getEngine` returned undefined
 *      and every handler took its built-in-bot branch — so the bot was listed
 *      AND played, with the built-in bot's moves going out under the
 *      configured bot's name. This is the reported bug.
 *
 *   B. THE ENGINE STARTS AND DIES. `Bun.spawn` returns normally and the
 *      EngineProcess is in the map, so the built-in bot is never reached.
 *      Before the fix the bot was listed and then FORFEITED: every request
 *      threw "Engine process is not running" and went back as success:false.
 *      Not impersonation, but the same root defect — a bot is offered that
 *      cannot play. B is the likelier production shape (a missing .trt file,
 *      a CUDA init failure), so a fix that only handled A would miss it.
 *
 * B's load-bearing assertion is therefore ABSENCE FROM THE ATTACH PAYLOAD, not
 * the refusal: success:false is what the engine-error path already produced
 * before this change, so a green "B is refused" would prove nothing on its own.
 *
 * The test drives the real BotClient over a stubbed WebSocket and real spawned
 * fixture engines. No server, no database, no GPU.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { join } from "node:path";
import { BotClient } from "./ws-client";
import { setLogLevel } from "./logger";
import {
  CUSTOM_BOT_PROTOCOL_VERSION,
  DEFAULT_BOT_LIMITS,
  type BotConfig,
} from "../../shared/contracts/custom-bot-protocol";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const HEALTHY_ENGINE = `bun run ${join(FIXTURES, "echo-engine.ts")}`;
const DYING_ENGINE = `bun run ${join(FIXTURES, "dying-engine.ts")}`;
const LATE_DYING_ENGINE = `bun run ${join(FIXTURES, "late-dying-engine.ts")}`;
const MISSING_BINARY = "wallgame-engine-that-does-not-exist";

const BOARD = 8;

/**
 * A stand-in for the global WebSocket the client constructs.
 *
 * It records what the client sent and lets the test play the server: `open()`
 * fires the client's onopen (which is what triggers the attach), and
 * `deliver()` feeds it a server message. Every socket the client opens is
 * kept, so a test can assert on a RE-attach as well as the first attach.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "test" });
  }

  /** Play the server accepting the connection. */
  open(): void {
    this.onopen?.();
  }

  /** Play the server sending a message. */
  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Every message the client sent on this socket, parsed. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

const bot = (botId: string, name: string): BotConfig => ({
  botId,
  name,
  username: null,
  variants: {
    standard: {
      boardWidth: { min: 5, max: 12 },
      boardHeight: { min: 5, max: 10 },
      recommended: [{ boardWidth: BOARD, boardHeight: BOARD }],
    },
  },
});

const attachedMessage = {
  type: "attached",
  protocolVersion: CUSTOM_BOT_PROTOCOL_VERSION,
  server: { name: "test-server", version: "0.0.0" },
  limits: DEFAULT_BOT_LIMITS,
};

const startSession = (bgsId: string, botId: string) => ({
  type: "start_game_session",
  bgsId,
  botId,
  config: {
    variant: "standard",
    boardWidth: BOARD,
    boardHeight: BOARD,
    initialState: buildStandardInitialState(BOARD, BOARD),
  },
});

const evaluate = (bgsId: string, expectedPly = 0) => ({
  type: "evaluate_position",
  bgsId,
  expectedPly,
});

/** Poll until `predicate` holds, or fail loudly rather than hang the suite. */
async function until<T>(
  what: string,
  predicate: () => T | undefined | null | false,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** The response frame of a given type, once the client has sent it. */
const responseOfType = (ws: FakeWebSocket, type: string) =>
  until(`a ${type} response`, () =>
    ws.frames().find((frame) => frame.type === type),
  );

let client: BotClient | undefined;
let originalWebSocket: unknown;

beforeEach(() => {
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  // The client logs an error for every withheld bot. That is the intended
  // behaviour, but it is noise in a passing test run.
  setLogLevel("error");
});

afterEach(() => {
  client?.close();
  client = undefined;
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  setLogLevel("info");
});

/**
 * Bring a client up against the fake server and return the attach payload.
 * The bot list it carries IS what the server advertises, so it is the subject
 * of most assertions below.
 */
async function attach(
  bots: BotConfig[],
  engineCommands: Map<string, string>,
): Promise<{ ws: FakeWebSocket; advertised: string[] }> {
  client = new BotClient({
    serverUrl: "http://localhost:5173",
    clientId: "test-client",
    bots,
    engineCommands,
  });

  const connected = client.connect();
  const ws = await until(
    "the client to open a socket",
    () => FakeWebSocket.instances[0],
  );
  ws.open();
  ws.deliver(attachedMessage);
  await connected;

  const attachFrame = ws
    .frames()
    .find((frame) => frame.type === "attach") as unknown as {
    bots: BotConfig[];
  };
  return { ws, advertised: attachFrame.bots.map((b) => b.botId) };
}

describe("a bot whose engine failed to start", () => {
  it("is not advertised when its binary is missing, and the built-in bot never answers for it", async () => {
    const { ws, advertised } = await attach(
      [bot("bot-healthy", "Healthy Bot"), bot("bot-missing", "Missing Bot")],
      new Map([
        ["bot-healthy", HEALTHY_ENGINE],
        ["bot-missing", MISSING_BINARY],
      ]),
    );

    expect(advertised).not.toContain("bot-missing");

    // Even if the server asks anyway — a stale listing, a retry — the answer is
    // a refusal, never a move from the built-in bot under this bot's name.
    ws.deliver(startSession("bgs-missing", "bot-missing"));
    const started = await responseOfType(ws, "game_session_started");
    expect(started.success).toBe(false);

    ws.deliver(evaluate("bgs-missing"));
    const answer = await responseOfType(ws, "evaluate_response");
    expect(answer.success).toBe(false);
    expect(answer.bestMove).toBe("");
  });

  it("is not advertised when the engine starts and then dies", async () => {
    const { ws, advertised } = await attach(
      [bot("bot-healthy", "Healthy Bot"), bot("bot-dying", "Dying Bot")],
      new Map([
        ["bot-healthy", HEALTHY_ENGINE],
        ["bot-dying", DYING_ENGINE],
      ]),
    );

    expect(advertised).not.toContain("bot-dying");

    // The same stray-message check as the missing-binary case, and NOT a
    // duplicate of it: here the dead EngineProcess is still in the client's
    // map, so this exercises the "present but not running" arm rather than the
    // "never created" one. Without this the two arms would look alike and only
    // one of them would be guarded.
    ws.deliver(startSession("bgs-dying", "bot-dying"));
    const started = await responseOfType(ws, "game_session_started");
    expect(started.success).toBe(false);

    ws.deliver(evaluate("bgs-dying"));
    const answer = await responseOfType(ws, "evaluate_response");
    expect(answer.success).toBe(false);
    expect(answer.bestMove).toBe("");
  });

  it("does not take its healthy neighbours down with it", async () => {
    const { ws, advertised } = await attach(
      [
        bot("bot-healthy", "Healthy Bot"),
        bot("bot-missing", "Missing Bot"),
        bot("bot-dying", "Dying Bot"),
      ],
      new Map([
        ["bot-healthy", HEALTHY_ENGINE],
        ["bot-missing", MISSING_BINARY],
        ["bot-dying", DYING_ENGINE],
      ]),
    );

    // Two dead engines, and the survivor is still listed and still playing.
    expect(advertised).toEqual(["bot-healthy"]);

    ws.deliver(startSession("bgs-healthy", "bot-healthy"));
    const started = await responseOfType(ws, "game_session_started");
    expect(started.success).toBe(true);

    ws.deliver(evaluate("bgs-healthy"));
    const answer = await responseOfType(ws, "evaluate_response");
    expect(answer.success).toBe(true);
    expect(answer.bestMove).toBe("a1"); // the fixture engine's move, not a built-in one
  });
});

describe("an engine that dies after it was already advertised", () => {
  it("re-attaches without that bot, and keeps serving the others", async () => {
    const { ws, advertised } = await attach(
      [bot("bot-healthy", "Healthy Bot"), bot("bot-later", "Later Bot")],
      new Map([
        ["bot-healthy", HEALTHY_ENGINE],
        ["bot-later", LATE_DYING_ENGINE],
      ]),
    );

    // It was healthy at startup, so it is advertised — that is the premise.
    expect(advertised).toContain("bot-later");

    // Advertising can only change by attaching again, so the client drops the
    // socket and the reconnect path carries the reduced list.
    const second = await until(
      "the client to re-attach on a fresh socket",
      () => FakeWebSocket.instances[1],
      15000,
    );
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);

    second.open();
    const reattach = await until("the re-attach frame", () =>
      second.frames().find((frame) => frame.type === "attach"),
    );
    const readvertised = (
      reattach as unknown as { bots: BotConfig[] }
    ).bots.map((b) => b.botId);

    expect(readvertised).toEqual(["bot-healthy"]);
  }, 20000);
});

describe("an engine that dies while the first attach is still in flight", () => {
  it("still re-attaches without that bot, instead of taking the whole client down", async () => {
    // The narrow window the other late-death test cannot reach: the socket is
    // open and the attach has been SENT, but the server's "attached" has not
    // come back yet, so the client is still in its "connecting" state. A
    // close here looks exactly like a failed connection — it rejects
    // connect(), which escapes run() and exits the process. That would
    // restart every engine, which is option C rather than the option A Nil
    // approved.
    client = new BotClient({
      serverUrl: "http://localhost:5173",
      clientId: "test-client",
      bots: [bot("bot-healthy", "Healthy Bot"), bot("bot-later", "Later Bot")],
      engineCommands: new Map([
        ["bot-healthy", HEALTHY_ENGINE],
        ["bot-later", LATE_DYING_ENGINE],
      ]),
    });

    let connectFailed: unknown;
    const connected = client.connect().catch((error: unknown) => {
      connectFailed = error;
    });

    const first = await until(
      "the client to open its first socket",
      () => FakeWebSocket.instances[0],
      10000,
    );
    first.open(); // attach goes out; no "attached" comes back yet

    // Outlive the fixture, so the engine dies inside the window.
    await Bun.sleep(1500);

    // The server finally answers the attach it was sent.
    first.deliver(attachedMessage);
    await connected;

    // The client is up. It did NOT die on the way in.
    expect(connectFailed).toBeUndefined();

    const second = await until(
      "the client to re-attach on a fresh socket",
      () => FakeWebSocket.instances[1],
      15000,
    );
    second.open();
    const reattach = await until("the re-attach frame", () =>
      second.frames().find((frame) => frame.type === "attach"),
    );

    expect(
      (reattach as unknown as { bots: BotConfig[] }).bots.map((b) => b.botId),
    ).toEqual(["bot-healthy"]);
  }, 25000);
});

describe("a bot that deliberately has no engine", () => {
  it("is still advertised and still served by the built-in bot", async () => {
    // The built-in bot is not being removed — the test configs use it, and
    // board task 9c0ac857 will use it on purpose. What changed is that
    // reaching it requires a config that asked for it.
    const { ws, advertised } = await attach(
      [bot("bot-builtin", "Built-in Bot")],
      new Map(),
    );

    expect(advertised).toEqual(["bot-builtin"]);

    ws.deliver(startSession("bgs-builtin", "bot-builtin"));
    const started = await responseOfType(ws, "game_session_started");
    expect(started.success).toBe(true);

    ws.deliver(evaluate("bgs-builtin"));
    const answer = await responseOfType(ws, "evaluate_response");
    expect(answer.success).toBe(true);
    expect(answer.bestMove).not.toBe("");
  });
});

describe("every engine dead", () => {
  it("refuses to attach at all rather than advertise nothing it can serve", async () => {
    client = new BotClient({
      serverUrl: "http://localhost:5173",
      clientId: "test-client",
      bots: [bot("bot-missing", "Missing Bot"), bot("bot-dying", "Dying Bot")],
      engineCommands: new Map([
        ["bot-missing", MISSING_BINARY],
        ["bot-dying", DYING_ENGINE],
      ]),
    });

    // Bounded on purpose: before the fix, connect() neither resolved nor
    // rejected here — it opened a socket and waited forever for an attach that
    // the test never sends. An unbounded await would hang the suite instead of
    // reporting the defect.
    let thrown: unknown;
    try {
      await Promise.race([
        client.connect(),
        // Comfortably past the startup grace window, so this bound reports a
        // client that never settles rather than one that is merely waiting.
        Bun.sleep(8000).then(() => {
          throw new Error("TIMEOUT: connect() did not settle within 8s");
        }),
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toMatch(/every configured engine/i);
    // It never even opened a socket, so the server saw nothing.
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
