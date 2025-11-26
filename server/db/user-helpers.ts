import { db } from "./index";
import { usersTable, userAuthTable } from "./schema/users";
import { userSettingsTable } from "./schema/user-settings";
import { eq } from "drizzle-orm";
import type { UserType } from "@kinde-oss/kinde-typescript-sdk";
import type { Context } from "hono";

/**
 * User info returned from getUserFromKinde
 */
export interface UserInfo {
  userId: number;
  displayName: string;
  capitalizedDisplayName: string;
  createdAt: Date;
  isDeleted: boolean;
}

/**
 * Ensures a user exists in the database. If they don't exist, creates them
 * with default settings. Returns the user_id.
 */
export async function ensureUserExists(
  kindeUser: UserType,
  authProvider = "kinde"
): Promise<number> {
  if (!kindeUser) {
    throw new Error("Kinde user is null or undefined");
  }

  const authUserId = kindeUser.id;
  if (!authUserId) {
    throw new Error("Kinde user ID is missing");
  }

  // Check if user already exists in user_auth table
  const existingAuth = await db
    .select()
    .from(userAuthTable)
    .where(eq(userAuthTable.authUserId, authUserId))
    .limit(1);

  if (existingAuth.length > 0) {
    // User already exists, ensure they have settings
    const userId = existingAuth[0].userId;

    // Check if settings exist
    const existingSettings = await db
      .select()
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, userId))
      .limit(1);

    // Create default settings if they don't exist
    if (existingSettings.length === 0) {
      await db.insert(userSettingsTable).values({
        userId,
      });
    }

    return userId;
  }

  // User doesn't exist, create them
  // Generate a random display name (user can change it later)
  // Format: "player_XXXXXXXXXX" where XXXXXXXXXX is 10 random lowercase letters
  // Initialize with fallback values (will be overwritten if we find a unique random name)
  let displayName;
  let capitalizedDisplayName;

  // Generate random lowercase letters
  const generateRandomLetters = (length: number): string => {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += letters[Math.floor(Math.random() * letters.length)];
    }
    return result;
  };

  // Try to find a unique random name
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const randomLetters = generateRandomLetters(10);
    const candidateName = `player_${randomLetters}`;

    // Check if this display name is already taken
    const existing = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.displayName, candidateName))
      .limit(1);

    if (existing.length === 0) {
      // Found an available name
      displayName = candidateName;
      capitalizedDisplayName = `Player_${randomLetters}`;
      break;
    }

    attempts++;
  }

  if (!displayName || !capitalizedDisplayName) {
    throw new Error("Failed to generate a unique display name");
  }

  // Create user in users table
  const [newUser] = await db
    .insert(usersTable)
    .values({
      displayName,
      capitalizedDisplayName,
      authProvider,
    })
    .returning();

  const userId = newUser.userId;

  // Create entry in user_auth table
  await db.insert(userAuthTable).values({
    userId,
    authProvider,
    authUserId,
  });

  // Create default settings
  await db.insert(userSettingsTable).values({
    userId,
    // All defaults are set in the schema, so we can just insert with userId
  });

  return userId;
}

/**
 * Gets user data from a Kinde user object.
 * Uses a JOIN query for efficiency (single database call).
 * If the user doesn't exist, creates them automatically.
 *
 * @param kindeUser - The Kinde user object from getUserMiddleware
 * @returns UserInfo object with userId, displayName, capitalizedDisplayName, createdAt, and isDeleted
 * @throws Error if kindeUser is invalid or user creation fails
 */
export async function getUserFromKinde(kindeUser: UserType): Promise<UserInfo> {
  if (!kindeUser) {
    throw new Error("Kinde user is null or undefined");
  }

  const authUserId = kindeUser.id;
  if (!authUserId) {
    throw new Error("Kinde user ID is missing");
  }

  // Get user_id and user info in a single query with JOIN
  const userData = await db
    .select({
      userId: userAuthTable.userId,
      displayName: usersTable.displayName,
      capitalizedDisplayName: usersTable.capitalizedDisplayName,
      createdAt: usersTable.createdAt,
      isDeleted: usersTable.isDeleted,
    })
    .from(userAuthTable)
    .innerJoin(usersTable, eq(userAuthTable.userId, usersTable.userId))
    .where(eq(userAuthTable.authUserId, authUserId))
    .limit(1);

  // If user doesn't exist, create them (fallback for callback failures)
  if (userData.length === 0) {
    const userId = await ensureUserExists(kindeUser);
    // After creating, fetch user info
    const newUserInfo = await db
      .select({
        displayName: usersTable.displayName,
        capitalizedDisplayName: usersTable.capitalizedDisplayName,
        createdAt: usersTable.createdAt,
        isDeleted: usersTable.isDeleted,
      })
      .from(usersTable)
      .where(eq(usersTable.userId, userId))
      .limit(1);

    if (newUserInfo.length === 0) {
      throw new Error("Failed to fetch user info after creation");
    }
    if (newUserInfo.length > 1) {
      throw new Error("Multiple users found after creation");
    }

    return {
      userId,
      displayName: newUserInfo[0].displayName,
      capitalizedDisplayName: newUserInfo[0].capitalizedDisplayName,
      createdAt: newUserInfo[0].createdAt,
      isDeleted: newUserInfo[0].isDeleted,
    };
  }

  return {
    userId: userData[0].userId,
    displayName: userData[0].displayName,
    capitalizedDisplayName: userData[0].capitalizedDisplayName,
    createdAt: userData[0].createdAt,
    isDeleted: userData[0].isDeleted,
  };
}

/**
 * Gets userId from a Hono context (extracts Kinde user and converts to userId).
 * This is a convenience wrapper around getUserFromKinde for routes that only need the userId.
 *
 * @param c - Hono context object
 * @returns userId number
 * @throws Error if user ID not found or user data retrieval fails
 */
export async function getUserIdFromKinde(c: Context): Promise<number> {
  try {
    const kindeUser = c.get("user");
    const authUserId = kindeUser.id;

    if (!authUserId) {
      throw new Error("User ID not found");
    }

    const userInfo = await getUserFromKinde(kindeUser);
    return userInfo.userId;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to get user data");
  }
}
