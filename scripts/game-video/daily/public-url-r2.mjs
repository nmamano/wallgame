/**
 * The public copy of the video that Threads fetches (post-threads.mjs), kept
 * in Cloudflare R2 (Nil, ask eb46a7d2, 2026-10-26).
 *
 * The bucket is PRIVATE. The video goes in under a random name, Threads gets
 * a presigned GET URL that works for 15 minutes, and remove() deletes the
 * object once the post attempt ends, also when it fails. A 1-day lifecycle
 * rule on the bucket (set by Nil) removes what a crash leaves behind; the
 * code does not depend on it.
 *
 * Read on developers.cloudflare.com 2026-10-26 (R2: Presigned URLs, S3 API
 * compatibility):
 *   endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com, region "auto"
 *   ("an empty value and us-east-1 will alias to the auto region").
 *   PutObject, GetObject and DeleteObject are implemented. A presigned URL
 *   allows GET, HEAD, PUT and DELETE, for 1 second to 7 days; it needs "an
 *   implementation of the AWS Signature Version 4 signing algorithm" and
 *   works only on the S3 API domain, not on a custom domain.
 * Requests here use path style: <endpoint>/<bucket>/<key>.
 *
 * SigV4 is written here, not imported: about 60 lines, and its tests check
 * it against AWS's published S3 examples (public-url-r2.test.ts).
 *
 * SECRETS: R2_SECRET_ACCESS_KEY only signs; it is never sent. The PUT and
 * DELETE carry a signature in the Authorization header, which the live
 * transport redacts.
 *
 * THE GET URL IS A BEARER LINK for 15 minutes: whoever has it can fetch the
 * video (Warden, via Wall Game PM, 2026-10-26). Only Threads gets it. Logs,
 * the post log, the cycle record, plans and error messages name the object
 * by `key` instead (post-threads.mjs).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { ok, PostFailed } from "./transport.mjs";

export const R2_SECRETS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

export const R2_BUCKET = "wallgame-threads-video";

/** Every R2 request goes to a host that ends so. */
export const R2_HOST_SUFFIX = ".r2.cloudflarestorage.com";

/**
 * What a dry run signs with. The account id is a host name label, since the
 * URL must parse; the signature it gives is worth nothing.
 */
export const DRY_RUN_R2 = {
  R2_ACCOUNT_ID: "dry-run-account",
  R2_ACCESS_KEY_ID: "<R2_ACCESS_KEY_ID>",
  R2_SECRET_ACCESS_KEY: "<R2_SECRET_ACCESS_KEY>",
};

/** The canned R2 replies of a dry run: the PUT and the DELETE succeed. */
export const r2DryRunReply = (req) =>
  req.method === "DELETE"
    ? { status: 204, json: null }
    : { status: 200, json: null };

/** How long Threads may fetch the video. It fetches within the first minutes. */
export const GET_URL_SECONDS = 15 * 60;

const R2_REGION = "auto";

// ---- AWS Signature Version 4 ------------------------------------------------

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** 2013-05-24T00:00:00.000Z -> 20130524T000000Z */
const amzDate = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** S3's URI encoding: only A-Z a-z 0-9 - _ . ~ stay as they are. */
export const uriEncode = (text) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const canonicalQuery = (params) =>
  [...params]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

/**
 * The signature of one request. `url` is a URL whose query holds every
 * parameter that is signed; `headers` maps lower-case names to values and
 * holds every header that is signed, host included.
 */
const sign = ({ method, url, headers, payloadHash, creds, scope, stamp }) => {
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    url.pathname
      .split("/")
      .map((s) => uriEncode(decodeURIComponent(s)))
      .join("/"),
    canonicalQuery(url.searchParams),
    ...names.map(
      (n) => `${n}:${String(headers[n]).trim().replace(/\s+/g, " ")}`,
    ),
    "",
    names.join(";"),
    payloadHash,
  ].join("\n");
  const toSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope.join("/"),
    sha256Hex(canonical),
  ].join("\n");
  const key = scope.reduce(
    (k, part) => hmac(k, part),
    `AWS4${creds.secretAccessKey}`,
  );
  return {
    signedHeaders: names.join(";"),
    signature: createHmac("sha256", key).update(toSign).digest("hex"),
  };
};

