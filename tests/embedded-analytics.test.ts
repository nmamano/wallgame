import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMBEDDED_QUERY_PARAM,
  EMBEDDED_STORAGE_KEY,
} from "../frontend/src/lib/embedded-mode";

/**
 * A portal frame must contact no third party at all, and the analytics tag in
 * `index.html` is appended before any module runs - so the decision has to be
 * made there, in plain JS, duplicating what `lib/embedded-mode.ts` knows.
 *
 * This exists because a browser probe MISSED that. It served the build from
 * 127.0.0.1, analytics is gated to the production hostname, so the whole block
 * was skipped and "zero external hosts" proved nothing about
 * `https://wallgame.io/?embedded=1`, where it would have loaded. Project
 * Reviewer 1 caught it on 2026-08-09.
 *
 * So this test does not read the file and look for reassuring words. It EXECUTES
 * the shipped script with a production hostname and asks what it appended.
 */

const INDEX_HTML = join(import.meta.dir, "../frontend/index.html");

/** The inline analytics script, exactly as it ships. */
const analyticsScript = (): string => {
  const html = readFileSync(INDEX_HTML, "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((body) => body.includes("googletagmanager.com"));
  if (!script) {
    throw new Error("no inline script in index.html appends the analytics tag");
  }
  return script;
};

interface Run {
  /** Every script src the page appended. */
  appended: string[];
  /** Whether the gtag shim was installed at all. */
  installedGtag: boolean;
}

/**
 * Runs the shipped script against a fake page. `with (window)` is what lets the
 * script's bare `gtag(...)` resolve to the `window.gtag` it just assigned,
 * exactly as it does in a browser.
 */
const run = (opts: {
  hostname: string;
  search?: string;
  stored?: string | null;
  storageThrows?: boolean;
}): Run => {
  const appended: string[] = [];
  const fakeWindow: Record<string, unknown> = {
    URLSearchParams,
    location: { hostname: opts.hostname, search: opts.search ?? "" },
    sessionStorage: {
      getItem: (key: string) => {
        if (opts.storageThrows) throw new Error("blocked");
        return key === EMBEDDED_STORAGE_KEY ? (opts.stored ?? null) : null;
      },
    },
    document: {
      createElement: () => ({}) as Record<string, unknown>,
      head: {
        appendChild: (node: { src?: string }) => {
          appended.push(node.src ?? "(no src)");
        },
      },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const evaluate = new Function(
    "window",
    `with (window) { ${analyticsScript()} }`,
  ) as (win: Record<string, unknown>) => void;
  evaluate(fakeWindow);

  return { appended, installedGtag: typeof fakeWindow.gtag === "function" };
};

const PROD_HOSTS = ["wallgame.io", "www.wallgame.io"];

describe("the analytics tag in index.html", () => {
  test("loads on the production host, which is the point of it", () => {
    for (const hostname of PROD_HOSTS) {
      const result = run({ hostname });
      expect(result.appended).toEqual([
        "https://www.googletagmanager.com/gtag/js?id=G-WJTLKK8C80",
      ]);
      expect(result.installedGtag).toBe(true);
    }
  });

  test("never loads off the production host", () => {
    for (const hostname of ["localhost", "127.0.0.1", "wallgame.fly.dev"]) {
      expect(run({ hostname }).appended).toEqual([]);
    }
  });

  test("is suppressed by the query param, ON THE PRODUCTION HOST", () => {
    for (const hostname of PROD_HOSTS) {
      const result = run({
        hostname,
        search: `?${EMBEDDED_QUERY_PARAM}=1`,
      });
      expect(result.appended).toEqual([]);
      // Not even the shim, so nothing can queue a hit for a later loader.
      expect(result.installedGtag).toBe(false);
    }
  });

  test("stays suppressed on a reload that has lost the param", () => {
    // The latch case: sessionStorage carries it, the URL no longer does.
    const result = run({
      hostname: "wallgame.io",
      search: "",
      stored: "1",
    });
    expect(result.appended).toEqual([]);
    expect(result.installedGtag).toBe(false);
  });

  test("is suppressed among other query params", () => {
    const result = run({
      hostname: "wallgame.io",
      search: `?utm_source=crazygames&${EMBEDDED_QUERY_PARAM}=1&x=2`,
    });
    expect(result.appended).toEqual([]);
  });

  test("is NOT suppressed by a near-miss value", () => {
    for (const search of [
      `?${EMBEDDED_QUERY_PARAM}=0`,
      `?${EMBEDDED_QUERY_PARAM}`,
      `?${EMBEDDED_QUERY_PARAM}=true`,
      "?embed=1",
    ]) {
      expect(run({ hostname: "wallgame.io", search }).appended).toHaveLength(1);
    }
  });

  test("a storage that throws does not take the page down", () => {
    // Same guarded behaviour as readEmbeddedFlag: unknown means not embedded,
    // so the production host keeps its analytics.
    expect(
      run({ hostname: "wallgame.io", storageThrows: true }).appended,
    ).toHaveLength(1);
    // ...but an explicit param still wins, without ever reading storage.
    expect(
      run({
        hostname: "wallgame.io",
        search: `?${EMBEDDED_QUERY_PARAM}=1`,
        storageThrows: true,
      }).appended,
    ).toEqual([]);
  });
});

describe("index.html and embedded-mode.ts agree", () => {
  // The two copies of this decision cannot import each other, so pin the
  // literals. Renaming the constant without editing index.html fails here.
  const script = analyticsScript();

  test("on the query param", () => {
    expect(script).toContain(`"${EMBEDDED_QUERY_PARAM}"`);
  });

  test("on the storage key", () => {
    expect(script).toContain(`"${EMBEDDED_STORAGE_KEY}"`);
  });
});
