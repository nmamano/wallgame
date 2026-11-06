import { persistCompletedGame } from "./persistence";
import {
  processRatingUpdate,
  releaseEndedSessions,
  sessionMemoryStats,
} from "./store";

/**
 * Started once by the process entrypoint, never by createApp or an import.
 * Both callbacks come from the game socket route, which server/games must not
 * import.
 */
export function startSessionMaintenance(
  hasConnections: (id: string) => boolean,
  endEngineSessions: (id: string) => void,
) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void releaseEndedSessions({
      now: Date.now(),
      hasConnections,
      finalize: async (session) => {
        // A session is released only once it is over, so nothing may still
        // hold an engine session for it.
        endEngineSessions(session.id);
        await processRatingUpdate(session.id);
        await persistCompletedGame(session);
      },
      onError: (id) => {
        console.error("[session-maintenance] save failed; retaining session", {
          gameId: id,
        });
      },
    })
      .then((released) => {
        const memory = process.memoryUsage();
        console.info("[session-maintenance]", {
          at: new Date().toISOString(),
          released,
          ...sessionMemoryStats(),
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
        });
      })
      .catch(() => console.error("[session-maintenance] sweep failed"))
      .finally(() => {
        running = false;
      });
  }, 60_000);
  timer.unref();
  return timer;
}
