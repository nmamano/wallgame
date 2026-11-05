/**
 * Post one video to YouTube as a Short through the YouTube Data API v3
 * videos.insert, with a resumable upload.
 *
 * Read on developers.google.com 2026-10-26:
 *   POST https://oauth2.googleapis.com/token        refresh -> access token
 *   POST https://www.googleapis.com/upload/youtube/v3/videos
 *        ?uploadType=resumable&part=snippet,status  -> Location header
 *   PUT  <Location>                                 the bytes -> video resource
 * One insert costs 1 unit of the Video Uploads bucket, 100 calls a day.
 *
 * UNVERIFIED PROJECTS. The 2020 rule locked uploads from unverified API
 * projects to private until a Google audit. The videos.insert page read on
 * 2026-10-26 says the opposite: "Videos uploaded from unverified API projects
 * are not restricted to private viewing mode." Unchecked until the first real
 * upload, so the result keeps the privacy status YouTube returns and the post
 * log records it.
 *
 * A Short is a vertical video of three minutes or less; YouTube decides by the
 * file, and #Shorts in the title is a hint only.
 *
 * Auth: OAuth 2.0 with a refresh token for the channel, scope
 * https://www.googleapis.com/auth/youtube.upload. YOUTUBE_CLIENT_ID is a
 * constant in public-ids.mjs; the app's environment holds only the Isomux
 * secret YOUTUBE_CLIENT_SECRET; the refresh
 * token comes from /daily/connect (connect.mjs) and lives in the token store.
 * A Google OAuth app left in "Testing" status expires its refresh tokens
 * after 7 days, so the consent screen must be "In production".
 */
import { PostFailed, ok, sha256 } from "./transport.mjs";

export const YOUTUBE_SECRETS = ["YOUTUBE_CLIENT_SECRET"];
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const YOUTUBE_UPLOAD_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus";

/** YouTube's "Gaming" category. */
const GAMING = "20";

/** The token request body. The dry-run form names the secrets. */
export const tokenBody = (creds) =>
  new URLSearchParams({
    client_id: creds.YOUTUBE_CLIENT_ID,
    client_secret: creds.YOUTUBE_CLIENT_SECRET,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  }).toString();

export const DRY_RUN_CREDS = {
  YOUTUBE_CLIENT_ID: "<YOUTUBE_CLIENT_ID>",
  YOUTUBE_CLIENT_SECRET: "<YOUTUBE_CLIENT_SECRET>",
  refreshToken: "<refresh token from /daily/connect>",
};

export const youtubeDryRunReply = (req) => {
  if (req.url === GOOGLE_TOKEN_URL) {
    return {
      status: 200,
      json: { access_token: "DRY-RUN-ACCESS", expires_in: 3599 },
    };
  }
  if (req.method === "POST") {
    return {
      status: 200,
      headers: {
        location:
          "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=DRY-RUN",
      },
      json: null,
    };
  }
  return {
    status: 200,
    json: {
      id: "DRY-RUN-VIDEO-ID",
      status: { uploadStatus: "uploaded", privacyStatus: "public" },
    },
  };
};

/**
 * An access token from the stored refresh token. Google may return a new
 * refresh token: it goes to `onRefreshToken`. Throws PostFailed("youtube
 * token", reply).
 */
export const youtubeAccessToken = async ({
  transport,
  creds,
  onRefreshToken = () => {},
}) => {
  const dry = transport.mode === "dry-run";
  const token = await transport.request({
    method: "POST",
    url: GOOGLE_TOKEN_URL,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody(creds),
    secretBody: !dry,
  });
  if (!ok(token) || !token.json?.access_token) {
    throw new PostFailed("youtube token", token);
  }
  const rotated = token.json.refresh_token;
  if (!dry && typeof rotated === "string" && rotated !== creds.refreshToken) {
    onRefreshToken(rotated);
  }
  return token.json.access_token;
};

/**
 * Upload `video` (a Buffer). `caption` has youtubeTitle and youtubeDescription.
 * `creds` is the client id and secret and the stored `refreshToken`, or
 * DRY_RUN_CREDS for a dry run. `onRefreshToken` gets a new refresh token if
 * Google ever sends one (its pages describe none; the store keeps it).
 * Returns {postId, url, privacyStatus, uploadStatus}.
 *
 * `beforeCommit` runs just before the PUT of the bytes, the request that makes
 * the video. A resumable session that is started and never filled makes
 * nothing.
 */
