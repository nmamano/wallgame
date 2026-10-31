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
 * The most characters of the wire move and of the reason that are stored. A
 * real move is a few characters, but both come from the bot - any user can
 * connect a custom bot - and only the 64 KiB frame limit bounds them, so an
 * unbounded copy would let one bot write tens of kilobytes per refusal, and
 * once more on every takeback (Reviewer 1, 2026-11-01).
 */
export const WIRE_MOVE_MAX_CHARS = 200;
export const REASON_MAX_CHARS = 500;

/** Cut a string to `max` characters, and say how many were cut. */
const cap = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}...(+${text.length - max} chars)`;

/**
 * Leave a durable trace of a bot move the game refused. Never throws: a
 * failed write is logged, and the caller's handling of the refusal goes on.
 */
export const recordBotMoveRefusal = async (
  refusal: BotMoveRefusal,
): Promise<void> => {
  const row = {
    ...refusal,
    wireMove: cap(refusal.wireMove, WIRE_MOVE_MAX_CHARS),
    reason: cap(refusal.reason, REASON_MAX_CHARS),
  };
  console.error("[ws] bot move refused by the game", row);
  try {
    await db.insert(botMoveRefusalsTable).values(row);
  } catch (error) {
    console.error("[persistence] failed to record a refused bot move", {
      error,
      ...row,
    });
  }
};
