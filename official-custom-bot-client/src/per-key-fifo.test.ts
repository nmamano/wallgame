import { describe, expect, it } from "bun:test";
import { PerKeyFifo } from "./per-key-fifo";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("PerKeyFifo", () => {
  it("runs the same key in FIFO order", async () => {
    const queue = new PerKeyFifo<string>();
    const gate = deferred();
    const events: string[] = [];
    const first = queue.enqueue("A", async () => {
      events.push("first-begin");
      await gate.promise;
      events.push("first-end");
    });
    const second = queue.enqueue("A", () => {
      events.push("second");
      return Promise.resolve();
    });

    await flush();
    expect(events).toEqual(["first-begin"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-begin", "first-end", "second"]);
  });

  it("lets different keys overlap", async () => {
    const queue = new PerKeyFifo<string>();
    const gate = deferred();
    const events: string[] = [];
    const blocked = queue.enqueue("A", async () => {
      events.push("A-begin");
      await gate.promise;
      events.push("A-end");
    });
    const other = queue.enqueue("B", () => {
      events.push("B");
      return Promise.resolve();
    });

    await other;
    expect(events).toEqual(["A-begin", "B"]);
    gate.resolve();
    await blocked;
  });

  it("contains predecessor rejection and runs later work", async () => {
    const queue = new PerKeyFifo<string>();
    const failure = queue.enqueue("A", () =>
      Promise.reject(new Error("intended predecessor failure")),
    );
    const events: string[] = [];
    const recovery = queue.enqueue("A", () => {
      events.push("recovered");
      return Promise.resolve();
    });

    let failureMessage = "";
    try {
      await failure;
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }
    expect(failureMessage).toBe("intended predecessor failure");
    await recovery;
    expect(events).toEqual(["recovered"]);
  });

  it("does not let an old completion delete a newer tail", async () => {
    const queue = new PerKeyFifo<string>();
    const firstGate = deferred();
    const secondGate = deferred();
    const first = queue.enqueue("A", () => firstGate.promise);
    const second = queue.enqueue("A", () => secondGate.promise);

    expect(queue.size).toBe(1);
    firstGate.resolve();
    await first;
    await flush();
    expect(queue.size).toBe(1);

    secondGate.resolve();
    await second;
    await flush();
    expect(queue.size).toBe(0);
  });
});
