// Largely based on:
// https://github.com/meech-ward/Bun-Hono-React-Expense-Tracker/blob/main/server/routes/auth.ts
/* Settings on the Kinde dashboard:

Allowed callback URLs:
http://localhost:5173/api/callback (the vite proxy)
https://wallgame.fly.dev/api/callback

Allowed logout redirect URLs:
http://localhost:5173 (the vite proxy)
https://wallgame.fly.dev

Setting on .env:

KINDE_SITE_URL=http://localhost:5173
KINDE_LOGOUT_REDIRECT_URI=http://localhost:5173
KINDE_REDIRECT_URI=http://localhost:5173/api/callback
*/

import {
  createKindeServerClient,
  GrantType,
  type SessionManager,
  type UserType,
} from "@kinde-oss/kinde-typescript-sdk";
import { type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";

// Client for authorization code flow
export const kindeClient = createKindeServerClient(
  GrantType.AUTHORIZATION_CODE,
  {
    authDomain: process.env.KINDE_DOMAIN!,
    clientId: process.env.KINDE_CLIENT_ID!,
    clientSecret: process.env.KINDE_CLIENT_SECRET,
    redirectURL: process.env.KINDE_REDIRECT_URI!,
    logoutRedirectURL: process.env.KINDE_LOGOUT_REDIRECT_URI,
  },
);

export const sessionManager = (c: Context): SessionManager => ({
  getSessionItem(key: string) {
    return Promise.resolve(getCookie(c, key));
  },
  setSessionItem(key: string, value: unknown) {
    const isProduction = process.env.NODE_ENV === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction, // Only require HTTPS in production (localhost doesn't have HTTPS)
      sameSite: "Lax",
    } as const;
    if (typeof value === "string") {
      setCookie(c, key, value, cookieOptions);
    } else {
      setCookie(c, key, JSON.stringify(value), cookieOptions);
    }
    return Promise.resolve();
  },
  removeSessionItem(key: string) {
    deleteCookie(c, key);
    return Promise.resolve();
  },
  destroySession() {
    ["id_token", "access_token", "user", "refresh_token"].forEach((key) => {
      deleteCookie(c, key);
    });
    return Promise.resolve();
  },
});

/**
 * The context shape the auth middlewares add.
 *
 * Exported so a caller that WRAPS one of them can type its own handler the
 * same way. Without it a wrapper is `MiddlewareHandler` over hono's default
 * `any` env, and passing that context on trips
 * `@typescript-eslint/no-unsafe-argument` - and the honest fix is to share this
 * type rather than to restate a narrower copy at the call site.
 */
export interface Env {
  Variables: {
    user?: UserType;
  };
}

/**
 * In test mode, creates a mock user from the x-test-user-id header.
 * This is walled off in its own function for clarity and easy removal.
 */
function getTestUserFromHeader(c: Context): UserType | null {
  if (process.env.NODE_ENV !== "test") {
    return null;
  }
  const testUserId = c.req.header("x-test-user-id");
  if (!testUserId) {
    return null;
  }
  return {
    id: testUserId,
    given_name: "Test",
    family_name: "User",
    email: `${testUserId}@example.com`,
    picture: null,
  };
}

// Add this middleware to all routes that need to be authenticated.
// Note: /api/me does NOT use this middleware - it handles auth directly to allow guests.
export const getUserMiddleware = createMiddleware<Env>(async (c, next) => {
  try {
    // Mock auth for testing
    const testUser = getTestUserFromHeader(c);
    if (testUser) {
      c.set("user", testUser);
      await next();
      return;
    }

    const manager = sessionManager(c);
    const isAuthenticated = await kindeClient.isAuthenticated(manager);
    if (!isAuthenticated) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const user = await kindeClient.getUserProfile(manager);
    if (!user?.id) {
      console.error("getUserMiddleware: User profile is null or missing ID");
      return c.json({ error: "Failed to get user profile" }, 500);
    }
    c.set("user", user);
    await next();
  } catch (error) {
    console.error("getUserMiddleware:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

/**
 * Optional authentication middleware for routes that work for both
 * authenticated users and guests. Sets c.get("user") if authenticated,
 * otherwise leaves it undefined.
 */
export const getOptionalUserMiddleware = createMiddleware<Env>(
  async (c, next) => {
    // THE TRY COVERS RESOLVING WHO THIS IS, AND NOTHING ELSE.
    //
    // It used to wrap `await next()` as well, and the catch called `next()`
    // again - so a rejecting `next()` ran the rest of the chain and the handler
    // a SECOND time, and threw the first failure away. A middleware whose whole
    // job is to be optional must never do that; on anything with a side effect
    // it would do it twice (board 8649e958, found by Wall Game Reviewer 1).
    //
    // Measured on hono 4.13.2, 2026-08-16: compose never rejects the promise
    // `next()` returns - a downstream throw goes to the app's error handling
    // instead - so the retry was unreachable through a Hono app and no request
    // is known to have run twice. It was still wrong, and it was one framework
    // detail away from being live.
    //
    // What the catch is genuinely for is below it: reading the cookie and the
    // profile can fail on an expired or malformed session, and a request that
    // works perfectly well for a guest must not break because of it.
    const user = await resolveOptionalUser(c);
    if (user) c.set("user", user);

    // Exactly once, whatever happened above, and outside the catch so a
    // downstream failure surfaces to the caller instead of being retried.
    await next();
  },
);

/**
 * Resolves an account for a request that is also valid anonymously.
 *
 * This function does not call downstream middleware. A WebSocket handshake
 * needs to finish authentication before it mutates a seat, and must be able to
 * distinguish an absent or invalid session from a later account-name database
 * failure.
 */
export async function resolveOptionalUser(
  c: Context,
): Promise<UserType | undefined> {
  try {
    const testUser = getTestUserFromHeader(c);
    if (testUser) return testUser;

    const manager = sessionManager(c);
    if (!(await kindeClient.isAuthenticated(manager))) return undefined;
    const user = await kindeClient.getUserProfile(manager);
    return user?.id ? user : undefined;
  } catch (error) {
    console.warn("Optional auth check failed, proceeding as guest:", error);
    return undefined;
  }
}
