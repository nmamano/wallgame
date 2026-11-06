import { Hono } from "hono";
import { kindeClient, sessionManager } from "../kinde";
import { ensureUserExists } from "../db/user-helpers";
import { createWsOriginCheck } from "../ws-origin";

// Logout clears the session, so another site must not be able to trigger it.
// The site's own pages are exactly the origins its game socket accepts, so
// ADDITIONAL_WS_ORIGINS also controls which origins can log out.
//
// This relies on the browser sending the site's real Origin on a same-origin
// form POST. It does under the default Referrer-Policy; under
// "Referrer-Policy: no-referrer" (set by the app, Caddy or Cloudflare) the
// browser sends "Origin: null" instead, and every logout would get a 403.
const isAllowedOrigin = createWsOriginCheck(
  process.env.NODE_ENV,
  process.env.ADDITIONAL_WS_ORIGINS,
);

// Largely based on:
// https://docs.kinde.com/developer-tools/sdks/backend/typescript-sdk/
// and
// https://github.com/meech-ward/Bun-Hono-React-Expense-Tracker/blob/main/server/routes/auth.ts
export const authRoute = new Hono()
  .get("/login", async (c) => {
    const loginUrl = await kindeClient.login(sessionManager(c));
    return c.redirect(loginUrl.toString());
  })
  .get("/register", async (c) => {
    const registerUrl = await kindeClient.register(sessionManager(c));
    return c.redirect(registerUrl.toString());
  })
  .get("/callback", async (c) => {
    // Gets called every time the user logs in or registers.
    const url = new URL(c.req.url);
    await kindeClient.handleRedirectToApp(sessionManager(c), url);

    // Ensure user exists in our database
    // Note: getUserProfile might return null immediately after handleRedirectToApp
    // due to timing issues. We'll create the user lazily when they first access
    // a protected endpoint (see settings.ts for fallback logic).
    const manager = sessionManager(c);
    const isAuthenticated = await kindeClient.isAuthenticated(manager);
    if (isAuthenticated) {
      try {
        // Try to get user profile, but don't fail if it's null (timing issue)
        const kindeUser = await kindeClient.getUserProfile(manager);
        if (kindeUser?.id) {
          await ensureUserExists(kindeUser);
        } else {
          // User profile not available yet - this is OK, we'll create them
          // lazily when they first access a protected endpoint
          console.log(
            "User profile not available in callback (will be created on first access)",
          );
        }
      } catch (error) {
        // Log error but don't fail the callback - user can still log in
        // The user will be created automatically when they first access settings
        console.error("Error ensuring user exists in callback:", error);
        if (error instanceof Error) {
          console.error("Error details:", error.message);
        }
      }
    }

    return c.redirect("/");
  })
  // POST only: the Kinde cookies are SameSite=Lax, so a GET would let any
  // same-origin <img> or a cross-site link log the viewer out. A browser always
  // sends Origin on a cross-site POST, so a missing Origin is not a browser.
  .post("/logout", async (c) => {
    if (!isAllowedOrigin(c.req.header("origin"))) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const logoutUrl = await kindeClient.logout(sessionManager(c));
    // 303: the browser follows with a GET to Kinde, which returns to the site.
    return c.redirect(logoutUrl.toString(), 303);
  })
  .get("/me", async (c) => {
    // Check authentication without throwing errors for unauthenticated users
    // This allows the endpoint to return quickly for guests
    const manager = sessionManager(c);
    const isAuthenticated = await kindeClient.isAuthenticated(manager);
    if (!isAuthenticated) {
      return c.json({ user: null });
    }
    const user = await kindeClient.getUserProfile(manager);
    return c.json({ user });
    // Let unexpected errors propagate - Hono will return 500 and log them
  });
