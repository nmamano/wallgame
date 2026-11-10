/**
 * /daily/connect: the state check, the token store, and (below) each
 * platform's code exchange and the Meta discovery, against canned replies
 * only. Nothing here calls a platform.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openTokenStore } from "./token-store.mjs";
import { connectPage } from "./connect-page.mjs";
import {
  CONNECT_MEMBER_ID,
  createDaily,
  type PlatformPause,
} from "./routes.mjs";
import { PUBLIC_IDS } from "./public-ids.mjs";
import {
  connectStates,
  ConnectRefused,
  s256,
  STATE_MAX_AGE_MS,
} from "./connect-state.mjs";
import {
  authorizeUrl,
  exchangeCode,
  missingClientSecrets,
  xRequestToken,
} from "./connect.mjs";
import { testTmp } from "../test-tmp";

/** This file's temp dirs, removed after its tests (cb84d862). */
const TEST_TMP = testTmp();

/**
 * Every app this file's tests make, stopped after them: an app left running
 * keeps its schedule's timer, which ticks on a removed dir (cb84d862).
 */
const DAILIES: { stop: () => void }[] = [];
afterAll(() => DAILIES.forEach((d) => d.stop()));
const stopLater = <T extends { stop: () => void }>(daily: T) => {
  DAILIES.push(daily);
  return daily;
};

