#!/usr/bin/env bun
/**
 * Wall Game Official Custom Bot Client
 *
 * This CLI connects to the Wall Game server and controls a seat
 * using either an external engine or the built-in dumb bot.
 *
 * Usage:
 *   wallgame-bot-client --server <url> --token <seatToken> [--engine "<command>"] [--log-level <level>]
 */

import { parseArgs } from "util";
import { BotClient } from "./ws-client";
import { setLogLevel, logger, type LogLevel } from "./logger";

const VERSION = "1.0.0";

function printUsage(): void {
  console.log(`
Wall Game Custom Bot Client v${VERSION}

USAGE:
  wallgame-bot-client --token <seatToken> [OPTIONS]

OPTIONS:
  --server <url>       Server URL (default: http://localhost:5173)
  --token <token>      Seat token from the game setup UI (required)
  --engine "<cmd>"     Command to run your engine (optional)
  --log-level <level>  Log level: debug, info, warn, error (default: info)
  --help               Show this help message
  --version            Show version

EXAMPLES:
  # Connect with the built-in dumb bot (for testing)
  wallgame-bot-client --token cbt_abc123

  # Connect with a custom engine
  wallgame-bot-client --token cbt_abc123 --engine "python my_engine.py"

  # Connect to production server
  wallgame-bot-client --server https://wallgame.io --token cbt_abc123 --engine "./my-engine"

ENGINE INTERFACE:
  Your engine receives a JSON request on stdin and must write a JSON response to stdout.
  See the Wall Game documentation for the full engine API specification.
`);
}

function printVersion(): void {
  console.log(`wallgame-bot-client v${VERSION}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      server: { type: "string", default: "http://localhost:5173" },
      token: { type: "string" },
      engine: { type: "string" },
      "log-level": { type: "string", default: "info" },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (values.version) {
    printVersion();
    process.exit(0);
  }

  if (!values.token) {
    console.error("Error: --token is required");
    console.error("Use --help for usage information");
    process.exit(1);
  }

  // Set log level
  const logLevel = values["log-level"] as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    console.error(`Error: Invalid log level: ${logLevel}`);
    process.exit(1);
  }
  setLogLevel(logLevel);

  logger.info(`Wall Game Custom Bot Client v${VERSION}`);
  logger.info(`Server: ${values.server}`);
  logger.info(`Engine: ${values.engine ?? "(built-in dumb bot)"}`);

  const client = new BotClient({
    serverUrl: values.server!,
    seatToken: values.token,
    engineCommand: values.engine,
  });

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    client.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await client.run();
    logger.info("Client disconnected");
  } catch (error) {
    logger.error("Fatal error:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
