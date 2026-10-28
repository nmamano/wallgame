/**
 * The follower counts (followers.mjs) and GET /api/daily/followers: each
 * platform's read, "needs reconnect" for a token without the read scope,
 * safe reasons, and the one-hour cache.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOLLOWER_PLATFORMS,
  NEEDS_RECONNECT,
  readFollowers,
} from "./followers.mjs";
import { META_ACCOUNTS_URL } from "./meta.mjs";
import { openTokenStore } from "./token-store.mjs";
import { createDaily } from "./routes.mjs";
import { TIKTOK_TOKEN_URL } from "./post-tiktok.mjs";
import { GOOGLE_TOKEN_URL } from "./post-youtube.mjs";

interface Req {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}
interface Reply {
  status: number;
  json?: unknown;
  text?: string;
}

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

const tempDir = () => mkdtempSync(join(tmpdir(), "followers-test-"));

const ENV = {
  X_API_KEY: "x-key",
  X_API_SECRET: "SECRET-X-KEY",
  META_SYSTEM_USER_TOKEN: "SECRET-SU",
  YOUTUBE_CLIENT_ID: "yt-client",
  YOUTUBE_CLIENT_SECRET: "SECRET-YT-CLIENT",
  TIKTOK_CLIENT_KEY: "tt-key",
  TIKTOK_CLIENT_SECRET: "SECRET-TT-CLIENT",
  BLUESKY_IDENTIFIER: "did:plc:wallgame",
};

const CONNECTED = {
  connectedAt: "2026-10-28T05:00:00.000Z",
  connectedBy: "Nil",
};
/** Every Connect with its read scope. */
const RECORDS = {
  x: {
    ...CONNECTED,
    scopes: [],
    account: { id: "1", name: "@wallgameio" },
    accessToken: "1-SECRET-XAT",
    accessTokenSecret: "SECRET-XATS",
  },
  threads: {
    ...CONNECTED,
    scopes: [
      "threads_basic",
      "threads_content_publish",
      "threads_manage_insights",
    ],
    account: { id: "TH1", name: "wallgame.io" },
    accessToken: "SECRET-THREADS",
  },
  youtube: {
    ...CONNECTED,
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
    account: { id: null, name: null },
    refreshToken: "SECRET-YT-RT",
  },
  tiktok: {
    ...CONNECTED,
    scopes: ["user.info.basic", "video.upload", "user.info.stats"],
    account: { id: "OID", name: "wallgame.io" },
    refreshToken: "SECRET-TT-RT",
  },
};
const SECRETS = [
  "SECRET-X-KEY",
  "SECRET-SU",
  "SECRET-PAGE",
  "SECRET-YT-CLIENT",
  "SECRET-TT-CLIENT",
  "1-SECRET-XAT",
  "SECRET-XATS",
  "SECRET-THREADS",
  "SECRET-YT-RT",
  "SECRET-TT-RT",
  "SECRET-YT-AT",
  "SECRET-TT-AT",
];

/** Every platform answers with a count. */
const answers = (req: Req): Reply => {
  const u = req.url;
  if (u === META_ACCOUNTS_URL) {
    return {
      status: 200,
      json: {
        data: [{ id: "P1", name: "Wall Game", access_token: "SECRET-PAGE" }],
      },
    };
  }
  if (u.endsWith("/P1?fields=instagram_business_account")) {
    return { status: 200, json: { instagram_business_account: { id: "IG1" } } };
  }
  if (u.endsWith("/P1?fields=followers_count")) {
    return { status: 200, json: { followers_count: 12 } };
  }
  if (u.endsWith("/IG1?fields=followers_count")) {
    return { status: 200, json: { followers_count: 34 } };
  }
  if (u.startsWith("https://api.x.com/2/users/me")) {
    return {
      status: 200,
      json: { data: { public_metrics: { followers_count: 56 } } },
    };
  }
  if (u.includes("/threads_insights")) {
    return {
      status: 200,
      json: {
        data: [{ name: "followers_count", total_value: { value: 78 } }],
      },
    };
  }
  if (u.startsWith("https://public.api.bsky.app/")) {
    return { status: 200, json: { followersCount: 90 } };
  }
  if (u === GOOGLE_TOKEN_URL) {
    return { status: 200, json: { access_token: "SECRET-YT-AT" } };
  }
  if (u.startsWith("https://www.googleapis.com/youtube/v3/channels")) {
    return {
      status: 200,
      json: {
        items: [
          {
            statistics: {
              subscriberCount: "1200",
              hiddenSubscriberCount: false,
            },
          },
        ],
      },
    };
  }
  if (u === TIKTOK_TOKEN_URL) {
    return {
      status: 200,
      json: { access_token: "SECRET-TT-AT", refresh_token: "SECRET-TT-RT2" },
    };
  }
  if (u.startsWith("https://open.tiktokapis.com/v2/user/info/")) {
    return { status: 200, json: { data: { user: { follower_count: 345 } } } };
  }
  return { status: 404, json: null };
};

