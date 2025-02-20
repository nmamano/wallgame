// Largely based on:
// https://github.com/meech-ward/Bun-Hono-React-Expense-Tracker/blob/main/server/routes/auth.ts

import {
  createKindeServerClient,
  GrantType,
  type SessionManager,
} from "@kinde-oss/kinde-typescript-sdk";
import { type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

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

/* Settings on the Kinde dashboard:

Allowed callback URLs:
http://localhost:5173/api/callback (the vite proxy)

Allowed logout redirect URLs:
http://localhost:5173 (the vite proxy)

Setting on .env:

KINDE_SITE_URL=http://localhost:5173
KINDE_LOGOUT_REDIRECT_URI=http://localhost:5173
KINDE_REDIRECT_URI=http://localhost:5173/api/callback
*/
