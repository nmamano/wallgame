/**
 * Post one video to X through the X API v2: chunked media upload, then a post
 * that carries the media and NO link (a link raises the price from $0.015 to
 * $0.20 a post; docs.x.com pricing, read 2026-10-25).
 *
 * Endpoints, read on docs.x.com 2026-10-26:
 *   POST /2/media/upload/initialize        {media_type, total_bytes, media_category}
 *   POST /2/media/upload/{id}/append       multipart: segment_index, media
 *   POST /2/media/upload/{id}/finalize
 *   GET  /2/media/upload?command=STATUS&media_id={id}   while processing
 *   POST /2/tweets                         {text, media: {media_ids: [id]}}
 *
 * AUTH IS OAUTH 1.0A USER CONTEXT. The upload endpoints accept it ("UserToken",
 * scheme OAuth) as well as OAuth 2.0 user tokens. The app's consumer key pair,
 * X_API_KEY and X_API_SECRET, is in its environment (Isomux secrets). The
 * access token and its secret come from /daily/connect (connect.mjs, OAuth
 * 1.0a 3-legged; Nil, 2026-10-28: typing token secrets is "too annoying"),
 * so they belong to the account that authorized, not to the developer app's
 * owner. They do not expire. JSON and multipart bodies are not part of an
 * OAuth 1.0a signature; only the query string is.
 */
import { createHmac, randomBytes } from "node:crypto";
import { PostFailed, ok, sha256 } from "./transport.mjs";

export const X_API = "https://api.x.com";
/** The consumer key pair; the access token comes from Connect. */
export const X_SECRETS = ["X_API_KEY", "X_API_SECRET"];

/** At or below the documented 5 MB per chunk. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** X processes a short video in seconds; this bounds a stuck one. */
const MAX_STATUS_POLLS = 60;

/** RFC 3986 percent-encoding, which OAuth 1.0a requires. */
const enc = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * The signing credentials of a post: the app's consumer key pair (env) and
 * the access token that Connect stored (`record`, tokens/x.json).
 * @returns {{ consumerKey: string, consumerSecret: string, token: string, tokenSecret: string }}
 */
export const xCreds = (env, record) => ({
  consumerKey: env.X_API_KEY,
  consumerSecret: env.X_API_SECRET,
  token: record.accessToken,
  tokenSecret: record.accessTokenSecret,
});

/**
 * The live signer: an OAuth 1.0a HMAC-SHA1 Authorization header for one
 * request. `creds` is {consumerKey, consumerSecret, token?, tokenSecret?}:
 * the request-token step of Connect has no token yet. `extra` holds more
 * signed oauth_* parameters (oauth_callback, oauth_verifier). `now` and
 * `nonce` are arguments so a test can pin them.
 * @param {{ method: string, url: string }} req
 * @param {{ consumerKey: string, consumerSecret: string, token?: string, tokenSecret?: string }} creds
 * @param {Record<string, string>} [extra]
 */
export const oauth1Header = (
  { method, url },
  creds,
  extra = {},
  now = Math.floor(Date.now() / 1000),
  nonce = randomBytes(16).toString("hex"),
) => {
  const u = new URL(url);
  const oauth = {
    ...extra,
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(now),
    ...(creds.token ? { oauth_token: creds.token } : {}),
    oauth_version: "1.0",
  };
  const params = [...u.searchParams.entries(), ...Object.entries(oauth)]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [
    method.toUpperCase(),
    enc(`${u.origin}${u.pathname}`),
    enc(params),
  ].join("&");
  const key = `${enc(creds.consumerSecret)}&${enc(creds.tokenSecret ?? "")}`;
  const signature = createHmac("sha1", key).update(base).digest("base64");
  const header = { ...oauth, oauth_signature: signature };
  return (
    "OAuth " +
    Object.entries(header)
      .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
      .join(", ")
  );
};

/** The dry-run signer: the header's shape, with no credential in it. */
export const dryRunSigner = () =>
  'OAuth oauth_consumer_key="<X_API_KEY>", oauth_nonce="<random>", ' +
  'oauth_signature_method="HMAC-SHA1", oauth_timestamp="<unix time>", ' +
  'oauth_token="<access token from /daily/connect>", oauth_version="1.0", ' +
  'oauth_signature="<HMAC-SHA1 with X_API_SECRET and the access token secret>"';

/** The canned replies a dry run gets, shaped like X's. */
export const xDryRunReply = (req) => {
  if (req.url.endsWith("/2/media/upload/initialize")) {
    return {
      status: 200,
      json: { data: { id: "DRY-RUN-MEDIA-ID", expires_after_secs: 86400 } },
    };
  }
  if (req.url.includes("/finalize")) {
    return {
      status: 200,
      json: {
        data: {
          id: "DRY-RUN-MEDIA-ID",
          processing_info: { state: "succeeded" },
        },
      },
    };
  }
  if (req.url.endsWith("/2/tweets")) {
    return { status: 201, json: { data: { id: "DRY-RUN-POST-ID", text: "" } } };
  }
  return { status: 204, json: null, text: "" };
};