const scopeOf = (date, region, service) => [
  amzDate(date).slice(0, 8),
  region,
  service,
  "aws4_request",
];

/**
 * The headers that sign a request with an Authorization header. `headers`
 * are the other signed headers (lower-case names); `host` is taken from the
 * URL and is not returned, because fetch sets it.
 * @param {{ method: string, url: string, headers?: Record<string, string>,
 *   payloadHash: string, creds: { accessKeyId: string, secretAccessKey: string },
 *   region: string, service?: string, date: Date }} request
 * @returns {Record<string, string>}
 */
export const signedHeaders = ({
  method,
  url,
  headers = {},
  payloadHash,
  creds,
  region,
  service = "s3",
  date,
}) => {
  const target = new URL(url);
  const stamp = amzDate(date);
  const scope = scopeOf(date, region, service);
  const own = {
    ...headers,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  const { signedHeaders: names, signature } = sign({
    method,
    url: target,
    headers: { ...own, host: target.host },
    payloadHash,
    creds,
    scope,
    stamp,
  });
  return {
    ...own,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope.join("/")},SignedHeaders=${names},Signature=${signature}`,
  };
};

/** A URL that allows `method` on `url` for `expiresSeconds`, signed in its query. */
export const presignedUrl = ({
  method,
  url,
  expiresSeconds,
  creds,
  region,
  service = "s3",
  date,
}) => {
  const target = new URL(url);
  const stamp = amzDate(date);
  const scope = scopeOf(date, region, service);
  target.search = canonicalQuery(
    new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${creds.accessKeyId}/${scope.join("/")}`,
      "X-Amz-Date": stamp,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": "host",
    }),
  );
  const { signature } = sign({
    method,
    url: target,
    headers: { host: target.host },
    payloadHash: "UNSIGNED-PAYLOAD",
    creds,
    scope,
    stamp,
  });
  return `${target.href}&X-Amz-Signature=${signature}`;
};

// ---- The provider ------------------------------------------------------------

/**
 * A PublicUrl (post-threads.mjs) backed by R2. `env` holds R2_SECRETS. Each
 * call stores the video under a new random 128-bit name: no game id or date
 * is in it, so the URL tells nothing about the post before it is made.
 */
export const r2PublicUrl = ({
  env,
  now = () => new Date(),
  randomName = () => randomBytes(16).toString("hex"),
}) => {
  const creds = {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
  const endpoint = `https://${env.R2_ACCOUNT_ID}${R2_HOST_SUFFIX}`;

  /** @type {import("./post-threads.mjs").PublicUrl} */
  return async ({ video, sha256, transport }) => {
    const key = `${randomName()}.mp4`;
    const url = `${endpoint}/${R2_BUCKET}/${key}`;
    const send = (method, extra) =>
      transport.request({
        method,
        url,
        ...extra,
        headers: signedHeaders({
          method,
          url,
          headers: extra?.headers,
          payloadHash: extra ? sha256 : sha256Hex(""),
          creds,
          region: R2_REGION,
          date: now(),
        }),
      });
    const remove = async () => {
      const reply = await send("DELETE");
      // 404: already gone, which is what remove wants.
      if (!ok(reply) && reply.status !== 404) {
        throw new PostFailed("r2 delete", reply);
      }
    };

    try {
      const put = await send("PUT", {
        headers: { "content-type": "video/mp4" },
        body: video,
        describe: { bytes: video.length, sha256 },
      });
      if (!ok(put)) throw new PostFailed("r2 upload", put);
    } catch (err) {
      // A lost reply or a 5xx can still leave the object stored.
      await remove().catch(() => {});
      throw err;
    }
    return {
      url: presignedUrl({
        method: "GET",
        url,
        expiresSeconds: GET_URL_SECONDS,
        creds,
        region: R2_REGION,
        date: now(),
      }),
      key: `${R2_BUCKET}/${key}`,
      remove,
    };
  };
};

/**
 * The dry run's public copy: the same requests as a live one, signed with
 * DRY_RUN_R2, so the plan shows the PUT and the DELETE.
 */
export const dryRunPublicUrl = r2PublicUrl({ env: DRY_RUN_R2 });
