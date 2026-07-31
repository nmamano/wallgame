/**
 * The bot-client CONFIG FILE schema.
 *
 * Extracted from index.ts so that tooling can validate a config file without
 * importing the CLI entry point (which would start the client). There must be
 * exactly ONE definition of this shape: a validator with its own copy would
 * drift from what the client actually accepts and would then certify configs
 * the client rejects — or worse, pass ones it silently mishandles.
 *
 * Note what the schema does NOT enforce, and what
 * `assertEngineCommandsCoverBots` exists for: a bot with no entry in
 * `engineCommands` parses cleanly and then falls back to the built-in dummy
 * implementation at runtime while still attaching and advertising itself. That
 * is a silent downgrade, so command coverage is checked separately and
 * fail-closed before any rollout.
 */

import { z } from "zod";
import { botConfigBaseSchema } from "../../shared/contracts/custom-bot-config-schema";

/**
 * A bot as written in a config file: the full runtime bot shape minus the
 * official token (the client supplies that from its own flag), plus two
 * CLIENT-ONLY fields. `official: false` makes the client WITHHOLD the token
 * for that bot, and the server then derives isOfficial from the token match.
 *
 * `naiveMoveRate` is the per-move probability (0-1) that the bot plays the
 * built-in naive walk-toward-the-goal move instead of its engine's move — the
 * knob that makes Easy Bot beatable without a weaker model or a rebuild. It is
 * deliberately a plain number with no default: absent means 0, i.e. today's
 * behaviour. Retuning it is a config edit plus a client restart.
 *
 * Neither field is part of the wire protocol. index.ts strips both before the
 * attach message is built, so the server sees exactly the bot shape it always
 * has and a change here never needs a server deploy to land first.
 */
export const configBotSchema = botConfigBaseSchema
  .omit({ officialToken: true })
  .extend({
    official: z.boolean().optional(),
    naiveMoveRate: z.number().min(0).max(1).optional(),
  })
  .strict();

export const configFileSchema = z
  .object({
    server: z.string().optional(),
    bots: z.array(configBotSchema).min(1),
    engineCommands: z.record(z.string(), z.string().trim().min(1)),
  })
  .strict();

/**
 * DERIVED from the schemas, never hand-written: one definition covers both the
 * runtime parse and the TypeScript shape, so they cannot drift apart.
 */
export type ConfigBot = z.infer<typeof configBotSchema>;
export type ConfigFile = z.infer<typeof configFileSchema>;

/**
 * Every bot must have an engine command and every command must belong to a
 * bot — an EXACT set match, not containment in one direction.
 *
 * A missing command silently downgrades that bot to the dummy engine; a
 * stray command is a typo'd bot id, which presents as the same downgrade for
 * the bot that was meant to have it.
 */
export const assertEngineCommandsCoverBots = (config: ConfigFile): void => {
  const botIds = config.bots.map((bot) => bot.botId);
  const duplicateBotIds = botIds.filter((id, i) => botIds.indexOf(id) !== i);
  if (duplicateBotIds.length > 0) {
    throw new Error(`duplicate botId(s): ${duplicateBotIds.join(", ")}`);
  }
  const commandIds = Object.keys(config.engineCommands);
  const missing = botIds.filter((id) => !commandIds.includes(id));
  const stray = commandIds.filter((id) => !botIds.includes(id));
  if (missing.length > 0 || stray.length > 0) {
    throw new Error(
      `engineCommands must match bots exactly — ` +
        `bots without a command: [${missing.join(", ")}]; ` +
        `commands without a bot: [${stray.join(", ")}]`,
    );
  }
};
