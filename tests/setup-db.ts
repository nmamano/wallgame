/**
 * Test database setup using Testcontainers.
 *
 * Spins up an ephemeral PostgreSQL 16 container for each test run.
 * Runs Drizzle migrations against the container.
 * No manual DB setup required - just Docker.
 */
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

export interface TestDbHandle {
  container: StartedTestContainer;
  connectionUrl: string;
}

const DB_NAME = "testdb";
const DB_USER = "test";
const DB_PASSWORD = "test";

/**
 * How long ONE attempt at starting the container may take, and how many
 * attempts it gets. Board 04a59d77.
 *
 * These two numbers are not free: every integration suite gives its beforeAll
 * 120_000ms, and this function is the first thing that beforeAll does. The old
 * budget was a single attempt of 120_000ms - exactly the hook budget - so a
 * slow start on a CI runner consumed the whole hook and bun aborted it before
 * anything here could report a cause. What the runner prints for an aborted
 * hook is "a beforeEach/afterEach hook timed out", which names no container;
 * the suite then failed again in its own afterAll, against a database handle
 * that was never assigned, and THAT TypeError was the loudest line in the log.
 * Two failures, neither naming the container that did not start.
 *
 * So the budget has to leave the runner room to hear us: 3 x 30s is 90s of
 * trying and ~30s of headroom, and the error below is raised inside the hook
 * rather than by the runner killing it.
 *
 * 30s is roughly 10x a healthy start. The retry is the actual flake fix -
 * container startup on a shared GitHub runner is transient, and it went green
 * on a rerun of the identical commit.
 */
const CONTAINER_ATTEMPT_TIMEOUT_MS = 30_000;
const CONTAINER_START_ATTEMPTS = 3;

/**
 * Runs `startAttempt` until one succeeds, giving each attempt a wall-clock
 * deadline, and failing with every attempt's cause named.
 *
 * WHY A DEADLINE HERE AND NOT JUST withStartupTimeout: testcontainers applies
 * withStartupTimeout to the WAIT STRATEGY only - `generic-container.js` sets it
 * immediately before `waitForContainer(...)`, which is after the image pull and
 * after container create. Neither of those is covered, so withStartupTimeout on
 * its own cannot promise this function ever returns, and a hanging pull would
 * reproduce exactly the diagnosis-free timeout above. The deadline covers the
 * whole attempt.
 *
 * Exported for `tests/setup-db-retry.test.ts`, which drives it with fakes so
 * the retry and the deadline can be tested without Docker.
 */
export async function startContainerWithRetry(
  startAttempt: () => Promise<StartedTestContainer>,
  attempts: number = CONTAINER_START_ATTEMPTS,
  attemptTimeoutMs: number = CONTAINER_ATTEMPT_TIMEOUT_MS,
): Promise<StartedTestContainer> {
  const failures: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = startAttempt();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`no result within ${String(attemptTimeoutMs)}ms`),
              ),
            attemptTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Not transient, and retrying it would only delay the one message that
      // actually tells the reader what to do.
      if (message.includes("Could not find a working container runtime")) {
        throw new Error(
          "Docker is not running. Please start Docker Desktop and try again.\n" +
            "  macOS: open -a Docker\n" +
            "  Or launch Docker Desktop from Applications.\n" +
            "  Original error: " +
            message,
        );
      }

      failures.push(
        `attempt ${String(attempt)}/${String(attempts)}: ${message}`,
      );

      // We stopped waiting for this attempt, but it may still be starting.
      // Dispose it rather than leave an orphan Postgres behind on every retry.
      void started.then((late) => late.stop()).catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `Postgres testcontainer did not start after ${String(attempts)} attempts ` +
      `of ${String(attemptTimeoutMs)}ms each:\n` +
      failures.map((failure) => `  ${failure}`).join("\n"),
  );
}

/**
 * Starts an ephemeral PostgreSQL container and runs migrations.
 * Sets process.env.DATABASE_URL so that subsequent imports of
 * server modules will use this database.
 *
 * IMPORTANT: Call this BEFORE importing any server modules that
 * depend on the database (e.g., server/db, server/app).
 */
export async function setupEphemeralDb(): Promise<TestDbHandle> {
  // Use GenericContainer instead of PostgreSqlContainer for better Bun compatibility
  const container = await startContainerWithRetry(() =>
    new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_DB: DB_NAME,
        POSTGRES_USER: DB_USER,
        POSTGRES_PASSWORD: DB_PASSWORD,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .withStartupTimeout(CONTAINER_ATTEMPT_TIMEOUT_MS)
      .start(),
  );

  const host = container.getHost();

  const port = container.getMappedPort(5432);
  const url = `postgres://${DB_USER}:${DB_PASSWORD}@${host}:${port}/${DB_NAME}`;

  // Set environment variables so the app uses this DB
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = "test";

  // Run Drizzle migrations on the ephemeral DB.
  //
  // Deliberately NOT retried, and deliberately outside the retry above. Only
  // the container START is flaky. A container that came up and then failed to
  // migrate is a real failure - a broken migration, a schema conflict - and
  // must be reported as one on the first try. Retrying it would turn a
  // reproducible error into three of them and hide the cause behind a delay.
  const migrationClient = postgres(url, { max: 1 });
  const db = drizzle(migrationClient);
  await migrate(db, { migrationsFolder: "drizzle" });
  await migrationClient.end();

  return { container, connectionUrl: url };
}

/**
 * Stops the PostgreSQL container.
 * Call this in afterAll() to clean up.
 */
export async function teardownEphemeralDb(
  container: StartedTestContainer | undefined,
): Promise<void> {
  if (!container) {
    return; // Container was never initialized (setup failed)
  }

  await container.stop();
}
