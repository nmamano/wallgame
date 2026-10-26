/** Permanent invite to the Wall Game Discord server. */
export const DISCORD_INVITE_URL = "https://discord.gg/7KYXduSaMS";

/** The site's contact address (Nil, 2026-10-27). */
export const CONTACT_EMAIL = "contact@wallgame.io";

/**
 * The Contact line of /privacy and /terms, as markdown. In a portal frame
 * (lib/embedded-mode.ts) the Discord link becomes text. The address stays a
 * mailto link there (GFM links any address): it opens the mail app and does
 * not take the player to another site.
 */
export const contactMarkdown = (embedded: boolean) =>
  embedded
    ? `Write to us at ${CONTACT_EMAIL}, or on the Wall Game Discord.`
    : `Write to us at [${CONTACT_EMAIL}](mailto:${CONTACT_EMAIL}), or on the [Wall Game Discord](${DISCORD_INVITE_URL}).`;
