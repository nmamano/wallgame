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
      // `--losing_fallback_eval` MUST precede the bare `--losing_fallback`: alternation takes the
      // first branch that matches at a position, so the short one would swallow the long one's
      // prefix and the threshold would silently vanish from the summary.
      /--samples \d+|--parallel_samples \d+|--thread_pool_size \d+|--root_noise_factor \S+|--losing_fallback_eval \S+|--losing_fallback|models_serving\/\S+/g,
    ) ?? [];
  console.log(
    `  ${bot.botId}: "${bot.name}" official=${bot.official !== false} ` +
      `color=${bot.appearance?.color ?? "(default)"} variants=[${variants}]`,
  );
  console.log(`      engine: ${knobs.join(" ")}`);
  // The naive mix changes how the bot PLAYS without changing a single engine
  // flag, so a preflight that only summarised the command line would report a
  // deliberately weakened bot as identical to a full-strength one.
  if ((bot.naiveMoveRate ?? 0) > 0) {
    console.log(
      `      naive mix: ${Math.round(bot.naiveMoveRate! * 100)}% of moves ` +
        `come from the built-in naive policy, not the engine`,
    );
  }
}
