/**
 * One-click Connect for the platforms that need a person's consent: YouTube,
 * TikTok and Threads (Wall Game PM, 2026-10-26; Nil: "make it as easy as
 * possible for me"). /daily/connect sends the browser to the platform's
 * authorize URL with a state (connect-state.mjs); the platform sends it back
 * to /daily/connect/<platform>/callback with a code; the app exchanges the
 * code here, server side, and keeps the tokens in the token store
 * (token-store.mjs). The app's environment holds only each platform's client
 * id and secret.
 *
 * The callback URLs are fixed: they are registered in each platform's app
 * settings (Wall Game PM gave them to Wall Game Growth).
 *
 * NO TOKEN IN AN ERROR: a refusal names the step, the HTTP status and the
 * platform's error code, never a reply body (a body can hold tokens). Every
 * request with a secret, a code or a token in its body is `secretBody`.
 *
 * Read 2026-10-26 (Worker 1's research notes, with quotes):
 * - Google, "Using OAuth 2.0 for Web Server Applications"
 *   (developers.google.com/identity/protocols/oauth2/web-server, updated
 *   2026-10-16): authorize https://accounts.google.com/o/oauth2/v2/auth with
 *   access_type=offline ("return a refresh token ... the first time"), and
 *   prompt=consent, so a reconnect also gets one; token POST
 *   https://oauth2.googleapis.com/token, form encoded, reply {access_token,
 *   expires_in, refresh_token, scope (space separated), token_type}. PKCE:
 *   S256 is in Google's discovery document; the web guide does not name it.
 *   An app in "Testing" gets refresh tokens that expire in 7 days.
 * - TikTok, "Login Kit for Web" and "Manage User Access Tokens"
 *   (developers.tiktok.com, updated 2026-08-04): authorize
 *   https://www.tiktok.com/v2/auth/authorize/ (client_key, scope comma
 *   separated, response_type=code, redirect_uri, state); "PKCE applies to
 *   desktop, iOS, and Android but not web". Token POST
 *   https://open.tiktokapis.com/v2/oauth/token/, form encoded, reply
 *   {open_id, scope (comma separated), access_token, expires_in (24 h),
 *   refresh_token (365 days), refresh_expires_in, token_type}. "The returned
 *   refresh_token may be different ... You must use the newly-returned
 *   token". User info GET /v2/user/info/?fields=open_id,display_name
 *   (user.info.basic).
 * - Threads, "Get Access Tokens and Permissions", "Long-Lived Access
 *   Tokens", "Profiles" (developers.facebook.com/docs/threads, updated
 *   2026-08-12, 2025-03-27, 2026-04-13): authorize
 *   https://threads.com/oauth/authorize (client_id = the Threads App ID,
 *   redirect_uri, scope, response_type=code, state); code -> short-lived
 *   token: POST https://graph.threads.com/oauth/access_token (client_id,
 *   client_secret, code, grant_type=authorization_code, redirect_uri) ->
 *   {access_token, user_id}; short -> long-lived (60 days): GET
 *   /access_token?grant_type=th_exchange_token&client_secret=...; the user:
 *   GET /v1.0/me?fields=id,username. No PKCE is documented. user_id comes as
 *   a JSON number over 2^53, which JSON.parse rounds, so the id is read from
 *   /me, where it is a string.
 */
import { ConnectRefused, s256 } from "./connect-state.mjs";
import { ok } from "./transport.mjs";
import { YOUTUBE_SECRETS, GOOGLE_TOKEN_URL } from "./post-youtube.mjs";
import { TIKTOK_SECRETS, TIKTOK_TOKEN_URL } from "./post-tiktok.mjs";
import { THREADS_SECRETS } from "./post-threads.mjs";

export const CONNECT_PLATFORMS = ["youtube", "tiktok", "threads"];