/**
 * Upload `video` (a Buffer) and post it with `text`.
 * Returns {postId, url, mediaId}. Throws PostFailed with the failing step.
 *
 * `beforeCommit` runs just before POST /2/tweets, the one request that makes
 * something public. Everything before it can be repeated without effect.
 */
export const postToX = async ({
  video,
  text,
  transport,
  sign,
  sleep,
  beforeCommit,
}) => {
  const send = async (step, req) => {
    const withAuth = {
      ...req,
      headers: { ...(req.headers ?? {}), authorization: sign(req) },
    };
    const reply = await transport.request(withAuth);
    if (!ok(reply)) throw new PostFailed(`x ${step}`, reply);
    return reply;
  };

  const init = await send("initialize", {
    method: "POST",
    url: `${X_API}/2/media/upload/initialize`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      media_type: "video/mp4",
      total_bytes: video.length,
      media_category: "tweet_video",
    }),
  });
  const mediaId = init.json?.data?.id;
  if (!mediaId) throw new PostFailed("x initialize: no media id", init);

  for (let i = 0, at = 0; at < video.length; i++, at += CHUNK_BYTES) {
    const chunk = video.subarray(at, Math.min(at + CHUNK_BYTES, video.length));
    const form = new FormData();
    form.append("segment_index", String(i));
    form.append("media", new Blob([chunk], { type: "video/mp4" }), "chunk.mp4");
    await send(`append ${i}`, {
      method: "POST",
      url: `${X_API}/2/media/upload/${mediaId}/append`,
      body: form,
      describe: {
        multipart: {
          segment_index: i,
          media: { bytes: chunk.length, from: at, sha256: sha256(chunk) },
        },
      },
    });
  }

  const fin = await send("finalize", {
    method: "POST",
    url: `${X_API}/2/media/upload/${mediaId}/finalize`,
  });
  let info = fin.json?.data?.processing_info;
  let lastReply = fin;
  for (let polls = 0; info && info.state !== "succeeded"; polls++) {
    if (info.state === "failed" || polls >= MAX_STATUS_POLLS) {
      throw new PostFailed(`x processing ${info.state}`, lastReply);
    }
    await sleep((info.check_after_secs ?? 2) * 1000);
    const status = await send("status", {
      method: "GET",
      url: `${X_API}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
    });
    info = status.json?.data?.processing_info;
    lastReply = status;
  }

  await beforeCommit();

  const post = await send("post", {
    method: "POST",
    url: `${X_API}/2/tweets`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, media: { media_ids: [mediaId] } }),
  });
  const postId = post.json?.data?.id;
  if (!postId) throw new PostFailed("x post: no post id", post);
  return { postId, url: `https://x.com/i/web/status/${postId}`, mediaId };
};

/** The read-only request of the auth check: who the four values sign as. */
export const X_ME_URL = `${X_API}/2/users/me`;

/**
 * Yes/no facts about the consumer key pair that do not show any part of it:
 * is each set, and does it have whitespace at an end (a pasted line break
 * makes every signature wrong).
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, { set: boolean, whitespaceAtAnEnd: boolean }>}
 */
export const xSecretShape = (env) =>
  Object.fromEntries(
    X_SECRETS.map((name) => {
      const value = env[name];
      return [
        name,
        {
          set: typeof value === "string" && value.length > 0,
          whitespaceAtAnEnd:
            typeof value === "string" && value.trim() !== value,
        },
      ];
    }),
  );

/** App-only auth (docs.x.com "Bearer tokens", read 2026-10-28). */
export const X_APP_TOKEN_URL = `${X_API}/oauth2/token`;

/**
 * READ-ONLY: does X accept the consumer key pair alone? POST oauth2/token
 * with grant_type=client_credentials and Basic key:secret answers 200 when
 * the pair is valid. Only the status is kept: the bearer token in the reply
 * is never returned, and nothing calls invalidate_token.
 */
export const xAppCheck = async ({ transport, env }) => {
  const basic = Buffer.from(
    `${encodeURIComponent(env.X_API_KEY)}:${encodeURIComponent(env.X_API_SECRET)}`,
  ).toString("base64");
  const reply = await transport.request({
    method: "POST",
    url: X_APP_TOKEN_URL,
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "grant_type=client_credentials",
  });
  return { status: reply.status, ok: ok(reply) };
};

/**
 * READ-ONLY: GET /2/users/me signed as a post is. It posts nothing. Returns
 * the HTTP status; on success the account's public handle and the
 * x-access-level header that X sends on OAuth 1.0a replies ("read",
 * "read-write", ...); on failure X's error title and detail. A 200 also
 * shows that the app is in a Project, which every v2 endpoint needs.
 */
export const xAuthCheck = async ({ transport, sign }) => {
  const req = { method: "GET", url: X_ME_URL };
  const reply = await transport.request({
    ...req,
    headers: { authorization: sign(req) },
  });
  return ok(reply)
    ? {
        status: reply.status,
        ok: true,
        username: reply.json?.data?.username ?? null,
        accessLevel: reply.headers?.["x-access-level"] ?? null,
      }
    : {
        status: reply.status,
        ok: false,
        title: reply.json?.title ?? null,
        detail: reply.json?.detail ?? null,
      };
};
