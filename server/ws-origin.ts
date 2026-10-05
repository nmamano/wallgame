/**
 * ADDITIONAL_WS_ORIGINS is a comma-separated list of exact HTTP(S) origins.
 * Validate it at startup; paths, credentials and wildcards are not origins.
 */
export function createWsOriginCheck(
  nodeEnv: string | undefined,
  additionalOrigins?: string,
): (origin: string | undefined) => boolean {
  const allowedOrigins =
    nodeEnv !== "production"
      ? ["http://localhost:5173"]
      : ["https://wallgame.io"];
  if (additionalOrigins) {
    for (const entry of additionalOrigins.split(",")) {
      const origin = entry.trim();
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new Error(
          "ADDITIONAL_WS_ORIGINS must contain exact HTTP(S) origins",
        );
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin !== origin ||
        origin.includes("*")
      ) {
        throw new Error(
          "ADDITIONAL_WS_ORIGINS must contain exact HTTP(S) origins",
        );
      }
      allowedOrigins.push(origin);
    }
  }
  return (origin) => !origin || allowedOrigins.includes(origin);
}
