/**
 * A small bounded rate limiter for unauthenticated HTTP writes.
 *
 * The chat limiter is keyed and lifecycle-managed for WebSocket connections,
 * so it cannot be reused here: an HTTP map keyed by client IP with no expiry
 * would grow without bound. This one expires entries lazily and also caps the
 * map size, so a flood of distinct IPs cannot exhaust memory — when the cap is
 * reached the oldest entries are dropped, which at worst forgives some
 * requests. That is the right failure direction for telemetry.
 */

export interface AnonymousWriteLimiterOptions {
  /** Requests allowed per key within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum number of tracked keys. */
  maxKeys: number;
}

export interface AnonymousWriteLimiter {
  /** True when the request is allowed; false when it must be refused (429). */
  tryConsume: (key: string, now?: number) => boolean;
}

export const createAnonymousWriteLimiter = ({
  limit,
  windowMs,
  maxKeys,
}: AnonymousWriteLimiterOptions): AnonymousWriteLimiter => {
  // Insertion-ordered, which is what makes the oldest-first eviction below
  // cheap: Map iteration yields keys in insertion order.
  const hits = new Map<string, { count: number; windowStart: number }>();

  const evictExpired = (now: number) => {
    for (const [key, entry] of hits) {
      if (now - entry.windowStart >= windowMs) {
        hits.delete(key);
      }
    }
  };

  return {
    tryConsume: (key, now = Date.now()) => {
      const entry = hits.get(key);
      if (entry && now - entry.windowStart < windowMs) {
        if (entry.count >= limit) {
          return false;
        }
        entry.count += 1;
        return true;
      }

      if (hits.size >= maxKeys) {
        evictExpired(now);
        // Still full of live windows: drop the oldest to stay bounded.
        while (hits.size >= maxKeys) {
          const oldest = hits.keys().next();
          if (oldest.done) break;
          hits.delete(oldest.value);
        }
      }

      hits.set(key, { count: 1, windowStart: now });
      return true;
    },
  };
};

/**
 * Caddy replaces X-Forwarded-For with the connection address. The app must
 * remain reachable only through Caddy, with no trusted upstream proxies.
 * A client can still send Fly-Client-IP (set by the former Fly host). Caddy
 * passes it through unchanged, so it must never select a bucket.
 * Missing or blank addresses share one bucket rather than bypassing the limit.
 */
export const clientIpKey = (headers: Headers): string => {
  const address = headers.get("x-forwarded-for")?.trim() ?? "";
  return address.length > 0 ? address : "unknown";
};

/**
 * The client's network rather than its exact address: an IPv4 address as is,
 * an IPv6 address as its /64 prefix. One IPv6 host normally holds a whole /64,
 * so a limit keyed by the full address would stop nobody. Built on clientIpKey,
 * so it trusts the same header. A value that is not an IPv6 address passes
 * through unchanged.
 */
export const clientNetworkKey = (headers: Headers): string => {
  const address = clientIpKey(headers);
  if (!address.includes(":")) return address;
  const withoutZone = address.split("%")[0].toLowerCase();
  // An IPv4-mapped address (::ffff:192.0.2.1) is the IPv4 client.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(withoutZone);
  if (mapped) return mapped[1];
  const halves = withoutZone.split("::");
  if (halves.length > 2) return address;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail =
    halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return address;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return address;
  const prefix = groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":");
  return `${prefix}::/64`;
};
