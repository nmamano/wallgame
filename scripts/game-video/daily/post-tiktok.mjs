/**
 * Send one video to TikTok as an inbox draft through the Content Posting API
 * "upload" flow. Nil finishes the post in the TikTok app.
 *
 * Read on developers.tiktok.com 2026-10-26:
 *   POST https://open.tiktokapis.com/v2/oauth/token/      refresh -> access token
 *   POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/
 *        {source_info: {source: FILE_UPLOAD, video_size, chunk_size,
 *        total_chunk_count}}                              -> publish_id, upload_url
 *   PUT  <upload_url>  the bytes, Content-Range bytes 0-N/size
 *   POST https://open.tiktokapis.com/v2/post/publish/status/fetch/
 *        {publish_id}  -> PROCESSING_UPLOAD, SEND_TO_USER_INBOX, FAILED, ...
 * Scope video.upload. 6 init requests and 30 status requests a minute per
 * token.
 *
 * WHY A DRAFT AND NOT A DIRECT POST (Nil, 2026-10-26, through Wall Game PM):
 * TikTok lets an unaudited client post only private videos, and it does not
 * audit tools that post to one's own account. The upload flow puts the video
 * in the creator's inbox; Nil opens the notification, pastes the caption and
 * taps Post. The upload carries no caption, so the ask shows it to him.
 *
 * ONE CHUNK. TikTok: a file under 5 MB must go as one chunk, and a chunk may
 * be up to 64 MB. A daily video is a few MB, so chunk_size = video_size and
 * total_chunk_count = 1; a file over 64 MB is refused here.
 *
 * THE REFRESH TOKEN ROTATES. It lasts 365 days, and a refresh "may" return a
 * new one, which must be used from then on. The secret TIKTOK_REFRESH_TOKEN
 * is only the seed: the app keeps the newest token in its data dir
 * (tokenStore below). When Nil sets a new secret, the new secret wins.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { NotPosted, PostFailed, ok, sha256 } from "./transport.mjs";

export const TIKTOK_SECRETS = [
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_REFRESH_TOKEN",
];
export const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
export const TIKTOK_INIT_URL =
  "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
export const TIKTOK_STATUS_URL =
  "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

const MAX_ONE_CHUNK = 64 * 1024 * 1024;
/** 30 status requests a minute are allowed; one every 5 s is 12. */
const STATUS_POLL_MS = 5_000;
const STATUS_POLLS = 24;

export const DRY_RUN_TIKTOK = {
  TIKTOK_CLIENT_KEY: "<TIKTOK_CLIENT_KEY>",
  TIKTOK_CLIENT_SECRET: "<TIKTOK_CLIENT_SECRET>",
  refreshToken: "<TIKTOK_REFRESH_TOKEN>",
};

/**
 * The newest refresh token, kept in `dir` (mode 0600). `seed` is the secret
 * from the app's environment; the file records the hash of the seed it grew
 * from, so a new secret replaces the old chain.
 */
