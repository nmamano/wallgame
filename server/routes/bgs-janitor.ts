/**
 * The stale-BGS janitor: defense in depth behind each end path.
 *
 * Every end path (game end, start timeout, client disconnect) already ends
 * its session, so in normal operation a sweep finds nothing. A session it
 * finds has leaked, and the janitor ends it the way a normal end would, so
 * nothing that points at it stays behind either.
 *
 * Its own module because it calls the game-end hooks of both
 * custom-bot-socket.ts and eval-socket.ts, and eval-socket.ts already
 * imports custom-bot-socket.ts.
 */

import { endBgs, findStaleBgs } from "../games/bgs-store";
import { removeClientBgsSession } from "../games/custom-bot-store";
import { endBgsSession, notifyBotGameEnded } from "./custom-bot-socket";
import { handleEvalBarGameEnd } from "./eval-socket";

/** How often the janitor looks for stale BGS. */
export const BGS_JANITOR_INTERVAL_MS = 60 * 60 * 1000;

/**
 * End every BGS idle longer than BGS_MAX_IDLE_MS (bgs-store.ts), one at a
 * time. Returns how many it found.
 *
 * A BGS keyed by its game (bgsId === gameId) is a live game's: a bot's own
 * game, or the shared eval bar of a human game. It ends through the same two
 * hooks game-socket.ts calls at game end: notifyBotGameEnded also drops the
 * bot's active-game entry, and handleEvalBarGameEnd the shared eval-bar
 * entry. Any other BGS is a replay's, which nothing else holds.
 */
export const sweepStaleBgs = async (now: number): Promise<number> => {
  const stale = findStaleBgs(now);
  for (const session of stale) {
    const { bgsId, botCompositeId, gameId } = session;
    console.warn("[bgs-janitor] ending stale BGS", {
      bgsId,
      botCompositeId,
      gameId,
      idleMs: now - session.updatedAt,
    });
    try {
      if (bgsId === gameId) {
        await notifyBotGameEnded(botCompositeId, gameId);
        await handleEvalBarGameEnd(gameId);
      } else {
        await endBgsSession(botCompositeId, bgsId);
      }
    } catch (error) {
      console.error("[bgs-janitor] failed to end BGS", { error, bgsId });
      // Clean up locally anyway, as the game-end path does.
      endBgs(bgsId);
      const [clientId] = botCompositeId.split(":");
      removeClientBgsSession(clientId, bgsId);
    }
  }
  return stale.length;
};

/** Started once by the process entrypoint, never by createApp or an import. */
export const startBgsJanitor = (): Timer => {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepStaleBgs(Date.now())
      .catch((error: unknown) =>
        console.error("[bgs-janitor] sweep failed", { error }),
      )
      .finally(() => {
        running = false;
      });
  }, BGS_JANITOR_INTERVAL_MS);
  timer.unref();
  return timer;
};
