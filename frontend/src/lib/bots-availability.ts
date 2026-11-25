import type { OfficialBotsStatus } from "../../../shared/contracts/custom-bot-protocol";

/**
 * What every bot-pick surface says while the site's own bots are away - a
 * reboot or network loss of the bot host (task 9158770c). Nil's words.
 */
export const BOTS_DOWN_MESSAGE =
  "The bots are down for maintenance. They will be back soon.";

/** How often a bot list asks again while the official bots are away. */
export const BOTS_AWAY_REFETCH_MS = 30_000;

/**
 * `refetchInterval` for a bot-list query: ask again every 30 s while the
 * server says the official bots are away, so the message goes away by itself
 * when they come back; no polling while they are online.
 */
export const refetchWhileBotsAway = (query: {
  state: { data?: { officialBots: OfficialBotsStatus } };
}): number | false =>
  query.state.data?.officialBots === "away" ? BOTS_AWAY_REFETCH_MS : false;
