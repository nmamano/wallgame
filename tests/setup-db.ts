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
 * Starts an ephemeral PostgreSQL container and runs migrations.
 * Sets process.env.DATABASE_URL so that subsequent imports of
 * server modules will use this database.
 *
 * IMPORTANT: Call this BEFORE importing any server modules that
 * depend on the database (e.g., server/db, server/index).
 */
export async function setupEphemeralDb(): Promise<TestDbHandle> {
  // Use GenericContainer instead of PostgreSqlContainer for better Bun compatibility
  let container: StartedTestContainer;
  try {
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_DB: DB_NAME,
        POSTGRES_USER: DB_USER,
        POSTGRES_PASSWORD: DB_PASSWORD,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .withStartupTimeout(120_000)
      .start();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Could not find a working container runtime")
    ) {
      throw new Error(
        "Docker is not running. Please start Docker Desktop and try again.\n" +
          "  macOS: open -a Docker\n" +
          "  Or launch Docker Desktop from Applications.",
      );
    }
    throw error;
  }

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://${DB_USER}:${DB_PASSWORD}@${host}:${port}/${DB_NAME}`;

  // Set environment variables so the app uses this DB
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = "test";

  // Run Drizzle migrations on the ephemeral DB
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
  container: StartedTestContainer,
): Promise<void> {
  await container.stop();
}
