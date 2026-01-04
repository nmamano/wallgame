#!/usr/bin/env bun
/**
 * Wall Game Official Custom Bot Client - V2 Proactive Protocol
 *
 * This CLI connects proactively to the Wall Game server and registers
 * one or more bots that can serve game requests.
 *
 * Usage:
 *   wallgame-bot-client --client-id <id> --config <path> [OPTIONS]
 */

import { parseArgs } from "util";
import { z } from "zod";
import { BotClient } from "./ws-client";
import { setLogLevel, logger, type LogLevel } from "./logger";
import type { BotConfig } from "../../shared/contracts/custom-bot-protocol";
import { botConfigSchema } from "../../shared/contracts/custom-bot-config-schema";

const VERSION = "2.0.0";

interface ConfigFile {
  server?: string;
  bots: BotConfig[];
  engineCommands: Record<string, Record<string, string>>;
}

function printUsage(): void {
  console.log(`
Wall Game Custom Bot Client v${VERSION} (Protocol V2)

USAGE:
  wallgame-bot-client --client-id <id> --config <path> [OPTIONS]

REQUIRED:
  --client-id <id>     Unique identifier for this client connection

OPTIONS:
  --config <path>      Path to JSON config file (for multi-bot setups)
  --official-token <token> Official token (requires valid OFFICIAL_BOT_TOKEN)
  --log-level <level>  Log level: debug, info, warn, error (default: info)
  --help               Show this help message
  --version            Show version

CONFIG FILE FORMAT:
  {
    "server": "http://localhost:5173",
    "bots": [
      {
        "botId": "bot-1",
        "name": "My First Bot",
        "username": null,
        "appearance": {
          "color": "#ff6b6b",
          "catStyle": "cat1",
          "mouseStyle": "mouse1",
          "homeStyle": "home1"
        },
        "variants": {
          "classic": {
            "timeControls": ["bullet", "blitz", "rapid"],
            "boardWidth": { "min": 5, "max": 12 },
            "boardHeight": { "min": 5, "max": 12 },
            "recommended": [
              { "boardWidth": 8, "boardHeight": 8 }
            ]
          }
        }
      }
    ],
    "engineCommands": {
      "bot-1": {
        "default": "python my_engine.py"
      },
      "bot-2": {
        "classic": "python classic_engine.py",
        "standard": "python standard_engine.py"
      }
    }
  }

EXAMPLES:
  # Multi-bot setup from config file
  wallgame-bot-client --client-id my-client --config bots.json

  # Official bot (requires token)
  wallgame-bot-client --client-id my-client --config bots.json --official-token abc123

ENGINE INTERFACE:
  Your engine receives a JSON request on stdin and must write a JSON response to stdout.
  See the Wall Game documentation for the full engine API specification (V2).

PROTOCOL V2 CHANGES:
  - Bots connect proactively (no per-game seat tokens)
  - One client can serve multiple bots
  - Server queues requests (one at a time per client)
  - Draw offers are auto-declined (no engine consultation)
  - Rematches are transparent (just new game requests)
`);
}

function printVersion(): void {
  console.log(`wallgame-bot-client v${VERSION}`);
}

const configFileSchema = z
  .object({
    server: z.string().optional(),
    bots: z
      .array(botConfigSchema.omit({ officialToken: true }).strict())
      .min(1),
    engineCommands: z.record(
      z.string(),
      z.record(z.string(), z.string().trim().min(1)),
    ),
  })
  .strict();

async function loadConfig(path: string): Promise<ConfigFile> {
  const file = Bun.file(path);
  const text = await file.text();
  const parsed = configFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const pathLabel = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${pathLabel}: ${issue.message}`;
    });
    throw new Error(details.join("; "));
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "client-id": { type: "string" },
      config: { type: "string" },
      "official-token": { type: "string" },
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

  // Set log level
  const logLevel = values["log-level"] as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    console.error(`Error: Invalid log level: ${logLevel}`);
    process.exit(1);
  }
  setLogLevel(logLevel);

  let clientId: string;
  let serverUrl: string;
  let bots: BotConfig[];
  let officialToken: string | undefined;
  let engineCommands: Map<string, Record<string, string>>;

  // Load from config file (required)
  if (!values.config) {
    console.error("Error: --config is required");
    console.error("Use --help for usage information");
    process.exit(1);
  }

  if (!values["client-id"]) {
    console.error("Error: --client-id is required");
    console.error("Use --help for usage information");
    process.exit(1);
  }

  try {
    const config = await loadConfig(values.config);
    clientId = values["client-id"]!;
    serverUrl = config.server ?? "http://localhost:5173";
    officialToken = values["official-token"];

    engineCommands = new Map();
    for (const [botId, command] of Object.entries(config.engineCommands)) {
      engineCommands.set(botId, command);
    }

    bots = config.bots.map((bot) => ({
      ...bot,
      officialToken,
    }));
  } catch (error) {
    console.error(`Error loading config file: ${error}`);
    process.exit(1);
  }

  logger.info(`Wall Game Custom Bot Client v${VERSION}`);
  logger.info(`Client ID: ${clientId}`);
  logger.info(`Server: ${serverUrl}`);
  logger.info(`Bots: ${bots.map((b) => b.name).join(", ")}`);

  const client = new BotClient({
    serverUrl,
    clientId,
    bots,
    engineCommands,
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
