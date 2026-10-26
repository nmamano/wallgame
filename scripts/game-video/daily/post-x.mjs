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
 * scheme OAuth) as well as OAuth 2.0 user tokens. OAuth 1.0a access tokens do
 * not expire, so the app holds four fixed secrets and never has to store a
 * rotated refresh token. The four are the app's environment variables
 * X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET, given to the
 * app as Isomux secrets. JSON and multipart bodies are not part of an OAuth
 * 1.0a signature; only the query string is.
 */
import { createHmac, randomBytes } from "node:crypto";
import { PostFailed, ok, sha256 } from "./transport.mjs";

export const X_API = "https://api.x.com";
export const X_SECRETS = [
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
];

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
 * The live signer: an OAuth 1.0a HMAC-SHA1 Authorization header for one
 * request. `now` and `nonce` are arguments so a test can pin them.
 */
export const oauth1Header = (
  { method, url },
  creds,
  now = Math.floor(Date.now() / 1000),
  nonce = randomBytes(16).toString("hex"),
) => {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: creds.X_API_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(now),
    oauth_token: creds.X_ACCESS_TOKEN,
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
  const key = `${enc(creds.X_API_SECRET)}&${enc(creds.X_ACCESS_TOKEN_SECRET)}`;
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
  'oauth_token="<X_ACCESS_TOKEN>", oauth_version="1.0", ' +
  'oauth_signature="<HMAC-SHA1 with X_API_SECRET and X_ACCESS_TOKEN_SECRET>"';

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
