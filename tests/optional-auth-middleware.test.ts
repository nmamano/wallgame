/**
 * `getOptionalUserMiddleware` must call `next()` exactly once.
 *
 * It wrapped `await next()` in the same try/catch it used to tolerate a bad
 * cookie, and that catch calls `await next()` AGAIN. So if `next()` ever
 * rejects, the remainder of the chain and the handler run a second time, and
 * the first failure is swallowed. Found by Wall Game Reviewer 1 on 2026-08-16
 * while reviewing fda22287, which mounts this middleware on spectator socket
 * upgrades (board 8649e958).
 *
 * WHAT IS AND IS NOT TRUE ABOUT IT, measured 2026-08-16 against hono 4.13.2.
 * The defect is real in this middleware's own logic - driven directly with a
 * rejecting `next()`, the unfixed version calls it twice. It is NOT reachable
 * through a Hono app today: compose never rejects the promise returned by
 * `next()`. A downstream failure is routed to the app's error handling instead,
 * so this middleware's catch never sees it. Probed across four shapes - a
 * synchronous handler throw, an async handler rejection, a throw in a later
 * middleware, and the same with `app.onError` registered - and in every one the
 * handler ran once and the catch did not fire.
 *
 * So this is a LATENT contract violation, not an observed production failure,
 * and the three blocks below say which is which:
 *   1. the next()-exactly-once gate, which fails against the unfixed middleware;
 *   2. identity resolution, including what the catch is really for - reachable
 *      only by spying on the Kinde client, because no request shape makes the
 *      auth read throw;
 *   3. characterisation only, recording that a downstream throw never reaches
 *      this middleware through Hono. That one stays green either way.
 *
 * The catch is FOR auth resolution - reading the cookie and the user profile,
 * either of which can fail on an expired or malformed session, neither of which
 * should break a request that works fine for a guest. It is not for whatever
 * happens downstream.
 */

import { describe, expect, it, beforeAll, spyOn } from "bun:test";
import { Hono } from "hono";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Env as KindeEnv } from "../server/kinde";

// The test-user seam is gated on NODE_ENV, and the Kinde client is built at
// import time from these, so both are set before the dynamic import below.
process.env.NODE_ENV = "test";
process.env.KINDE_DOMAIN ??= "https://example.kinde.com";
process.env.KINDE_CLIENT_ID ??= "test-client-id";
process.env.KINDE_REDIRECT_URI ??= "http://localhost:5173/api/callback";

let getOptionalUserMiddleware: MiddlewareHandler<KindeEnv>;

beforeAll(async () => {
  const kinde = await import("../server/kinde");
  getOptionalUserMiddleware = kinde.getOptionalUserMiddleware;
});

/** Awaits a promise expected to reject and returns the message it rejected with. */
const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the middleware to reject, but it resolved");
};

/**
 * A real Hono Context, borrowed from a real request.
 *
 * Hand-rolling one would mean guessing at the parts the Kinde session manager
 * touches (`c.req.raw.headers` for the cookie read), and a guess that happened
 * to miss would make these tests pass for the wrong reason.
 */
const borrowContext = async (headers?: Record<string, string>) => {
  let captured: Context<KindeEnv, string> | undefined;
  const app = new Hono<KindeEnv>();
  app.get("/borrow", (c) => {
    captured = c;
    return c.text("ok");
  });
  await app.request("/borrow", headers ? { headers } : undefined);
  if (!captured) throw new Error("failed to borrow a context");
  return captured;
};

/**
 * THE GATE. Drives the middleware directly, because its contract with `next()`
 * is the thing under test and Hono does not currently exercise it.
 */
