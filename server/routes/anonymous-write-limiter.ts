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
 * Fly terminates TLS and sets `Fly-Client-IP` itself, so it is the trusted
 * source here; `x-forwarded-for` is client-settable and only used as a
 * development fallback. An unknown source shares one bucket rather than
 * bypassing the limit.
 */
export const clientIpKey = (headers: Headers): string =>
  headers.get("fly-client-ip") ??
  headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  "unknown";
