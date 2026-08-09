/**
 * The browser half of the anonymous player id: what `getAnonymousId` returns,
 * and - more importantly - when it returns nothing.
 *
 * Storage semantics only. Whether the id reaches a database row is a separate
 * question with its own file, because these two fail in completely different
 * ways and a test that mixed them could not say which had broken.
 *
 * No browser needed: the storage is injected, which is also the only way to
 * simulate the interesting cases. A real localStorage cannot be asked to accept
 * a write and silently drop it.
 */

import { describe, it, expect } from "bun:test";
import {
  getAnonymousId,
  type IdStorage,
} from "../frontend/src/lib/anonymous-id";
import { isAnonymousId } from "../shared/domain/anonymous-id";

const KEY = "wall-game-anonymous-id";

/** An ordinary storage that remembers what it is told. */
function workingStorage(initial?: Record<string, string>): IdStorage {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("getAnonymousId", () => {
  it("mints a valid id when there is none", () => {
    const storage = workingStorage();

    const id = getAnonymousId(storage);

    expect(isAnonymousId(id)).toBe(true);
    expect(storage.getItem(KEY)).toBe(id!);
  });

  it("returns the same id every time, from the same storage", () => {
    const storage = workingStorage();

    const first = getAnonymousId(storage);
    const second = getAnonymousId(storage);
    const third = getAnonymousId(storage);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("writes nothing when a valid id is already there", () => {
    const existing = crypto.randomUUID();
    let writes = 0;
    const storage: IdStorage = {
      ...workingStorage({ [KEY]: existing }),
      setItem: () => {
        writes++;
      },
    };

    expect(getAnonymousId(storage)).toBe(existing);
    // The common path by far. Rewriting on every call would churn storage for
    // no reason and, worse, give a failing write a chance to null out a
    // perfectly good id.
    expect(writes).toBe(0);
  });

  it("gives different browsers different ids", () => {
    expect(getAnonymousId(workingStorage())).not.toBe(
      getAnonymousId(workingStorage()),
    );
  });

  it("replaces a stored value that is not a valid id", () => {
    for (const junk of ["", "not-a-uuid", "12345", "{}"]) {
      const storage = workingStorage({ [KEY]: junk });

      const id = getAnonymousId(storage);

      expect(isAnonymousId(id)).toBe(true);
      expect(id).not.toBe(junk);
      expect(storage.getItem(KEY)).toBe(id!);
    }
  });

  it("rejects a UUID that is not version 4", () => {
    // A v1 UUID is a valid UUID and encodes a timestamp and MAC address. We
    // only ever mint v4, so anything else in there did not come from us.
    const storage = workingStorage({
      [KEY]: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    });

    expect(getAnonymousId(storage)).not.toBe(
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    );
  });

  it("returns nothing when storage is unavailable", () => {
    expect(getAnonymousId(undefined)).toBeUndefined();
  });

  it("returns nothing when reading throws", () => {
    const storage: IdStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    };

    expect(getAnonymousId(storage)).toBeUndefined();
  });

  it("returns nothing when writing throws", () => {
    const storage: IdStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };

    expect(getAnonymousId(storage)).toBeUndefined();
  });

  it("returns nothing when a write is accepted but does not stick", () => {
    // The case that matters most, and the one a real browser cannot be asked
    // to perform. A storage that swallows writes without complaining would,
    // if we trusted the write, hand out a brand-new id on every page load -
    // turning one person into an endless stream of visitors who each played
    // once and never came back. That is precisely the shape of the answer
    // this column exists to measure, so it must never be manufactured.
    const storage: IdStorage = {
      getItem: () => null,
      // Accepts the write and keeps nothing, without complaining.
      setItem: () => undefined,
    };

    expect(getAnonymousId(storage)).toBeUndefined();
  });

  it("returns nothing when the write is corrupted in transit", () => {
    let stored: string | null = null;
    const storage: IdStorage = {
      getItem: () => stored,
      setItem: (_key, value) => {
        stored = value.slice(0, -1); // truncated, so no longer a valid id
      },
    };

    expect(getAnonymousId(storage)).toBeUndefined();
  });
});

describe("isAnonymousId", () => {
  it("accepts what we mint", () => {
    expect(isAnonymousId(crypto.randomUUID())).toBe(true);
  });

  it("rejects everything else", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "not-a-uuid",
      "6BA7B810-9DAD-41D1-80B4-00C04FD430C8", // uppercase
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8", // v1
      "6ba7b810-9dad-41d1-c0b4-00c04fd430c8", // bad variant nibble
      " 6ba7b810-9dad-41d1-80b4-00c04fd430c8", // leading space
    ]) {
      expect(isAnonymousId(value)).toBe(false);
    }
  });
});
