/** Permanent invite to the Wall Game Discord server. */
export const DISCORD_INVITE_URL = "https://discord.gg/7KYXduSaMS";

/**
 * The Wall Game social accounts, in the order the home footer shows them (by
 * reach). URLs from Wall Game Growth, 2026-11-01.
 */
export const SOCIAL_ACCOUNTS = [
  { platform: "YouTube", url: "https://www.youtube.com/@wallgameio" },
  { platform: "Instagram", url: "https://www.instagram.com/wallgame.io/" },
  { platform: "TikTok", url: "https://www.tiktok.com/@wallgame.io" },
  { platform: "X", url: "https://x.com/wallgameio" },
  { platform: "Threads", url: "https://www.threads.com/@wallgame.io" },
  { platform: "Bluesky", url: "https://bsky.app/profile/wallgame.io" },
  {
    platform: "Facebook",
    url: "https://www.facebook.com/profile.php?id=61595961929183",
  },
] as const;

export type SocialPlatform = (typeof SOCIAL_ACCOUNTS)[number]["platform"];

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