const tempDir = () => TEST_TMP.dir("connect-test-");

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

  test("a token file from before Connect is not connected, and the page says so", () => {
    const dir = tempDir();
    // The two formats of the removed seed stores, at the same file names.
    writeFileSync(
      join(dir, "tiktok.json"),
      JSON.stringify({
        seedSha256: "abc",
        refreshToken: "SECRET-1",
        savedAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    writeFileSync(
      join(dir, "threads.json"),
      JSON.stringify({
        seedSha256: "abc",
        token: "SECRET-2",
        refreshedAt: "2026-10-01T00:00:00.000Z",
        triedAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    const store = openTokenStore(dir);
    for (const platform of ["tiktok", "threads"]) {
      expect(store.connected(platform)).toBe(false);
      const status = store.status(platform);
      expect(status?.error).toMatch(`connect ${platform} again`);
      expect(JSON.stringify(status)).not.toContain("SECRET");
      const html = connectPage([
        { platform, status, reasons: ["not connected"], canConnect: true },
      ]);
      expect(html).not.toContain("Connected");
      expect(html).not.toContain("Connect again");
      expect(html).toContain("from before Connect");
    }
  });
});

interface Req {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  secretBody?: boolean;
}
interface Reply {
  status: number;
  json?: unknown;
}

/** A live-mode transport that answers from `answer` and keeps every request. */
const fakeLive = (answer: (req: Req) => Reply) => {
  const sent: Req[] = [];
  return {
    mode: "live",
    sent,
    request(req: Req) {
      sent.push(req);
      return Promise.resolve(answer(req));
    },
  };
};

/** What `run` rejected with; a test fails if it did not reject. */
const rejected = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    await run;
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
};

const ENV = {
  YOUTUBE_CLIENT_ID: "yt-client",
  YOUTUBE_CLIENT_SECRET: "SECRET-YT-CLIENT",
  TIKTOK_CLIENT_KEY: "tt-key",
  TIKTOK_CLIENT_SECRET: "SECRET-TT-CLIENT",
  THREADS_APP_ID: "th-app",
  THREADS_APP_SECRET: "SECRET-TH-APP",
};
/** The public ids that the tests' Connect uses; ENV holds the same ones. */
const IDS = {
  ...PUBLIC_IDS,
  YOUTUBE_CLIENT_ID: "yt-client",
  TIKTOK_CLIENT_KEY: "tt-key",
  THREADS_APP_ID: "th-app",
};
const at = () => new Date("2026-10-26T22:00:00Z");
/** A reply body that holds tokens, as an error body could. */
const LEAKY = { error: "invalid_grant", access_token: "SECRET-IN-BODY" };

describe("authorize URLs", () => {
  test("YouTube: offline, consent, youtube.upload and youtube.readonly, state and S256", () => {
    const url = new URL(
      authorizeUrl("youtube", ENV, { state: "S1", verifier: "V".repeat(64) }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "yt-client",
      redirect_uri:
        "https://game-video.office.nilmamano.com/daily/connect/youtube/callback",
      response_type: "code",
      scope:
        "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      access_type: "offline",
      prompt: "consent",
      state: "S1",
      code_challenge: s256("V".repeat(64)),
      code_challenge_method: "S256",
    });
  });

  test("TikTok: video.upload, user.info.basic and user.info.stats, no PKCE on the web", () => {
    const url = new URL(
      authorizeUrl("tiktok", ENV, { state: "S2", verifier: "unused" }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_key: "tt-key",
      scope: "user.info.basic,video.upload,user.info.stats",
      response_type: "code",
      redirect_uri:
        "https://game-video.office.nilmamano.com/daily/connect/tiktok/callback",
      state: "S2",
    });
  });

  test("Threads: threads.com, basic, content_publish and manage_insights", () => {
    const url = new URL(
      authorizeUrl("threads", ENV, { state: "S3", verifier: "unused" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://threads.com/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("th-app");
    expect(url.searchParams.get("scope")).toBe(
      "threads_basic,threads_content_publish,threads_manage_insights",
    );
    expect(url.searchParams.get("state")).toBe("S3");
  });

  test("the client secrets each Connect needs", () => {
    expect(missingClientSecrets("youtube", {})).toEqual([
      "YOUTUBE_CLIENT_SECRET",
    ]);
    expect(missingClientSecrets("tiktok", ENV)).toEqual([]);
    expect(missingClientSecrets("threads", {})).toEqual(["THREADS_APP_SECRET"]);
  });
});

describe("code exchange", () => {
  test("YouTube: the code and verifier go in a secret body; the refresh token is kept", async () => {
    const transport = fakeLive(() => ({
      status: 200,
      json: {
        access_token: "SECRET-AT",
        expires_in: 3599,
        refresh_token: "SECRET-RT",
        scope:
          "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
        token_type: "Bearer",
      },
    }));
    const record = await exchangeCode("youtube", {
      transport,
      env: ENV,
      code: "CODE-1",
      verifier: "VER-1",
      now: at,
    });
    expect(record).toEqual({
      scopes: [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
      ],
      account: { id: null, name: null },
      refreshToken: "SECRET-RT",
      refreshExpiresAt: null,
    });
    // Without the read scope the token still posts: only upload is needed.
    const uploadOnly = await exchangeCode("youtube", {
      transport: fakeLive(() => ({
        status: 200,
        json: {
          refresh_token: "SECRET-RT",
          scope: "https://www.googleapis.com/auth/youtube.upload",
        },
      })),
      env: ENV,
      code: "CODE-1",
      verifier: "VER-1",
      now: at,
    });
    expect(uploadOnly.scopes).toEqual([
      "https://www.googleapis.com/auth/youtube.upload",
    ]);
    const [req] = transport.sent;
    expect(req.url).toBe("https://oauth2.googleapis.com/token");
    expect(req.secretBody).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({
      client_id: "yt-client",
      client_secret: "SECRET-YT-CLIENT",
      code: "CODE-1",
      code_verifier: "VER-1",
      grant_type: "authorization_code",
      redirect_uri:
        "https://game-video.office.nilmamano.com/daily/connect/youtube/callback",
    });
  });

  test("YouTube: no upload scope, no refresh token, or an error reply is refused without its body", async () => {
    const run = (reply: Reply) =>
      rejected(
        exchangeCode("youtube", {
          transport: fakeLive(() => reply),
          env: ENV,
          code: "c",
          verifier: "v",
        }),
      );
    expect(
      String(
        await run({
          status: 200,
          json: { refresh_token: "SECRET-RT", scope: "openid" },
        }),
      ),
    ).toMatch(/upload access was not granted/);
    expect(
      String(
        await run({
          status: 200,
          json: { scope: "https://www.googleapis.com/auth/youtube.upload" },
        }),
      ),
    ).toMatch(/no refresh token/);
    const err = await run({ status: 400, json: LEAKY });
    expect(err).toBeInstanceOf(ConnectRefused);
    expect(String(err)).toBe(
      "ConnectRefused: youtube token exchange failed: HTTP 400 invalid_grant",
    );
  });

  test("TikTok: open_id, display name and the refresh token are kept; no video.upload is refused", async () => {
    const transport = fakeLive((req) =>
      req.url.startsWith("https://open.tiktokapis.com/v2/user/info/")
        ? {
            status: 200,
            json: {
              data: { user: { open_id: "OID", display_name: "wallgame.io" } },
            },
          }
        : {
            status: 200,
            json: {
              access_token: "SECRET-AT",
              expires_in: 86400,
              open_id: "OID",
              refresh_token: "SECRET-RT",
              refresh_expires_in: 31536000,
              scope: "user.info.basic,video.upload,user.info.stats",
              token_type: "Bearer",
            },
          },
    );
    const record = await exchangeCode("tiktok", {
      transport,
      env: ENV,
      code: "CODE-2",
      verifier: "unused",
      now: at,
    });
    expect(record).toEqual({
      scopes: ["user.info.basic", "video.upload", "user.info.stats"],
      account: { id: "OID", name: "wallgame.io" },
      refreshToken: "SECRET-RT",
      refreshExpiresAt: "2027-10-26T22:00:00.000Z",
    });
    expect(transport.sent[0].secretBody).toBe(true);
    expect(transport.sent[1].headers?.authorization).toBe("Bearer SECRET-AT");

    // Without the stats scope the token still posts: only upload is needed.
    const noStats = await exchangeCode("tiktok", {
      transport: fakeLive(() => ({
        status: 200,
        json: {
          open_id: "OID",
          refresh_token: "SECRET-RT",
          scope: "user.info.basic,video.upload",
        },
      })),
      env: ENV,
      code: "c",
      verifier: "",
      now: at,
    });
    expect(noStats.scopes).toEqual(["user.info.basic", "video.upload"]);

    const narrow = fakeLive(() => ({
      status: 200,
      json: {
        open_id: "OID",
        refresh_token: "SECRET-RT",
        scope: "user.info.basic",
      },
    }));
    expect(
      String(
        await rejected(
          exchangeCode("tiktok", {
            transport: narrow,
            env: ENV,
            code: "c",
            verifier: "",
          }),
        ),
      ),
    ).toMatch(/video.upload was not granted/);
  });

  test("Threads: code, long-lived exchange, then the id and handle from /me", async () => {
    const transport = fakeLive((req) => {
      if (req.url === "https://graph.threads.com/oauth/access_token") {
        // user_id over 2^53: JSON.parse would round it, so it is not used.
        return {
          status: 200,
          json: { access_token: "SECRET-SHORT", user_id: 17841405793187218 },
        };
      }
      if (req.url.startsWith("https://graph.threads.com/access_token?")) {
        return {
          status: 200,
          json: {
            access_token: "SECRET-LONG",
            token_type: "bearer",
            expires_in: 5184000,
          },
        };
      }
      return {
        status: 200,
        json: { id: "17841405793187218", username: "wallgameio" },
      };
    });
    const record = await exchangeCode("threads", {
      transport,
      env: ENV,
      code: "CODE-3",
      verifier: "unused",
      now: at,
    });
    expect(record).toEqual({
      scopes: [
        "threads_basic",
        "threads_content_publish",
        "threads_manage_insights",
      ],
      account: { id: "17841405793187218", name: "wallgameio" },
      accessToken: "SECRET-LONG",
      accessExpiresAt: "2026-12-25T22:00:00.000Z",
      refreshedAt: "2026-10-26T22:00:00.000Z",
      triedAt: "2026-10-26T22:00:00.000Z",
    });
    const [code, long, me] = transport.sent;
    expect(code.secretBody).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(code.body))).toMatchObject({
      client_id: "th-app",
      code: "CODE-3",
      grant_type: "authorization_code",
    });
    expect(Object.fromEntries(new URL(long.url).searchParams)).toEqual({
      grant_type: "th_exchange_token",
      client_secret: "SECRET-TH-APP",
      access_token: "SECRET-SHORT",
    });
    expect(me.url).toBe("https://graph.threads.com/v1.0/me?fields=id,username");
    expect(me.headers?.authorization).toBe("Bearer SECRET-LONG");
  });

  test("Threads: a failed step is refused without its body", async () => {
    const err = await rejected(
      exchangeCode("threads", {
        transport: fakeLive(() => ({
          status: 400,
          json: {
            error_type: "OAuthException",
            error_message: "SECRET-IN-MESSAGE",
          },
        })),
        env: ENV,
        code: "c",
        verifier: "",
      }),
    );
    expect(String(err)).toBe(
      "ConnectRefused: threads code exchange failed: HTTP 400 OAuthException",
    );
  });
});

describe("X Connect (OAuth 1.0a 3-legged)", () => {
  const X_ENV = { X_API_KEY: "x-key", X_API_SECRET: "SECRET-X-KEY" };
  /** The signed oauth_* fields of an Authorization header. */
  const oauthFields = (header: string | undefined) =>
    Object.fromEntries(
      [...String(header).matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [
        k,
        decodeURIComponent(v),
      ]),
    );

  test("the request token step signs oauth_callback with the key pair only, and needs the callback confirmed", async () => {
    const transport = fakeLive(() => ({
      status: 200,
      text: "oauth_token=RT&oauth_token_secret=SECRET-RTS&oauth_callback_confirmed=true",
    }));
    expect(await xRequestToken({ transport, env: X_ENV })).toEqual({
      token: "RT",
      secret: "SECRET-RTS",
    });
    const [req] = transport.sent;
    expect(req).toMatchObject({
      method: "POST",
      url: "https://api.x.com/oauth/request_token",
    });
    const f = oauthFields(req.headers?.authorization);
    expect(f.oauth_callback).toBe(
      "https://game-video.office.nilmamano.com/daily/connect/x/callback",
    );
    expect(f.oauth_consumer_key).toBe("x-key");
    expect(f).not.toHaveProperty("oauth_token");

    const unconfirmed = fakeLive(() => ({
      status: 200,
      text: "oauth_token=RT&oauth_token_secret=S&oauth_callback_confirmed=false",
    }));
    expect(
      String(
        await rejected(xRequestToken({ transport: unconfirmed, env: X_ENV })),
      ),
    ).toContain("did not confirm the callback URL");
    const refusedReply = fakeLive(() => ({
      status: 401,
      json: { errors: [{ code: 32 }] },
      text: "SECRET-IN-BODY",
    }));
    expect(
      String(
        await rejected(xRequestToken({ transport: refusedReply, env: X_ENV })),
      ),
    ).toBe("ConnectRefused: x request token failed: HTTP 401");
  });

  test("authorize goes to api.x.com with the request token and force_login", () => {
    const url = new URL(
      authorizeUrl("x", X_ENV, { state: "RT", verifier: "SECRET-RTS" }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.x.com/oauth/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      oauth_token: "RT",
      force_login: "true",
    });
  });

  test("the exchange signs oauth_verifier with the request token, and stores the token pair and the @handle", async () => {
    const transport = fakeLive(() => ({
      status: 200,
      text: "oauth_token=123-SECRET-AT&oauth_token_secret=SECRET-ATS&user_id=123&screen_name=wallgameio",
    }));
    const record = await exchangeCode("x", {
      transport,
      env: X_ENV,
      code: "VERIFIER",
      verifier: "SECRET-RTS",
      state: "RT",
      now: at,
    });
    expect(record).toEqual({
      scopes: [],
      account: { id: "123", name: "@wallgameio" },
      accessToken: "123-SECRET-AT",
      accessTokenSecret: "SECRET-ATS",
    });
    const [req] = transport.sent;
    expect(req.url).toBe("https://api.x.com/oauth/access_token");
    const f = oauthFields(req.headers?.authorization);
    expect(f.oauth_token).toBe("RT");
    expect(f.oauth_verifier).toBe("VERIFIER");

    const odd = fakeLive(() => ({
      status: 200,
      text: "oauth_token=T&oauth_token_secret=S&user_id=12x&screen_name=<b>",
    }));
    expect(
      (
        await exchangeCode("x", {
          transport: odd,
          env: X_ENV,
          code: "V",
          verifier: "S",
          state: "RT",
        })
      ).account,
    ).toEqual({ id: null, name: null });
  });
});

describe("/daily/connect through the app", () => {
  /** A server for `daily`, and every response it gave, headers included. */
  const serve = async (daily: {
    handle: (...a: never[]) => Promise<boolean>;
  }) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void (
        daily.handle as (a: unknown, b: unknown, c: URL) => Promise<boolean>
      )(req, res, url).then((done) => {
        if (!done) res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const seen: string[] = [];
    const call = async (
      path: string,
      { method = "GET", member }: { method?: string; member?: string } = {},
    ) => {
      const res = await fetch(`${base}${path}`, {
        method,
        redirect: "manual",
        headers: member
          ? {
              "x-isomux-member-id": member,
              "x-isomux-member-name": encodeURIComponent(`${member} Name`),
            }
          : {},
      });
      const text = await res.text();
      seen.push(JSON.stringify([...res.headers]), text);
      return {
        status: res.status,
        location: res.headers.get("location"),
        text,
      };
    };
    return { call, seen, close: () => server.close() };
  };

  const NIL = CONNECT_MEMBER_ID;

  const googleReply = {
    status: 200,
    json: {
      access_token: "SECRET-AT",
      expires_in: 3599,
      refresh_token: "SECRET-RT",
      scope:
        "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      token_type: "Bearer",
    },
  };

  test("connect X: request token, authorize as the right account, token pair stored 0600, @handle shown, no secret in any response", async () => {
    const dir = tempDir();
    const env = { ...ENV, X_API_KEY: "x-key", X_API_SECRET: "SECRET-X-KEY" };
    const transport = fakeLive((req) =>
      req.url.endsWith("/oauth/request_token")
        ? {
            status: 200,
            text: "oauth_token=RT1&oauth_token_secret=SECRET-RTS&oauth_callback_confirmed=true",
          }
        : {
            status: 200,
            text: "oauth_token=123-SECRET-AT&oauth_token_secret=SECRET-ATS&user_id=123&screen_name=wallgameio",
          },
    );
    const daily = stopLater(
      createDaily({
        dataDir: dir,
        env,
        ids: IDS,
        live: () => transport,
      }),
    );
    const app = await serve(daily);
    try {
      const start = await app.call("/daily/connect/x/start", {
        method: "POST",
        member: NIL,
      });
      expect(start.status).toBe(303);
      expect(start.location).toBe(
        "https://api.x.com/oauth/authorize?oauth_token=RT1&force_login=true",
      );
      // A callback with a token nobody here asked for is refused.
      const stray = await app.call(
        "/daily/connect/x/callback?oauth_token=OTHER&oauth_verifier=V",
        { member: NIL },
      );
      expect(stray.status).toBe(400);
      const done = await app.call(
        "/daily/connect/x/callback?oauth_token=RT1&oauth_verifier=V1",
        { member: NIL },
      );
      expect(done.status).toBe(303);
      expect(done.location).toBe("/daily/connect?connected=x");
      const file = join(dir, "daily", "tokens", "x.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        accessToken: "123-SECRET-AT",
        accessTokenSecret: "SECRET-ATS",
        account: { id: "123", name: "@wallgameio" },
      });
      const page = await app.call("/daily/connect?connected=x");
      expect(page.text).toContain("X is connected.");
      expect(page.text).toContain("Account: @wallgameio");
      const modes = (
        JSON.parse((await app.call("/api/daily/state")).text) as {
          modes: Record<string, string>;
        }
      ).modes;
      expect(modes.x).toBe("live");
      // The same request token again: refused.
      expect(
        (
          await app.call(
            "/daily/connect/x/callback?oauth_token=RT1&oauth_verifier=V1",
            { member: NIL },
          )
        ).text,
      ).toContain("already used");

      // Cancel on X: `denied` carries the request token; nothing connects.
      const again = await app.call("/daily/connect/x/start", {
        method: "POST",
        member: NIL,
      });
      expect(again.status).toBe(303);
      const denied = await app.call("/daily/connect/x/callback?denied=RT1", {
        member: NIL,
      });
      expect(denied.status).toBe(400);
      expect(denied.text).toContain("cancelled");

      for (const text of app.seen) {
        for (const secret of [
          "SECRET-X-KEY",
          "SECRET-RTS",
          "123-SECRET-AT",
          "SECRET-ATS",
        ]) {
          expect(text).not.toContain(secret);
        }
      }
    } finally {
      app.close();
    }
  });

  test("connect YouTube: state checked, tokens stored 0600, and no token in any response or log", async () => {
    const dir = tempDir();
    let answer: (req: Req) => Reply = () => googleReply;
    const logged: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((k) =>
      spyOn(console, k).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      }),
    );
    const daily = stopLater(
      createDaily({
        dataDir: dir,
        env: ENV,
        ids: IDS,
        live: () => fakeLive((req) => answer(req)),
      }),
    );
    const app = await serve(daily);
    try {
      const page = await app.call("/daily/connect");
      expect(page.status).toBe(200);
      expect(page.text.match(/Not connected/g)).toHaveLength(4);

      // No office member: refused.
      expect(
        (await app.call("/daily/connect/youtube/start", { method: "POST" }))
          .status,
      ).toBe(403);

      const start = async (member = NIL) => {
        const r = await app.call("/daily/connect/youtube/start", {
          method: "POST",
          member,
        });
        expect(r.status).toBe(303);
        return new URL(r.location!).searchParams.get("state")!;
      };
      const state = await start();
      const done = await app.call(
        `/daily/connect/youtube/callback?state=${state}&code=CODE-1&scope=x`,
        { member: NIL },
      );
      expect(done.status).toBe(303);
      expect(done.location).toBe("/daily/connect?connected=youtube");

      const file = join(dir, "daily", "tokens", "youtube.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        refreshToken: "SECRET-RT",
        connectedBy: `${NIL} Name`,
      });

      const after = await app.call("/daily/connect?connected=youtube");
      expect(after.text).toContain("YouTube is connected.");
      expect(after.text).toMatch(
        new RegExp(
          `Connected at 20\\d\\d-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC by ${NIL} Name`,
        ),
      );
      expect(after.text).toContain("youtube.upload");
      // The app now posts to YouTube for real; its state shows no token.
      const state1 = await app.call("/api/daily/state");
      const modes = (
        JSON.parse(state1.text) as { modes: Record<string, string> }
      ).modes;
      expect(modes.youtube).toBe("live");

      // The same state again: refused.
      const replay = await app.call(
        `/daily/connect/youtube/callback?state=${state}&code=CODE-1`,
        { member: NIL },
      );
      expect(replay.status).toBe(400);
      expect(replay.text).toContain("already used");

      // Another member may not start or finish a Connect, and a refused
      // callback does not use up Nil's state.
      const notNil = await app.call("/daily/connect/youtube/start", {
        method: "POST",
        member: "m-other",
      });
      expect(notNil.status).toBe(403);
      expect(notNil.text).toContain("only Nil can connect accounts");
      const nilState = await start();
      const stolen = await app.call(
        `/daily/connect/youtube/callback?state=${nilState}&code=c`,
        { member: "m-other" },
      );
      expect(stolen.status).toBe(403);
      expect(stolen.text).toContain("only Nil can connect accounts");
      expect(
        (
          await app.call(
            `/daily/connect/youtube/callback?state=${nilState}&code=CODE-2`,
            { member: NIL },
          )
        ).status,
      ).toBe(303);

      // An unknown state, a platform error.
      expect(
        (
          await app.call(
            "/daily/connect/youtube/callback?state=made-up&code=c",
            {
              member: NIL,
            },
          )
        ).text,
      ).toContain("unknown");
      const denied = await start();
      const deniedPage = await app.call(
        `/daily/connect/youtube/callback?state=${denied}&error=access_denied`,
        { member: NIL },
      );
      expect(deniedPage.status).toBe(400);
      expect(deniedPage.text).toContain("youtube answered access_denied");

      // A refused exchange and a lost connection show no reply body and
      // no request; the stored connection stays.
      answer = () => ({
        status: 400,
        json: { error: "invalid_grant", leak: "SECRET-X" },
      });
      const bad = await start();
      expect(
        (
          await app.call(
            `/daily/connect/youtube/callback?state=${bad}&code=c`,
            {
              member: NIL,
            },
          )
        ).text,
      ).toContain("youtube token exchange failed: HTTP 400 invalid_grant");
      answer = () => {
        throw new Error(
          "connect to https://x/?client_secret=SECRET-YT-CLIENT failed",
        );
      };
      const lost = await start();
      expect(
        (
          await app.call(
            `/daily/connect/youtube/callback?state=${lost}&code=c`,
            {
              member: NIL,
            },
          )
        ).text,
      ).toContain("did not finish (Error); click Connect again");
      expect(
        (JSON.parse(readFileSync(file, "utf8")) as { refreshToken: string })
          .refreshToken,
      ).toBe("SECRET-RT");

      for (const text of [...app.seen, ...logged]) {
        // Every fake value starts "SECRET-"; secret NAMES (such as
        // R2_SECRET_ACCESS_KEY) may show in a dry-run reason.
        expect(text).not.toContain("SECRET-");
      }
    } finally {
      app.close();
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("a platform without its client secrets has no Connect button, and start is refused", async () => {
    const daily = stopLater(
      createDaily({
        dataDir: tempDir(),
        env: {},
        ids: IDS,
        live: () => fakeLive(() => ({ status: 500 })),
      }),
    );
    const app = await serve(daily);
    try {
      const page = await app.call("/daily/connect");
      expect(page.text).toContain(
        "Posts are dry runs: secrets missing: YOUTUBE_CLIENT_SECRET; not connected.",
      );
      expect(page.text).not.toContain('action="/daily/connect/youtube/start"');
      const start = await app.call("/daily/connect/youtube/start", {
        method: "POST",
        member: NIL,
      });
      expect(start.status).toBe(409);
      expect(start.text).toContain("needs the secrets YOUTUBE_CLIENT_SECRET");
    } finally {
      app.close();
    }
  });

  test("a null id keeps the platform dry-run with a plain reason; an env var of its name has no effect", async () => {
    const daily = stopLater(
      createDaily({
        dataDir: tempDir(),
        // The secret is set, and so is an env var with the id's name.
        env: {
          YOUTUBE_CLIENT_ID: "from-env",
          YOUTUBE_CLIENT_SECRET: "SECRET-YT",
          BLUESKY_APP_PASSWORD: "SECRET-BSKY",
          R2_ACCESS_KEY_ID: "SECRET-R2-ID",
        },
        ids: { ...PUBLIC_IDS, YOUTUBE_CLIENT_ID: null },
        live: () => fakeLive(() => ({ status: 500 })),
      }),
    );
    const app = await serve(daily);
    try {
      const page = await app.call("/daily/connect");
      expect(page.text).toContain(
        "Posts are dry runs: YouTube client id not set in code; not connected.",
      );
      expect(page.text).not.toContain('action="/daily/connect/youtube/start"');
      const start = await app.call("/daily/connect/youtube/start", {
        method: "POST",
        member: CONNECT_MEMBER_ID,
      });
      expect(start.status).toBe(409);
      expect(start.text).toContain("YouTube client id not set in code");
      const stateText = (await app.call("/api/daily/state")).text;
      const { modes, modeReasons } = JSON.parse(stateText) as {
        modes: Record<string, string>;
        modeReasons: Record<string, string[]>;
      };
      expect(modes.youtube).toBe("dry-run");
      // The same reasons as the page, for each dry-run platform only.
      expect(modeReasons.youtube).toEqual([
        "YouTube client id not set in code",
        "not connected",
      ]);
      expect(modeReasons.threads).toEqual([
        "secrets missing: THREADS_APP_SECRET",
        "R2 secrets missing: R2_SECRET_ACCESS_KEY",
        "not connected",
      ]);
      expect(modes.bluesky).toBe("live");
      expect(modeReasons).not.toHaveProperty("bluesky");
      expect(page.text).toContain(
        "Posts are dry runs: secrets missing: THREADS_APP_SECRET; R2 secrets missing: R2_SECRET_ACCESS_KEY; not connected.",
      );
      // Names only: no value of a set secret, not even a part of one.
      for (const text of [stateText, page.text]) {
        expect(text).not.toContain("SECRET-");
      }
    } finally {
      app.close();
    }
  });

  test("the ids in code: the Bluesky DID and the YouTube, TikTok, Threads and R2 ids", () => {
    expect(PUBLIC_IDS).toEqual({
      BLUESKY_IDENTIFIER: "did:plc:7hk4ouyq7rfod3qatg2pbjln",
      YOUTUBE_CLIENT_ID:
        "487593560695-qdu8rjjistmaq4iouds76ffsiameggu0.apps.googleusercontent.com",
      TIKTOK_CLIENT_KEY: "sbawgnt7vpik5zdozp",
      THREADS_APP_ID: "2049959042384724",
      R2_ACCOUNT_ID: "1f1a89fa2a45aeb655275b923202a800",
    });
  });
});

describe("/daily/connect shows what the Meta token finds", () => {
  const metaReplies =
    (pages: unknown[]) =>
    (req: Req): Reply => {
      if (req.url.includes("/me/accounts")) {
        return { status: 200, json: { data: pages } };
      }
      if (req.url.endsWith("?fields=instagram_business_account")) {
        return {
          status: 200,
          json: { instagram_business_account: { id: "IG1" } },
        };
      }
      return { status: 200, json: { username: "wallgameio" } };
    };
  const page = (name: string) => ({
    id: `P-${name}`,
    name,
    access_token: "SECRET-PAGE-TOKEN",
  });
  const show = async (
    env: Record<string, string>,
    pages: unknown[],
    pauses: PlatformPause[] = [],
  ) => {
    const transport = fakeLive(metaReplies(pages));
    const daily = stopLater(
      createDaily({
        dataDir: tempDir(),
        env,
        pauses,
        live: () => transport,
      }),
    );
    const server: Server = createServer((req, res) => {
      void daily.handle(req, res, new URL(req.url ?? "/", "http://localhost"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const text = await (
        await fetch(`http://127.0.0.1:${port}/daily/connect`)
      ).text();
      const state = (await (
        await fetch(`http://127.0.0.1:${port}/api/daily/state`)
      ).json()) as {
        modes: Record<string, string>;
        modeReasons: Record<string, string[]>;
      };
      return {
        text,
        state,
        live: daily.livePlatforms(),
        sent: transport.sent,
      };
    } finally {
      daily.stop();
      server.close();
    }
  };
  const TOKEN = { META_SYSTEM_USER_TOKEN: "SECRET-SU" };

  test("one Page with Instagram: its name and handle, and no token", async () => {
    const { text, sent } = await show(TOKEN, [page("Wall Game")]);
    expect(text).toContain("Meta: Page Wall Game, Instagram @wallgameio");
    expect(text).not.toContain("SECRET-");
    expect(sent.map((r) => r.headers?.authorization)).toEqual([
      "Bearer SECRET-SU",
      "Bearer SECRET-SU",
      "Bearer SECRET-SU",
    ]);
  });

  test("two Pages, or no secret: the reason, and no call without the secret", async () => {
    const two = await show(TOKEN, [page("Wall Game"), page("Other")]);
    expect(two.text).toContain("sees 2 Facebook Pages");
    expect(two.text).not.toContain("SECRET-");
    const none = await show({}, [page("Wall Game")]);
    expect(none.text).toContain(
      "Posts are dry runs: secrets missing: META_SYSTEM_USER_TOKEN",
    );
    expect(none.sent).toHaveLength(0);
  });

  test("a Facebook pause makes Facebook dry-run, with its reason, and leaves the Meta account and Instagram alone", async () => {
    const r2 = {
      R2_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
    };
    const now = Date.now();
    const paused = await show(
      { ...TOKEN, ...r2 },
      [page("Wall Game")],
      [
        {
          platform: "facebook",
          from: new Date(now - 60_000).toISOString(),
          until: "2099-01-01T00:00:00Z",
          why: "Facebook test",
        },
      ],
    );
    // The slot, a retry and the post read livePlatforms: no Facebook.
    expect(paused.live).toContain("instagram");
    expect(paused.live).toContain("instagram-story");
    expect(paused.live).not.toContain("facebook");
    expect(paused.state.modes.facebook).toBe("dry-run");
    expect(paused.state.modeReasons.facebook).toEqual([
      "paused until 2099-01-01T00:00:00Z: Facebook test",
    ]);
    expect(paused.state.modeReasons).not.toHaveProperty("instagram");
    // The Meta account is still read and shown as found.
    expect(paused.text).toContain(
      "Meta: Page Wall Game, Instagram @wallgameio",
    );
    // A pause that has ended has no effect.
    const ended = await show(
      { ...TOKEN, ...r2 },
      [page("Wall Game")],
      [
        {
          platform: "facebook",
          from: "2026-01-01T00:00:00Z",
          until: new Date(now - 60_000).toISOString(),
          why: "Facebook test",
        },
      ],
    );
    expect(ended.live).toContain("facebook");
    expect(ended.state.modeReasons).not.toHaveProperty("facebook");
  });
});