/** Where the app is; the callbacks below are registered with each platform. */
export const CONNECT_ORIGIN = "https://game-video.office.nilmamano.com";
export const callbackUrl = (platform) =>
  `${CONNECT_ORIGIN}/daily/connect/${platform}/callback`;

/** The client secrets each platform's Connect needs. */
export const CLIENT_SECRETS = {
  youtube: YOUTUBE_SECRETS,
  tiktok: TIKTOK_SECRETS,
  threads: THREADS_SECRETS,
};

export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
/** video.upload: the inbox draft post-tiktok.mjs makes; basic: the name. */
export const TIKTOK_SCOPES = ["user.info.basic", "video.upload"];
export const THREADS_SCOPES = ["threads_basic", "threads_content_publish"];

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TIKTOK_AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_USER_INFO =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name";
const THREADS_AUTHORIZE = "https://threads.com/oauth/authorize";
export const THREADS_CODE_URL = "https://graph.threads.com/oauth/access_token";
export const THREADS_EXCHANGE_URL = "https://graph.threads.com/access_token";
export const THREADS_ME =
  "https://graph.threads.com/v1.0/me?fields=id,username";

/** The client secrets that are missing for `platform`. */
export const missingClientSecrets = (platform, env) =>
  CLIENT_SECRETS[platform].filter((name) => !env[name]);

/** Where the Connect button sends the browser. */
export const authorizeUrl = (platform, env, { state, verifier }) => {
  const redirect_uri = callbackUrl(platform);
  if (platform === "youtube") {
    return `${GOOGLE_AUTHORIZE}?${new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      redirect_uri,
      response_type: "code",
      scope: YOUTUBE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
    })}`;
  }
  if (platform === "tiktok") {
    return `${TIKTOK_AUTHORIZE}?${new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      scope: TIKTOK_SCOPES.join(","),
      response_type: "code",
      redirect_uri,
      state,
    })}`;
  }
  if (platform === "threads") {
    return `${THREADS_AUTHORIZE}?${new URLSearchParams({
      client_id: env.THREADS_APP_ID,
      redirect_uri,
      scope: THREADS_SCOPES.join(","),
      response_type: "code",
      state,
    })}`;
  }
  throw new ConnectRefused(`no Connect for ${platform}`);
};

/**
 * The platform's error code from a reply, if it is a short code-like word.
 * Anything else is left out: only the status is safe to show.
 */
const errorCode = (json) => {
  const candidates = [
    json?.error,
    json?.error_type,
    json?.error?.type,
    json?.error?.code,
  ];
  const code = candidates.find(
    (c) => typeof c === "string" && /^[\w.-]{1,64}$/.test(c),
  );
  return code ? ` ${code}` : "";
};

const refused = (platform, step, reply) =>
  new ConnectRefused(
    `${platform} ${step} failed: HTTP ${reply.status}${errorCode(reply.json)}`,
  );

const plusSeconds = (now, seconds) =>
  Number.isFinite(seconds) && seconds > 0
    ? new Date(now.getTime() + seconds * 1000).toISOString()
    : null;

const form = (fields) => ({
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
  secretBody: true,
});

/**
 * Exchange `code` for tokens. Returns the record to store, without
 * connectedAt and connectedBy (the caller adds them).
 * @returns {Promise<Omit<import("./token-store.mjs").TokenRecord, "connectedAt" | "connectedBy">>}
 */
