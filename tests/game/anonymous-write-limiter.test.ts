import { describe, expect, it } from "bun:test";
import {
  createAnonymousWriteLimiter,
  clientIpKey,
} from "../../server/routes/anonymous-write-limiter";

/**
 * The limiter guards an OPEN write (anonymous scripted-puzzle completions,
 * S-G3). Two properties matter: it actually refuses past the cap, and it
 * cannot grow without bound, since an unbounded map keyed by client IP is a
 * memory leak wearing a rate limiter's clothes.
 */

describe("anonymous write limiter", () => {
  it("allows up to the limit and refuses beyond it", () => {
    const limiter = createAnonymousWriteLimiter({
      limit: 3,
      windowMs: 1000,
      maxKeys: 10,
    });

    expect([1, 2, 3].map(() => limiter.tryConsume("ip-a", 0))).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.tryConsume("ip-a", 0)).toBe(false);
  });

  it("keeps separate budgets per key", () => {
    const limiter = createAnonymousWriteLimiter({
      limit: 1,
      windowMs: 1000,
      maxKeys: 10,
    });

    expect(limiter.tryConsume("ip-a", 0)).toBe(true);
    expect(limiter.tryConsume("ip-a", 0)).toBe(false);
    expect(limiter.tryConsume("ip-b", 0)).toBe(true);
  });

  it("forgives once the window has passed", () => {
    const limiter = createAnonymousWriteLimiter({
      limit: 1,
      windowMs: 1000,
      maxKeys: 10,
    });

    expect(limiter.tryConsume("ip-a", 0)).toBe(true);
    expect(limiter.tryConsume("ip-a", 500)).toBe(false);
    expect(limiter.tryConsume("ip-a", 1000)).toBe(true);
  });

  it("stays bounded when flooded with distinct keys", () => {
    const maxKeys = 8;
    const limiter = createAnonymousWriteLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys,
    });

    // All within one window, so nothing can be expired away: eviction has to
    // be what keeps the map bounded.
    for (let i = 0; i < 100; i++) {
      expect(limiter.tryConsume(`ip-${i}`, 0)).toBe(true);
    }
    // The most recent key must still be tracked (its budget was consumed),
    // while an early one has been evicted and is therefore forgiven.
    expect(limiter.tryConsume("ip-99", 0)).toBe(false);
    expect(limiter.tryConsume("ip-0", 0)).toBe(true);
  });
});

describe("client ip key", () => {
  it("uses only the address set by Caddy", () => {
    const headers = new Headers({
      "fly-client-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.9",
    });
    expect(clientIpKey(headers)).toBe("198.51.100.9");
  });

  it("keeps rotated spoof headers in one bucket after Caddy", () => {
    const limiter = createAnonymousWriteLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 10,
    });
    // Local Caddy 2.11.7 observation, 2026-10-05: requests with rotating
    // Fly-Client-IP and X-Forwarded-For values arrived with Fly-Client-IP
    // unchanged, but X-Forwarded-For replaced by the connection address.
    const allowed = [1, 2, 3].map((n) => {
      const upstreamHeaders = new Headers({
        "fly-client-ip": `203.0.113.${n}`,
        "x-forwarded-for": "127.0.0.1",
      });
      return limiter.tryConsume(clientIpKey(upstreamHeaders), 0);
    });
    expect(allowed).toEqual([true, false, false]);
  });

  it("shares one bucket for missing or blank addresses, even with Fly headers", () => {
    const limiter = createAnonymousWriteLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 10,
    });
    const headers = [
      new Headers(),
      new Headers({ "fly-client-ip": "203.0.113.1" }),
      new Headers({ "x-forwarded-for": "" }),
      new Headers({ "x-forwarded-for": "   ", "fly-client-ip": "203.0.113.2" }),
    ];
    expect(headers.map(clientIpKey)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect(headers.map((h) => limiter.tryConsume(clientIpKey(h), 0))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});
