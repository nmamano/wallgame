/**
 * /daily/connect: the state check, the token store, and (below) each
 * platform's code exchange and the Meta discovery, against canned replies
 * only. Nothing here calls a platform.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTokenStore } from "./token-store.mjs";
import {
  connectStates,
  ConnectRefused,
  s256,
  STATE_MAX_AGE_MS,
} from "./connect-state.mjs";

const tempDir = () => mkdtempSync(join(tmpdir(), "connect-test-"));

/** What `run` threw; a test fails if it did not throw. */
const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
};

describe("connect state", () => {
  const clock = () => {
    let t = 1_000_000;
    return {
      now: () => t,
      pass: (ms: number) => {
        t += ms;
      },
    };
  };

  test("a state works once, for its platform and its member", () => {
    const states = connectStates();
    const { state, verifier } = states.create("youtube", "m1");
    expect(state).toMatch(/^[\w-]{43}$/);
    expect(verifier).toMatch(/^[\w-]{64}$/);
    expect(states.take(state, "youtube", "m1")).toEqual({ verifier });
    const again = thrown(() => states.take(state, "youtube", "m1"));
    expect(again).toBeInstanceOf(ConnectRefused);
    expect(String(again)).toMatch(/already used/);
  });

  test("an unknown state, another platform or another member is refused", () => {
    const states = connectStates();
    expect(
      String(thrown(() => states.take("made-up", "youtube", "m1"))),
    ).toMatch(/unknown/);
    expect(
      String(thrown(() => states.take(undefined, "youtube", "m1"))),
    ).toMatch(/unknown/);
    const a = states.create("youtube", "m1");
    expect(String(thrown(() => states.take(a.state, "tiktok", "m1")))).toMatch(
      /made for youtube, not tiktok/,
    );
    const b = states.create("youtube", "m1");
    expect(String(thrown(() => states.take(b.state, "youtube", "m2")))).toMatch(
      /another member/,
    );
  });

  test("a state older than 10 minutes is refused", () => {
    const c = clock();
    const states = connectStates({ now: c.now });
    const fresh = states.create("threads", "m1");
    const old = states.create("threads", "m1");
    c.pass(STATE_MAX_AGE_MS);
    expect(states.take(fresh.state, "threads", "m1").verifier).toBe(
      fresh.verifier,
    );
    c.pass(1);
    expect(
      String(thrown(() => states.take(old.state, "threads", "m1"))),
    ).toMatch(/more than 10 minutes old/);
  });

  test("the PKCE challenge is RFC 7636's S256", () => {
    // RFC 7636, Appendix B (rfc-editor.org, read 2026-10-26).
    expect(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("token store", () => {
  const record = {
    connectedAt: "2026-10-26T22:00:00.000Z",
    connectedBy: "Nil",
    scopes: ["video.upload"],
    account: { id: "open-id-1", name: "wallgame.io" },
    accessToken: "SECRET-ACCESS",
    refreshToken: "SECRET-REFRESH",
    refreshExpiresAt: "2027-10-26T22:00:00.000Z",
  };

  test("a token file is mode 0600 in a 0700 directory, also over a stale .part", () => {
    const dir = join(tempDir(), "tokens");
    const store = openTokenStore(dir);
    store.write("tiktok", record);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "tiktok.json")).mode & 0o777).toBe(0o600);

    writeFileSync(join(dir, "youtube.json.part"), "", { mode: 0o644 });
    store.write("youtube", record);
    expect(statSync(join(dir, "youtube.json")).mode & 0o777).toBe(0o600);
    expect(store.read("youtube")).toEqual(record);
  });

  test("status shows no token; update keeps the rest", () => {
    const store = openTokenStore(tempDir());
    expect(store.status("tiktok")).toBeNull();
    expect(store.connected("tiktok")).toBe(false);
    store.write("tiktok", record);
    store.update("tiktok", { refreshToken: "SECRET-NEW" });
    expect(store.read("tiktok")?.refreshToken).toBe("SECRET-NEW");
    expect(store.read("tiktok")?.connectedBy).toBe("Nil");
    const status = store.status("tiktok");
    expect(JSON.stringify(status)).not.toContain("SECRET");
    expect(status).toEqual({
      connectedAt: record.connectedAt,
      connectedBy: "Nil",
      scopes: ["video.upload"],
      account: record.account,
      refreshExpiresAt: record.refreshExpiresAt,
    });
  });

  test("an unreadable file is not connected, and its error quotes nothing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "threads.json"), '{"accessToken": "SECRET-');
    const store = openTokenStore(dir);
    expect(store.connected("threads")).toBe(false);
    expect(JSON.stringify(store.status("threads"))).toMatch(
      /connect threads again/,
    );
    expect(JSON.stringify(store.status("threads"))).not.toContain("SECRET");
    expect(String(thrown(() => store.read("threads")))).not.toContain("SECRET");
  });
});