export const tokenStore = (dir, seed) => {
  const path = join(dir, "tiktok.json");
  const seedSha256 = sha256(String(seed));
  return {
    current() {
      if (existsSync(path)) {
        const kept = JSON.parse(readFileSync(path, "utf8"));
        if (kept.seedSha256 === seedSha256) return kept.refreshToken;
      }
      return seed;
    },
    save(refreshToken) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const part = `${path}.part`;
      writeFileSync(
        part,
        JSON.stringify({
          seedSha256,
          refreshToken,
          savedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      renameSync(part, path);
    },
  };
};

export const tiktokDryRunReply = (req) => {
  if (req.url === TIKTOK_TOKEN_URL) {
    return {
      status: 200,
      json: {
        access_token: "DRY-RUN-ACCESS",
        expires_in: 86400,
        refresh_token: "<TIKTOK_REFRESH_TOKEN>",
      },
    };
  }
  if (req.url === TIKTOK_INIT_URL) {
    return {
      status: 200,
      json: {
        data: {
          publish_id: "DRY-RUN-PUBLISH-ID",
          upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=DRY",
        },
        error: { code: "ok" },
      },
    };
  }
  if (req.url === TIKTOK_STATUS_URL) {
    return {
      status: 200,
      json: { data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } },
    };
  }
  return { status: 201, json: null };
};

/**
 * Upload `video` (a Buffer) as a draft in the creator's inbox. `creds` holds
 * TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and refreshToken (live), or
 * DRY_RUN_TIKTOK. `onRefreshToken(token)` keeps a rotated refresh token; it
 * runs before any other request, so a failed post still keeps it.
 * Returns {postId, url: null, tiktokStatus}.
 *
 * `beforeCommit` runs just before the PUT of the bytes: an init without
 * bytes makes no draft.
 */
export const postToTiktok = async ({
  video,
  transport,
  creds,
  onRefreshToken,
  sleep,
  beforeCommit,
}) => {
  if (video.length > MAX_ONE_CHUNK) {
    throw new Error(
      `the video is ${video.length} bytes; one TikTok chunk holds 64 MB at most`,
    );
  }
  const dry = transport.mode === "dry-run";
  const token = await transport.request({
    method: "POST",
    url: TIKTOK_TOKEN_URL,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: creds.TIKTOK_CLIENT_KEY,
      client_secret: creds.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
    }).toString(),
    secretBody: !dry,
  });
  if (!ok(token) || !token.json?.access_token) {
    throw new PostFailed("tiktok token", token);
  }
  // A refresh "may" return a new token; keep it only when it does.
  const rotated = token.json.refresh_token;
  if (
    !dry &&
    typeof rotated === "string" &&
    rotated &&
    rotated !== creds.refreshToken
  ) {
    onRefreshToken(rotated);
  }
  const bearer = dry
    ? "Bearer <access token from the step above>"
    : `Bearer ${token.json.access_token}`;
  const api = (url, body) =>
    transport.request({
      method: "POST",
      url,
      headers: {
        authorization: bearer,
        "content-type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(body),
    });

  const init = await api(TIKTOK_INIT_URL, {
    source_info: {
      source: "FILE_UPLOAD",
      video_size: video.length,
      chunk_size: video.length,
      total_chunk_count: 1,
    },
  });
  const publishId = init.json?.data?.publish_id;
  const uploadUrl = init.json?.data?.upload_url;
  if (!ok(init) || !publishId || !uploadUrl) {
    throw new PostFailed("tiktok init", init);
  }

  await beforeCommit();

  const put = await transport.request({
    method: "PUT",
    url: uploadUrl,
    headers: {
      "content-type": "video/mp4",
      "content-length": String(video.length),
      "content-range": `bytes 0-${video.length - 1}/${video.length}`,
    },
    body: video,
    describe: { bytes: video.length, sha256: sha256(video) },
  });
  if (!ok(put)) throw new PostFailed("tiktok upload", put);

  // The draft reaches the inbox once TikTok has processed the upload. The
  // bytes are sent, so a refused status request (a 429, a 401) does not say
  // the draft was not made: it is a plain Error, and the post is uncertain.
  for (let i = 0; i < STATUS_POLLS; i++) {
    const status = await api(TIKTOK_STATUS_URL, { publish_id: publishId });
    if (!ok(status)) {
      throw new Error(
        `${new PostFailed("tiktok status", status).message}; the draft of ${publishId} may exist: look in the TikTok app before you post again`,
      );
    }
    const state = status.json?.data?.status;
    if (state === "FAILED") {
      throw new NotPosted(
        `tiktok processing failed: ${status.json?.data?.fail_reason ?? "no reason given"}`,
      );
    }
    if (state === "SEND_TO_USER_INBOX" || state === "PUBLISH_COMPLETE") {
      return { postId: publishId, url: null, tiktokStatus: state };
    }
    await sleep(STATUS_POLL_MS);
  }
  throw new Error(
    `tiktok: ${publishId} was not in the inbox after ${(STATUS_POLLS * STATUS_POLL_MS) / 1000} s; look in the TikTok app before you post again`,
  );
};
