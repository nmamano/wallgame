# Game session memory

The server owns live sessions in `server/games/store.ts`. Each session includes
the game state and board snapshots for its move history. Persisting a result does
not release these objects by itself.

The process entrypoint starts session maintenance once. Every minute it examines
ended sessions. A session is eligible for release after 30 minutes without a
session update, provided neither player nor any game socket is connected.
Active games are never eligible. The delay preserves reconnects and rematches;
after release, saved game URLs use the existing database replay path.

Before deletion, maintenance completes the idempotent rating and persistence
operations. A failed operation keeps the session for another attempt. Games that
the existing persistence rules intentionally omit, such as cancelled lobbies,
can also be released. After awaiting the database, maintenance rechecks the
session timestamp, lifecycle and connections. A reconnect or rematch therefore
prevents deletion. Session timers and spectator counts are removed with it.

Sweeps do not overlap. Their logs contain timestamps, RSS, JavaScript heap use,
session counts, ended-session counts, history-entry counts and released counts.
RSS can remain above live heap size because the runtime retains allocated pages.
Connected sessions and failed saves are retained for correctness, so these counts
must be considered when investigating continued growth.

## Regression evidence

On 2026-09-21, a local reproduction with 1,000 synthetic seven-move games retained
all 1,000 finished sessions without cleanup. After forced garbage collection, live
JavaScript heap grew from about 3.3 MB to 23.8 MB. With cleanup, two successive
batches of 500 games each returned to zero sessions and approximately 4.3 MB of
live heap. These measurements establish the retention mechanism, not its share
of any production incident.

`tests/game/session-retention.test.ts` covers the release boundary, failures,
connections, in-flight saves, rematches, cancellation and repeated batches.
`tests/integration/past-games.test.ts` verifies database replay after release.
