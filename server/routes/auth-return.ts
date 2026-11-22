import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SIGNUP_GUEST_GAMES_COOKIE } from "../../shared/contracts/user";

/**
 * Where a player goes after they log in or sign up: back to the page they
 * left (task B), not to the home page. A guest who signs up right after a win
 * must land on that game again.
 *
 * /api/login and /api/register take `?return=<site path>` and keep it in a
 * short-lived cookie for the round trip through Kinde; /api/callback reads it
 * once and sends the player there. The cookie, not Kinde's state, carries it:
 * the callback is a top-level GET back to this site, so a SameSite=Lax cookie
 * comes with it.
 */
export const RETURN_COOKIE = "post_auth_path";

/** Long enough to sign up (Kinde form, email code), short enough to go stale. */
const RETURN_COOKIE_MAX_AGE_S = 30 * 60;
const MAX_RETURN_PATH_LENGTH = 512;
/** Any origin works: only "did it stay on this origin" is asked of it. */
const PROBE_ORIGIN = "https://return.invalid";

/**
 * The path itself when it is a page of this site, else null.
 *
 * Anything that could leave the site is refused, so the callback cannot be
 * turned into an open redirect: a protocol-relative "//evil.example", a
 * backslash (browsers read "/\evil.example" as "//evil.example"), control
 * characters, and an absolute URL. /api/ paths are refused too: returning to
 * /api/login would start the round trip again.
 */
export const safeReturnPath = (
  raw: string | null | undefined,
): string | null => {
  if (!raw || raw.length > MAX_RETURN_PATH_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return null;
  return `${url.pathname}${url.search}`;
};

/**
 * Keeps the request's `?return=` for the callback, or clears an old one: a
 * login started without a return path must not inherit the last one.
 */
export const rememberReturnPath = (c: Context): void => {
  const path = safeReturnPath(c.req.query("return"));
  if (path === null) {
    deleteCookie(c, RETURN_COOKIE, { path: "/" });
    return;
  }
  setCookie(c, RETURN_COOKIE, path, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: RETURN_COOKIE_MAX_AGE_S,
  });
};

/**
 * Where the callback sends the player: the kept path, read once, or home.
 * The cookie is checked again here, because a cookie is client input.
 */
export const takeReturnPath = (c: Context): string => {
  const path = safeReturnPath(getCookie(c, RETURN_COOKIE));
  deleteCookie(c, RETURN_COOKIE, { path: "/" });
  return path ?? "/";
};

/**
 * Marks this browser as signing up, so the page links its guest games once
 * the account is signed in. Readable by the page on purpose: the page must
 * see it to send the anonymous id. It grants nothing on its own; the link
 * still needs the signed-in account and the browser's anonymous id.
 */
export const markSignup = (c: Context): void => {
  setCookie(c, SIGNUP_GUEST_GAMES_COOKIE, "1", {
    path: "/",
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: RETURN_COOKIE_MAX_AGE_S,
  });
};

/** A plain log-in links nothing, even after an abandoned sign-up. */
export const clearSignup = (c: Context): void => {
  deleteCookie(c, SIGNUP_GUEST_GAMES_COOKIE, { path: "/" });
};

/** Whether this request comes from a browser that has just signed up. */
export const takeSignup = (c: Context): boolean => {
  const signedUp = getCookie(c, SIGNUP_GUEST_GAMES_COOKIE) === "1";
  clearSignup(c);
  return signedUp;
};
