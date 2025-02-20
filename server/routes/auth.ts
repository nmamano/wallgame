import { Hono } from "hono";
import { kindeClient, sessionManager, getUserMiddleware } from "../kinde";

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
    return c.redirect("/");
  })
  .get("/logout", async (c) => {
    const logoutUrl = await kindeClient.logout(sessionManager(c));
    return c.redirect(logoutUrl.toString());
  })
  .get("/me", getUserMiddleware, async (c) => {
    const user = c.get("user");
    return c.json({ user });
  });
