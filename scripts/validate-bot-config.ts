/**
 * Fail-closed preflight for a bot-client config file, to be run BEFORE
 * restarting a production bot client.
 *
 * It validates with the SAME schema the client itself uses (imported, not
 * re-declared — a validator with its own copy would certify configs the client
 * rejects) and then asserts what the schema cannot: that bots and
 * engineCommands are the same exact set. A bot with no engine command parses
 * perfectly and then serves the built-in dummy implementation while still
 * attaching and advertising itself, so parse success alone is not evidence
 * that a rollout is safe.
 *
 * Usage:
 *   bun scripts/validate-bot-config.ts official-custom-bot-client/transformer.prod.config.json
 */

import {
  configFileSchema,
  assertEngineCommandsCoverBots,
} from "../official-custom-bot-client/src/config-schema";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/validate-bot-config.ts <config path>");
  process.exit(1);
}

const text = await Bun.file(path).text();
const parsed = configFileSchema.safeParse(JSON.parse(text));
if (!parsed.success) {
  console.error(`INVALID ${path}`);
  for (const issue of parsed.error.issues) {
    const label = issue.path.length > 0 ? issue.path.join(".") : "config";
    console.error(`  ${label}: ${issue.message}`);
  }
  process.exit(1);
}

const config = parsed.data;
try {
  assertEngineCommandsCoverBots(config);
} catch (error) {
  console.error(`INVALID ${path}`);
  console.error(`  ${(error as Error).message}`);
  process.exit(1);
}

console.log(`VALID ${path}`);
console.log(`server: ${config.server ?? "(default)"}`);
console.log(`bots (${config.bots.length}), each with an engine command:`);
for (const bot of config.bots) {
  const variants = Object.keys(bot.variants).join(", ");
  const command = config.engineCommands[bot.botId];
  // Surface the knobs a reviewer actually checks, without asserting on them:
  // which model, and how much search.
  const knobs =
    command.match(
      /--samples \d+|--parallel_samples \d+|--thread_pool_size \d+|--root_noise_factor \S+|models_serving\/\S+/g,
    ) ?? [];
  console.log(
    `  ${bot.botId}: "${bot.name}" official=${bot.official !== false} ` +
      `color=${bot.appearance?.color ?? "(default)"} variants=[${variants}]`,
  );
  console.log(`      engine: ${knobs.join(" ")}`);
}
