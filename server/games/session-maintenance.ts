import { persistCompletedGame } from "./persistence";
import {
  processRatingUpdate,
  releaseEndedSessions,
  sessionMemoryStats,
} from "./store";

/** Started once by the process entrypoint, never by createApp or an import. */
export function startSessionMaintenance(
  hasConnections: (id: string) => boolean,
) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void releaseEndedSessions({
      now: Date.now(),
      hasConnections,
      finalize: async (session) => {
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
