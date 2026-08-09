import { beforeEach, describe, expect, test } from "bun:test";
import { readEmbeddedFlag } from "../frontend/src/lib/embedded-mode";
import type { IdStorage } from "../frontend/src/lib/anonymous-id";

/**
 * The default-off behaviour is the whole gate for this feature: wallgame.io must
 * render exactly what it renders today, and it only does so while every one of
 * these returns false.
 *
 * This lives in `tests/` rather than beside the helper because
 * `scripts/run-tests.ts` globs `tests/**` only - a test under `frontend/src`
 * never runs in CI.
 */

const fakeStorage = (initial: Record<string, string> = {}): IdStorage => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
};

/** Storage that exists but refuses every operation, as a full quota does. */
const hostileStorage = (): IdStorage => ({
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
});

describe("default off", () => {
  let storage: IdStorage;
  beforeEach(() => {
    storage = fakeStorage();
  });

  test("a plain visit is not embedded", () => {
    expect(readEmbeddedFlag("", storage)).toBe(false);
  });

  test("an unrelated query string is not embedded", () => {
    expect(readEmbeddedFlag("?ref=twitter&utm_source=x", storage)).toBe(false);
  });

  test("only the exact value counts", () => {
    for (const search of [
      "?embedded",
      "?embedded=",
      "?embedded=0",
      "?embedded=true",
      "?embedded=yes",
      "?embedded=11",
    ]) {
      expect(readEmbeddedFlag(search, storage)).toBe(false);
    }
  });

  test("no storage at all still answers false", () => {
    expect(readEmbeddedFlag("", undefined)).toBe(false);
  });
});

describe("the portal case", () => {
  test("?embedded=1 is embedded", () => {
    expect(readEmbeddedFlag("?embedded=1", fakeStorage())).toBe(true);
  });

  test("it is found among other params, in any position", () => {
    const storage = fakeStorage();
    expect(readEmbeddedFlag("?utm_source=crazygames&embedded=1", storage)).toBe(
      true,
    );
    expect(readEmbeddedFlag("?embedded=1&utm_source=crazygames", storage)).toBe(
      true,
    );
  });

  test("the flag latches, so a later navigation without it stays embedded", () => {
    const storage = fakeStorage();
    expect(readEmbeddedFlag("?embedded=1", storage)).toBe(true);
    // Client-side navigation has rewritten the URL and dropped the param.
    expect(readEmbeddedFlag("", storage)).toBe(true);
    expect(readEmbeddedFlag("?ref=elsewhere", storage)).toBe(true);
  });

  test("the latch does not leak into a different tab", () => {
    expect(readEmbeddedFlag("?embedded=1", fakeStorage())).toBe(true);
    // sessionStorage is per tab, so a fresh one starts empty.
    expect(readEmbeddedFlag("", fakeStorage())).toBe(false);
  });

  test("works with no storage, for the length of one page load", () => {
    expect(readEmbeddedFlag("?embedded=1", undefined)).toBe(true);
    expect(readEmbeddedFlag("", undefined)).toBe(false);
  });

  test("a storage that throws does not take the page down", () => {
    expect(readEmbeddedFlag("?embedded=1", hostileStorage())).toBe(true);
    expect(readEmbeddedFlag("", hostileStorage())).toBe(false);
  });
});
