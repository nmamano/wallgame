/**
 * Retiring a stored game preference once per browser.
 *
 * The rule is small and the failure modes are all silent, which is why it is
 * a pure function over injected storage rather than something that could only
 * be checked by reading it: a reset that never fires looks exactly like a
 * browser that had nothing stored, and a reset that fires every time looks
 * exactly like a setting that will not save.
 *
 * Lives in tests/ rather than beside the module because `scripts/run-tests.ts`
 * globs `tests/**` only - a test under `frontend/src` never runs in CI.
 */

import { describe, it, expect } from "bun:test";
import {
  resetStalePreferences,
  PREFERENCE_GENERATION,
} from "../frontend/src/lib/preference-reset";
import { RESETTABLE_GAME_SETUP_KEYS } from "../frontend/src/hooks/use-settings";

/** A localStorage stand-in, with the two ways a real one misbehaves. */
class FakeStorage {
  readonly map = new Map<string, string>();
  constructor(
    private readonly mode: "normal" | "throws" | "drops-writes" = "normal",
  ) {}
  getItem(key: string): string | null {
    if (this.mode === "throws") throw new Error("blocked");
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.mode === "throws") throw new Error("blocked");
    if (this.mode === "drops-writes") return;
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    if (this.mode === "throws") throw new Error("blocked");
    this.map.delete(key);
  }
}

const KEYS = RESETTABLE_GAME_SETUP_KEYS;
const withSetup = (mode?: "normal" | "throws" | "drops-writes") => {
  const storage = new FakeStorage(mode);
  for (const key of KEYS) storage.map.set(key, "the player's old choice");
  return storage;
};

describe("retiring a stored game setup", () => {
  it("clears the setup keys on a browser that has not seen this generation", () => {
    const storage = withSetup();
    expect(resetStalePreferences(storage, KEYS)).toBe("reset");
    for (const key of KEYS) expect(storage.getItem(key)).toBeNull();
  });

  it("does it once, not on every load", () => {
    // The bug this rules out is the expensive one: a reset with no memory
    // would throw away whatever the player chose after it, every single time.
    const storage = withSetup();
    expect(resetStalePreferences(storage, KEYS)).toBe("reset");

    storage.map.set(KEYS[0], "a choice made after the reset");
    expect(resetStalePreferences(storage, KEYS)).toBe("current");
    expect(storage.getItem(KEYS[0])).toBe("a choice made after the reset");
  });

  it("fires again when the generation is bumped, and only then", () => {
    const storage = withSetup();
    resetStalePreferences(storage, KEYS, 1);
    storage.map.set(KEYS[0], "a later choice");

    expect(resetStalePreferences(storage, KEYS, 1)).toBe("current");
    expect(resetStalePreferences(storage, KEYS, 2)).toBe("reset");
    expect(storage.getItem(KEYS[0])).toBeNull();
  });

  it("leaves every other key alone", () => {
    // Appearance is the player's own taste and has no default worth taking
    // back. A reset that cleared it would read to them as the site forgetting
    // who they are.
    const storage = withSetup();
    storage.map.set("wall-game-board-theme", "crisp");
    storage.map.set("wall-game-pawn-color", "cyan");
    storage.map.set("wall-game-anonymous-id", "keep-me");

    resetStalePreferences(storage, KEYS);

    expect(storage.getItem("wall-game-board-theme")).toBe("crisp");
    expect(storage.getItem("wall-game-pawn-color")).toBe("cyan");
    expect(storage.getItem("wall-game-anonymous-id")).toBe("keep-me");
  });

  it("stamps a browser that had nothing stored, so it never runs again", () => {
    const storage = new FakeStorage();
    expect(resetStalePreferences(storage, KEYS)).toBe("reset");
    expect(resetStalePreferences(storage, KEYS)).toBe("current");
  });

  it("clears NOTHING when the stamp cannot be written", () => {
    // The ordering guarantee. If a storage accepts writes and drops them, a
    // clear-then-stamp implementation would wipe the setup on every load and
    // the player could never keep a choice. Stamping first means the worst
    // case is that the reset simply never happens.
    const storage = withSetup("drops-writes");
    expect(resetStalePreferences(storage, KEYS)).toBe("unavailable");
    for (const key of KEYS) {
      expect(storage.getItem(key)).toBe("the player's old choice");
    }
  });

  it("reports unavailable rather than throwing when storage is blocked", () => {
    expect(resetStalePreferences(new FakeStorage("throws"), KEYS)).toBe(
      "unavailable",
    );
    expect(resetStalePreferences(undefined, KEYS)).toBe("unavailable");
  });

  it("targets the game setup keys and nothing else", () => {
    // Imported, not restated: a renamed key must break this rather than
    // silently leave the reset pointing at a name nothing writes.
    expect([...KEYS]).toEqual([
      "wall-game-default-config",
      "wall-game-variant-settings",
    ]);
    expect(PREFERENCE_GENERATION).toBeGreaterThan(0);
  });
});
