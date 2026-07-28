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
  it("prefers the header Fly sets itself", () => {
    const headers = new Headers({
      "fly-client-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.9, 203.0.113.7",
    });
    expect(clientIpKey(headers)).toBe("203.0.113.7");
  });

  it("falls back to the first forwarded address off Fly", () => {
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.9, 203.0.113.7",
    });
    expect(clientIpKey(headers)).toBe("198.51.100.9");
  });

  it("buckets an unidentifiable caller rather than exempting it", () => {
    expect(clientIpKey(new Headers())).toBe("unknown");
  });
});
