import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { GameClient, type TransportState } from "./game-client";

/**
 * Lifecycle tests for board 97f9d99c.
 *
 * Before this, a closed game socket was permanent: measured on 2026-08-16
 * against a local server, restarting the backend left the page with
 * opened=1 closed=1 and no further attempt, still rendering a live game it
 * could not send to.
 *
 * The seam is the browser globals the client uses - `WebSocket` and the timer
 * functions on `window`. Driving those directly keeps the test on the
 * client's own decisions (when to retry, which socket owns the state) instead
 * of on real elapsed time.
 */

interface Listeners {
  open: (() => void)[];
  close: (() => void)[];
  error: ((event: unknown) => void)[];
  message: ((event: { data: string }) => void)[];
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  closeCalls: { code: number; reason: string }[] = [];
  sent: string[] = [];
  private readonly listeners: Listeners = {
    open: [],
    close: [],
    error: [],
    message: [],
  };

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: keyof Listeners, handler: unknown): void {
    (this.listeners[type] as unknown[]).push(handler);
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** The socket reaching "open" on the wire. */
  emitOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.listeners.open.forEach((fn) => fn());
  }

  /** The connection ending, for any reason. */
  emitClose(): void {
    this.readyState = 3;
    this.listeners.close.forEach((fn) => fn());
  }

  emitMessage(data: string): void {
    this.listeners.message.forEach((fn) => fn({ data }));
  }
}

interface PendingTimeout {
  id: number;
  fn: () => void;
  delay: number;
}

let pendingTimeouts: PendingTimeout[] = [];
let nextTimerId = 1;

const runNextTimeout = (): number => {
  const entry = pendingTimeouts.shift();
  if (!entry) throw new Error("no pending timeout");
  entry.fn();
  return entry.delay;
};

const originalWindow = (globalThis as { window?: unknown }).window;
const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  FakeSocket.instances = [];
  pendingTimeouts = [];
  nextTimerId = 1;
  (globalThis as { window?: unknown }).window = {
    location: { origin: "http://localhost:5173" },
    setTimeout: (fn: () => void, delay: number) => {
      const id = nextTimerId++;
      pendingTimeouts.push({ id, fn, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      pendingTimeouts = pendingTimeouts.filter((entry) => entry.id !== id);
    },
    setInterval: () => nextTimerId++,
    // The keepalive ping is not what these tests measure; its timer is
    // handed out and dropped.
    clearInterval: () => undefined,
  };
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
});

const newClient = () => {
  const states: TransportState[] = [];
  const client = new GameClient({ gameId: "g1", socketToken: "tok" });
  client.connect({ onTransportState: (state) => states.push(state) });
  return { client, states };
};

describe("GameClient reconnection", () => {
  it("reopens after a close it did not ask for", () => {
    const { client, states } = newClient();
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0].emitOpen();
    FakeSocket.instances[0].emitClose();

    expect(states).toEqual(["connecting", "open", "reconnecting"]);
    expect(pendingTimeouts).toHaveLength(1);
    runNextTimeout();
    expect(FakeSocket.instances).toHaveLength(2);
    void client;
  });

  it("backs off with a capped delay and no attempt limit", () => {
    newClient();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
      socket.emitClose();
      delays.push(runNextTimeout());
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
    // Still trying after the schedule saturates - a long outage must not
    // strand the player on a board that can never recover.
    expect(FakeSocket.instances).toHaveLength(9);
  });

  it("restarts the backoff schedule once a socket opens", () => {
    newClient();
    FakeSocket.instances[0].emitClose();
    expect(runNextTimeout()).toBe(500);
    FakeSocket.instances[1].emitClose();
    expect(runNextTimeout()).toBe(1000);

    FakeSocket.instances[2].emitOpen();
    FakeSocket.instances[2].emitClose();
    expect(runNextTimeout()).toBe(500);
  });

  it("does not reconnect after a close the caller asked for", () => {
    const { client, states } = newClient();
    FakeSocket.instances[0].emitOpen();

    client.close("test disconnect");
    FakeSocket.instances[0].emitClose();

    expect(pendingTimeouts).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(states).not.toContain("reconnecting");
  });

  /**
   * The retry timer is armed BEFORE the page decides to leave. Without the
   * cancel in close(), that timer still fires and attaches a socket to a game
   * nobody is watching.
   */
  it("cancels a retry that is already pending when the caller closes", () => {
    const { client } = newClient();
    FakeSocket.instances[0].emitClose();
    expect(pendingTimeouts).toHaveLength(1);

    client.close("left the page");

    expect(pendingTimeouts).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  /**
   * A replaced socket keeps its own listeners and still delivers. Its close
   * must not speak for the live socket.
   */
  it("ignores a close from a socket that has already been replaced", () => {
    newClient();
    const stale = FakeSocket.instances[0];
    stale.emitClose();
    runNextTimeout();
    const live = FakeSocket.instances[1];
    live.emitOpen();

    stale.emitClose();

    expect(pendingTimeouts).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("ignores messages from a replaced socket", () => {
    const states: TransportState[] = [];
    const seen: number[] = [];
    const client = new GameClient({ gameId: "g1", socketToken: "tok" });
    client.connect({
      onTransportState: (state) => states.push(state),
      onState: (state) => seen.push(state.moveCount),
    });
    const stale = FakeSocket.instances[0];
    stale.emitClose();
    runNextTimeout();

    stale.emitMessage(
      JSON.stringify({ type: "state", state: { turn: 1, moveCount: 7 } }),
    );

    expect(seen).toEqual([]);
  });

  it("ignores a second connect() instead of opening a rival socket", () => {
    const client = new GameClient({ gameId: "g1", socketToken: "tok" });
    client.connect({});
    client.connect({});
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
