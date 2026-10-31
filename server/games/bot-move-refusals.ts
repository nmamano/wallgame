import { db } from "../db";
import { botMoveRefusalsTable } from "../db/schema/bot-move-refusals";

export interface BotMoveRefusal {
  gameId: string;
  botCompositeId: string;
  ply: number;
  wireMove: string;
  reason: string;
}

/**
 * Leave a durable trace of a bot move the game refused. Never throws: a
 * failed write is logged, and the caller's handling of the refusal goes on.
 */
export const recordBotMoveRefusal = async (
  refusal: BotMoveRefusal,
): Promise<void> => {
  console.error("[ws] bot move refused by the game", refusal);
  try {
    await db.insert(botMoveRefusalsTable).values(refusal);
  } catch (error) {
    console.error("[persistence] failed to record a refused bot move", {
      error,
      ...refusal,
    });
  }
};
