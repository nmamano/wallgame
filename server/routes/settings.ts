import { Hono } from "hono";
import { getUserMiddleware } from "../kinde";
import { db } from "../db/index";
import {
  userSettingsTable,
  userPawnSettingsTable,
  userVariantSettingsTable,
} from "../db/schema/user-settings";
import { usersTable } from "../db/schema/users";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getUserFromKinde, getUserIdFromKinde } from "../db/user-helpers";

export const settingsRoute = new Hono();

/**
 * Get user settings
 * GET /api/settings
 */
settingsRoute.get("/", getUserMiddleware, async (c) => {
  try {
    const kindeUser = c.get("user");
    const authUserId = kindeUser.id;
    if (!authUserId) {
      console.error(`User ID not found for user: ${kindeUser.email}`);
      return c.json({ error: "User ID not found" }, 400);
    }

    let userInfo;
    try {
      userInfo = await getUserFromKinde(kindeUser);
    } catch (error) {
      console.error("Error getting user from Kinde:", error);
      return c.json({ error: "Failed to get user data" }, 500);
    }

    const userId = userInfo.userId;

    // Get all settings in a single query with subqueries
    const settingsResult = await db
      .select({
        boardTheme: userSettingsTable.boardTheme,
        pawnColor: userSettingsTable.pawnColor,
        defaultVariant: userSettingsTable.defaultVariant,
        defaultTimeControl: userSettingsTable.defaultTimeControl,
        defaultRatedStatus: userSettingsTable.defaultRatedStatus,
        pawnSettings: sql<
          | {
              pawn_type: string;
              pawn_shape: string;
            }[]
          | null
        >`(
          SELECT COALESCE(
            json_agg(
              json_build_object(
                'pawn_type', ups.pawn_type,
                'pawn_shape', ups.pawn_shape
              )
            ),
            '[]'::json
          )
          FROM user_pawn_settings AS ups
          WHERE ups.user_id = ${userSettingsTable.userId}
        )`,
        variantSettings: sql<
          | {
              variant: string;
              default_parameters: unknown;
            }[]
          | null
        >`(
          SELECT COALESCE(
            json_agg(
              json_build_object(
                'variant', uvs.variant,
                'default_parameters', uvs.default_parameters
              )
            ),
            '[]'::json
          )
          FROM user_variant_settings AS uvs
          WHERE uvs.user_id = ${userSettingsTable.userId}
        )`,
      })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, userId))
      .limit(1);

    if (settingsResult.length === 0) {
      console.error("Settings not found for user:", userId);
      return c.json({ error: "Settings not found" }, 404);
    }
    if (settingsResult.length > 1) {
      console.error(
        "Data integrity error: multiple settings found for user:",
        userId,
      );
      return c.json({ error: "Internal server error" }, 500);
    }

    const settings = settingsResult[0];
    const pawnSettings = settings.pawnSettings || [];
    const variantSettings = settings.variantSettings || [];

    return c.json({
      displayName: userInfo.displayName,
      capitalizedDisplayName: userInfo.capitalizedDisplayName,
      boardTheme: settings.boardTheme,
      pawnColor: settings.pawnColor,
      pawnSettings: pawnSettings,
      defaultVariant: settings.defaultVariant,
      defaultTimeControl: settings.defaultTimeControl,
      defaultRatedStatus: settings.defaultRatedStatus,
      variantSettings: variantSettings,
    });
  } catch (error) {
    console.error("Error fetching settings:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Update board theme
 * PUT /api/settings/board-theme
 */
settingsRoute.put("/board-theme", getUserMiddleware, async (c) => {
  try {
    const userId = await getUserIdFromKinde(c);
    const body = await c.req.json();
    const { boardTheme } = z.object({ boardTheme: z.string() }).parse(body);

    await db
      .update(userSettingsTable)
      .set({ boardTheme })
      .where(eq(userSettingsTable.userId, userId));

    return c.json({ success: true });
  } catch (error) {
    console.error("Error updating board theme:", error);
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request data", details: error.issues },
        400,
      );
    }
    if (error instanceof Error) {
      if (error.message === "User ID not found") {
        return c.json({ error: error.message }, 400);
      }
      if (error.message === "Failed to get user data") {
        return c.json({ error: error.message }, 500);
      }
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Update pawn color
 * PUT /api/settings/pawn-color
 */
settingsRoute.put("/pawn-color", getUserMiddleware, async (c) => {
  try {
    const userId = await getUserIdFromKinde(c);
    const body = await c.req.json();
    const { pawnColor } = z.object({ pawnColor: z.string() }).parse(body);

    await db
      .update(userSettingsTable)
      .set({ pawnColor })
      .where(eq(userSettingsTable.userId, userId));

    return c.json({ success: true });
  } catch (error) {
    console.error("Error updating pawn color:", error);
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request data", details: error.issues },
        400,
      );
    }
    if (error instanceof Error) {
      if (error.message === "User ID not found") {
        return c.json({ error: error.message }, 400);
      }
      if (error.message === "Failed to get user data") {
        return c.json({ error: error.message }, 500);
      }
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Update pawn shape
 * PUT /api/settings/pawn
 */
settingsRoute.put("/pawn", getUserMiddleware, async (c) => {
  try {
    const userId = await getUserIdFromKinde(c);
    const body = await c.req.json();
    const { pawnType, pawnShape } = z
      .object({
        pawnType: z.string(),
        pawnShape: z.string(),
      })
      .parse(body);

    await db
      .insert(userPawnSettingsTable)
      .values({
        userId,
        pawnType,
        pawnShape,
      })
      .onConflictDoUpdate({
        target: [userPawnSettingsTable.userId, userPawnSettingsTable.pawnType],
        set: {
          pawnShape,
        },
      });

    return c.json({ success: true });
  } catch (error) {
    console.error("Error updating pawn:", error);
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request data", details: error.issues },
        400,
      );
    }
    if (error instanceof Error) {
      if (error.message === "User ID not found") {
        return c.json({ error: error.message }, 400);
      }
      if (error.message === "Failed to get user data") {
        return c.json({ error: error.message }, 500);
      }
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Update default variant
 * PUT /api/settings/default-variant
 */
settingsRoute.put("/default-variant", getUserMiddleware, async (c) => {
  try {
    const userId = await getUserIdFromKinde(c);
    const body = await c.req.json();
    const { variant } = z.object({ variant: z.string() }).parse(body);

    await db
      .update(userSettingsTable)
      .set({ defaultVariant: variant })
      .where(eq(userSettingsTable.userId, userId));

    return c.json({ success: true });
  } catch (error) {
    console.error("Error updating default variant:", error);
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request data", details: error.issues },
        400,
      );
    }
    if (error instanceof Error) {
      if (error.message === "User ID not found") {
        return c.json({ error: error.message }, 400);
      }
      if (error.message === "Failed to get user data") {
        return c.json({ error: error.message }, 500);
      }
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Update time control
 * PUT /api/settings/time-control
 */
settingsRoute.put("/time-control", getUserMiddleware, async (c) => {
  try {
    const userId = await getUserIdFromKinde(c);
    const body = await c.req.json();
    const { timeControl } = z
      .object({
        timeControl: z.enum(["bullet", "blitz", "rapid", "classical"]),
      })
      .parse(body);

    await db
      .update(userSettingsTable)
      .set({ defaultTimeControl: timeControl })
      .where(eq(userSettingsTable.userId, userId));

    return c.json({ success: true });
  } catch (error) {
    console.error("Error updating time control:", error);
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request data", details: error.issues },
        400,
      );
    }
    if (error instanceof Error) {
      if (error.message === "User ID not found") {
        return c.json({ error: error.message }, 400);
      }
      if (error.message === "Failed to get user data") {
        return c.json({ error: error.message }, 500);
      }
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Update rated status
 * PUT /api/settings/rated-status
 */
settingsRoute.put("/rated-status", getUserMiddleware, async (c) => {
  try {
    const userId = await getUserIdFromKinde(c);
    const body = await c.req.json();
    const { rated } = z.object({ rated: z.boolean() }).parse(body);

    await db
      .update(userSettingsTable)
      .set({ defaultRatedStatus: rated })
      .where(eq(userSettingsTable.userId, userId));

    return c.json({ success: true });
  } catch (error) {
    console.error("Error updating rated status:", error);
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request data", details: error.issues },
        400,
      );
    }
    if (error instanceof Error) {
      if (error.message === "User ID not found") {
        return c.json({ error: error.message }, 400);
      }
      if (error.message === "Failed to get user data") {
        return c.json({ error: error.message }, 500);
      }
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Update variant parameters
 * PUT /api/settings/variant-parameters
 */
settingsRoute.put("/variant-parameters", getUserMiddleware, async (c) => {
  try {
    const userId = await getUserIdFromKinde(c);
    const body = await c.req.json();
    const { variant, parameters } = z
      .object({
        variant: z.string(),
        parameters: z.record(z.string(), z.unknown()),
      })
      .parse(body);

    await db
      .insert(userVariantSettingsTable)
      .values({
        userId,
        variant,
        defaultParameters: parameters,
      })
      .onConflictDoUpdate({
        target: [
          userVariantSettingsTable.userId,
          userVariantSettingsTable.variant,
        ],
        set: {
          defaultParameters: parameters,
        },
      });

    return c.json({ success: true });
  } catch (error) {
    console.error("Error updating variant parameters:", error);
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request data", details: error.issues },
        400,
      );
    }
    if (error instanceof Error) {
      if (error.message === "User ID not found") {
        return c.json({ error: error.message }, 400);
      }
      if (error.message === "Failed to get user data") {
        return c.json({ error: error.message }, 500);
      }
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

// Schema for updating display name
const updateDisplayNameSchema = z.object({
  displayName: z.string().min(3),
});

/**
 * Update display name
 * PUT /api/settings/display-name
 */
settingsRoute.put("/display-name", getUserMiddleware, async (c) => {
  try {
    const userId = await getUserIdFromKinde(c);

    // Parse and validate request body
    const body = await c.req.json();
    const { displayName } = updateDisplayNameSchema.parse(body);

    // Trim whitespace but preserve user's exact capitalization
    const displayNameTrimmed = displayName.trim();
    // Lowercase version for uniqueness checks and storage
    const displayNameLower = displayNameTrimmed.toLowerCase();

    // Validate display name (no guest, deleted, bot)
    if (
      displayNameLower.includes("guest") ||
      displayNameLower.includes("deleted") ||
      displayNameLower.includes("bot")
    ) {
      return c.json(
        {
          error:
            "Names including 'guest', 'deleted', or 'bot' are not allowed.",
        },
        400,
      );
    }

    // Check if display name is already taken by another user
    const existingUser = await db
      .select()
      .from(usersTable)
      .where(
        sql`${usersTable.displayName} = ${displayNameLower} AND ${usersTable.userId} != ${userId}`,
      )
      .limit(1);

    const nameTaken = existingUser.length > 0;

    if (nameTaken) {
      return c.json(
        {
          error:
            "This display name is already taken. Please choose another one.",
        },
        409,
      );
    }

    // Update display name
    // Store lowercase version for uniqueness checks
    // Store user's exact capitalization for display
    await db
      .update(usersTable)
      .set({
        displayName: displayNameLower,
        capitalizedDisplayName: displayNameTrimmed, // User's exact capitalization
      })
      .where(eq(usersTable.userId, userId));

    return c.json({
      success: true,
      displayName: displayNameLower,
      capitalizedDisplayName: displayNameTrimmed,
    });
  } catch (error) {
    console.error("Error updating display name:", error);
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request data", details: error.issues },
        400,
      );
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});
