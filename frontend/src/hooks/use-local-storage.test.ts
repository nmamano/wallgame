import { describe, expect, it, beforeEach } from "bun:test";
import {
  readStored,
  writeStored,
  subscribeStored,
  refreshStored,
  __resetStoredForTests,
} from "./use-local-storage";

/**
 * The defect these pin (measured on the live site, logged out): picking a board
 * theme in /settings wrote "crisp" to localStorage and updated the settings
 * picker, while the board - whose provider is mounted at the app root and never
 * unmounts - kept drawing the default until a full page reload.
 *
 * The cause was one useState per hook CALL rather than per storage KEY, so
 * these exercise the store directly. There is no DOM in this runner, so the
 * hook itself is not rendered here; it is a thin useSyncExternalStore wrapper
 * over exactly these functions.
 */

class FakeStorage {
  private data = new Map<string, string>();
  failOnWrite = false;
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failOnWrite) throw new Error("QuotaExceededError");
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  raw(key: string) {
    return this.data.get(key) ?? null;
  }
}

let fake: FakeStorage;

beforeEach(() => {
  fake = new FakeStorage();
  (globalThis as { localStorage?: unknown }).localStorage = fake;
  __resetStoredForTests();
});

describe("stored value sharing", () => {
  it("gives two readers of one key the same value after either writes", () => {
    // Stands in for BoardThemeProvider and the settings page.
    expect(readStored("theme", () => "default")).toBe("default");

    writeStored("theme", "crisp");

    // The second reader must NOT get its own copy seeded from the default.
    expect(readStored("theme", () => "default")).toBe("crisp");
  });

  it("notifies subscribers of the key that changed, and only that key", () => {
    readStored("theme", () => "default");
    readStored("pawn", () => "default");
    let themeCalls = 0;
    let pawnCalls = 0;
    subscribeStored("theme", () => themeCalls++);
    subscribeStored("pawn", () => pawnCalls++);

    writeStored("theme", "crisp");

    expect(themeCalls).toBe(1);
    expect(pawnCalls).toBe(0);
  });

  it("stops notifying once a subscriber unsubscribes", () => {
    let calls = 0;
    const unsubscribe = subscribeStored("theme", () => calls++);
    writeStored("theme", "crisp");
    unsubscribe();
    writeStored("theme", "default");
    expect(calls).toBe(1);
  });
});

describe("snapshot stability", () => {
  it("returns the same reference for an object value until it is written", () => {
    // useSyncExternalStore re-reads on every render and loops forever if the
    // snapshot is a fresh object each time, so this is load-bearing.
    const first = readStored("config", () => ({ width: 8 }));
    const second = readStored("config", () => ({ width: 8 }));
    expect(second).toBe(first);
  });

  it("keeps a stable reference after storage is cleared underneath it", () => {
    readStored("config", () => ({ width: 8 }));
    fake.removeItem("config");
    refreshStored("config");
    const a = readStored("config", () => ({ width: 8 }));
    const b = readStored("config", () => ({ width: 8 }));
    expect(b).toBe(a);
  });
});

describe("persistence", () => {
  it("writes through to storage", () => {
    readStored("theme", () => "default");
    writeStored("theme", "crisp");
    expect(fake.raw("theme")).toBe(JSON.stringify("crisp"));
  });

  it("does not write a default merely because someone read the key", () => {
    // The old effect-based hook persisted on mount, so a reader could stamp
    // its default over a value another reader had just set.
    readStored("theme", () => "default");
    expect(fake.raw("theme")).toBeNull();
  });

  it("reads an existing stored value rather than the default", () => {
    fake.setItem("theme", JSON.stringify("crisp"));
    expect(readStored("theme", () => "default")).toBe("crisp");
  });

  it("falls back to the default when the stored value is corrupt", () => {
    fake.setItem("theme", "{not json");
    expect(readStored("theme", () => "default")).toBe("default");
  });

  it("still updates and notifies when storage refuses the write", () => {
    // Private mode / quota. The app should behave like React state anyway.
    readStored("theme", () => "default");
    let calls = 0;
    subscribeStored("theme", () => calls++);
    fake.failOnWrite = true;

    writeStored("theme", "crisp");

    expect(readStored("theme", () => "default")).toBe("crisp");
    expect(calls).toBe(1);
  });
});

describe("cross-tab refresh", () => {
  it("re-reads the key another tab wrote", () => {
    readStored("theme", () => "default");
    fake.setItem("theme", JSON.stringify("crisp"));

    refreshStored("theme");

    expect(readStored("theme", () => "default")).toBe("crisp");
  });

  it("restores the registered default when another tab clears the key", () => {
    readStored("theme", () => "default");
    writeStored("theme", "crisp");
    fake.removeItem("theme");

    refreshStored("theme");

    expect(readStored("theme", () => "default")).toBe("default");
  });

  it("ignores a key nobody is reading", () => {
    let calls = 0;
    subscribeStored("theme", () => calls++);
    refreshStored("never-read");
    expect(calls).toBe(0);
  });
});