export const exchangeCode = async (
  platform,
  { transport, env, code, verifier, now = () => new Date() },
) => {
  const at = now();
  const redirect_uri = callbackUrl(platform);

  if (platform === "youtube") {
    const reply = await transport.request({
      method: "POST",
      url: GOOGLE_TOKEN_URL,
      ...form({
        client_id: env.YOUTUBE_CLIENT_ID,
        client_secret: env.YOUTUBE_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri,
      }),
    });
    if (!ok(reply)) throw refused(platform, "token exchange", reply);
    const scopes = String(reply.json?.scope ?? "")
      .split(" ")
      .filter(Boolean);
    if (!scopes.includes(YOUTUBE_SCOPE)) {
      throw new ConnectRefused(
        "youtube: upload access was not granted; connect again and allow it",
      );
    }
    if (!reply.json?.refresh_token) {
      throw new ConnectRefused(
        "youtube: Google sent no refresh token; connect again",
      );
    }
    return {
      scopes,
      // youtube.upload cannot read the channel, so its name is unknown here.
      account: { id: null, name: null },
      refreshToken: reply.json.refresh_token,
      refreshExpiresAt: plusSeconds(at, reply.json.refresh_token_expires_in),
    };
  }

  if (platform === "tiktok") {
    const reply = await transport.request({
      method: "POST",
      url: TIKTOK_TOKEN_URL,
      ...form({
        client_key: env.TIKTOK_CLIENT_KEY,
        client_secret: env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri,
      }),
    });
    if (!ok(reply) || reply.json?.error) {
      throw refused(platform, "token exchange", reply);
    }
    const scopes = String(reply.json?.scope ?? "")
      .split(",")
      .filter(Boolean);
    if (!scopes.includes("video.upload")) {
      throw new ConnectRefused(
        "tiktok: video.upload was not granted; connect again and allow it",
      );
    }
    const { open_id: openId, refresh_token: refreshToken } = reply.json;
    if (!refreshToken || !openId) {
      throw new ConnectRefused("tiktok: no refresh token or open_id came back");
    }
    // The name only shows which account was connected; without it the
    // connection still works.
    let name = null;
    try {
      const info = await transport.request({
        method: "GET",
        url: TIKTOK_USER_INFO,
        headers: { authorization: `Bearer ${reply.json.access_token}` },
      });
      const user = info.json?.data?.user;
      if (ok(info) && typeof user?.display_name === "string") {
        name = user.display_name;
      }
    } catch {
      /* the name stays unknown */
    }
    return {
      scopes,
      account: { id: String(openId), name },
      refreshToken,
      refreshExpiresAt: plusSeconds(at, reply.json.refresh_expires_in),
    };
  }

  if (platform === "threads") {
    const short = await transport.request({
      method: "POST",
      url: THREADS_CODE_URL,
      ...form({
        client_id: env.THREADS_APP_ID,
        client_secret: env.THREADS_APP_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri,
      }),
    });
    if (!ok(short) || !short.json?.access_token) {
      throw refused(platform, "code exchange", short);
    }
    // As the page shows it: the secret and the short-lived token in the
    // query. This transport is used for this callback only and its request
    // list is not kept.
    const long = await transport.request({
      method: "GET",
      url: `${THREADS_EXCHANGE_URL}?${new URLSearchParams({
        grant_type: "th_exchange_token",
        client_secret: env.THREADS_APP_SECRET,
        access_token: short.json.access_token,
      })}`,
      headers: {},
    });
    if (!ok(long) || !long.json?.access_token) {
      throw refused(platform, "long-lived token exchange", long);
    }
    // The Bearer header, as the posters send it (post-threads.mjs): if
    // Threads refuses it, Connect shows that now, not the first post.
    const me = await transport.request({
      method: "GET",
      url: THREADS_ME,
      headers: { authorization: `Bearer ${long.json.access_token}` },
    });
    if (!ok(me) || typeof me.json?.id !== "string") {
      throw refused(platform, "profile read", me);
    }
    return {
      scopes: THREADS_SCOPES,
      account: { id: me.json.id, name: me.json.username ?? null },
      accessToken: long.json.access_token,
      accessExpiresAt: plusSeconds(at, long.json.expires_in),
      // A long-lived token can be refreshed once it is a day old.
      refreshedAt: at.toISOString(),
      triedAt: at.toISOString(),
    };
  }

  throw new ConnectRefused(`no Connect for ${platform}`);
};
