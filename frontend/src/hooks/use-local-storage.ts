/**
 * A localStorage-backed value that every reader sees at the same time.
 *
 * WHY THIS IS A STORE AND NOT A useState. This hook used to be a plain
 * useState seeded from localStorage at mount, with an effect that wrote back.
 * Two components reading the same key therefore held two INDEPENDENT copies,
 * and nothing told one that the other had written. That is invisible while
 * every reader sits on a page that remounts as you navigate, and it breaks the
 * moment a reader outlives navigation.
 *
 * BoardThemeProvider is exactly that reader: it is mounted at the app root and
 * never unmounts. Measured on the live site, logged out - picking "Crisp" in
 * /settings wrote "crisp" to localStorage and the settings picker updated,
 * while the board kept drawing the default theme (0 crisp joints) until a full
 * page reload, at which point it drew 49. Logging in appeared to fix it only
 * because logged-in users read the theme from the database instead and so
 * never consulted the stale copy.
 *
 * So the value lives in a module-level store keyed by storage key, and the
 * hook subscribes to it. useSyncExternalStore is the right primitive here: it
 * hands every consumer of a key one snapshot and is safe under concurrent
 * rendering, which a hand-rolled listener plus useState is not.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";

/**
 * The current value per key. A hit here is what makes getSnapshot
 * referentially stable: React re-reads the snapshot on every render and will
 * loop forever if it keeps getting a fresh object, so parsing happens only
 * when a key is first read or when storage changes underneath us - never on
 * the read path.
 */
const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
/**
 * How to rebuild a key's value when storage loses it. The default lives at the
 * call site, but a `storage` event arrives with no call site attached, so the
 * first hook to initialise a key registers its default here for later.
 */
const defaults = new Map<string, () => unknown>();

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Access itself throws in a browser with site data blocked.
    return null;
  }
};

const notify = (key: string) => {
  listeners.get(key)?.forEach((listener) => listener());
};

const resolve = <T>(defaultValue: T | (() => T)): T =>
  typeof defaultValue === "function"
    ? (defaultValue as () => T)()
    : defaultValue;

/**
 * The value for `key`, seeding the cache from storage on first use.
 *
 * `resolveDefault` is a thunk rather than a value so that a caller's default
 * is only COMPUTED when this key has nothing cached - one call site builds its
 * default by reading another key out of localStorage, which should not happen
 * on every render.
 */
export function readStored<T>(key: string, resolveDefault: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;

  defaults.set(key, resolveDefault as () => unknown);
  const raw = storage()?.getItem(key);
  let value: T;
  if (raw == null) {
    value = resolveDefault();
  } else {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      value = resolveDefault();
    }
  }
  cache.set(key, value);
  return value;
}

/**
 * Set `key`, persist it, and tell every reader.
 *
 * Persisting here rather than in a mount effect makes the three steps one
 * logical operation, and stops a newly mounted reader from writing its default
 * over a value someone else just set. A storage failure - quota, private mode,
 * blocked site data - still updates the in-memory value and still notifies, so
 * the app behaves like React state even where nothing can be saved.
 */
export function writeStored<T>(key: string, value: T): void {
  cache.set(key, value);
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Deliberately ignored; the in-memory value above is the useful part.
  }
  notify(key);
}

export function subscribeStored(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/**
 * Re-seed a key from what storage now holds, and notify.
 *
 * Exported for the `storage` event and for tests. A cleared key must be
 * REBUILT from its registered default rather than dropped from the cache:
 * dropping it would make the next getSnapshot resolve the default afresh, and
 * an object-valued default would then hand React a new reference on every
 * read.
 */
export function refreshStored(key: string): void {
  const resolveDefault = defaults.get(key);
  if (!resolveDefault) return; // nobody is reading this key
  cache.delete(key);
  readStored(key, resolveDefault);
  notify(key);
}

let storageListenerInstalled = false;
const installStorageListener = () => {
  if (storageListenerInstalled || typeof window === "undefined") return;
  storageListenerInstalled = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    // Another tab wrote. `key: null` means clear(), which touches everything.
    if (event.storageArea && event.storageArea !== storage()) return;
    if (event.key === null) {
      [...defaults.keys()].forEach(refreshStored);
      return;
    }
    if (defaults.has(event.key)) refreshStored(event.key);
  });
};

/**
 * @param key     storage key; all hooks sharing a key share one value.
 * @param defaultValue used only when the key is absent or unparseable. The
 *                FIRST hook to read a key registers its default, so passing
 *                different defaults for one key is ambiguous by construction -
 *                first one wins.
 */
export function useLocalStorageState<T>(
  key: string,
  defaultValue: T | (() => T),
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      // Installed HERE and not in the render body: addEventListener is a side
      // effect, and React may abandon a speculative render. The idempotence
      // guard would stop a duplicate listener but not the mutation itself.
      // useSyncExternalStore calls subscribe after commit.
      installStorageListener();
      return subscribeStored(key, listener);
    },
    [key],
  );

  // Not wrapped in useCallback on `defaultValue`: the thunk is only INVOKED
  // when the key has nothing cached, so rebuilding the closure per render
  // costs nothing and avoids a stale-default dependency.
  const getSnapshot = () => readStored<T>(key, () => resolve(defaultValue));

  // The third argument is a getServerSnapshot, and passing the same function
  // is correct ONLY because this app has no server rendering - it is a Vite
  // SPA. It is not SSR safety: on a server the module-global cache would
  // outlive a request and leak one user's value into the next render. If SSR
  // is ever introduced, this argument and the cache's ownership both have to
  // be redesigned.
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const previous = readStored<T>(key, () => resolve(defaultValue));
      const next =
        typeof action === "function"
          ? (action as (prev: T) => T)(previous)
          : action;
      writeStored(key, next);
    },
    // `defaultValue` is intentionally not a dependency: it only matters when
    // the key is uninitialised, and by the time a setter runs it is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return [value, setValue] as const;
}

/**
 * Test seam: clear the store's state - values, subscribers and registered
 * defaults.
 *
 * NOT "as if the page had just loaded": the installed `storage` listener stays
 * installed, because removing it would be test machinery for a case this
 * runner cannot reach (there is no window here, so it is never installed).
 * Only call this with no consumers mounted - dropping the listener set from
 * under a mounted hook would silently disconnect it.
 */
export function __resetStoredForTests(): void {
  cache.clear();
  listeners.clear();
  defaults.clear();
}