export const postToYoutube = async ({
  video,
  caption,
  transport,
  creds,
  onRefreshToken = () => {},
  beforeCommit,
}) => {
  const dry = transport.mode === "dry-run";
  const accessToken = await youtubeAccessToken({
    transport,
    creds,
    onRefreshToken,
  });
  const bearer = dry
    ? "Bearer <access token from the step above>"
    : `Bearer ${accessToken}`;

  const metadata = {
    snippet: {
      title: caption.youtubeTitle,
      description: caption.youtubeDescription,
      tags: ["wall game", "board game", "strategy"],
      categoryId: GAMING,
    },
    status: {
      privacyStatus: "public",
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: false,
    },
  };
  const start = await transport.request({
    method: "POST",
    url: YOUTUBE_UPLOAD_URL,
    headers: {
      authorization: bearer,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(video.length),
      "x-upload-content-type": "video/mp4",
    },
    body: JSON.stringify(metadata),
  });
  const location = start.headers?.location;
  if (!ok(start) || !location) throw new PostFailed("youtube start", start);

  await beforeCommit();

  const put = await transport.request({
    method: "PUT",
    url: location,
    headers: {
      authorization: bearer,
      "content-type": "video/mp4",
      "content-length": String(video.length),
    },
    body: video,
    describe: { bytes: video.length, sha256: sha256(video) },
  });
  const id = put.json?.id;
  if (!ok(put) || !id) throw new PostFailed("youtube upload", put);
  return {
    postId: id,
    url: `https://www.youtube.com/shorts/${id}`,
    privacyStatus: put.json.status?.privacyStatus ?? null,
    uploadStatus: put.json.status?.uploadStatus ?? null,
  };
};

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

/**
 * Google's short reason of a refused read (e.g. "quotaExceeded",
 * "insufficientPermissions"), or "": never its message, which can quote
 * the request.
 */
const googleReason = (reply) => {
  const e = reply.json?.error;
  const reason = e?.errors?.[0]?.reason ?? e?.status;
  return typeof reason === "string" && /^[\w.-]{1,64}$/.test(reason)
    ? ` ${reason}`
    : "";
};

/**
 * The channel's last `count` uploads in every state, for a person who checks
 * an UNCERTAIN upload (Wall Game PM, 2026-11-05: a "fetch failed" on the PUT
 * of v-2026-11-01-6). With the owner's token (scope youtube.readonly): the
 * uploads playlist of channels.list mine=true, its newest items (the owner
 * sees private and processing videos there), then videos.list of those ids
 * with snippet, status and processingDetails. 1 quota unit each, 3 in all.
 * Returns [{id, title, publishedAt, privacyStatus, uploadStatus,
 * processingStatus, failureReason, rejectionReason}], newest first: only
 * those fields, null where YouTube gives none. A refusal throws an Error
 * with the step, the HTTP status and Google's reason, never the reply.
 */
export const youtubeRecentUploads = async ({
  transport,
  creds,
  onRefreshToken,
  count = 5,
}) => {
  let accessToken;
  try {
    accessToken = await youtubeAccessToken({
      transport,
      creds,
      onRefreshToken,
    });
  } catch (err) {
    if (!(err instanceof PostFailed)) throw err;
    throw new Error(`youtube token: HTTP ${err.status}`);
  }
  const get = async (step, url) => {
    const reply = await transport.request({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!ok(reply)) {
      throw new Error(
        `youtube ${step}: HTTP ${reply.status}${googleReason(reply)}`,
      );
    }
    return reply.json ?? {};
  };
  const channel = await get(
    "channels",
    `${YOUTUBE_API}/channels?part=contentDetails&mine=true`,
  );
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (typeof uploads !== "string") {
    throw new Error("youtube channels: no uploads playlist for this account");
  }
  const items = await get(
    "playlistItems",
    `${YOUTUBE_API}/playlistItems?part=contentDetails&maxResults=${count}&playlistId=${encodeURIComponent(uploads)}`,
  );
  const ids = (items.items ?? [])
    .map((i) => i.contentDetails?.videoId)
    .filter((id) => typeof id === "string");
  if (!ids.length) return [];
  const videos = await get(
    "videos",
    `${YOUTUBE_API}/videos?part=snippet,status,processingDetails&id=${ids.map(encodeURIComponent).join(",")}`,
  );
  const byId = new Map((videos.items ?? []).map((v) => [v.id, v]));
  const text = (v) => (typeof v === "string" ? v : null);
  return ids.map((id) => {
    const v = byId.get(id);
    return {
      id,
      title: text(v?.snippet?.title),
      publishedAt: text(v?.snippet?.publishedAt),
      privacyStatus: text(v?.status?.privacyStatus),
      uploadStatus: text(v?.status?.uploadStatus),
      processingStatus: text(v?.processingDetails?.processingStatus),
      failureReason: text(v?.status?.failureReason),
      rejectionReason: text(v?.status?.rejectionReason),
    };
  });
};
