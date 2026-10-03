import { describe, expect, it } from "bun:test";
import { createWsOriginCheck } from "../server/ws-origin";

describe("WebSocket origins", () => {
  const staging = "https://192.0.2.1";

  it("rejects foreign hosts, schemes, ports and paths", () => {
    const check = createWsOriginCheck("production", staging);
    for (const origin of [
      "https://wallgame.io.evil.example",
      "http://192.0.2.1",
      "https://192.0.2.1:8443",
      "https://192.0.2.1/game",
      "https://192.0.2.1/",
      "null",
    ]) {
      expect(check(origin)).toBe(false);
    }
  });

  it("rejects invalid configuration before serving requests", () => {
    for (const value of [
      "*",
      "https://*.example.com",
      "not a URL",
      "https://example.com/",
      "https://example.com/game",
      "https://example.com?x=1",
      "https://example.com#x",
      "https://user:password@example.com",
      "wss://example.com",
      "https://example.com,",
      ",https://example.com",
      "https://example.com,,https://other.example.com",
      "   ",
    ]) {
      expect(() => createWsOriginCheck("production", value)).toThrow(
        "ADDITIONAL_WS_ORIGINS",
      );
    }
  });

  it("accepts configured exact origins and retains production defaults", () => {
    const check = createWsOriginCheck(
      "production",
      `${staging}, https://example.com:8443`,
    );
    for (const origin of [
      staging,
      "https://example.com:8443",
      "https://wallgame.io",
      "https://wallgame.fly.dev",
      undefined,
    ]) {
      expect(check(origin)).toBe(true);
    }
  });

  it("keeps defaults when the setting is unset or empty", () => {
    for (const setting of [undefined, ""]) {
      const production = createWsOriginCheck("production", setting);
      expect(production("https://wallgame.io")).toBe(true);
      expect(production("https://wallgame.fly.dev")).toBe(true);
      expect(production("http://localhost:5173")).toBe(false);
      expect(production(staging)).toBe(false);
      expect(production(undefined)).toBe(true);
      const dev = createWsOriginCheck("development", setting);
      expect(dev("http://localhost:5173")).toBe(true);
      expect(dev("https://wallgame.io")).toBe(false);
      expect(dev(undefined)).toBe(true);
    }
  });
});
