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
  }
);

export const sessionManager = (c: Context): SessionManager => ({
  async getSessionItem(key: string) {
    return getCookie(c, key);
  },
  async setSessionItem(key: string, value: unknown) {
    const cookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    } as const;
    if (typeof value === "string") {
      setCookie(c, key, value, cookieOptions);
    } else {
      setCookie(c, key, JSON.stringify(value), cookieOptions);
    }
  },
  async removeSessionItem(key: string) {
    deleteCookie(c, key);
  },
  async destroySession() {
    ["id_token", "access_token", "user", "refresh_token"].forEach((key) => {
      deleteCookie(c, key);
    });
  },
});

type Env = {
  Variables: {
    user: UserType;
  };
};

// Add this middleware to all routes that need to be authenticated.
// Note: /api/me does NOT use this middleware - it handles auth directly to allow guests.
export const getUserMiddleware = createMiddleware<Env>(async (c, next) => {
  try {
    const manager = sessionManager(c);
    const isAuthenticated = await kindeClient.isAuthenticated(manager);
    if (!isAuthenticated) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const user = await kindeClient.getUserProfile(manager);
    if (!user || !user.id) {
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
