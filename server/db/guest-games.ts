import { and, eq, isNull } from "drizzle-orm";
import { db } from "./index";
import { gamePlayersTable } from "./schema/game-players";

/**
 * Links every guest seat this browser played (its anonymous id, no account
 * yet) to the account `userId`, and returns how many seats it linked
 * (task B; see SIGNUP_GUEST_GAMES_COOKIE in shared/contracts/user.ts).
 *
 * Only `user_id` changes. The stored names, results and ratings stay as they
 * were played: a guest game was unrated, and no rating reads game_players.
 * A seat that already has an account is never moved, so a second sign-up on
 * the same browser takes nothing from the first.
 */
export const linkGuestGames = async (
  userId: number,
  anonymousId: string,
): Promise<number> => {
  const linked = await db
    .update(gamePlayersTable)
    .set({ userId })
    .where(
      and(
        eq(gamePlayersTable.anonymousId, anonymousId),
        isNull(gamePlayersTable.userId),
      ),
    )
    .returning({ gameId: gamePlayersTable.gameId });
  return linked.length;
};
