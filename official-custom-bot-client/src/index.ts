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
import { BotClient } from "./ws-client";
import { setLogLevel, logger, type LogLevel } from "./logger";
import type {
  BotConfig,
  VariantConfig,
} from "../../shared/contracts/custom-bot-protocol";
import type {
  Variant,
  TimeControlPreset,
} from "../../shared/domain/game-types";

const VERSION = "2.0.0";

interface ConfigFile {
  server?: string;
  clientId?: string;
  officialToken?: string;
  bots: Array<{
    botId: string;
    name: string;
    engine?: string;
    variants?: string[];
    boardSizes?: Array<{ width: number; height: number }>;
  }>;
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
  --official-token     Mark bots as official (requires valid OFFICIAL_BOT_TOKEN)
  --log-level <level>  Log level: debug, info, warn, error (default: info)
  --help               Show this help message
  --version            Show version

CONFIG FILE FORMAT:
  {
    "server": "http://localhost:5173",
    "clientId": "my-client",
    "officialToken": "secret",
    "bots": [
      {
        "botId": "bot-1",
        "name": "My First Bot",
        "engine": "python my_engine.py",
        "variants": ["standard", "classic"],
        "boardSizes": [{ "width": 9, "height": 9 }]
      }
    ]
  }

EXAMPLES:
  # Multi-bot setup from config file
  wallgame-bot-client --config bots.json

  # Official bot (requires token)
  wallgame-bot-client --config bots.json --official-token

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

/** Default variant config supporting all time controls and board sizes */
function createDefaultVariantConfig(): VariantConfig {
  return {
    timeControls: [
      "bullet",
      "blitz",
      "rapid",
      "classical",
    ] as TimeControlPreset[],
    boardWidth: { min: 3, max: 20 },
    boardHeight: { min: 3, max: 20 },
    recommended: [],
  };
}

/** Build variants object from string array or use defaults for all variants */
function buildVariantsConfig(
  variantNames?: string[],
): Partial<Record<Variant, VariantConfig>> {
  const allVariants: Variant[] = ["standard", "classic", "freestyle"];
  const targetVariants = variantNames ?? allVariants;

  const result: Partial<Record<Variant, VariantConfig>> = {};
  for (const v of targetVariants) {
    if (allVariants.includes(v as Variant)) {
      result[v as Variant] = createDefaultVariantConfig();
    }
  }
  return result;
}

async function loadConfig(path: string): Promise<ConfigFile> {
  const file = Bun.file(path);
  const text = await file.text();
  return JSON.parse(text) as ConfigFile;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "client-id": { type: "string" },
      config: { type: "string" },
      "official-token": { type: "boolean", default: false },
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
  let engineCommands: Map<string, string | undefined>;

  // Load from config file (required)
  if (!values.config) {
    console.error("Error: --config is required");
    console.error("Use --help for usage information");
    process.exit(1);
  }

  try {
    const config = await loadConfig(values.config);
    clientId = config.clientId ?? values["client-id"]!;
    serverUrl = config.server ?? "http://localhost:5173";
    officialToken = config.officialToken;

    if (!clientId) {
      console.error("Error: clientId required in config file or --client-id");
      process.exit(1);
    }

    if (!config.bots || config.bots.length === 0) {
      console.error("Error: At least one bot required in config file");
      process.exit(1);
    }

    engineCommands = new Map();
    bots = config.bots.map((b) => {
      engineCommands.set(b.botId, b.engine);
      return {
        botId: b.botId,
        name: b.name,
        officialToken: officialToken,
        username: null, // Public bot
        variants: buildVariantsConfig(b.variants),
      };
    });
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
