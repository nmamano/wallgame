/**
 * After a sign-up, this browser's guest games move to the new account
 * (task B; Nil, 2026-11-22). POST /api/me/guest-games through the real app,
 * against a real Postgres.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import { SIGNUP_GUEST_GAMES_COOKIE } from "../../shared/contracts/user";

const BROWSER = "11111111-1111-4111-8111-111111111111";
const OTHER_BROWSER = "22222222-2222-4222-8222-222222222222";
/** The dev origin: outside production the site is the Vite server. */
const SITE_ORIGIN = "http://localhost:5173";
const NEW_ACCOUNT = "auth-new-account";

let container: StartedTestContainer | undefined;
let app: ReturnType<typeof import("../../server/app").createApp>["app"];
let db: typeof import("../../server/db").db;
let gamePlayersTable: typeof import("../../server/db/schema/game-players").gamePlayersTable;
let eq: typeof import("drizzle-orm").eq;

/** The account id of a seat, by game and player order. */
const seatUser = async (gameId: string, playerOrder: number) => {
  const rows = await db
    .select({
      userId: gamePlayersTable.userId,
      order: gamePlayersTable.playerOrder,
    })
    .from(gamePlayersTable)
    .where(eq(gamePlayersTable.gameId, gameId));
  return rows.find((row) => row.order === playerOrder)?.userId ?? null;
};

const link = (options: {
  anonymousId?: string;
  signedUp: boolean;
  origin?: string;
  user?: string;
}) =>
  app.request("/api/me/guest-games", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: options.origin ?? SITE_ORIGIN,
      "x-test-user-id": options.user ?? NEW_ACCOUNT,
      ...(options.signedUp ? { cookie: `${SIGNUP_GUEST_GAMES_COOKIE}=1` } : {}),
    },
    body: JSON.stringify({ anonymousId: options.anonymousId ?? BROWSER }),
  });

beforeAll(async () => {
  container = (await setupEphemeralDb()).container;
  db = (await import("../../server/db")).db;
  ({ gamePlayersTable } = await import("../../server/db/schema/game-players"));
  const { gamesTable } = await import("../../server/db/schema/games");
  const { usersTable, userAuthTable } =
    await import("../../server/db/schema/users");
  ({ eq } = await import("drizzle-orm"));
  app = (await import("../../server/app")).createApp().app;

  // A member who played on this same browser earlier, signed in.
  const [member] = await db
    .insert(usersTable)
    .values({
      displayName: "member",
      capitalizedDisplayName: "MEMBER",
      authProvider: "test",
    })
    .returning({ userId: usersTable.userId });
  await db.insert(userAuthTable).values({
    userId: member.userId,
    authProvider: "test",
    authUserId: "auth-member",
  });

  const game = async (
    gameId: string,
    seats: { anonymousId: string | null; userId?: number; bot?: boolean }[],
  ) => {
    await db.insert(gamesTable).values({
      gameId,
      variant: "standard",
      timeControl: "rapid",
      rated: false,
      matchType: "friend",
      boardWidth: 8,
      boardHeight: 8,
      startedAt: new Date("2026-11-20T12:00:00Z"),
      movesCount: 20,
    });
    await db.insert(gamePlayersTable).values(
      seats.map((seat, index) => ({
        gameId,
        playerOrder: index + 1,
        playerRole: index === 0 ? "host" : "joiner",
        playerConfigType: seat.bot ? "bot" : index === 0 ? "you" : "friend",
        displayName: seat.bot ? "Easy Bot" : "Guest Wallaby",
        userId: seat.userId ?? null,
        anonymousId: seat.anonymousId,
        outcomeRank: index + 1,
        outcomeReason: "capture",
      })),
    );
  };
  // Two guest wins on this browser against a bot.
  await game("guest-1", [
    { anonymousId: BROWSER },
    { anonymousId: null, bot: true },
  ]);
  await game("guest-2", [
    { anonymousId: BROWSER },
    { anonymousId: null, bot: true },
  ]);
  // The member's own game on this browser: already linked, never moved.
  await game("member-1", [
    { anonymousId: BROWSER, userId: member.userId },
    { anonymousId: OTHER_BROWSER },
  ]);
}, 120_000);

afterAll(async () => {
  await teardownEphemeralDb(container);
});

describe("POST /api/me/guest-games", () => {
  it("links nothing without the sign-up mark (a plain log-in)", async () => {
    const response = await link({ signedUp: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: 0 });
    expect(await seatUser("guest-1", 1)).toBeNull();
  });

  it("refuses another origin and links nothing", async () => {
    const response = await link({
      signedUp: true,
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
    expect(await seatUser("guest-1", 1)).toBeNull();
  });

  it("refuses a request with no account", async () => {
    const response = await app.request("/api/me/guest-games", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: SITE_ORIGIN,
        cookie: `${SIGNUP_GUEST_GAMES_COOKIE}=1`,
      },
      body: JSON.stringify({ anonymousId: BROWSER }),
    });
    expect(response.status).toBe(401);
    expect(await seatUser("guest-1", 1)).toBeNull();
  });

  it("after a sign-up, moves this browser's guest seats to the account, once", async () => {
    const response = await link({ signedUp: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: 2 });
    // The mark is used up.
    expect(
      response.headers
        .getSetCookie()
        .some(
          (line) =>
            line.startsWith(`${SIGNUP_GUEST_GAMES_COOKIE}=`) &&
            /max-age=0/i.test(line),
        ),
    ).toBe(true);

    const newAccount = await seatUser("guest-1", 1);
    expect(newAccount).not.toBeNull();
    expect(await seatUser("guest-2", 1)).toBe(newAccount);
    // Bot seats, other browsers and the member's seat stay as they were.
    expect(await seatUser("guest-1", 2)).toBeNull();
    expect(await seatUser("member-1", 2)).toBeNull();
    expect(await seatUser("member-1", 1)).not.toBe(newAccount);
  });

  it("a second sign-up on the same browser takes nothing from the first", async () => {
    const first = await seatUser("guest-1", 1);
    const response = await link({ signedUp: true, user: "auth-second" });
    expect(await response.json()).toEqual({ linked: 0 });
    expect(await seatUser("guest-1", 1)).toBe(first);
  });

  it("refuses an id that is not an anonymous id", async () => {
    const response = await link({ signedUp: true, anonymousId: "not-a-uuid" });
    expect(response.status).toBe(400);
  });
});