describe("the middleware calls next() exactly once", () => {
  const countingRejectingNext = () => {
    const calls = { count: 0 };
    const next: Next = () => {
      calls.count += 1;
      return Promise.reject(new Error("downstream failure"));
    };
    return { calls, next };
  };

  it("does not retry a rejecting next() for a logged-in request", async () => {
    const c = await borrowContext({ "x-test-user-id": "user-1" });
    const { calls, next } = countingRejectingNext();

    expect(await rejectionMessage(getOptionalUserMiddleware(c, next))).toBe(
      "downstream failure",
    );

    // Two is the bug: the catch swallows the first rejection and calls next()
    // again, so everything past this middleware happens twice.
    expect(calls.count).toBe(1);
  });

  it("does not retry a rejecting next() for an anonymous request", async () => {
    // The other arm. A guest goes through the real cookie read rather than the
    // test-user shortcut, so a different part of the try block precedes next().
    const c = await borrowContext();
    const { calls, next } = countingRejectingNext();

    expect(await rejectionMessage(getOptionalUserMiddleware(c, next))).toBe(
      "downstream failure",
    );

    expect(calls.count).toBe(1);
  });

  it("lets the downstream failure propagate rather than swallowing it", async () => {
    // The other half of the same bug: re-running the chain also DISCARDED the
    // first failure, so a caller saw the retry's outcome instead.
    //
    // next() rejects once and then succeeds, which is what makes this a gate
    // rather than a restatement of the count. A next() that always rejects
    // would pass against the unfixed middleware too - the retry would reject
    // identically and the error would still surface - so it would prove
    // nothing. Measured: with this fixture the unfixed version RESOLVES, having
    // thrown the real failure away.
    const c = await borrowContext({ "x-test-user-id": "user-1" });
    let attempt = 0;
    const next: Next = () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("the real failure"))
        : Promise.resolve();
    };

    expect(await rejectionMessage(getOptionalUserMiddleware(c, next))).toBe(
      "the real failure",
    );
  });

  it("still calls next() once when nothing goes wrong", async () => {
    // Guards the opposite mistake: a fix that added a call outside the try
    // without removing the one inside would run everything twice on EVERY
    // request, which the rejecting tests above cannot see.
    const c = await borrowContext({ "x-test-user-id": "user-7" });
    let calls = 0;
    const next: Next = () => {
      calls += 1;
      return Promise.resolve();
    };

    await getOptionalUserMiddleware(c, next);

    expect(calls).toBe(1);
  });
});

/**
 * The behaviour fda22287 depends on. A spectator socket upgrade mounts this
 * middleware, so an expired cookie must degrade to a guest rather than fail.
 */
describe("the middleware still resolves identity", () => {
  const appThatReports = () => {
    const app = new Hono<KindeEnv>();
    app.get("/who", getOptionalUserMiddleware, (c) => {
      const user = c.get("user") as { id?: string } | undefined;
      return c.json({ id: user?.id ?? null });
    });
    return app;
  };

  it("sets the account for a logged-in request", async () => {
    const response = await appThatReports().request("/who", {
      headers: { "x-test-user-id": "user-42" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "user-42" });
  });

  it("leaves a guest undefined and does not fail the request", async () => {
    const response = await appThatReports().request("/who");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: null });
  });

  /**
   * What the catch is actually for, and the only way to reach it.
   *
   * Measured 2026-08-16: no cookie, a garbage `id_token` and a garbage
   * `access_token` all make `isAuthenticated` return FALSE rather than throw,
   * so no request shape reaches the catch at all. Without the spy below,
   * deleting the catch outright reddens nothing and the "degrades to a guest"
   * claim rests on reading. The spy is on an exported client object rather than
   * a mocked module, so it stays a normal function replacement.
   */
  it("degrades to a guest when the auth read throws", async () => {
    const kinde = await import("../server/kinde");
    const spy = spyOn(kinde.kindeClient, "isAuthenticated").mockImplementation(
      () => {
        throw new Error("session decode failed");
      },
    );

    try {
      const response = await appThatReports().request("/who");

      // The request must SUCCEED as a guest. An expired or malformed session is
      // not a reason to fail a page that works fine for a logged-out visitor -
      // and on the spectator socket of fda22287 it must not stop somebody
      // watching a game.
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: null });
    } finally {
      spy.mockRestore();
    }
  });

  it("still runs the rest of the chain once when the auth read throws", async () => {
    // The two halves together: the catch absorbs the auth failure, and next()
    // runs exactly once rather than being retried by it.
    const kinde = await import("../server/kinde");
    const spy = spyOn(kinde.kindeClient, "isAuthenticated").mockImplementation(
      () => {
        throw new Error("session decode failed");
      },
    );

    try {
      const c = await borrowContext();
      let calls = 0;
      const next: Next = () => {
        calls += 1;
        return Promise.resolve();
      };

      await getOptionalUserMiddleware(c, next);

      expect(calls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * CHARACTERISATION ONLY - these do not gate the fix.
 *
 * They record why the gate above had to bypass Hono: through an app, a
 * downstream throw never reaches this middleware, so the handler runs once
 * whether or not the bug is present. Kept because that fact is the whole reason
 * the finding is latent rather than live, and the next person to read the board
 * task will want it measured rather than asserted.
 */
describe("through a Hono app, a downstream throw never reaches the catch", () => {
  it("runs a throwing handler once - true before and after the fix", async () => {
    let runs = 0;
    const app = new Hono<KindeEnv>();
    app.get("/boom", getOptionalUserMiddleware, () => {
      runs += 1;
      throw new Error("downstream failure");
    });

    const response = await app.request("/boom", {
      headers: { "x-test-user-id": "user-1" },
    });

    expect(runs).toBe(1);
    expect(response.status).toBe(500);
  });
});