const storeWith = (records: Record<string, object>) => {
  const tokens = openTokenStore(join(tempDir(), "tokens"));
  for (const [p, r] of Object.entries(records)) {
    tokens.write(p, r as Parameters<typeof tokens.write>[1]);
  }
  return tokens;
};

const run = async (
  records: Record<string, object>,
  answer: (req: Req) => Reply = answers,
) => {
  const transport = fakeLive(answer);
  const kept: unknown[][] = [];
  const counts = await readFollowers({
    transport,
    env: ENV,
    tokens: storeWith(records),
    keepRefreshToken: (...a: unknown[]) => kept.push(a),
    now: () => new Date("2026-10-28T06:00:00.000Z"),
  });
  return { counts, sent: transport.sent, kept };
};

describe("follower counts", () => {
  test("every platform's count, read with the right token, and no secret in the result", async () => {
    const { counts, sent, kept } = await run(RECORDS);
    expect(Object.keys(counts)).toEqual(FOLLOWER_PLATFORMS);
    expect(
      Object.fromEntries(
        Object.entries(counts).map(([p, c]) => [p, c.followers]),
      ),
    ).toEqual({
      x: 56,
      facebook: 12,
      instagram: 34,
      threads: 78,
      bluesky: 90,
      youtube: 1200,
      tiktok: 345,
    });
    for (const c of Object.values(counts)) {
      expect(c).toMatchObject({ at: "2026-10-28T06:00:00.000Z", error: null });
    }
    const auth = (part: string) =>
      sent.find((r) => r.url.includes(part))?.headers?.authorization;
    expect(auth("/2/users/me?user.fields=public_metrics")).toContain(
      'oauth_token="1-SECRET-XAT"',
    );
    expect(auth("/P1?fields=followers_count")).toBe("Bearer SECRET-PAGE");
    // The IG User page names a user token: the system user's.
    expect(auth("/IG1?fields=followers_count")).toBe("Bearer SECRET-SU");
    expect(auth("/TH1/threads_insights?metric=followers_count")).toBe(
      "Bearer SECRET-THREADS",
    );
    expect(auth("public.api.bsky.app")).toBeUndefined();
    expect(
      sent
        .find((r) => r.url.includes("bsky"))
        ?.url.endsWith("?actor=did%3Aplc%3Awallgame"),
    ).toBe(true);
    expect(sent.every((r) => r.method !== "DELETE")).toBe(true);
    // TikTok rotated its refresh token: the new one is kept, as a post does.
    expect(kept).toEqual([["tiktok", "SECRET-TT-RT2", undefined]]);
    const text = JSON.stringify(counts);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  test("a token from before the read scope gives needs reconnect, and no call to its platform", async () => {
    const { counts, sent } = await run({
      x: RECORDS.x,
      threads: { ...RECORDS.threads, scopes: ["threads_basic"] },
      youtube: {
        ...RECORDS.youtube,
        scopes: ["https://www.googleapis.com/auth/youtube.upload"],
      },
      tiktok: {
        ...RECORDS.tiktok,
        scopes: ["user.info.basic", "video.upload"],
      },
    });
    for (const p of ["threads", "youtube", "tiktok"]) {
      expect(counts[p]).toMatchObject({
        followers: null,
        error: NEEDS_RECONNECT,
      });
    }
    // No refresh: a TikTok refresh could rotate the token a post needs.
    expect(
      sent.some(
        (r) =>
          r.url === TIKTOK_TOKEN_URL ||
          r.url === GOOGLE_TOKEN_URL ||
          r.url.includes("threads"),
      ),
    ).toBe(false);
    expect(counts.x.followers).toBe(56);
  });

  test("a platform that is not connected, or has no secret, says so", async () => {
    const transport = fakeLive(answers);
    const counts = await readFollowers({
      transport,
      env: { BLUESKY_IDENTIFIER: "did:plc:wallgame" },
      tokens: storeWith({}),
      keepRefreshToken: () => undefined,
    });
    expect(counts.x.error).toBe("secrets missing: X_API_KEY, X_API_SECRET");
    expect(counts.facebook.error).toBe(
      "secrets missing: META_SYSTEM_USER_TOKEN",
    );
    expect(counts.threads.error).toBe("not connected (/daily/connect)");
    expect(counts.bluesky.followers).toBe(90);
  });

  test("a refusal gives the step and the status, never the reply body", async () => {
    const { counts } = await run(RECORDS, (req) => {
      if (req.url.startsWith("https://api.x.com/2/users/me")) {
        return { status: 401, json: { detail: "SECRET-IN-BODY" } };
      }
      if (req.url === TIKTOK_TOKEN_URL) {
        return {
          status: 400,
          json: { error: "invalid_grant", token: "SECRET-IN-BODY" },
        };
      }
      if (req.url.startsWith("https://www.googleapis.com/youtube/v3/")) {
        return {
          status: 200,
          json: { items: [{ statistics: { hiddenSubscriberCount: true } }] },
        };
      }
      if (req.url.startsWith("https://public.api.bsky.app/")) {
        return { status: 200, json: { followersCount: "lots" } };
      }
      return answers(req);
    });
    expect(counts.x).toMatchObject({
      followers: null,
      error: "x users/me: HTTP 401",
    });
    expect(counts.tiktok.error).toBe("tiktok token: HTTP 400");
    expect(counts.youtube.error).toBe("the channel hides its subscriber count");
    expect(counts.bluesky.error).toBe("bluesky: no count in the reply");
    expect(counts.facebook.followers).toBe(12);
    expect(JSON.stringify(counts)).not.toContain("SECRET-IN-BODY");
  });
});

describe("GET /api/daily/followers", () => {
  test("reads once, keeps the result in the app's data, and answers from it for an hour", async () => {
    const transport = fakeLive(answers);
    const dir = tempDir();
    const daily = createDaily({
      dataDir: dir,
      env: ENV,
      live: () => transport,
    });
    const tokens = openTokenStore(join(daily.store.dirs.root, "tokens"));
    for (const [p, r] of Object.entries(RECORDS)) {
      tokens.write(p, r as Parameters<typeof tokens.write>[1]);
    }
    const server: Server = createServer((req, res) => {
      void daily.handle(req, res, new URL(req.url ?? "/", "http://localhost"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const get = async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/daily/followers`);
        return { status: res.status, text: await res.text() };
      };
      const first = await get();
      expect(first.status).toBe(200);
      const counts = JSON.parse(first.text) as Record<
        string,
        { followers: number | null }
      >;
      expect(counts.x.followers).toBe(56);
      expect(counts.tiktok.followers).toBe(345);
      const calls = transport.sent.length;
      expect(calls).toBeGreaterThan(0);

      const second = await get();
      expect(second.text).toBe(first.text);
      // No new request inside the hour: X reads are paid.
      expect(transport.sent.length).toBe(calls);
      for (const secret of SECRETS) expect(first.text).not.toContain(secret);
    } finally {
      daily.stop();
      server.close();
    }
  });
});
